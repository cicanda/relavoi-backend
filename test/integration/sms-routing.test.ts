/**
 * Integration tests for the CPaaS SMS webhook + SMS router path.
 *
 * Drives POST /v1/webhooks/cpaas/sms with realistic Africa's Talking
 * form-encoded payloads and verifies:
 *   - the JSON ack
 *   - DB side effects on sms_records
 *   - That outbound sendSms() is invoked with the correct other-party number
 *   - That direction-mode and unknown-sender restrictions are honoured
 *   - That webhook deduplication suppresses repeat forwarding
 *
 * We mock the Africa's Talking sms-sender module so no real API calls fire.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// IMPORTANT: vi.mock is hoisted above imports. Place it BEFORE any module that
// transitively imports src/services/africastalking/sms-sender (sms-router →
// webhook-handler → routes/webhooks).
vi.mock('../../src/services/africastalking/sms-sender', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/africastalking/sms-sender')
  >('../../src/services/africastalking/sms-sender');
  return {
    ...actual,
    sendSms: vi.fn(async (_args: { from?: string; to: string; message: string }) => ({
      status: 'sent' as const,
      messageId: `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      recipients: [],
    })),
  };
});

import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import {
  ensureTestDatabase,
  runTestMigrations,
  openTestDb,
  buildTestApp,
  cleanTables,
  resetSessionState,
  seedTestTenant,
  seedProxyNumbers,
  getSdkToken,
  disconnectRedis,
  TEST_TENANT_ID,
} from '../helpers/integration';
import { getSessionManager } from '../../src/services/session-manager';
import { sendSms } from '../../src/services/africastalking/sms-sender';

// ─── helpers ─────────────────────────────────────────────────────────────────

async function postSmsWebhook(
  app: FastifyInstance,
  fields: Record<string, string>,
): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> {
  const body = new URLSearchParams(fields).toString();
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/cpaas/sms',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: body,
  });
}

interface CreatedSession {
  id: string;
  proxyNumber: string;
  state: string;
}

interface CreateSessionOpts {
  agentPhone: string;
  customerPhone: string;
  gracePeriodMinutes?: number;
  directionMode?: 'BIDIRECTIONAL' | 'A_TO_B_ONLY' | 'B_TO_A_ONLY';
  recordingEnabled?: boolean;
  consentPrompt?: 'DEFAULT' | 'CUSTOM' | 'NONE';
}

async function createSession(
  app: FastifyInstance,
  sdkToken: string,
  opts: CreateSessionOpts,
): Promise<CreatedSession> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { authorization: `Bearer ${sdkToken}` },
    payload: opts,
  });
  if (res.statusCode !== 201) {
    throw new Error(`createSession failed: ${res.statusCode} ${res.body}`);
  }
  return res.json() as CreatedSession;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let smsIdCounter = 0;
function nextSmsId(): string {
  smsIdCounter += 1;
  return `ATSms_${Date.now()}_${smsIdCounter}`;
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe('CPaaS SMS webhook + SMS routing (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;
  let sdkToken: string;

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenant(db);
    await seedProxyNumbers(db, { count: 5, region: 'lagos' });
    app = await buildTestApp();
    sdkToken = await getSdkToken(app);
  });

  beforeEach(async () => {
    await resetSessionState(db, { region: 'lagos' });
    // NOTE: we intentionally do NOT mockClear() here; individual tests that
    // care about call counts reset the mock at their start.
  });

  afterAll(async () => {
    await app.close();
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  it('(a) SMS from agent forwards to customer (A_TO_B)', async () => {
    vi.mocked(sendSms).mockClear();

    const agent = '+2348011110001';
    const customer = '+2348022220001';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
    });

    const res = await postSmsWebhook(app, {
      id: nextSmsId(),
      from: agent,
      to: session.proxyNumber,
      text: 'Hello from agent',
      date: new Date().toISOString(),
    });

    expect(res.statusCode).toBe(200);
    await sleep(250);

    const rows = await db('sms_records').where({ session_id: session.id });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.direction).toBe('A_TO_B');
    expect(['PENDING', 'SENT', 'DELIVERED']).toContain(row.status as string);

    const calls = vi.mocked(sendSms).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const sentToCustomer = calls.some((c) => c[0].to === customer);
    expect(sentToCustomer).toBe(true);
  });

  it('(b) SMS from customer forwards to agent (B_TO_A)', async () => {
    vi.mocked(sendSms).mockClear();

    const agent = '+2348011110002';
    const customer = '+2348022220002';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
    });

    const res = await postSmsWebhook(app, {
      id: nextSmsId(),
      from: customer,
      to: session.proxyNumber,
      text: 'Hello from customer',
      date: new Date().toISOString(),
    });

    expect(res.statusCode).toBe(200);
    await sleep(250);

    const rows = await db('sms_records').where({ session_id: session.id });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].direction).toBe('B_TO_A');

    const calls = vi.mocked(sendSms).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const sentToAgent = calls.some((c) => c[0].to === agent);
    expect(sentToAgent).toBe(true);
  });

  it('(c) SMS on expired session is rejected (sendSms not called)', async () => {
    const agent = '+2348011110003';
    const customer = '+2348022220003';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
      gracePeriodMinutes: 0,
    });

    const sm = getSessionManager();
    await sm.endSession(session.id, TEST_TENANT_ID);
    await sm.expireSession(session.id);

    vi.mocked(sendSms).mockClear();

    const res = await postSmsWebhook(app, {
      id: nextSmsId(),
      from: agent,
      to: session.proxyNumber,
      text: 'Anyone home?',
      date: new Date().toISOString(),
    });

    expect(res.statusCode).toBe(200);
    await sleep(200);

    expect(vi.mocked(sendSms)).not.toHaveBeenCalled();
  });

  it('(d) SMS direction-mode A_TO_B_ONLY rejects B-side sender', async () => {
    const agent = '+2348011110004';
    const customer = '+2348022220004';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
      directionMode: 'A_TO_B_ONLY',
    });

    vi.mocked(sendSms).mockClear();

    const res = await postSmsWebhook(app, {
      id: nextSmsId(),
      from: customer, // B side trying to message — should be blocked
      to: session.proxyNumber,
      text: 'B says hi',
      date: new Date().toISOString(),
    });

    expect(res.statusCode).toBe(200);
    await sleep(200);

    // Should not have forwarded to the agent.
    const calls = vi.mocked(sendSms).mock.calls;
    const forwardedToAgent = calls.some((c) => c[0].to === agent);
    expect(forwardedToAgent).toBe(false);
  });

  it('(e) SMS content is stored encrypted, not in plaintext', async () => {
    vi.mocked(sendSms).mockClear();

    const agent = '+2348011110005';
    const customer = '+2348022220005';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
    });

    const plaintext = 'TopSecretEncryptionCanary42';
    const res = await postSmsWebhook(app, {
      id: nextSmsId(),
      from: agent,
      to: session.proxyNumber,
      text: plaintext,
      date: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(200);

    await sleep(300);

    const rows = await db('sms_records').where({ session_id: session.id });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const enc = rows[0].message_text_enc;

    expect(enc).toBeTruthy();
    const isBinary = Buffer.isBuffer(enc) || enc instanceof Uint8Array;
    expect(isBinary).toBe(true);

    const asBuf = Buffer.isBuffer(enc) ? enc : Buffer.from(enc as Uint8Array);
    // The encrypted blob must not contain the plaintext canary.
    expect(asBuf.toString('utf8')).not.toContain(plaintext);
    expect(asBuf.toString('binary')).not.toContain(plaintext);
  });

  it('(f) SMS from an unknown sender is dropped (sendSms not called)', async () => {
    const agent = '+2348011110006';
    const customer = '+2348022220006';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
    });

    vi.mocked(sendSms).mockClear();

    const stranger = '+2348099999999';
    const res = await postSmsWebhook(app, {
      id: nextSmsId(),
      from: stranger,
      to: session.proxyNumber,
      text: 'I am a stranger',
      date: new Date().toISOString(),
    });

    // The webhook acks even when dropping.
    expect(res.statusCode).toBe(200);
    await sleep(200);

    expect(vi.mocked(sendSms)).not.toHaveBeenCalled();
  });

  it('(g) Duplicate SMS webhook posts only forward once', async () => {
    vi.mocked(sendSms).mockClear();

    const agent = '+2348011110007';
    const customer = '+2348022220007';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
    });

    // Same `id` => same eventId => dedup hit on the second post.
    const fields = {
      id: nextSmsId(),
      from: agent,
      to: session.proxyNumber,
      text: 'Dedup me please',
      date: new Date().toISOString(),
    };

    const first = await postSmsWebhook(app, fields);
    const second = await postSmsWebhook(app, fields);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    await sleep(300);

    // Even though we POSTed twice, only one outbound send should have fired.
    expect(vi.mocked(sendSms).mock.calls.length).toBeLessThanOrEqual(1);
  });
});
