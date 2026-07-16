/**
 * Device token registration upserts on the token column, which requires a
 * UNIQUE constraint on device_tokens.token (added in migration 004). Without it
 * the ON CONFLICT clause 500s.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  disconnectRedis,
} from '../helpers/integration';

describe('device token registration (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;
  let token: string;

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenantDeterministic(db);
    app = await buildTestApp();
    token = await getSdkToken(app);
  });

  afterAll(async () => {
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  it('POST /devices/token registers, and re-registering the same token upserts (no 500)', async () => {
    const body = {
      userPhone: '+2348012349999',
      token: 'fcm-token-abc',
      platform: 'android',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/devices/token',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect([200, 201, 204]).toContain(first.statusCode);

    // Re-register same token → exercises ON CONFLICT (token) upsert.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/devices/token',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...body, platform: 'ios' },
    });
    expect([200, 201, 204]).toContain(second.statusCode);

    const rows = await db('device_tokens').where({ token: 'fcm-token-abc' });
    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe('ios');
  });
});
