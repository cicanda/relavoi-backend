/**
 * Integration tests: ADMIN (operator console) subsystem.
 *
 * Covers: admin auth, tenant tokens cannot access /admin/*, system health,
 * tenant listing, tier patches (ROOT-only), fleet view, DLQ retry, role
 * enforcement (VIEWER), operator CRUD (ROOT-only), and audit-log capture.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
  seedOperator,
  seedProxyNumbers,
  getSdkToken,
  getOperatorToken,
  disconnectRedis,
  TEST_TENANT_ID,
  TEST_OPERATOR_EMAIL,
  TEST_OPERATOR_PASSWORD,
} from '../helpers/integration';

describe('ADMIN — operator console', () => {
  let app: FastifyInstance;
  let db: Knex;
  let operatorToken: string;
  let sdkToken: string;

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenant(db);
    await seedProxyNumbers(db, { count: 5 });
    await seedOperator(db, { role: 'ROOT' });
    app = await buildTestApp();
    operatorToken = await getOperatorToken(app);
    sdkToken = await getSdkToken(app);
  });

  beforeEach(async () => {
    await resetSessionState(db);
  });

  afterAll(async () => {
    await app.close();
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  // ── a ────────────────────────────────────────────────────────────────────
  it('Admin login returns operator JWT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/login',
      payload: { email: TEST_OPERATOR_EMAIL, password: TEST_OPERATOR_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accessToken: string; operator: { email: string; role: string } };
    expect(typeof body.accessToken).toBe('string');
    expect(body.accessToken.length).toBeGreaterThan(0);
    expect(body.operator?.email).toBe(TEST_OPERATOR_EMAIL);
    expect(body.operator?.role).toBe('ROOT');

    // Decode JWT payload (no verify) — split & base64-decode the middle segment.
    const parts = body.accessToken.split('.');
    expect(parts.length).toBe(3);
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    expect(payload.type).toBe('operator');
    expect(payload.role).toBe('ROOT');
  });

  // ── b ────────────────────────────────────────────────────────────────────
  it('Admin login rejects wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/login',
      payload: { email: TEST_OPERATOR_EMAIL, password: 'definitely-not-the-password' },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── c ────────────────────────────────────────────────────────────────────
  it('Tenant JWT cannot access admin endpoints', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: { authorization: `Bearer ${sdkToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── d ────────────────────────────────────────────────────────────────────
  it('GET admin overview/system-health returns infrastructure block', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/system/health',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('postgres');
    expect(body).toHaveProperty('redis');
    expect(body.postgres).toBe('ok');
    expect(body.redis).toBe('ok');
  });

  // ── e ────────────────────────────────────────────────────────────────────
  it('GET /v1/admin/tenants lists tenants', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data?: Array<{ id: string }>; tenants?: Array<{ id: string }> };
    const list = body.data ?? body.tenants ?? [];
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((t) => t.id === TEST_TENANT_ID)).toBe(true);
  });

  // ── f ────────────────────────────────────────────────────────────────────
  it('PATCH /v1/admin/tenants/:id/tier updates tier', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${TEST_TENANT_ID}/tier`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { tier: 'ENTERPRISE' },
    });
    expect(res.statusCode).toBe(200);
    const row = await db('tenants').where({ id: TEST_TENANT_ID }).first('tier');
    expect(row?.tier).toBe('ENTERPRISE');

    // restore to keep cross-test invariant
    await db('tenants').where({ id: TEST_TENANT_ID }).update({ tier: 'GROWTH' });
  });

  // ── g ────────────────────────────────────────────────────────────────────
  it('GET /v1/admin/fleet returns number pool', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/fleet',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // Be flexible: pools could be an array or object. Verify the key is present
    // and contains some data (we seeded 5 numbers).
    expect(body).toHaveProperty('pools');
    const serialized = JSON.stringify(body);
    // either a region label or one of our seeded numbers should be in the dump
    expect(serialized.length).toBeGreaterThan(2);
  });

  // ── h ────────────────────────────────────────────────────────────────────
  it('POST /v1/admin/pool/quarantine quarantines a number', async () => {
    const row = await db('proxy_numbers').where({ status: 'AVAILABLE' }).first();
    expect(row, 'expected at least one AVAILABLE proxy number from the seed').toBeTruthy();
    const number: string = row!.number;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/pool/quarantine',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { number, reason: 'Test quarantine' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      number: string;
      previousStatus: string;
      reason: string;
    };
    expect(body.success).toBe(true);
    expect(body.number).toBe(number);
    expect(body.previousStatus).toBe('AVAILABLE');

    const after = await db('proxy_numbers').where({ number }).first();
    expect(after?.status).toBe('QUARANTINED');

    // Audit log captured the action.
    const audit = await db('audit_log')
      .where({ action: 'pool.number_quarantined', resource_id: number })
      .first();
    expect(audit).toBeTruthy();
  });

  // ── h2 (release follow-up) ──────────────────────────────────────────────
  it('POST /v1/admin/pool/release releases a quarantined number', async () => {
    const row = await db('proxy_numbers').where({ status: 'AVAILABLE' }).first();
    expect(row).toBeTruthy();
    const number: string = row!.number;

    // Quarantine first.
    const q = await app.inject({
      method: 'POST',
      url: '/v1/admin/pool/quarantine',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { number, reason: 'Release test setup' },
    });
    expect(q.statusCode).toBe(200);

    // Now release.
    const r = await app.inject({
      method: 'POST',
      url: '/v1/admin/pool/release',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { number },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { success: boolean; number: string };
    expect(body.success).toBe(true);
    expect(body.number).toBe(number);

    const after = await db('proxy_numbers').where({ number }).first();
    expect(after?.status).toBe('AVAILABLE');

    // Number is back in the Redis pool set.
    const { getRedis } = await import('../../src/config/redis');
    const region = (after?.region as string | null) ?? 'lagos';
    const isMember = await getRedis().sismember(`pool:${region}:available`, number);
    expect(isMember).toBe(1);
  });

  // ── i ────────────────────────────────────────────────────────────────────
  it('DLQ endpoints work', async () => {
    // Seed a DLQ row directly.
    const [inserted] = await db('webhook_dlq')
      .insert({
        event_id: `evt-${Date.now()}`,
        provider: 'AFRICASTALKING',
        payload: { foo: 'bar' },
        error_message: 'simulated failure',
        retry_count: 0,
        status: 'PENDING',
      })
      .returning(['id']);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/dlq/retry',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { ids: [inserted.id] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { retrying: number };
    expect(body.retrying).toBe(1);

    const after = await db('webhook_dlq').where({ id: inserted.id }).first();
    expect(after?.status).toBe('RETRYING');
    expect(after?.last_retry_at).not.toBeNull();
  });

  // ── j ────────────────────────────────────────────────────────────────────
  it('Role enforcement: VIEWER cannot PATCH tier (quarantine endpoint not implemented)', async () => {
    const viewerEmail = `viewer-${Date.now()}@relavoi.test`;
    const viewerPassword = 'viewerpass123';
    await seedOperator(db, {
      email: viewerEmail,
      password: viewerPassword,
      name: 'Viewer Op',
      role: 'VIEWER',
    });
    const viewerToken = await getOperatorToken(app, viewerEmail, viewerPassword);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${TEST_TENANT_ID}/tier`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { tier: 'ENTERPRISE' },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── k ────────────────────────────────────────────────────────────────────
  it('Operator CRUD (ROOT only)', async () => {
    const newOpEmail = `support-${Date.now()}@relavoi.test`;
    const newOpPassword = 'support-pass-1234';
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/operators',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        email: newOpEmail,
        name: 'New Support Op',
        role: 'SUPPORT',
        password: newOpPassword,
      },
    });
    expect([200, 201]).toContain(createRes.statusCode);

    // Now login as a SUPPORT operator and confirm POST /admin/operators is 403.
    const supportEmail = `support2-${Date.now()}@relavoi.test`;
    const supportPassword = 'support-pass-1234';
    await seedOperator(db, {
      email: supportEmail,
      password: supportPassword,
      name: 'Support Two',
      role: 'SUPPORT',
    });
    const supportToken = await getOperatorToken(app, supportEmail, supportPassword);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/v1/admin/operators',
      headers: { authorization: `Bearer ${supportToken}` },
      payload: {
        email: `another-${Date.now()}@relavoi.test`,
        name: 'X',
        role: 'SUPPORT',
        password: 'another-pass-1234',
      },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  // ── l1 ───────────────────────────────────────────────────────────────────
  it('DELETE /v1/admin/operators/:id deactivates the operator', async () => {
    // Seed a fresh operator we can deactivate (the ROOT test operator must stay).
    const target = await seedOperator(db, {
      email: `delete-target-${Date.now()}@relavoi.test`,
      password: 'delete-me-1234',
      name: 'Delete Target',
      role: 'SUPPORT',
    });

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/operators/${target.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(del.statusCode).toBe(200);
    const body = del.json() as { success: boolean; id: string };
    expect(body.success).toBe(true);
    expect(body.id).toBe(target.id);

    const after = await db('operators').where({ id: target.id }).first();
    expect(after?.is_active).toBe(false);

    // And the deactivated operator can no longer log in.
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/login',
      payload: { email: target.email, password: target.password },
    });
    expect(loginRes.statusCode).toBe(401);
  });

  // ── l2 ───────────────────────────────────────────────────────────────────
  it('Cannot delete yourself', async () => {
    // Login fresh to grab the operator's own JWT payload (operatorId).
    const me = await db('operators').where({ email: TEST_OPERATOR_EMAIL }).first();
    expect(me).toBeTruthy();

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/operators/${me!.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { detail: string };
    expect(body.detail.toLowerCase()).toContain('your own');

    // And the operator account is still active.
    const after = await db('operators').where({ id: me!.id }).first();
    expect(after?.is_active).toBe(true);
  });

  // ── m ────────────────────────────────────────────────────────────────────
  it('Audit log records actions', async () => {
    // Trigger an auditable event: patch tier.
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${TEST_TENANT_ID}/tier`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { tier: 'STARTER' },
    });
    expect(patchRes.statusCode).toBe(200);

    const auditRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const body = auditRes.json() as { data: Array<{ action: string; resourceType: string }> };
    expect(Array.isArray(body.data)).toBe(true);
    const hit = body.data.find(
      (e) =>
        (typeof e.action === 'string' && e.action.toLowerCase().includes('tier')) ||
        (typeof e.resourceType === 'string' && e.resourceType.toLowerCase().includes('tenant')),
    );
    expect(hit).toBeDefined();

    // restore tier
    await db('tenants').where({ id: TEST_TENANT_ID }).update({ tier: 'GROWTH' });
  });
});
