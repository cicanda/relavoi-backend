/**
 * Admin console <-> backend contract fixes (2026-07 audit):
 *  - GET /admin/dlq (+ summary) and POST /admin/dlq/:id/abandon
 *  - GET /admin/fleet enriched with totals/byRegion/numbers
 *  - PATCH /admin/operators/:id, PATCH /admin/pricing/:id
 *  - POST /admin/cpaas/:provider/force-open|force-close
 *  - operator create accepts VIEWER
 *  - GET /admin/pricing camelCase DTO with id
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  seedOperator,
  getOperatorToken,
  disconnectRedis,
} from '../helpers/integration';

describe('admin contract fixes (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;
  let root: string;

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenantDeterministic(db);
    await seedProxyNumbers(db, { count: 5 });
    await seedOperator(db); // ROOT
    app = await buildTestApp();
    root = await getOperatorToken(app);
  });

  afterAll(async () => {
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  const auth = () => ({ authorization: `Bearer ${root}` });

  it('GET /admin/dlq returns data + pagination + summary', async () => {
    await db('webhook_dlq').insert({
      id: randomUUID(),
      event_id: 'evt-dlq-1',
      provider: 'AFRICASTALKING',
      payload: JSON.stringify({ x: 1 }),
      error_message: 'boom',
      status: 'PENDING',
      first_received_at: new Date(),
    });

    const res = await app.inject({ method: 'GET', url: '/v1/admin/dlq', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ id: string; eventId: string; status: string }>;
      pagination: { count: number };
      summary: { pending: number; retrying: number; resolved: number; abandoned: number };
    };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].eventId).toBe('evt-dlq-1');
    expect(body.summary.pending).toBeGreaterThanOrEqual(1);
  });

  it('POST /admin/dlq/:id/abandon marks the row ABANDONED', async () => {
    const id = randomUUID();
    await db('webhook_dlq').insert({
      id,
      event_id: 'evt-dlq-abandon',
      provider: 'AFRICASTALKING',
      payload: JSON.stringify({}),
      status: 'PENDING',
      first_received_at: new Date(),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/dlq/${id}/abandon`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const row = await db('webhook_dlq').where({ id }).first();
    expect(row.status).toBe('ABANDONED');
    expect(row.resolved_at).toBeTruthy();
  });

  it('GET /admin/fleet includes totals, byRegion, and individual numbers', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/fleet', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      pools: unknown[];
      totals: { total: number; available: number };
      byRegion: Array<{ region: string; total: number }>;
      numbers: Array<{ number: string; status: string; region?: string }>;
    };
    expect(body.totals.total).toBeGreaterThanOrEqual(5);
    expect(body.byRegion.length).toBeGreaterThanOrEqual(1);
    expect(body.numbers.length).toBeGreaterThanOrEqual(5);
    expect(body.numbers[0].number).toMatch(/^\+/);
  });

  it('PATCH /admin/operators/:id updates name/role/isActive', async () => {
    const target = await seedOperator(db, {
      email: 'patchme@relavoi.test',
      password: 'temppw12chars',
      role: 'SUPPORT',
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/operators/${target.id}`,
      headers: auth(),
      payload: { name: 'Renamed Op', role: 'SRE', isActive: false },
    });
    expect(res.statusCode).toBe(200);
    const row = await db('operators').where({ id: target.id }).first();
    expect(row.name).toBe('Renamed Op');
    expect(row.role).toBe('SRE');
    expect(row.is_active).toBe(false);
  });

  it('POST /admin/operators accepts VIEWER role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/operators',
      headers: auth(),
      payload: {
        email: 'viewer@relavoi.test',
        name: 'View Only',
        role: 'VIEWER',
        password: 'twelvecharspw!',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { role: string };
    expect(body.role).toBe('VIEWER');
  });

  it('GET /admin/pricing returns camelCase rows with id; PATCH /admin/pricing/:id updates', async () => {
    const id = randomUUID();
    await db('tier_pricing').insert({
      id,
      tier: 'STARTER',
      metric: 'sms_sent',
      unit_price: '1.0000',
      included_quantity: '100.0000',
      overage_price: '2.0000',
      currency: 'NGN',
      effective_from: new Date(),
    });

    const get = await app.inject({ method: 'GET', url: '/v1/admin/pricing', headers: auth() });
    const rows = (get.json() as { tiers: Array<Record<string, unknown>> }).tiers;
    const row = rows.find((r) => r.id === id)!;
    expect(row).toBeTruthy();
    expect(typeof row.unitPrice).toBe('number');
    expect(row.unit_price).toBeUndefined();

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/pricing/${id}`,
      headers: auth(),
      payload: { unitPrice: 3.5, includedQuantity: 250, overagePrice: 4 },
    });
    expect(patch.statusCode).toBe(200);
    const dbRow = await db('tier_pricing').where({ id }).first();
    expect(Number(dbRow.unit_price)).toBe(3.5);
    expect(Number(dbRow.included_quantity)).toBe(250);
  });

  it('POST /admin/cpaas/:provider/force-open then force-close flips breaker state', async () => {
    const open = await app.inject({
      method: 'POST',
      url: '/v1/admin/cpaas/africastalking/force-open',
      headers: auth(),
    });
    expect(open.statusCode).toBe(200);
    let health = (
      await app.inject({ method: 'GET', url: '/v1/admin/system/health', headers: auth() })
    ).json() as { circuitBreakers: Array<{ provider: string; state: string }> };
    expect(health.circuitBreakers.find((c) => c.provider === 'africastalking')?.state).toBe('OPEN');

    const close = await app.inject({
      method: 'POST',
      url: '/v1/admin/cpaas/africastalking/force-close',
      headers: auth(),
    });
    expect(close.statusCode).toBe(200);
    health = (
      await app.inject({ method: 'GET', url: '/v1/admin/system/health', headers: auth() })
    ).json() as { circuitBreakers: Array<{ provider: string; state: string }> };
    expect(health.circuitBreakers.find((c) => c.provider === 'africastalking')?.state).toBe('CLOSED');
  });
});
