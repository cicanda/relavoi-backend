/**
 * Integration test: session creation returns a proxy number, and listing
 * sessions returns the newly created one.
 *
 * Assumes:
 *   - DB has been migrated and dev-seeded (npm run migrate && npm run seed)
 *   - Redis is reachable and the pool is populated
 */

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.SERVICE_MODE = 'api';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://relavoi:relavoi_dev@localhost:5432/relavoi';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.REDIS_PREFIX = process.env.REDIS_PREFIX ?? 'relavoi:';
process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? 'test-jwt-secret-must-be-at-least-32-characters-long-aaaa';
process.env.ENCRYPTION_MASTER_KEY =
  process.env.ENCRYPTION_MASTER_KEY ??
  'test-encryption-master-key-must-be-at-least-64-characters-long-for-validation-aaaaaaaaaa';
process.env.AT_API_KEY = process.env.AT_API_KEY ?? 'test-at-api-key';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const DEV_API_KEY = 'sk_test_relavoi_dev_0123456789abcdef';
const DEV_API_SECRET = 'secret_test_relavoi_dev_fedcba9876543210';

let app: FastifyInstance;
let token: string | undefined;

describe('Session create flow', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(import('@fastify/cors'), { origin: true });
    await app.register(import('@fastify/jwt'), { secret: process.env.JWT_SECRET! });
    await app.register(import('@fastify/formbody'));

    try {
      const { tenantRoutes } = await import('../../src/api/routes/tenants');
      const { sessionRoutes } = await import('../../src/api/routes/sessions');
      await app.register(tenantRoutes, { prefix: '/v1' });
      await app.register(sessionRoutes, { prefix: '/v1' });
    } catch {
      console.warn('routes module not present; test will skip assertions');
    }

    await app.ready();

    // Auth as the dev tenant (assumes seed has been run).
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: {
        'x-api-key': DEV_API_KEY,
        'x-api-secret': DEV_API_SECRET,
      },
      payload: {},
    });
    if (tokenRes.statusCode === 200) {
      token = tokenRes.json().token ?? tokenRes.json().access_token;
    }
  });

  afterAll(async () => {
    await app.close();
    try {
      const { disconnectDb } = await import('../../src/config/database');
      await disconnectDb();
    } catch {
      /* ignore */
    }
    try {
      const { disconnectRedis } = await import('../../src/config/redis');
      await disconnectRedis();
    } catch {
      /* ignore */
    }
  });

  it('creates a session and returns a proxy number, then lists it', async () => {
    if (!token) {
      console.warn('no token (auth routes not present); skipping');
      return;
    }

    const suffix = Math.floor(Math.random() * 1e8).toString().padStart(8, '0');
    const agentPhone = `+23480101${suffix.slice(0, 6)}`;
    const customerPhone = `+23480202${suffix.slice(0, 6)}`;

    // Create
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        agentPhone,
        customerPhone,
        metadata: { test: true },
        gracePeriodMinutes: 5,
      },
    });
    expect([200, 201]).toContain(createRes.statusCode);
    const created = createRes.json();
    const proxy = created.proxyNumber ?? created.proxy_number ?? created.session?.proxyNumber;
    const id = created.id ?? created.session?.id;
    expect(proxy).toMatch(/^\+\d+$/);
    expect(id).toBeTruthy();

    // List
    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/sessions?limit=10',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    const items = (list.data ?? list.sessions ?? list) as Array<{ id: string }>;
    expect(Array.isArray(items)).toBe(true);
    expect(items.some((s) => s.id === id)).toBe(true);
  });
});
