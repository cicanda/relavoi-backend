/**
 * PATCH /v1/sessions/:id/target — retarget an active session without releasing
 * its proxy number.
 *
 * The point of the endpoint is sequential calling: one allocation serves a run
 * of recipients instead of burning a number (and a cooldown) per recipient. The
 * routing assertions below are the ones that matter — after a swap the new
 * target must be reachable on the same proxy and the old one must not.
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
  seedProxyNumbers,
  getSdkToken,
  disconnectRedis,
  TEST_TENANT_ID,
} from '../helpers/integration';
import { getRedis } from '../../src/config/redis';
import { hashPhone } from '../../src/utils/crypto';
import { getSessionManager } from '../../src/services/session-manager';

const AGENT = '+2348030000001';
const CUST_B = '+2349090000002';
const CUST_C = '+2349090000003';
const CUST_D = '+2349090000004';
const CUST_E = '+2349090000005';

interface SessionBody {
  id: string;
  proxyNumber: string;
  state: string;
}

describe('session target swap (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;
  let token: string;
  let proxyNumbers: string[];

  const h = (phone: string) => hashPhone(phone, TEST_TENANT_ID);

  async function postVoiceWebhook(fields: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/v1/webhooks/cpaas/voice',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(fields).toString(),
    });
  }

  async function createSession(
    agentPhone = AGENT,
    customerPhone = CUST_B,
  ): Promise<SessionBody> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${token}` },
      payload: { agentPhone, customerPhone },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as SessionBody;
  }

  async function swap(sessionId: string, customerPhone: string) {
    return app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${sessionId}/target`,
      headers: { authorization: `Bearer ${token}` },
      payload: { customerPhone },
    });
  }

  /** Who does an inbound call from `caller` on `proxy` get connected to? */
  async function dial(caller: string, proxy: string): Promise<string> {
    const res = await postVoiceWebhook({
      sessionId: `AT_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      isActive: '1',
      direction: 'Inbound',
      callerNumber: caller,
      destinationNumber: proxy,
    });
    return res.body;
  }

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenant(db);
    proxyNumbers = await seedProxyNumbers(db, { count: 5, region: 'lagos' });
    app = await buildTestApp();
    token = await getSdkToken(app);
  });

  beforeEach(async () => {
    await resetSessionState(db, { region: 'lagos' });
    const redis = getRedis();
    await redis.del('pool:NG:available', 'pool:NG:in_use', 'pool:NG:AFRICASTALKING:available');
    await redis.sadd('pool:NG:available', ...proxyNumbers);
    await redis.sadd('pool:NG:AFRICASTALKING:available', ...proxyNumbers);
    for (const n of proxyNumbers) {
      await redis.set(`proxy:${n}:region`, 'NG');
      await redis.set(`proxy:${n}:provider`, 'AFRICASTALKING');
    }
    await db('audit_log').del().catch(() => undefined);
  });

  afterAll(async () => {
    await app.close();
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  it('(a) swap returns the updated session and moves the routing hash', async () => {
    const s = await createSession();
    const redis = getRedis();

    const res = await swap(s.id, CUST_C);
    expect(res.statusCode).toBe(200);

    const body = res.json() as SessionBody;
    expect(body.id).toBe(s.id);
    expect(body.state).toBe('ACTIVE');
    expect(body.proxyNumber).toBe(s.proxyNumber); // the whole point: same number

    expect(await redis.sismember(`phone:${h(CUST_C)}:sessions`, s.id)).toBe(1);
    expect(await redis.sismember(`phone:${h(CUST_B)}:sessions`, s.id)).toBe(0);
    expect(await redis.hget(`session:${s.id}`, 'party_b_hash')).toBe(h(CUST_C));

    const row = await db('sessions').where({ id: s.id }).first();
    expect(row.party_b_phone_hash).toBe(h(CUST_C));
  });

  it('(b) after a swap, a call from the agent reaches the new target', async () => {
    const s = await createSession();
    await swap(s.id, CUST_C);

    const xml = await dial(AGENT, s.proxyNumber);
    expect(xml).toContain('<Dial');
    expect(xml).toContain(CUST_C);
    expect(xml).not.toContain(CUST_B);
  });

  it('(c) after a swap, the previous target no longer matches the session', async () => {
    const s = await createSession();
    await swap(s.id, CUST_C);

    const xml = await dial(CUST_B, s.proxyNumber);
    expect(xml).not.toContain(`<Dial callerId="${s.proxyNumber}" phoneNumbers="${AGENT}"`);
  });

  it('(d) after a swap, a call from the new target reaches the agent', async () => {
    const s = await createSession();
    await swap(s.id, CUST_C);

    const xml = await dial(CUST_C, s.proxyNumber);
    expect(xml).toContain('<Dial');
    expect(xml).toContain(AGENT);
  });

  it('(e) swapping to the agent phone is rejected with 422', async () => {
    const s = await createSession();
    const res = await swap(s.id, AGENT);
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/same as the agent/i);
  });

  it('(f) swapping to the current target is a no-op 200 and writes no audit row', async () => {
    const s = await createSession();
    const before = Number((await db('audit_log').count({ c: '*' }).first())!.c);

    const res = await swap(s.id, CUST_B);
    expect(res.statusCode).toBe(200);
    expect((res.json() as SessionBody).id).toBe(s.id);

    const after = Number((await db('audit_log').count({ c: '*' }).first())!.c);
    expect(after).toBe(before);
    // routing is untouched
    expect(await getRedis().sismember(`phone:${h(CUST_B)}:sessions`, s.id)).toBe(1);
  });

  it('(g) swapping an expired session is rejected with 409', async () => {
    const s = await createSession();
    await getSessionManager().expireSession(s.id);

    const res = await swap(s.id, CUST_C);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/EXPIRED/);
  });

  it('(h) swapping onto a participant of another session on the same proxy returns 409', async () => {
    const s = await createSession(AGENT, CUST_B);
    const redis = getRedis();

    // A proxy may carry several sessions as long as no participant is shared.
    // Attach a sibling directly rather than coaxing the allocator into reusing
    // the number, so this exercises the overlap check and nothing else.
    const siblingId = '11111111-2222-4333-8444-555555555555';
    await redis.hset(`session:${siblingId}`, {
      id: siblingId,
      tenant_id: TEST_TENANT_ID,
      party_a_hash: h('+2348030000099'),
      party_b_hash: h(CUST_D),
      proxy_number: s.proxyNumber,
      state: 'ACTIVE',
    });
    await redis.sadd(`proxy:${s.proxyNumber}:sessions`, siblingId);

    // CUST_D is already the sibling's party B on this proxy.
    const res = await swap(s.id, CUST_D);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/conflicts with another active session/i);

    // A target that clashes with nobody still goes through on the same proxy.
    const ok = await swap(s.id, CUST_E);
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as SessionBody).proxyNumber).toBe(s.proxyNumber);
  });

  it('(i) the swap is audit-logged with hashes and no phone numbers', async () => {
    const s = await createSession();
    await swap(s.id, CUST_C);

    const rows = await db('audit_log').where({ action: 'session.target_swapped' });
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_id).toBe(s.id);
    expect(rows[0].actor_id).toBe(TEST_TENANT_ID);

    const details =
      typeof rows[0].details === 'string' ? JSON.parse(rows[0].details) : rows[0].details;
    expect(details.previousPartyBHash).toBe(h(CUST_B));
    expect(details.newPartyBHash).toBe(h(CUST_C));

    // No plaintext numbers anywhere in the row.
    const blob = JSON.stringify(rows[0]);
    for (const p of [CUST_B, CUST_C, AGENT]) expect(blob).not.toContain(p);
  });

  it('(j) sequential swaps each retarget routing, and all are audited', async () => {
    const s = await createSession();

    for (const next of [CUST_C, CUST_D, CUST_E]) {
      const res = await swap(s.id, next);
      expect(res.statusCode).toBe(200);

      const xml = await dial(AGENT, s.proxyNumber);
      expect(xml).toContain(next);

      const back = await dial(next, s.proxyNumber);
      expect(back).toContain(AGENT);
    }

    const rows = await db('audit_log').where({ action: 'session.target_swapped' });
    expect(rows).toHaveLength(3);

    // Only the final target routes; the intermediates were all unwired.
    const redis = getRedis();
    expect(await redis.sismember(`phone:${h(CUST_E)}:sessions`, s.id)).toBe(1);
    for (const stale of [CUST_B, CUST_C, CUST_D]) {
      expect(await redis.sismember(`phone:${h(stale)}:sessions`, s.id)).toBe(0);
    }
  });

  it('(k) call records capture the target in force at call time', async () => {
    const s = await createSession();
    await dial(AGENT, s.proxyNumber);
    await swap(s.id, CUST_C);
    await dial(AGENT, s.proxyNumber);

    // call_records are written fire-and-forget off the routing path.
    await new Promise((r) => setTimeout(r, 300));

    const rows = await db('call_records').where({ session_id: s.id }).orderBy('initiated_at');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].party_b_phone_hash).toBe(h(CUST_B));
    expect(rows[rows.length - 1].party_b_phone_hash).toBe(h(CUST_C));
  });

  it('(l) a bad phone is rejected, and an unknown session is a 404', async () => {
    const s = await createSession();

    const bad = await swap(s.id, 'not-a-number');
    expect(bad.statusCode).toBe(400);

    const missing = await swap('00000000-0000-4000-8000-000000000000', CUST_C);
    expect(missing.statusCode).toBe(404);
  });
});
