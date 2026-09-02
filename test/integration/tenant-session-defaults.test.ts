/**
 * Per-tenant session defaults.
 *
 * createSession() used to read grace period and max duration straight from the
 * global env config, so tenants.default_grace_period and
 * default_session_ttl_min were settable via PATCH /config, readable via GET
 * /config, and silently ignored on every session. These specs pin the intended
 * precedence:
 *
 *   request value  >  tenant column  >  global env default
 *
 * and the same for cooldown_min on the release path.
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
  seedTestTenantDeterministic,
  seedProxyNumbers,
  getSdkToken,
  getDashboardToken,
  disconnectRedis,
  TEST_TENANT_ID,
} from '../helpers/integration';
import { getRedis } from '../../src/config/redis';
import { config } from '../../src/config/env';
import { getSessionManager, clearTenantConfigCache } from '../../src/services/session-manager';

interface SessionBody {
  id: string;
  gracePeriodMinutes: number;
  maxDurationMinutes: number;
  proxyNumber: string;
  expiresAt: string;
  createdAt: string;
}

describe('per-tenant session defaults (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;
  let sdkToken: string;
  let dashboardToken: string;
  let proxyNumbers: string[];

  /** Create a session over HTTP, returning the parsed body. */
  async function createSession(
    payload: Record<string, unknown> = {},
  ): Promise<{ status: number; body: SessionBody }> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${sdkToken}` },
      payload: {
        agentPhone: '+2348011111111',
        customerPhone: '+2348022222222',
        ...payload,
      },
    });
    return { status: res.statusCode, body: res.json() as SessionBody };
  }

  /** Overwrite tenant defaults directly, bypassing the API, then drop the cache. */
  async function setTenantDefaults(patch: Record<string, number | null>): Promise<void> {
    await db('tenants').where({ id: TEST_TENANT_ID }).update(patch);
    clearTenantConfigCache();
  }

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenantDeterministic(db);
    proxyNumbers = await seedProxyNumbers(db, { count: 5, region: 'lagos' });
    app = await buildTestApp();
    sdkToken = await getSdkToken(app);
    dashboardToken = await getDashboardToken(app);
  });

  beforeEach(async () => {
    await resetSessionState(db, { region: 'lagos' });
    // createSession() allocates from the default region ('NG'); the helper
    // seeds 'lagos'. Mirror the numbers across so allocation succeeds.
    const redis = getRedis();
    await redis.del('pool:NG:available', 'pool:NG:in_use', 'pool:NG:AFRICASTALKING:available');
    await redis.sadd('pool:NG:available', ...proxyNumbers);
    await redis.sadd('pool:NG:AFRICASTALKING:available', ...proxyNumbers);
    for (const n of proxyNumbers) {
      await redis.set(`proxy:${n}:region`, 'NG');
      await redis.set(`proxy:${n}:provider`, 'AFRICASTALKING');
    }
    clearTenantConfigCache();
  });

  afterAll(async () => {
    await app.close();
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  // ─── Grace period ──────────────────────────────────────────────────────────

  it('(a) uses the tenant default grace period when the request omits it', async () => {
    await setTenantDefaults({ default_grace_period: 30 });

    const { status, body } = await createSession();

    expect(status).toBe(201);
    expect(body.gracePeriodMinutes).toBe(30);
  });

  it('(b) request grace period overrides the tenant default', async () => {
    await setTenantDefaults({ default_grace_period: 30 });

    const { status, body } = await createSession({ gracePeriodMinutes: 5 });

    expect(status).toBe(201);
    expect(body.gracePeriodMinutes).toBe(5);
  });

  it('(c) falls back to the global env grace period when the tenant default is null', async () => {
    await setTenantDefaults({ default_grace_period: null });

    const { status, body } = await createSession();

    expect(status).toBe(201);
    expect(body.gracePeriodMinutes).toBe(config.SESSION_DEFAULT_GRACE_PERIOD_MINUTES);
    expect(body.gracePeriodMinutes).toBe(15);
  });

  it('(c2) an explicit grace period of 0 is honoured, not treated as absent', async () => {
    await setTenantDefaults({ default_grace_period: 30 });

    const { status, body } = await createSession({ gracePeriodMinutes: 0 });

    expect(status).toBe(201);
    expect(body.gracePeriodMinutes).toBe(0);
  });

  // ─── Max duration ──────────────────────────────────────────────────────────

  it('(d) uses the tenant default TTL when the request omits it', async () => {
    await setTenantDefaults({ default_session_ttl_min: 45 });

    const { status, body } = await createSession();

    expect(status).toBe(201);
    expect(body.maxDurationMinutes).toBe(45);

    // expires_at must be derived from the resolved TTL, not the env default.
    const spanMin =
      (new Date(body.expiresAt).getTime() - new Date(body.createdAt).getTime()) / 60_000;
    expect(spanMin).toBeCloseTo(45, 5);
  });

  it('(e) request maxDurationMinutes overrides the tenant default TTL', async () => {
    await setTenantDefaults({ default_session_ttl_min: 45 });

    const { status, body } = await createSession({ maxDurationMinutes: 10 });

    expect(status).toBe(201);
    expect(body.maxDurationMinutes).toBe(10);
  });

  it('(f) falls back to the global env TTL when the tenant default is null', async () => {
    await setTenantDefaults({ default_session_ttl_min: null });

    const { status, body } = await createSession();

    expect(status).toBe(201);
    expect(body.maxDurationMinutes).toBe(config.SESSION_DEFAULT_MAX_DURATION_MINUTES);
    expect(body.maxDurationMinutes).toBe(120);
  });

  // ─── Cooldown on release ───────────────────────────────────────────────────

  it('(g) expiry releases the proxy using the tenant cooldown, not the global default', async () => {
    // Global test config sets POOL_COOLDOWN_MINUTES=0, so a number released
    // under the old behaviour returns straight to AVAILABLE. A tenant cooldown
    // of 7 must instead park it in COOLDOWN.
    expect(config.POOL_COOLDOWN_MINUTES).toBe(0);
    await setTenantDefaults({ cooldown_min: 7 });

    const { body } = await createSession();
    const releasedAtMs = Date.now();
    await getSessionManager().expireSession(body.id);

    const row = await db('proxy_numbers').where({ number: body.proxyNumber }).first();
    expect(row.status).toBe('COOLDOWN');

    const cooldownMin = (new Date(row.cooldown_until).getTime() - releasedAtMs) / 60_000;
    expect(cooldownMin).toBeGreaterThan(6);
    expect(cooldownMin).toBeLessThanOrEqual(7.1);
  });

  // ─── Cache invalidation ────────────────────────────────────────────────────

  it('(h) PATCH /config takes effect on the next session without waiting for the TTL', async () => {
    await setTenantDefaults({ default_grace_period: 30 });

    // Warm the cache at 30.
    const first = await createSession();
    expect(first.body.gracePeriodMinutes).toBe(30);

    // Change it through the API — the route must invalidate the cache entry.
    const patch = await app.inject({
      method: 'PATCH',
      url: '/v1/config',
      headers: { authorization: `Bearer ${dashboardToken}` },
      payload: { defaultGracePeriod: 20 },
    });
    expect(patch.statusCode).toBe(200);

    const second = await createSession();
    expect(second.body.gracePeriodMinutes).toBe(20);
  });

  // ─── Empty body on /end ────────────────────────────────────────────────────

  it('(i) POST /sessions/:id/end accepts an empty body with a JSON content-type', async () => {
    const { body } = await createSession();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${body.id}/end`,
      headers: { authorization: `Bearer ${sdkToken}`, 'content-type': 'application/json' },
      payload: '',
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { state: string }).state).toBe('GRACE_PERIOD');
  });

  it('(j) POST /sessions/:id/end accepts an explicit {} body', async () => {
    const { body } = await createSession();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${body.id}/end`,
      headers: { authorization: `Bearer ${sdkToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { state: string }).state).toBe('GRACE_PERIOD');
  });

  it('(k) malformed JSON is still rejected with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${sdkToken}`, 'content-type': 'application/json' },
      payload: '{"agentPhone":',
    });

    expect(res.statusCode).toBe(400);
  });
});
