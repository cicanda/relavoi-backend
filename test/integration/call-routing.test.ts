/**
 * Integration tests for the CPaaS voice webhook + Call Router path.
 *
 * Drives POST /v1/webhooks/cpaas/voice with realistic Africa's Talking
 * form-encoded payloads and verifies:
 *   - the XML response (Dial / Reject / Hangup / consent prompt)
 *   - DB side effects on call_records + sessions
 *   - Redis dedup behaviour across phases of one AT call
 *
 * Notes:
 *   - The webhook route wraps all handler errors and always returns HTTP 200
 *     with empty/error XML, so we rely on body content + DB state, not status
 *     codes, to detect rejection behaviour.
 *   - We use app.inject so no real port binding is required.
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
import { getSessionManager } from '../../src/services/session-manager';

// ─── helpers ─────────────────────────────────────────────────────────────────

async function postVoiceWebhook(
  app: FastifyInstance,
  fields: Record<string, string>,
): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> {
  const body = new URLSearchParams(fields).toString();
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/cpaas/voice',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: body,
  });
}

interface CreatedSession {
  id: string;
  proxyNumber: string;
  state: string;
}

interface CreateSessionOpts {
  agentPhone: string;
  customerPhone: string;
  recordingEnabled?: boolean;
  consentPrompt?: 'DEFAULT' | 'CUSTOM' | 'NONE';
  gracePeriodMinutes?: number;
  directionMode?: 'BIDIRECTIONAL' | 'A_TO_B_ONLY' | 'B_TO_A_ONLY';
  metadata?: Record<string, unknown>;
}

async function createSession(
  app: FastifyInstance,
  sdkToken: string,
  opts: CreateSessionOpts,
): Promise<CreatedSession> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { authorization: `Bearer ${sdkToken}` },
    payload: opts,
  });
  if (res.statusCode !== 201) {
    throw new Error(`createSession failed: ${res.statusCode} ${res.body}`);
  }
  return res.json() as CreatedSession;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── suite ──────────────────────────────────────────────────────────────────

describe('CPaaS voice webhook + call routing (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;
  let sdkToken: string;

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenant(db);
    await seedProxyNumbers(db, { count: 5, region: 'lagos' });
    app = await buildTestApp();
    sdkToken = await getSdkToken(app);
  });

  beforeEach(async () => {
    await resetSessionState(db, { region: 'lagos' });
  });

  afterAll(async () => {
    await app.close();
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  it('(a) Incoming call routes to correct party', async () => {
    const agent = '+2348011111111';
    const customer = '+2348022222222';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
    });

    const res = await postVoiceWebhook(app, {
      sessionId: 'AT_a1',
      callerNumber: agent,
      destinationNumber: session.proxyNumber,
      direction: 'Inbound',
      isActive: '1',
    });

    expect(res.statusCode).toBe(200);
    // content-type may include charset; just sniff for text/xml
    expect((res.headers['content-type'] ?? '').toString()).toContain('text/xml');
    expect(res.body).toContain('<Dial');
    expect(res.body).toContain(customer);
  });

  it('(b) Recording session plays consent prompt before dialing', async () => {
    const agent = '+2348011111112';
    const customer = '+2348022222223';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
      recordingEnabled: true,
      consentPrompt: 'DEFAULT',
    });

    const res = await postVoiceWebhook(app, {
      sessionId: 'AT_b1',
      callerNumber: agent,
      destinationNumber: session.proxyNumber,
      direction: 'Inbound',
      isActive: '1',
    });

    expect(res.statusCode).toBe(200);
    // Either a <Say> consent line OR a <Play> consent audio must precede the dial.
    const hasConsent = res.body.includes('<Say') || res.body.includes('<Play');
    expect(hasConsent).toBe(true);
    expect(res.body).toContain('<Dial');
  });

  it('(c) Customer callback reverse-routes to agent', async () => {
    const agent = '+2348011111113';
    const customer = '+2348022222224';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
    });

    const res = await postVoiceWebhook(app, {
      sessionId: 'AT_c1',
      callerNumber: customer,
      destinationNumber: session.proxyNumber,
      direction: 'Inbound',
      isActive: '1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Dial');
    expect(res.body).toContain(agent);
  });

  it('(d) Expired session yields a dead-line / hangup response', async () => {
    const agent = '+2348011111114';
    const customer = '+2348022222225';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
      gracePeriodMinutes: 0,
    });

    // End → GRACE_PERIOD with 0-minute grace; then force expire so the Redis
    // session hash is cleared and the router sees no_session.
    const sm = getSessionManager();
    await sm.endSession(session.id, TEST_TENANT_ID);
    await sm.expireSession(session.id);

    const res = await postVoiceWebhook(app, {
      sessionId: 'AT_d1',
      callerNumber: agent,
      destinationNumber: session.proxyNumber,
      direction: 'Inbound',
      isActive: '1',
    });

    expect(res.statusCode).toBe(200);
    const body = res.body;
    const isDeadLine =
      body.includes('no longer in service') ||
      body.includes('<Reject') ||
      body.includes('<Hangup');
    expect(isDeadLine).toBe(true);
    // Should not be a Dial to either real party.
    expect(body).not.toContain(agent);
    expect(body).not.toContain(customer);
  });

  it('(e) Identical webhook posts are deduplicated (same XML on retry)', async () => {
    const agent = '+2348011111115';
    const customer = '+2348022222226';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
    });

    const fields = {
      sessionId: 'AT_dedup_e1',
      callerNumber: agent,
      destinationNumber: session.proxyNumber,
      direction: 'Inbound',
      isActive: '1',
    };

    const first = await postVoiceWebhook(app, fields);
    const second = await postVoiceWebhook(app, fields);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
  });

  it('(f) call_records row is created asynchronously after incoming_call', async () => {
    const agent = '+2348011111116';
    const customer = '+2348022222227';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
    });

    const res = await postVoiceWebhook(app, {
      sessionId: 'AT_f1',
      callerNumber: agent,
      destinationNumber: session.proxyNumber,
      direction: 'Inbound',
      isActive: '1',
    });
    expect(res.statusCode).toBe(200);

    await sleep(500);

    const rows = await db('call_records').where({ session_id: session.id });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const statuses = rows.map((r) => r.status as string);
    const okStatus = statuses.some((s) => s === 'RINGING' || s === 'ANSWERED');
    expect(okStatus).toBe(true);
  });

  it('(g) Full call status lifecycle updates call_records and session counters', async () => {
    const agent = '+2348011111117';
    const customer = '+2348022222228';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
    });

    // Phase 1 — incoming call
    const incoming = await postVoiceWebhook(app, {
      sessionId: 'AT_lc',
      callerNumber: agent,
      destinationNumber: session.proxyNumber,
      direction: 'Inbound',
      isActive: '1',
    });
    expect(incoming.statusCode).toBe(200);
    expect(incoming.body).toContain('<Dial');

    // Phase 2 — completion (different eventType, different dedup key)
    const completed = await postVoiceWebhook(app, {
      sessionId: 'AT_lc',
      callerNumber: agent,
      destinationNumber: session.proxyNumber,
      direction: 'Inbound',
      isActive: '0',
      status: 'Success',
      durationInSeconds: '30',
      hangupCause: 'Normal',
    });
    expect(completed.statusCode).toBe(200);

    await sleep(500);

    const callRows = await db('call_records').where({ session_id: session.id });
    expect(callRows.length).toBeGreaterThanOrEqual(1);

    const sessionRow = await db('sessions').where({ id: session.id }).first();
    expect(sessionRow).toBeTruthy();
    const callCount = Number(sessionRow!.call_count ?? 0);
    const hasLastCall = sessionRow!.last_call_at != null;
    expect(callCount >= 1 || hasLastCall).toBe(true);
  });

  it('(h) Unknown caller against an existing proxy gets dead-line behaviour', async () => {
    const agent = '+2348011111118';
    const customer = '+2348022222229';
    const session = await createSession(app, sdkToken, {
      agentPhone: agent,
      customerPhone: customer,
    });

    const stranger = '+2348099999999';
    const res = await postVoiceWebhook(app, {
      sessionId: 'AT_h1',
      callerNumber: stranger,
      destinationNumber: session.proxyNumber,
      direction: 'Inbound',
      isActive: '1',
    });

    expect(res.statusCode).toBe(200);
    const body = res.body;
    const isRejected =
      body.includes('<Reject') ||
      body.includes('<Hangup') ||
      body.includes('no longer in service') ||
      body.includes('not authorized');
    expect(isRejected).toBe(true);
    // Must not bridge to either real party.
    expect(body).not.toContain(agent);
    expect(body).not.toContain(customer);
  });
});
