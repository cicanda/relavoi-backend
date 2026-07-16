/**
 * Dashboard <-> backend contract fixes (2026-07 audit):
 *  - billing/pricing must return camelCase numeric fields (consistent with
 *    every other endpoint), not raw snake_case string columns
 *  - PATCH /config must accept `name`
 *  - dashboard (tenant_user) JWTs must be long-lived (no 15-min re-login)
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
  getSdkToken,
  getDashboardToken,
  disconnectRedis,
  TEST_TENANT_ID,
} from '../helpers/integration';

function decodeJwt(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

describe('dashboard contract fixes (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;
  let sdkToken: string;
  let dashToken: string;

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenantDeterministic(db);
    app = await buildTestApp();
    sdkToken = await getSdkToken(app);
    dashToken = await getDashboardToken(app);
  });

  afterAll(async () => {
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  it('GET /billing/pricing returns camelCase numeric fields', async () => {
    await db('tier_pricing').insert({
      id: randomUUID(),
      tier: 'GROWTH',
      metric: 'session_created',
      unit_price: '0.5000',
      included_quantity: '1000.0000',
      overage_price: '0.7500',
      currency: 'NGN',
      effective_from: new Date(),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/billing/pricing',
      headers: { authorization: `Bearer ${sdkToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tiers: Array<Record<string, unknown>> };
    const row = body.tiers.find((r) => r.metric === 'session_created' && r.tier === 'GROWTH')!;
    expect(row).toBeTruthy();
    // camelCase keys, numeric values
    expect(typeof row.unitPrice).toBe('number');
    expect(typeof row.includedQuantity).toBe('number');
    expect(typeof row.overagePrice).toBe('number');
    expect(row.includedQuantity).toBe(1000);
    // snake_case keys must be gone
    expect(row.unit_price).toBeUndefined();
    expect(row.included_quantity).toBeUndefined();
  });

  it('PATCH /config accepts and persists name', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/config',
      headers: { authorization: `Bearer ${dashToken}` },
      payload: { name: 'Chowdeck Renamed' },
    });
    expect(res.statusCode).toBe(200);
    const row = await db('tenants').where({ id: TEST_TENANT_ID }).first();
    expect(row.name).toBe('Chowdeck Renamed');
  });

  it('dashboard JWT is long-lived (>= 1 hour), SDK JWT stays short', async () => {
    const dash = decodeJwt(dashToken);
    const sdk = decodeJwt(sdkToken);
    const dashTtl = (dash.exp as number) - (dash.iat as number);
    const sdkTtl = (sdk.exp as number) - (sdk.iat as number);
    expect(dashTtl).toBeGreaterThanOrEqual(3600);
    expect(sdkTtl).toBeLessThanOrEqual(3600);
  });
});
