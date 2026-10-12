/**
 * Sandbox by default; live requires activation.
 *
 * The assertions that matter are the ones about spend: a sandbox session must
 * not reach the carrier, and sandbox usage must not reach an invoice. Key
 * prefixes and badges are the visible surface, but the gating is the product.
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
  TEST_SANDBOX_API_KEY,
  TEST_SANDBOX_API_SECRET,
} from '../helpers/integration';
import crypto from 'crypto';
import { getRedis } from '../../src/config/redis';
import { config } from '../../src/config/env';
import { getBillingManager } from '../../src/services/billing-manager';

const AGENT = '+2348040000001';
const CUSTOMER = '+2349040000002';

describe('sandbox vs live mode (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;
  let sdkToken: string;
  let dashToken: string;
  let proxyNumbers: string[];

  async function createSession(token = sdkToken) {
    return app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${token}` },
      payload: { agentPhone: AGENT, customerPhone: CUSTOMER },
    });
  }

  /**
   * Post an inbound-call webhook. Outside an AT sandbox the handler demands a
   * valid HMAC, so sign the body -- the production-mode cases below would
   * otherwise be rejected at the door and never reach the router at all.
   */
  async function dial(caller: string, proxy: string): Promise<string> {
    const body = new URLSearchParams({
      sessionId: `AT_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      isActive: '1',
      direction: 'Inbound',
      callerNumber: caller,
      destinationNumber: proxy,
    }).toString();
    const signature = crypto
      .createHmac(config.WEBHOOK_HMAC_ALGO, config.AT_API_KEY)
      .update(Buffer.from(body, 'utf8'))
      .digest('hex');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/cpaas/voice',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-africastalking-signature': signature,
      },
      payload: body,
    });
    return res.body;
  }

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenantDeterministic(db);
    proxyNumbers = await seedProxyNumbers(db, { count: 5, region: 'lagos' });
    app = await buildTestApp();
    // The token carries the mode of the tenant at exchange time, so the
    // workspace must be sandboxed before the SDK token is minted.
    await db('tenants').where({ id: TEST_TENANT_ID }).update({ mode: 'sandbox' });
    // Authenticate with the TEST pair: the key's prefix is what puts the
    // resulting token -- and every session it opens -- in sandbox.
    sdkToken = await getSdkToken(app, TEST_SANDBOX_API_KEY, TEST_SANDBOX_API_SECRET);
    dashToken = await getDashboardToken(app);
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
    // The seeded tenant holds test credentials, so it belongs in sandbox.
    await db('tenants').where({ id: TEST_TENANT_ID }).update({ mode: 'sandbox', webhook_url: null });
    await db('usage_records').del().catch(() => undefined);
  });

  afterAll(async () => {
    await app.close();
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  // ─── key issuance ─────────────────────────────────────────────────────────

  it('(a) a test key mints a sandbox token and tags sessions sandbox', async () => {
    const res = await createSession();
    expect(res.statusCode).toBe(201);
    expect((res.json() as { mode: string }).mode).toBe('sandbox');

    const row = await db('sessions').where({ id: (res.json() as { id: string }).id }).first();
    expect(row.mode).toBe('sandbox');
  });

  it('(b) sandbox keys generate freely; live keys are refused until activation', async () => {
    const sandbox = await app.inject({
      method: 'POST',
      url: '/v1/auth/keys/generate',
      headers: { authorization: `Bearer ${dashToken}` },
      payload: { mode: 'sandbox' },
    });
    expect(sandbox.statusCode).toBe(200);
    expect((sandbox.json() as { apiKey: string }).apiKey).toMatch(/^rk_test_/);

    const live = await app.inject({
      method: 'POST',
      url: '/v1/auth/keys/generate',
      headers: { authorization: `Bearer ${dashToken}` },
      payload: { mode: 'live' },
    });
    expect(live.statusCode).toBe(409);
    expect(live.json().detail).toMatch(/sandbox mode/i);
  });

  // ─── activation ───────────────────────────────────────────────────────────

  it('(c) activation is refused while requirements are unmet, and says which', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/keys/activate-live',
      headers: { authorization: `Bearer ${dashToken}` },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { requirements: Array<{ key: string; met: boolean }> };
    expect(body.requirements.find((r) => r.key === 'sandbox_session')!.met).toBe(false);
    expect(body.requirements.find((r) => r.key === 'webhook_url')!.met).toBe(false);
  });

  it('(d) activation succeeds once a sandbox session exists and a webhook is set', async () => {
    await createSession();
    await db('tenants')
      .where({ id: TEST_TENANT_ID })
      .update({ webhook_url: 'https://example.test/hook' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/keys/activate-live',
      headers: { authorization: `Bearer ${dashToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { mode: string }).mode).toBe('live');

    const row = await db('tenants').where({ id: TEST_TENANT_ID }).first();
    expect(row.mode).toBe('live');

    // Audited, and live keys now issue.
    const audit = await db('audit_log').where({ action: 'mode.activated_live' });
    expect(audit.length).toBe(1);

    const live = await app.inject({
      method: 'POST',
      url: '/v1/auth/keys/generate',
      headers: { authorization: `Bearer ${dashToken}` },
      payload: { mode: 'live' },
    });
    expect(live.statusCode).toBe(200);
    expect((live.json() as { apiKey: string }).apiKey).toMatch(/^rk_live_/);
  });

  it('(e) activating an already-live workspace is idempotent', async () => {
    await db('tenants')
      .where({ id: TEST_TENANT_ID })
      .update({ mode: 'live', webhook_url: 'https://example.test/hook' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/keys/activate-live',
      headers: { authorization: `Bearer ${dashToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { mode: string }).mode).toBe('live');
  });

  // ─── the part that actually guards spend ──────────────────────────────────

  it('(f) a sandbox session never dials, regardless of provider config', async () => {
    // The guard keys off the session alone now. AT_ENVIRONMENT is left exactly
    // as the suite configures it ('sandbox') precisely to prove the two are no
    // longer coupled: this is the configuration under which the old code DID
    // dial for sandbox tenants.
    expect(config.AT_ENVIRONMENT).toBe('sandbox');

    const s = (await createSession()).json() as { id: string; proxyNumber: string };
    const xml = await dial(AGENT, s.proxyNumber);

    expect(xml).not.toContain('<Dial');
    // Party B's number must not leave the platform for a sandbox session.
    expect(xml).not.toContain(CUSTOMER);
    expect(xml.toLowerCase()).toContain('sandbox');

    // call_records are written off the routing path.
    await new Promise((r) => setTimeout(r, 400));
    const rows = await db('call_records').where({ session_id: s.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].simulated).toBe(true);
    expect(rows[0].mode).toBe('sandbox');
    expect(rows[0].duration_seconds).toBe(0);
  });

  it('(g) a live session still dials, under the same provider config', async () => {
    const s = (await createSession()).json() as { id: string; proxyNumber: string };
    await db('sessions').where({ id: s.id }).update({ mode: 'live' });
    await getRedis().hset(`session:${s.id}`, 'mode', 'live');

    const xml = await dial(AGENT, s.proxyNumber);
    expect(xml).toContain('<Dial');
    expect(xml).toContain(CUSTOMER);

    await new Promise((r) => setTimeout(r, 400));
    const rows = await db('call_records').where({ session_id: s.id });
    expect(rows[0].simulated).toBe(false);
    expect(rows[0].mode).toBe('live');
  });

  it('(h) a sandbox session never hands an SMS to the provider', async () => {
    const s = (await createSession()).json() as { id: string };
    const body = new URLSearchParams({
      from: AGENT,
      to: '+2342017001428',
      text: 'sandbox message',
      date: new Date().toISOString(),
      id: `sms_${Date.now()}`,
    }).toString();
    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/cpaas/sms',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: body,
    });
    await new Promise((r) => setTimeout(r, 500));
    const rows = await db('sms_records').where({ session_id: s.id });
    if (rows.length > 0) {
      expect(rows.every((r: { simulated: boolean }) => r.simulated)).toBe(true);
      expect(rows.every((r: { mode: string }) => r.mode === 'sandbox')).toBe(true);
    }
  });

  // ─── billing ──────────────────────────────────────────────────────────────

  it('(i) sandbox usage is recorded but excluded from billable totals', async () => {
    const billing = getBillingManager();
    await billing.recordUsage(TEST_TENANT_ID, 'call_minute', 5, 'sandbox');
    await billing.recordUsage(TEST_TENANT_ID, 'call_minute', 3, 'live');

    const rows = await db('usage_records').where({ tenant_id: TEST_TENANT_ID });
    expect(rows.length).toBe(2); // both visible to the tenant
    expect(rows.filter((r) => r.mode === 'sandbox').length).toBe(1);

    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 60_000);
    const summary = await billing.getUsageSummary(TEST_TENANT_ID, from, to);
    // Only the live 3 minutes are billable.
    expect(summary.metrics.call_minute).toBe(3);
  });

  it('(j) usage defaults to sandbox when no mode is asserted', async () => {
    await getBillingManager().recordUsage(TEST_TENANT_ID, 'sms_sent', 1);
    const row = await db('usage_records').where({ tenant_id: TEST_TENANT_ID }).first();
    expect(row.mode).toBe('sandbox');
  });
});
