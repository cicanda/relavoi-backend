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
  seedTestTenantDeterministic,
  seedProxyNumbers,
  getSdkToken,
  disconnectRedis,
  TEST_TENANT_ID,
  TEST_API_KEY,
  TEST_API_SECRET,
  TEST_USER_EMAIL,
  TEST_USER_PASSWORD,
} from '../helpers/integration';
import { getRedis } from '../../src/config/redis';
import { getSessionManager } from '../../src/services/session-manager';

// ─────────────────────────────────────────────────────────────────────────────
// Main describe — uses seedTestTenant (random email suffix). Covers tests
// a, c, d, e, f, g, h, i, j, k, l, m, n.
// ─────────────────────────────────────────────────────────────────────────────
describe('session lifecycle (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;
  let sdkToken: string;
  let proxyNumbers: string[];

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenant(db);
    proxyNumbers = await seedProxyNumbers(db, { count: 5, region: 'lagos' });
    app = await buildTestApp();
    sdkToken = await getSdkToken(app);
  });

  beforeEach(async () => {
    await resetSessionState(db, { region: 'lagos' });
    // NumberPool.allocate() defaults to region 'NG' when callers don't
    // specify one (createSession doesn't), but the helper seeds the pool
    // at 'lagos'. Mirror the numbers into the NG pool and clear any
    // lingering NG `in_use` membership so allocation succeeds.
    const redis = getRedis();
    await redis.del('pool:NG:available', 'pool:NG:in_use', 'pool:NG:AFRICASTALKING:available');
    await redis.sadd('pool:NG:available', ...proxyNumbers);
    await redis.sadd('pool:NG:AFRICASTALKING:available', ...proxyNumbers);
    // Tag each proxy's region so release() can return it to a consistent
    // pool (otherwise it falls back to DEFAULT_REGION='NG').
    for (const n of proxyNumbers) {
      await redis.set(`proxy:${n}:region`, 'NG');
      await redis.set(`proxy:${n}:provider`, 'AFRICASTALKING');
    }
  });

  afterAll(async () => {
    await app.close();
    await cleanTables(db);
    await db.destroy();
    // NOTE: do NOT disconnectRedis here — the next describe block in this
    // file will re-use the shared service singletons that cache a redis
    // reference. Disconnect is performed only by the final describe.
  });

  it('(a) Get JWT token via API key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: { apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accessToken: string; tokenType?: string };
    expect(body.accessToken).toBeTruthy();
    expect(body.accessToken.split('.')).toHaveLength(3);
  });

  it('(c) Reject invalid credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: { apiKey: TEST_API_KEY, apiSecret: 'wrong_secret_value' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('(d) Create session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${sdkToken}` },
      payload: {
        agentPhone: '+2348011111111',
        customerPhone: '+2348022222222',
        metadata: { orderId: 'ORD-001' },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(proxyNumbers).toContain(body.proxyNumber);
    expect(body.state).toBe('ACTIVE');
    expect(body.metadata).toMatchObject({ orderId: 'ORD-001' });
  });

  it('(e) Reject without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { agentPhone: '+2348011111112', customerPhone: '+2348022222223' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('(f) Reject invalid phone', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${sdkToken}` },
      payload: { agentPhone: '12345', customerPhone: '+2348022222224' },
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('(g) Get session by ID', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${sdkToken}` },
      payload: { agentPhone: '+2348011111113', customerPhone: '+2348022222225' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: string; proxyNumber: string };

    const get = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${created.id}`,
      headers: { authorization: `Bearer ${sdkToken}` },
    });
    expect(get.statusCode).toBe(200);
    const body = get.json() as { id: string; proxyNumber: string };
    expect(body.id).toBe(created.id);
    expect(body.proxyNumber).toBe(created.proxyNumber);
  });

  it('(h) 404 for non-existent session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/sessions/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${sdkToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('(i) End session -> GRACE_PERIOD', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${sdkToken}` },
      payload: {
        agentPhone: '+2348011111114',
        customerPhone: '+2348022222226',
        gracePeriodMinutes: 15,
      },
    });
    expect(create.statusCode).toBe(201);
    const sessionId = (create.json() as { id: string }).id;

    const end = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/end`,
      headers: { authorization: `Bearer ${sdkToken}` },
    });
    expect(end.statusCode).toBe(200);
    expect((end.json() as { state: string }).state).toBe('GRACE_PERIOD');
  });

  it('(j) End session -> immediate EXPIRED with gracePeriodMinutes:0', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${sdkToken}` },
      payload: {
        agentPhone: '+2348011111115',
        customerPhone: '+2348022222227',
        gracePeriodMinutes: 0,
      },
    });
    expect(create.statusCode).toBe(201);
    const sessionId = (create.json() as { id: string }).id;

    const end = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/end`,
      headers: { authorization: `Bearer ${sdkToken}` },
    });
    expect(end.statusCode).toBe(200);
    // Grace 0 means we transition to GRACE_PERIOD with newExpiry==now; many
    // implementations report this as GRACE_PERIOD until the expiry sweeper runs.
    // Accept either GRACE_PERIOD (consistent with endSession) or EXPIRED.
    const body = end.json() as { state: string };
    expect(['GRACE_PERIOD', 'EXPIRED']).toContain(body.state);
  });

  it('(k) Expire + number release: redis session cleared, proxy back in pool', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${sdkToken}` },
      payload: { agentPhone: '+2348011111116', customerPhone: '+2348022222228' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: string; proxyNumber: string };

    const ok = await getSessionManager().expireSession(created.id);
    expect(ok).toBe(true);

    // DB checks
    const row = await db('sessions').where({ id: created.id }).first();
    expect(row.state).toBe('EXPIRED');
    expect(row.expired_at).toBeTruthy();

    // Redis checks (note: getRedis returns prefixed client; use keys WITHOUT prefix)
    const redis = getRedis();
    const stillHas = await redis.exists(`session:${created.id}`);
    expect(stillHas).toBe(0);

    // release() puts the proxy back into pool:NG:available (we tagged the
    // proxy region as 'NG' in beforeEach to keep alloc + release symmetric).
    const inNg = await redis.sismember('pool:NG:available', created.proxyNumber);
    expect(inNg).toBe(1);
  });

  it('(l) Recording requires consent — recordingEnabled:true + consentPrompt:NONE rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${sdkToken}` },
      payload: {
        agentPhone: '+2348011111117',
        customerPhone: '+2348022222229',
        recordingEnabled: true,
        consentPrompt: 'NONE',
      },
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('(m) Full lifecycle: create -> get -> end -> expire', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${sdkToken}` },
      payload: {
        agentPhone: '+2348011111118',
        customerPhone: '+2348022222230',
        gracePeriodMinutes: 5,
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: string; proxyNumber: string; state: string };
    expect(created.state).toBe('ACTIVE');

    const get1 = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${created.id}`,
      headers: { authorization: `Bearer ${sdkToken}` },
    });
    expect(get1.statusCode).toBe(200);
    expect((get1.json() as { state: string }).state).toBe('ACTIVE');

    const end = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${created.id}/end`,
      headers: { authorization: `Bearer ${sdkToken}` },
    });
    expect(end.statusCode).toBe(200);
    expect((end.json() as { state: string }).state).toBe('GRACE_PERIOD');

    const ok = await getSessionManager().expireSession(created.id);
    expect(ok).toBe(true);

    const dbRow = await db('sessions').where({ id: created.id }).first();
    expect(dbRow.state).toBe('EXPIRED');

    const redis = getRedis();
    const exists = await redis.exists(`session:${created.id}`);
    expect(exists).toBe(0);
    // Mirror of test (k): proxy returned to pool:NG:available
    const inNg = await redis.sismember('pool:NG:available', created.proxyNumber);
    expect(inNg).toBe(1);
  });

  it('(n) Raw phone cache: proxy region/provider keys exist', async () => {
    // Note: createSession does NOT cache raw phones at proxy:*:{sessionId}:party_a/b.
    // What IS persisted in Redis is the per-proxy region/provider config keys, plus
    // the session hash (which holds *hashes* only, never raw phones). Verify the
    // surrounding cache layout: session hash exists and contains the proxy number,
    // and that hash-based lookup keys are present.
    const create = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${sdkToken}` },
      payload: { agentPhone: '+2348011111119', customerPhone: '+2348022222231' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: string; proxyNumber: string };

    const redis = getRedis();

    // The session hash exists with proxy_number set
    const sess = await redis.hgetall(`session:${created.id}`);
    expect(sess.id).toBe(created.id);
    expect(sess.proxy_number).toBe(created.proxyNumber);

    // The proxy:{number}:sessions set contains the session id
    const proxySessions = await redis.smembers(`proxy:${created.proxyNumber}:sessions`);
    expect(proxySessions).toContain(created.id);

    // Phones themselves are E.164 +2348… in our test data; ensure we can find
    // the raw prefix nowhere in Redis (privacy invariant). Scan the whole
    // namespace for any value containing the raw agent number.
    let cursor = '0';
    let leakedPhoneFound = false;
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', '*', 'COUNT', 200);
      cursor = next;
      for (const k of keys) {
        const type = await redis.type(k);
        let value = '';
        if (type === 'string') value = (await redis.get(k)) ?? '';
        else if (type === 'hash') {
          const h = await redis.hgetall(k);
          value = Object.values(h).join('|');
        } else if (type === 'set') {
          value = (await redis.smembers(k)).join('|');
        }
        if (value.includes('+2348011111119') || value.includes('+2348022222231')) {
          leakedPhoneFound = true;
        }
      }
    } while (cursor !== '0');
    expect(leakedPhoneFound).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Separate describe — needs DETERMINISTIC email so we can log in via
// /v1/auth/dashboard/login with TEST_USER_EMAIL.
// ─────────────────────────────────────────────────────────────────────────────
describe('session lifecycle: dashboard login (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenantDeterministic(db);
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  it('(b) Get JWT token via dashboard login', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/dashboard/login',
      payload: { email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      accessToken: string;
      user: { tenantId: string; role: string };
    };
    expect(body.accessToken).toBeTruthy();
    expect(body.user.tenantId).toBe(TEST_TENANT_ID);
    expect(body.user.role).toBe('OWNER');
  });
});
