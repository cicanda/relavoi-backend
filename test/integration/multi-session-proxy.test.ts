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
  seedProxyNumbers,
  getSdkToken,
  disconnectRedis,
  TEST_TENANT_ID,
} from '../helpers/integration';
import { getRedis } from '../../src/config/redis';
import { hashPhone } from '../../src/utils/crypto';
import { getSessionManager } from '../../src/services/session-manager';

/**
 * Multi-session-on-shared-proxy tests. The pool is seeded with EXACTLY ONE
 * proxy number; the allocator's no-overlap rule means many disjoint sessions
 * can share that single number, but reusing a participant should refuse to
 * allocate (no other proxy to fall back to).
 */
describe('multi-session shared proxy (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;
  let sdkToken: string;
  let proxyNumber: string;

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenant(db);
    const nums = await seedProxyNumbers(db, { count: 1, region: 'lagos' });
    proxyNumber = nums[0];
    app = await buildTestApp();
    sdkToken = await getSdkToken(app);
  });

  beforeEach(async () => {
    await resetSessionState(db, { region: 'lagos' });
    // NumberPool.allocate() defaults to region 'NG'; mirror the lagos seed
    // into NG and tag the proxy's region so release returns it consistently.
    const redis = getRedis();
    await redis.del('pool:NG:available', 'pool:NG:in_use', 'pool:NG:AFRICASTALKING:available');
    await redis.sadd('pool:NG:available', proxyNumber);
    await redis.sadd('pool:NG:AFRICASTALKING:available', proxyNumber);
    await redis.set(`proxy:${proxyNumber}:region`, 'NG');
    await redis.set(`proxy:${proxyNumber}:provider`, 'AFRICASTALKING');
  });

  afterAll(async () => {
    await app.close();
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  async function createSession(
    agent: string,
    customer: string,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${sdkToken}` },
      payload: { agentPhone: agent, customerPhone: customer },
    });
    return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  async function postVoiceWebhook(form: URLSearchParams): Promise<{
    statusCode: number;
    body: string;
  }> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/cpaas/voice',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form.toString(),
    });
    return { statusCode: res.statusCode, body: res.body };
  }

  it('(a) Multiple sessions allocated to same proxy when no overlap', async () => {
    const created: Record<string, unknown>[] = [];
    for (let i = 1; i <= 5; i++) {
      const tag = i.toString().padStart(3, '0');
      const r = await createSession(`+234801000${tag}`, `+234802000${tag}`);
      expect(r.statusCode).toBe(201);
      created.push(r.body);
    }
    for (const c of created) {
      expect(c.proxyNumber).toBe(proxyNumber);
      expect(c.state).toBe('ACTIVE');
    }
  });

  it('(b) Call routing distinguishes sessions on shared proxy (agent1 -> customer1)', async () => {
    const s1 = await createSession('+2348010001001', '+2348020001001');
    const s2 = await createSession('+2348010001002', '+2348020001002');
    const s3 = await createSession('+2348010001003', '+2348020001003');
    expect(s1.statusCode).toBe(201);
    expect(s2.statusCode).toBe(201);
    expect(s3.statusCode).toBe(201);

    const form = new URLSearchParams({
      sessionId: 'AT_TEST_ROUTE_001',
      callerNumber: '+2348010001001',
      destinationNumber: proxyNumber,
      direction: 'Inbound',
      isActive: '1',
    });
    const { statusCode, body } = await postVoiceWebhook(form);
    expect(statusCode).toBe(200);
    // Expect a <Dial …> to customer1
    expect(body).toMatch(/<Dial[^>]*phoneNumbers="\+2348020001001"/);
  });

  it('(c) Reverse routing on shared proxy (customer2 -> agent2)', async () => {
    await createSession('+2348010002001', '+2348020002001');
    const s2 = await createSession('+2348010002002', '+2348020002002');
    await createSession('+2348010002003', '+2348020002003');
    expect(s2.statusCode).toBe(201);

    const form = new URLSearchParams({
      sessionId: 'AT_TEST_ROUTE_002',
      callerNumber: '+2348020002002',
      destinationNumber: proxyNumber,
      direction: 'Inbound',
      isActive: '1',
    });
    const { statusCode, body } = await postVoiceWebhook(form);
    expect(statusCode).toBe(200);
    expect(body).toMatch(/<Dial[^>]*phoneNumbers="\+2348010002002"/);
  });

  it('(d) Unknown caller on shared proxy is rejected', async () => {
    await createSession('+2348010003001', '+2348020003001');
    await createSession('+2348010003002', '+2348020003002');

    const form = new URLSearchParams({
      sessionId: 'AT_TEST_ROUTE_003',
      callerNumber: '+2348099887766',
      destinationNumber: proxyNumber,
      direction: 'Inbound',
      isActive: '1',
    });
    const { statusCode, body } = await postVoiceWebhook(form);
    expect(statusCode).toBe(200);
    // dead_line / play_message / Hangup all indicate the call was not bridged.
    // Accept <Hangup>, <Reject>, or the 'no longer in service' message.
    const looksLikeRejection =
      /<Hangup\s*\/?>/i.test(body) ||
      /<Reject/i.test(body) ||
      /no longer in service/i.test(body);
    expect(looksLikeRejection).toBe(true);
  });

  it('(e) Overlap prevents allocation when only one proxy exists', async () => {
    const a = await createSession('+2348010004001', '+2348020004001');
    expect(a.statusCode).toBe(201);

    // Reuse agent — would overlap with session A on the single proxy
    const b = await createSession('+2348010004001', '+2348020004099');
    // Expect either pool-exhausted (503) or a session-create-failed validation
    // path. The Lua script returns "" when no candidate is overlap-free; the
    // service then throws POOL_EXHAUSTED (503).
    expect([400, 503]).toContain(b.statusCode);
  });

  it('(f) After expiring a session, proxy serves new sessions', async () => {
    const a = await createSession('+2348010005001', '+2348020005001');
    expect(a.statusCode).toBe(201);

    // Reuse agent A — refused while session A is active
    const b1 = await createSession('+2348010005001', '+2348020005099');
    expect([400, 503]).toContain(b1.statusCode);

    // Expire the original session
    const sessionId = a.body.id as string;
    const ok = await getSessionManager().expireSession(sessionId);
    expect(ok).toBe(true);

    // Now the same agent should be able to create a new session
    const c = await createSession('+2348010005001', '+2348020005099');
    expect(c.statusCode).toBe(201);
    expect(c.body.proxyNumber).toBe(proxyNumber);
  });

  it('(g) Redis proxy:{number}:sessions tracks multiple sessions', async () => {
    const s1 = await createSession('+2348010006001', '+2348020006001');
    const s2 = await createSession('+2348010006002', '+2348020006002');
    const s3 = await createSession('+2348010006003', '+2348020006003');
    expect(s1.statusCode).toBe(201);
    expect(s2.statusCode).toBe(201);
    expect(s3.statusCode).toBe(201);

    const redis = getRedis();
    const members = await redis.smembers(`proxy:${proxyNumber}:sessions`);
    expect(members.length).toBe(3);
    expect(members).toEqual(
      expect.arrayContaining([s1.body.id as string, s2.body.id as string, s3.body.id as string]),
    );
  });

  it('(h) Redis phone:{hash}:sessions tracks the session for each participant', async () => {
    const agent = '+2348010007001';
    const customer = '+2348020007001';
    const r = await createSession(agent, customer);
    expect(r.statusCode).toBe(201);
    const sessionId = r.body.id as string;

    const redis = getRedis();
    const agentHash = hashPhone(agent, TEST_TENANT_ID);
    const customerHash = hashPhone(customer, TEST_TENANT_ID);

    const agentMembers = await redis.smembers(`phone:${agentHash}:sessions`);
    const customerMembers = await redis.smembers(`phone:${customerHash}:sessions`);

    expect(agentMembers).toContain(sessionId);
    expect(customerMembers).toContain(sessionId);
  });
});
