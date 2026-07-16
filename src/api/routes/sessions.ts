import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../config/database';
import { hashPhone } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { authenticate } from '../middleware/auth';
import { tierRateLimit } from '../middleware/tier-rate-limit';
import { getSessionManager } from '../../services/session-manager';
import { getTierEnforcer, type Tier } from '../../services/tier-enforcer';

const E164 = /^\+[1-9]\d{1,14}$/;

function rfc7807(slug: string, title: string, status: number, detail: string): Record<string, unknown> {
  return { type: `https://api.relavoi.com/errors/${slug}`, title, status, detail };
}

// ─── Schemas ────────────────────────────────────────────────────────────────────
const createBodySchema = z.object({
  agentPhone: z.string().regex(E164, 'agentPhone must be E.164'),
  customerPhone: z.string().regex(E164, 'customerPhone must be E.164'),
  metadata: z.record(z.unknown()).optional(),
  gracePeriodMinutes: z.number().int().nonnegative().optional(),
  maxDurationMinutes: z.number().int().positive().optional(),
  directionMode: z.enum(['BIDIRECTIONAL', 'A_TO_B_ONLY', 'B_TO_A_ONLY']).optional(),
  recordingEnabled: z.boolean().optional(),
  consentPrompt: z.enum(['DEFAULT', 'CUSTOM', 'NONE']).optional(),
});

const listQuerySchema = z.object({
  state: z.enum(['PENDING', 'ACTIVE', 'GRACE_PERIOD', 'EXPIRED', 'FAILED']).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  after: z.string().optional(),
});

const verifyQuerySchema = z.object({
  userPhone: z.string().regex(E164, 'userPhone must be E.164'),
  tenantId: z.string().optional(),
});

const patchBodySchema = z
  .object({
    metadata: z.record(z.unknown()).optional(),
    gracePeriodMinutes: z.number().int().nonnegative().optional(),
  })
  .strict();

const callListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  after: z.string().optional(),
});

// ─── DTOs ───────────────────────────────────────────────────────────────────────
// SessionManager returns camelCase Session objects, but direct DB rows are snake_case.
// This DTO accepts either shape — pull the first non-undefined value.
function sessionDto(s: any): Record<string, unknown> {
  const pick = (camel: string, snake: string) => s[camel] !== undefined ? s[camel] : s[snake];
  return {
    id: s.id,
    tenantId: pick('tenantId', 'tenant_id'),
    proxyNumber: pick('proxyNumber', 'proxy_number'),
    state: s.state,
    directionMode: pick('directionMode', 'direction_mode'),
    metadata: s.metadata ?? {},
    gracePeriodMinutes: pick('gracePeriodMin', 'grace_period_min'),
    maxDurationMinutes: pick('maxDurationMin', 'max_duration_min'),
    recordingEnabled: pick('recordingEnabled', 'recording_enabled'),
    consentPrompt: pick('consentPrompt', 'consent_prompt'),
    expiresAt: pick('expiresAt', 'expires_at'),
    createdAt: pick('createdAt', 'created_at'),
    activatedAt: pick('activatedAt', 'activated_at'),
    endedAt: pick('endedAt', 'ended_at'),
    expiredAt: pick('expiredAt', 'expired_at'),
    callCount: pick('callCount', 'call_count'),
    lastCallAt: pick('lastCallAt', 'last_call_at'),
  };
}

function callRecordDto(c: Record<string, unknown>): Record<string, unknown> {
  return {
    id: c.id,
    sessionId: c.session_id,
    status: c.status,
    direction: c.direction,
    durationSeconds: c.duration_seconds,
    cpaasCallId: c.cpaas_call_id,
    cpaasProvider: c.cpaas_provider,
    recordingUrl: c.recording_url,
    recordingConsentPlayed: c.recording_consent_played,
    initiatedAt: c.initiated_at,
    answeredAt: c.answered_at,
    endedAt: c.ended_at,
  };
}

