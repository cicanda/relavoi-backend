/**
 * Event-pipeline + pool-recycling fixes (2026-07 audit):
 *  - 7b: pool reaper returns COOLDOWN numbers to AVAILABLE
 *  - 8:  event consumers read tenantId from the envelope's payload
 *  - 9:  SessionManager publishes session.created
 *  - 10: SmsRouter publishes sms.sent
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Stub the AT SMS sender so no real network call fires (mirrors sms-routing.test.ts).
vi.mock('../../src/services/africastalking/sms-sender', () => ({
  sendSms: vi.fn(async () => ({ status: 'sent', messageId: `mock-${Math.random()}` })),
}));

import type { Knex } from 'knex';
import {
  ensureTestDatabase,
  runTestMigrations,
  openTestDb,
  cleanTables,
  seedTestTenantDeterministic,
  seedProxyNumbers,
  resetSessionState,
  disconnectRedis,
  TEST_TENANT_ID,
} from '../helpers/integration';
import { getSessionManager } from '../../src/services/session-manager';
import { getNumberPool } from '../../src/services/number-pool';
import { getEventBus } from '../../src/services/event-bus';
import { startEventConsumers, stopEventConsumers } from '../../src/workers/event-consumers';
import { PoolReaperWorker } from '../../src/workers/pool-reaper';
import { getRedis } from '../../src/config/redis';
import { config } from '../../src/config/env';

async function poll<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 5000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

describe('event pipeline + pool recycling (integration)', () => {
  let db: Knex;

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenantDeterministic(db);
    await seedProxyNumbers(db, { count: 6 });
  });

  afterAll(async () => {
    await stopEventConsumers();
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  beforeEach(async () => {
    await resetSessionState(db);
  });

  // Fix 8 + 9: creating a session publishes session.created, and the metering
  // consumer (which must read tenantId from event.payload) records usage.
  it('session.created flows through the consumer to a usage_records row', async () => {
    await startEventConsumers();

    await getSessionManager().createSession({
      tenantId: TEST_TENANT_ID,
      agentPhone: '+2348055556666',
      customerPhone: '+2348077778888',
    });

    const row = await poll(async () => {
      return db('usage_records')
        .where({ tenant_id: TEST_TENANT_ID, metric: 'session_created' })
        .first();
    });
    expect(row).toBeTruthy();
  });

  // Fix 10: SmsRouter publishes sms.sent after a successful forward.
  it('SmsRouter publishes sms.sent for a matched, forwarded message', async () => {
    const received: Array<{ tenantId?: string }> = [];
    await getEventBus().subscribe('sms.sent', 'test-probe', 'probe-1', (event) => {
      received.push(event.payload as { tenantId?: string });
    });

    const session = await getSessionManager().createSession({
      tenantId: TEST_TENANT_ID,
      agentPhone: '+2348099990000',
      customerPhone: '+2348088880000',
    });

    const { getSmsRouter } = await import('../../src/services/sms-router');
    await getSmsRouter().routeIncomingSms({
      proxyNumber: session.proxyNumber,
      fromPhone: '+2348099990000', // party A
      body: 'hi there',
      eventId: `sms-evt-${Date.now()}`,
    });

    const hit = await poll(async () => (received.length ? received : null));
    expect(hit).toBeTruthy();
    expect(received[0]?.tenantId).toBe(TEST_TENANT_ID);
  });

  // Fix 7b: reaper returns a cooldown number to the available pool once its
  // cooldown_until has passed.
  it('pool reaper moves an expired-cooldown number back to AVAILABLE', async () => {
    const [num] = await seedProxyNumbers(db, { count: 1, startAt: 900 });
    const region = 'lagos';

    // Put the number into COOLDOWN with an already-elapsed cooldown_until.
    const past = Date.now() - 60_000;
    await db('proxy_numbers')
      .where({ number: num })
      .update({ status: 'COOLDOWN', cooldown_until: new Date(past) });
    const redis = getRedis();
    await redis.srem(`pool:${region}:available`, num);
    await redis.zadd(`pool:${region}:cooldown`, past, num);

    const reaper = new PoolReaperWorker(getNumberPool());
    await reaper.tick();

    const row = await db('proxy_numbers').where({ number: num }).first();
    expect(row.status).toBe('AVAILABLE');
    const isMember = await redis.sismember(`${config.REDIS_PREFIX}pool:${region}:available`, num);
    // ioredis auto-prefixes, so query without manual prefix:
    const isMember2 = await redis.sismember(`pool:${region}:available`, num);
    expect(isMember === 1 || isMember2 === 1).toBe(true);
  });
});
