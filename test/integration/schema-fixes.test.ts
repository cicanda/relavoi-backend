/**
 * Schema/code-mismatch fixes (2026-07 audit). Each of these endpoints 500'd or
 * silently returned empty because the code referenced columns/cursors that did
 * not match the actual schema.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import {
  ensureTestDatabase,
  runTestMigrations,
  openTestDb,
  buildTestApp,
  cleanTables,
  seedTestTenantDeterministic,
  seedProxyNumbers,
  resetSessionState,
  seedOperator,
  getSdkToken,
  getDashboardToken,
  getOperatorToken,
  disconnectRedis,
  TEST_TENANT_ID,
} from '../helpers/integration';
import { getSessionManager } from '../../src/services/session-manager';

describe('schema/code mismatch fixes (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;
  let sdkToken: string;
  let ownerToken: string;

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenantDeterministic(db);
    await seedProxyNumbers(db, { count: 6 });
    app = await buildTestApp();
    sdkToken = await getSdkToken(app);
    ownerToken = await getDashboardToken(app);
  });

  afterAll(async () => {
    await app.close();
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  beforeEach(async () => {
    await resetSessionState(db);
  });

  // Fix 3
  it('GET /sessions/:id/sms returns 200 and orders by sent_at (not a 500)', async () => {
    const session = await getSessionManager().createSession({
      tenantId: TEST_TENANT_ID,
      agentPhone: '+2348011112222',
      customerPhone: '+2348033334444',
    });

    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    await db('sms_records').insert([
      {
        id: randomUUID(),
        session_id: session.id,
        direction: 'A_TO_B',
        message_text_enc: Buffer.from('x'),
        status: 'DELIVERED',
        sent_at: older,
      },
      {
        id: randomUUID(),
        session_id: session.id,
        direction: 'B_TO_A',
        message_text_enc: Buffer.from('y'),
        status: 'DELIVERED',
        sent_at: newer,
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${session.id}/sms`,
      headers: { authorization: `Bearer ${sdkToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ direction: string }> };
    expect(body.data).toHaveLength(2);
    // desc by sent_at → newest (B_TO_A) first
    expect(body.data[0].direction).toBe('B_TO_A');
  });

  // Fix 4
  it('GET /sessions pagination cursor walks pages without gaps or duplicates', async () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await getSessionManager().createSession({
        tenantId: TEST_TENANT_ID,
        agentPhone: `+23480100000${i}0`,
        customerPhone: `+23480200000${i}0`,
      });
      created.push(s.id);
    }

    const page1 = await app.inject({
      method: 'GET',
      url: '/v1/sessions?limit=2',
      headers: { authorization: `Bearer ${sdkToken}` },
    });
    expect(page1.statusCode).toBe(200);
    const b1 = page1.json() as { data: Array<{ id: string }>; pagination: { after: string | null } };
    expect(b1.data).toHaveLength(2);
    expect(b1.pagination.after).toBeTruthy();

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/sessions?limit=2&after=${encodeURIComponent(b1.pagination.after as string)}`,
      headers: { authorization: `Bearer ${sdkToken}` },
    });
    expect(page2.statusCode).toBe(200);
    const b2 = page2.json() as { data: Array<{ id: string }> };
    expect(b2.data).toHaveLength(1);

    const seen = [...b1.data, ...b2.data].map((r) => r.id);
    expect(new Set(seen).size).toBe(3);
    expect(new Set(seen)).toEqual(new Set(created));
  });

  // Fix 2
  it('GET /webhooks/logs surfaces delivery-log rows (real schema columns)', async () => {
    await db('webhook_delivery_logs').insert({
      id: randomUUID(),
      tenant_id: TEST_TENANT_ID,
      event_type: 'session.created',
      payload_summary: '{"test":true}',
      delivery_url: 'https://client.example/hook',
      http_status: 200,
      response_body: 'ok',
      success: true,
      attempt_number: 1,
      delivered_at: new Date(),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/logs',
      headers: { authorization: `Bearer ${sdkToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const row = body.data[0];
    expect(row.event).toBe('session.created');
    expect(row.statusCode).toBe(200);
    expect(row.success).toBe(true);
    expect(row.attemptCount).toBe(1);
  });

  // Fix 1
  it('PATCH /admin/tenants/:id/status persists status (not a 500)', async () => {
    await seedOperator(db);
    const rootToken = await getOperatorToken(app);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${TEST_TENANT_ID}/status`,
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { status: 'SUSPENDED' },
    });
    expect(res.statusCode).toBe(200);

    const row = await db('tenants').where({ id: TEST_TENANT_ID }).first();
    expect(row.status).toBe('SUSPENDED');

    // restore
    await db('tenants').where({ id: TEST_TENANT_ID }).update({ status: 'ACTIVE' });
  });

  // Fix 6
  it('POST /numbers/provision returns a clean 501', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/numbers/provision',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { region: 'lagos', count: 5 },
    });
    expect(res.statusCode).toBe(501);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe('string');
    expect((body.error as string).length).toBeGreaterThan(0);
  });
});