function smsRecordDto(s: Record<string, unknown>): Record<string, unknown> {
  return {
    id: s.id,
    sessionId: s.session_id,
    direction: s.direction,
    status: s.status,
    cpaasMessageId: s.cpaas_message_id,
    cpaasProvider: s.cpaas_provider,
    sentAt: s.sent_at ?? s.created_at,
    deliveredAt: s.delivered_at,
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────────
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  // POST /sessions
  app.post('/sessions', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const tenant = req.tenant!;
    const body = parsed.data;

    // Tier session-count enforcement (throws on exceed)
    try {
      await getTierEnforcer().enforceSessionLimit(tenant.id, tenant.tier as Tier);
    } catch (err) {
      const te = err as { statusCode?: number; code?: string; message?: string };
      if (te.code === 'TIER_SESSION_LIMIT_EXCEEDED') {
        return reply
          .status(429)
          .type('application/problem+json')
          .send(rfc7807('tier-session-limit', 'Too Many Requests', 429, te.message ?? 'limit'));
      }
      logger.warn({ err, tenantId: tenant.id }, 'tier enforcement failed open');
    }

    try {
      const session = await getSessionManager().createSession({
        tenantId: tenant.id,
        agentPhone: body.agentPhone,
        customerPhone: body.customerPhone,
        metadata: body.metadata,
        gracePeriodMinutes: body.gracePeriodMinutes,
        maxDurationMinutes: body.maxDurationMinutes,
        directionMode: body.directionMode,
        recordingEnabled: body.recordingEnabled,
        consentPrompt: body.consentPrompt,
      });
      return reply.status(201).send(sessionDto(session));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'session creation failed';
      logger.error({ err, tenantId: tenant.id }, 'createSession failed');
      if (/pool|no proxy/i.test(msg)) {
        return reply
          .status(503)
          .type('application/problem+json')
          .send(rfc7807('pool-exhausted', 'Service Unavailable', 503, msg));
      }
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('session-create-failed', 'Bad Request', 400, msg));
    }
  });

  // GET /sessions — list
  app.get('/sessions', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const tenant = req.tenant!;
    const rows = await getSessionManager().getSessionsByTenant(tenant.id, {
      state: parsed.data.state,
      limit: parsed.data.limit,
      after: parsed.data.after,
    });
    const data = rows.map((s) => sessionDto(s));
    return reply.send({
      data,
      pagination: {
        count: data.length,
        after:
        rows.length === parsed.data.limit
          ? rows[rows.length - 1].createdAt.toISOString()
          : null,
      },
    });
  });

  // GET /sessions/verify — call verification banner
  app.get('/sessions/verify', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = verifyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const tenant = req.tenant!;
    const userPhoneHash = hashPhone(parsed.data.userPhone, tenant.id);
    const result = await getSessionManager().verifyCall(userPhoneHash, tenant.id);
    return reply.send(result);
  });

  // GET /sessions/:id
  app.get<{ Params: { id: string } }>(
    '/sessions/:id',
    { preHandler: [authenticate, tierRateLimit] },
    async (req, reply) => {
      const tenant = req.tenant!;
      const db = getDb();
      const s = await db('sessions')
        .where({ id: req.params.id, tenant_id: tenant.id })
        .first();
      if (!s) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Session not found.'));
      }
      return reply.send(sessionDto(s));
    },
  );

  // POST /sessions/:id/end
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/end',
    { preHandler: [authenticate, tierRateLimit] },
    async (req, reply) => {
      const tenant = req.tenant!;
      try {
        const result = await getSessionManager().endSession(req.params.id, tenant.id);
        if (!result) {
          return reply
            .status(404)
            .type('application/problem+json')
            .send(rfc7807('not-found', 'Not Found', 404, 'Session not found.'));
        }
        return reply.send(sessionDto(result));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'end failed';
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('session-end-failed', 'Bad Request', 400, msg));
      }
    },
  );

  // PATCH /sessions/:id — extend/update
  app.patch<{ Params: { id: string } }>(
    '/sessions/:id',
    { preHandler: [authenticate, tierRateLimit] },
    async (req, reply) => {
      const parsed = patchBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const tenant = req.tenant!;
      const db = getDb();
      const existing = await db('sessions')
        .where({ id: req.params.id, tenant_id: tenant.id })
        .first();
      if (!existing) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Session not found.'));
      }
      const update: Record<string, unknown> = {};
      if (parsed.data.metadata) {
        const merged = { ...(existing.metadata ?? {}), ...parsed.data.metadata };
        update.metadata = JSON.stringify(merged);
      }
      if (parsed.data.gracePeriodMinutes !== undefined) {
        update.grace_period_min = parsed.data.gracePeriodMinutes;
        // Extend expires_at if currently in grace period
        if (existing.state === 'GRACE_PERIOD') {
          const newExpiry = new Date(Date.now() + parsed.data.gracePeriodMinutes * 60_000);
          update.expires_at = newExpiry;
        }
      }
      if (Object.keys(update).length > 0) {
        await db('sessions').where({ id: req.params.id, tenant_id: tenant.id }).update(update);
      }
      const fresh = await db('sessions')
        .where({ id: req.params.id, tenant_id: tenant.id })
        .first();
      return reply.send(sessionDto(fresh));
    },
  );

  // GET /sessions/:id/calls — call records
  app.get<{ Params: { id: string } }>(
    '/sessions/:id/calls',
    { preHandler: [authenticate, tierRateLimit] },
    async (req, reply) => {
      const parsed = callListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const tenant = req.tenant!;
      const db = getDb();

      const session = await db('sessions')
        .where({ id: req.params.id, tenant_id: tenant.id })
        .first();
      if (!session) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Session not found.'));
      }

      const q = db('call_records')
        .where({ session_id: req.params.id })
        .orderBy('initiated_at', 'desc')
        .limit(parsed.data.limit + 1);
      if (parsed.data.after) q.andWhere('id', '<', parsed.data.after);

      const rows = await q;
      const hasMore = rows.length > parsed.data.limit;
      const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
      const data = page.map((r) => callRecordDto(r));
      return reply.send({
        data,
        pagination: {
          count: data.length,
          after: hasMore ? page[page.length - 1].id : null,
        },
      });
    },
  );

  // GET /sessions/:id/sms — SMS records
  app.get<{ Params: { id: string } }>(
    '/sessions/:id/sms',
    { preHandler: [authenticate, tierRateLimit] },
    async (req, reply) => {
      const parsed = callListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const tenant = req.tenant!;
      const db = getDb();
      const session = await db('sessions')
        .where({ id: req.params.id, tenant_id: tenant.id })
        .first();
      if (!session) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Session not found.'));
      }
      const q = db('sms_records')
        .where({ session_id: req.params.id })
        .orderBy('sent_at', 'desc')
        .limit(parsed.data.limit + 1);
      if (parsed.data.after) q.andWhere('sent_at', '<', new Date(parsed.data.after));

      const rows = await q;
      const hasMore = rows.length > parsed.data.limit;
      const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
      const data = page.map((r) => smsRecordDto(r));
      return reply.send({
        data,
        pagination: {
          count: data.length,
          after: hasMore ? new Date(page[page.length - 1].sent_at).toISOString() : null,
        },
      });
    },
  );
}
