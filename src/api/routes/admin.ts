import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { getDb } from '../../config/database';
import { getRedis } from '../../config/redis';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import { adminAuthenticate, requireRole } from '../middleware/admin-auth';
import { getNumberPool } from '../../services/number-pool';
import { getAuditLogger } from '../../services/audit-logger';
import { getBillingManager } from '../../services/billing-manager';
import { getCircuitBreaker } from '../../services/circuit-breaker';

const BCRYPT_COST = 10;

function rfc7807(slug: string, title: string, status: number, detail: string): Record<string, unknown> {
  return { type: `https://api.relavoi.com/errors/${slug}`, title, status, detail };
}

// ─── Schemas ────────────────────────────────────────────────────────────────────
const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const tenantListQuery = z.object({
  q: z.string().optional(),
  tier: z.enum(['STARTER', 'GROWTH', 'ENTERPRISE']).optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  after: z.string().optional(),
});

const tierPatchSchema = z.object({
  tier: z.enum(['STARTER', 'GROWTH', 'ENTERPRISE']),
});

const statusPatchSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELLED']),
});

const sessionsListQuery = z.object({
  tenantId: z.string().optional(),
  state: z.enum(['PENDING', 'ACTIVE', 'GRACE_PERIOD', 'EXPIRED', 'FAILED']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  after: z.string().optional(),
});

const dlqRetrySchema = z.object({
  ids: z.array(z.string()).optional(),
});

const OPERATOR_ROLES = ['ROOT', 'SRE', 'SUPPORT', 'VIEWER'] as const;

const operatorCreateSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(OPERATOR_ROLES),
  password: z.string().min(12).max(128),
});

const operatorUpdateSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    role: z.enum(OPERATOR_ROLES).optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(12).max(128).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

const dlqListQuery = z.object({
  status: z.enum(['PENDING', 'RETRYING', 'RESOLVED', 'ABANDONED']).optional(),
  provider: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  after: z.string().optional(),
});

const pricingPatchSchema = z
  .object({
    unitPrice: z.number().nonnegative().optional(),
    includedQuantity: z.number().nonnegative().optional(),
    overagePrice: z.number().nonnegative().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

const cpaasProviderParams = z.object({
  provider: z.enum(['africastalking', 'twilio']),
});

const auditQuery = z.object({
  actorType: z.string().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  after: z.string().optional(),
});

// E.164: + then 7-15 digits, first digit non-zero.
const e164Re = /^\+[1-9]\d{6,14}$/;

const quarantineBodySchema = z.object({
  number: z.string().regex(e164Re, 'number must be E.164 (e.g. +2348012345678)'),
  reason: z.string().min(3).max(500),
});

const releaseBodySchema = z.object({
  number: z.string().regex(e164Re, 'number must be E.164 (e.g. +2348012345678)'),
});

const operatorIdParamsSchema = z.object({
  id: z.string().uuid(),
});

// ─── DTOs ───────────────────────────────────────────────────────────────────────
function tenantSummaryDto(t: Record<string, unknown>): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    tier: t.tier,
    status: t.status ?? 'ACTIVE',
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

function operatorDto(o: Record<string, unknown>): Record<string, unknown> {
  return {
    id: o.id,
    email: o.email,
    name: o.name,
    role: o.role,
    isActive: o.is_active ?? true,
    createdAt: o.created_at,
    lastLoginAt: o.last_login_at ?? null,
  };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pricingRowDto(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    tier: r.tier,
    metric: r.metric,
    unitPrice: num(r.unit_price),
    includedQuantity: num(r.included_quantity),
    overagePrice: num(r.overage_price),
    currency: r.currency,
    effectiveFrom: r.effective_from,
    effectiveUntil: r.effective_until,
  };
}

function dlqEntryDto(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    eventId: r.event_id,
    provider: r.provider,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload ?? {}),
    errorMessage: r.error_message ?? null,
    retryCount: r.retry_count ?? 0,
    maxRetries: r.max_retries ?? 0,
    status: r.status,
    firstReceivedAt: r.first_received_at,
    lastRetryAt: r.last_retry_at ?? null,
    resolvedAt: r.resolved_at ?? null,
  };
}

function proxyNumberDto(r: Record<string, unknown>): Record<string, unknown> {
  return {
    number: r.number,
    region: r.region ?? null,
    provider: r.provider,
    status: r.status,
    lastUsedAt: r.last_used_at ?? null,
    cooldownUntil: r.cooldown_until ?? null,
    healthCheckAt: r.health_check_at ?? null,
    provisionedAt: r.provisioned_at ?? null,
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────────
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /admin/auth/login — PUBLIC (no adminAuthenticate) ──────────────────
  app.post('/admin/auth/login', async (req, reply) => {
    const parsed = adminLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const db = getDb();
    const op = await db('operators').where({ email: parsed.data.email.toLowerCase() }).first();
    if (!op) {
      return reply
        .status(401)
        .type('application/problem+json')
        .send(rfc7807('unauthorized', 'Unauthorized', 401, 'Invalid credentials.'));
    }
    const ok = await bcrypt.compare(parsed.data.password, op.password_hash);
    if (!ok) {
      return reply
        .status(401)
        .type('application/problem+json')
        .send(rfc7807('unauthorized', 'Unauthorized', 401, 'Invalid credentials.'));
    }
    if (op.is_active === false) {
      // Backend gating for the soft-deactivation done by DELETE /admin/operators/:id.
      // A deactivated operator must not be able to mint a fresh JWT.
      return reply
        .status(401)
        .type('application/problem+json')
        .send(rfc7807('unauthorized', 'Unauthorized', 401, 'Account is deactivated.'));
    }
    await db('operators')
      .where({ id: op.id })
      .update({ last_login_at: new Date() })
      .catch(() => undefined);

    const accessToken = app.jwt.sign(
      { type: 'operator', operatorId: op.id, role: op.role },
      { expiresIn: config.JWT_EXPIRY },
    );

    return reply.send({
      accessToken,
      operator: { id: op.id, email: op.email, name: op.name, role: op.role },
    });
  });

  // All routes BELOW require adminAuthenticate
  // ─── GET /admin/tenants ───────────────────────────────────────────────────────
  app.get('/admin/tenants', { preHandler: [adminAuthenticate] }, async (req, reply) => {
    const parsed = tenantListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const db = getDb();
    const q = db('tenants').select('*').orderBy('created_at', 'desc').limit(parsed.data.limit + 1);
    if (parsed.data.q) q.andWhere('name', 'ilike', `%${parsed.data.q}%`);
    if (parsed.data.tier) q.andWhere('tier', parsed.data.tier);
    if (parsed.data.status) q.andWhere('status', parsed.data.status);
    if (parsed.data.after) q.andWhere('id', '<', parsed.data.after);

    const rows = await q;
    const hasMore = rows.length > parsed.data.limit;
    const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    return reply.send({
      data: page.map(tenantSummaryDto),
      pagination: {
        count: page.length,
        after: hasMore ? page[page.length - 1].id : null,
      },
    });
  });

  // ─── GET /admin/tenants/:id ───────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/admin/tenants/:id',
    { preHandler: [adminAuthenticate] },
    async (req, reply) => {
      const db = getDb();
      const t = await db('tenants').where({ id: req.params.id }).first();
      if (!t) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Tenant not found.'));
      }
      // Usage summary last 30d
      const periodEnd = new Date();
      const periodStart = new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
      let usage: unknown = null;
      try {
        usage = await getBillingManager().getUsageSummary(t.id, new Date(periodStart), new Date(periodEnd));
      } catch (err) {
        logger.warn({ err, tenantId: t.id }, 'admin tenant detail: usage fetch failed');
      }
      const userCount = await db('tenant_users')
        .where({ tenant_id: t.id })
        .count<{ count: string }[]>('* as count')
        .first()
        .catch(() => ({ count: '0' }));
      return reply.send({
        ...tenantSummaryDto(t),
        webhookUrl: t.webhook_url,
        recordingEnabled: t.recording_enabled,
        userCount: Number(userCount?.count ?? 0),
        usageLast30d: usage,
      });
    },
  );

  // ─── PATCH /admin/tenants/:id/tier (ROOT) ─────────────────────────────────────
  app.patch<{ Params: { id: string } }>(
    '/admin/tenants/:id/tier',
    { preHandler: [adminAuthenticate, requireRole('ROOT')] },
    async (req, reply) => {
      const parsed = tierPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const db = getDb();
      const existing = await db('tenants').where({ id: req.params.id }).first();
      if (!existing) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Tenant not found.'));
      }
      await db('tenants')
        .where({ id: req.params.id })
        .update({ tier: parsed.data.tier, updated_at: new Date() });

      await getAuditLogger()
        .log({
          actorType: 'operator',
          actorId: req.operator!.id,
          action: 'tenant.tier.update',
          resourceType: 'tenant',
          resourceId: req.params.id,
          metadata: { from: existing.tier, to: parsed.data.tier },
        })
        .catch((err) => logger.warn({ err }, 'audit log failed'));

      return reply.send({ id: req.params.id, tier: parsed.data.tier });
    },
  );

  // ─── PATCH /admin/tenants/:id/status (SRE|ROOT) ───────────────────────────────
  app.patch<{ Params: { id: string } }>(
    '/admin/tenants/:id/status',
    { preHandler: [adminAuthenticate, requireRole('SRE', 'ROOT')] },
    async (req, reply) => {
      const parsed = statusPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const db = getDb();
      const existing = await db('tenants').where({ id: req.params.id }).first();
      if (!existing) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Tenant not found.'));
      }
      await db('tenants')
        .where({ id: req.params.id })
        .update({ status: parsed.data.status, updated_at: new Date() });

      await getAuditLogger()
        .log({
          actorType: 'operator',
          actorId: req.operator!.id,
          action: 'tenant.status.update',
          resourceType: 'tenant',
          resourceId: req.params.id,
          metadata: { from: existing.status ?? 'ACTIVE', to: parsed.data.status },
        })
        .catch((err) => logger.warn({ err }, 'audit log failed'));

      return reply.send({ id: req.params.id, status: parsed.data.status });
    },
  );

  // ─── GET /admin/sessions (cross-tenant) ───────────────────────────────────────
  app.get('/admin/sessions', { preHandler: [adminAuthenticate] }, async (req, reply) => {
    const parsed = sessionsListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const db = getDb();
    const q = db('sessions')
      .select(
        'id',
        'tenant_id',
        'proxy_number',
        'state',
        'direction_mode',
        'created_at',
        'expires_at',
        'ended_at',
      )
      .orderBy('created_at', 'desc')
      .limit(parsed.data.limit + 1);
    if (parsed.data.tenantId) q.andWhere('tenant_id', parsed.data.tenantId);
    if (parsed.data.state) q.andWhere('state', parsed.data.state);
    if (parsed.data.after) q.andWhere('id', '<', parsed.data.after);

    const rows = await q;
    const hasMore = rows.length > parsed.data.limit;
    const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    return reply.send({
      data: page.map((s) => ({
        id: s.id,
        tenantId: s.tenant_id,
        proxyNumber: s.proxy_number,
        state: s.state,
        directionMode: s.direction_mode,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        endedAt: s.ended_at,
      })),
      pagination: {
        count: page.length,
        after: hasMore ? page[page.length - 1].id : null,
      },
    });
  });

  // ─── GET /admin/fleet ─────────────────────────────────────────────────────────
  // Returns per-region pool aggregates AND the individual numbers so the console
  // can render both the utilization summary and the per-number management table.
  app.get('/admin/fleet', { preHandler: [adminAuthenticate] }, async (_req, reply) => {
    const db = getDb();
    const pools = await getNumberPool().getPoolStatus();

    const numberRows = await db('proxy_numbers')
      .select(
        'number',
        'region',
        'provider',
        'status',
        'last_used_at',
        'cooldown_until',
        'health_check_at',
        'provisioned_at',
      )
      .orderBy('number');

    const blank = () => ({ total: 0, available: 0, inUse: 0, cooldown: 0, quarantined: 0 });
    const totals = blank();
    const regionMap = new Map<string, ReturnType<typeof blank> & { region: string }>();

    const bump = (acc: ReturnType<typeof blank>, status: string): void => {
      acc.total += 1;
      if (status === 'AVAILABLE') acc.available += 1;
      else if (status === 'IN_USE') acc.inUse += 1;
      else if (status === 'COOLDOWN') acc.cooldown += 1;
      else if (status === 'QUARANTINED') acc.quarantined += 1;
    };

    for (const r of numberRows) {
      const status = r.status as string;
      bump(totals, status);
      const region = (r.region as string | null) ?? 'unknown';
      let ra = regionMap.get(region);
      if (!ra) {
        ra = { region, ...blank() };
        regionMap.set(region, ra);
      }
      bump(ra, status);
    }

    return reply.send({
      pools,
      totals,
      byRegion: Array.from(regionMap.values()).sort((a, b) => a.region.localeCompare(b.region)),
      numbers: numberRows.map(proxyNumberDto),
    });
  });

  // ─── GET /admin/system/health ─────────────────────────────────────────────────
  app.get('/admin/system/health', { preHandler: [adminAuthenticate] }, async (_req, reply) => {
    const db = getDb();
    const redis = getRedis();

    const result: Record<string, unknown> = {
      postgres: 'down',
      redis: 'down',
      dlqDepth: 0,
      circuitBreakers: [] as Array<{ provider: string; state: string }>,
      timestamp: new Date().toISOString(),
    };

    try {
      await db.raw('SELECT 1');
      result.postgres = 'ok';
    } catch (err) {
      logger.warn({ err }, 'admin/system/health: postgres down');
    }

    try {
      if ((await redis.ping()) === 'PONG') result.redis = 'ok';
    } catch (err) {
      logger.warn({ err }, 'admin/system/health: redis down');
    }

    try {
      const depth = await db('webhook_dlq').where({ status: 'PENDING' }).count<{ count: string }[]>('* as count').first();
      result.dlqDepth = Number(depth?.count ?? 0);
    } catch {
      result.dlqDepth = 0;
    }

    const cbs: Array<{ provider: string; state: string; openedAt: string | null }> = [];
    for (const name of ['africastalking', 'twilio']) {
      try {
        const hash = await redis.hgetall(`cb:${name}`);
        if (hash && Object.keys(hash).length > 0) {
          cbs.push({
            provider: name,
            state: hash.state ?? 'UNKNOWN',
            openedAt: hash.opened_at ?? null,
          });
        }
      } catch {
        // skip
      }
    }
    result.circuitBreakers = cbs;
    return reply.send(result);
  });

  // ─── POST /admin/dlq/retry (SRE|ROOT) ─────────────────────────────────────────
  app.post(
    '/admin/dlq/retry',
    { preHandler: [adminAuthenticate, requireRole('SRE', 'ROOT')] },
    async (req, reply) => {
      const parsed = dlqRetrySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const db = getDb();
      const q = db('webhook_dlq')
        .where({ status: 'PENDING' })
        .update({ status: 'RETRYING', last_retry_at: new Date() });
      if (parsed.data.ids && parsed.data.ids.length > 0) {
        q.whereIn('id', parsed.data.ids);
      }
      const count = await q;
      await getAuditLogger()
        .log({
          actorType: 'operator',
          actorId: req.operator!.id,
          action: 'dlq.retry',
          resourceType: 'webhook_dlq',
          resourceId: parsed.data.ids?.join(',') ?? 'all',
          metadata: { count },
        })
        .catch((err) => logger.warn({ err }, 'audit log failed'));
      return reply.send({ retrying: count });
    },
  );

  // ─── POST /admin/pool/quarantine (ROOT|SRE) ───────────────────────────────────
  app.post(
    '/admin/pool/quarantine',
    { preHandler: [adminAuthenticate, requireRole('ROOT', 'SRE')] },
    async (req, reply) => {
      const parsed = quarantineBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const { number, reason } = parsed.data;
      const db = getDb();
      const row = await db('proxy_numbers').where({ number }).first();
      if (!row) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Number not found in pool'));
      }
      if (row.status === 'QUARANTINED') {
        return reply
          .status(409)
          .type('application/problem+json')
          .send(rfc7807('conflict', 'Conflict', 409, 'Number is already quarantined'));
      }
      const previousStatus = row.status as string;
      const region = (row.region as string | null) ?? 'lagos';
      const provider = (row.provider as string | null) ?? 'AFRICASTALKING';

      await db('proxy_numbers').where({ number }).update({ status: 'QUARANTINED' });

      // Yank from the Redis available pool so it can't be allocated again. Active
      // sessions on this number keep their session:{id} hash and the proxy:{n}:sessions
      // mapping untouched — they finish naturally, but no new session will pick it.
      const redis = getRedis();
      try {
        await Promise.all([
          redis.srem(`pool:${region}:available`, number),
          redis.srem(`pool:${region}:${provider}:available`, number),
          redis.srem(`pool:${region}:in_use`, number),
        ]);
      } catch (err) {
        logger.warn({ err, number }, 'quarantine: redis pool cleanup failed (non-fatal)');
      }

      await getAuditLogger()
        .log({
          actorType: 'operator',
          actorId: req.operator!.id,
          action: 'pool.number_quarantined',
          resourceType: 'proxy_number',
          resourceId: number,
          metadata: { reason, previousStatus },
        })
        .catch((err) => logger.warn({ err }, 'audit log failed'));

      return reply.send({ success: true, number, previousStatus, reason });
    },
  );

  // ─── POST /admin/pool/release (ROOT|SRE) ──────────────────────────────────────
  app.post(
    '/admin/pool/release',
    { preHandler: [adminAuthenticate, requireRole('ROOT', 'SRE')] },
    async (req, reply) => {
      const parsed = releaseBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const { number } = parsed.data;
      const db = getDb();
      const row = await db('proxy_numbers').where({ number }).first();
      if (!row) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Number not found in pool'));
      }
      if (row.status !== 'QUARANTINED') {
        return reply
          .status(409)
          .type('application/problem+json')
          .send(
            rfc7807(
              'conflict',
              'Conflict',
              409,
              `Only quarantined numbers can be released. Current status: ${row.status}`,
            ),
          );
      }
      const region = (row.region as string | null) ?? 'lagos';
      const provider = (row.provider as string | null) ?? 'AFRICASTALKING';

      await db('proxy_numbers')
        .where({ number })
        .update({ status: 'AVAILABLE', cooldown_until: null });

      const redis = getRedis();
      try {
        await Promise.all([
          redis.sadd(`pool:${region}:available`, number),
          redis.sadd(`pool:${region}:${provider}:available`, number),
        ]);
      } catch (err) {
        logger.warn({ err, number }, 'release: redis pool re-add failed (non-fatal)');
      }

      await getAuditLogger()
        .log({
          actorType: 'operator',
          actorId: req.operator!.id,
          action: 'pool.number_released',
          resourceType: 'proxy_number',
          resourceId: number,
        })
        .catch((err) => logger.warn({ err }, 'audit log failed'));

      return reply.send({ success: true, number });
    },
  );

  // ─── GET /admin/operators (ROOT) ──────────────────────────────────────────────
  app.get(
    '/admin/operators',
    { preHandler: [adminAuthenticate, requireRole('ROOT')] },
    async (_req, reply) => {
      const db = getDb();
      const rows = await db('operators')
        .select('id', 'email', 'name', 'role', 'is_active', 'created_at', 'last_login_at')
        .orderBy('created_at', 'desc');
      return reply.send({ data: rows.map(operatorDto) });
    },
  );

  // ─── POST /admin/operators (ROOT) ─────────────────────────────────────────────
  app.post(
    '/admin/operators',
    { preHandler: [adminAuthenticate, requireRole('ROOT')] },
    async (req, reply) => {
      const parsed = operatorCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const db = getDb();
      const existing = await db('operators').where({ email: parsed.data.email.toLowerCase() }).first();
      if (existing) {
        return reply
          .status(409)
          .type('application/problem+json')
          .send(rfc7807('conflict', 'Conflict', 409, 'Operator email already exists.'));
      }
      const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);
      const [created] = await db('operators')
        .insert({
          email: parsed.data.email.toLowerCase(),
          name: parsed.data.name,
          role: parsed.data.role,
          password_hash: passwordHash,
          is_active: true,
        })
        .returning(['id', 'email', 'name', 'role', 'is_active', 'created_at', 'last_login_at']);

      await getAuditLogger()
        .log({
          actorType: 'operator',
          actorId: req.operator!.id,
          action: 'operator.create',
          resourceType: 'operator',
          resourceId: created.id,
          metadata: { email: parsed.data.email, role: parsed.data.role },
        })
        .catch((err) => logger.warn({ err }, 'audit log failed'));

      return reply.status(201).send(operatorDto(created));
    },
  );

  // ─── DELETE /admin/operators/:id (ROOT) — soft-deactivate ─────────────────────
  app.delete(
    '/admin/operators/:id',
    { preHandler: [adminAuthenticate, requireRole('ROOT')] },
    async (req, reply) => {
      const params = operatorIdParamsSchema.safeParse(req.params);
      if (!params.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, params.error.message));
      }
      const { id } = params.data;

      // Self-protection: a ROOT operator can't lock themselves out of the console.
      if (id === req.operator!.id) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('self-deactivation', 'Bad Request', 400, 'Cannot deactivate your own account'));
      }

      const db = getDb();
      const op = await db('operators').where({ id }).first();
      if (!op) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Operator not found'));
      }
      if (op.is_active === false) {
        return reply
          .status(409)
          .type('application/problem+json')
          .send(rfc7807('conflict', 'Conflict', 409, 'Operator is already deactivated'));
      }

      await db('operators').where({ id }).update({ is_active: false, updated_at: new Date() });

      await getAuditLogger()
        .log({
          actorType: 'operator',
          actorId: req.operator!.id,
          action: 'operator.deactivated',
          resourceType: 'operator',
          resourceId: id,
          metadata: { name: op.name, email: op.email },
        })
        .catch((err) => logger.warn({ err }, 'audit log failed'));

      return reply.send({ success: true, id });
    },
  );

  // ─── GET /admin/audit ─────────────────────────────────────────────────────────
  app.get('/admin/audit', { preHandler: [adminAuthenticate] }, async (req, reply) => {
    const parsed = auditQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const db = getDb();
    const q = db('audit_log').select('*').orderBy('created_at', 'desc').limit(parsed.data.limit + 1);
    if (parsed.data.actorType) q.andWhere('actor_type', parsed.data.actorType);
    if (parsed.data.action) q.andWhere('action', parsed.data.action);
    if (parsed.data.resourceType) q.andWhere('resource_type', parsed.data.resourceType);
    if (parsed.data.after) q.andWhere('id', '<', parsed.data.after);

    try {
      const rows = await q;
      const hasMore = rows.length > parsed.data.limit;
      const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
      return reply.send({
        data: page.map((r) => ({
          id: r.id,
          actorType: r.actor_type,
          actorId: r.actor_id,
          action: r.action,
          resourceType: r.resource_type,
          resourceId: r.resource_id,
          metadata: r.details,
          createdAt: r.created_at,
        })),
        pagination: {
          count: page.length,
          after: hasMore ? page[page.length - 1].id : null,
        },
      });
    } catch (err) {
      logger.warn({ err }, 'audit_log query failed');
      return reply.send({ data: [], pagination: { count: 0, after: null } });
    }
  });

  // ─── GET /admin/pricing ───────────────────────────────────────────────────────
  app.get('/admin/pricing', { preHandler: [adminAuthenticate] }, async (_req, reply) => {
    const db = getDb();
    try {
      const rows = await db('tier_pricing').select('*').orderBy('tier');
      return reply.send({ tiers: rows.map(pricingRowDto) });
    } catch {
      return reply.send({ tiers: [] });
    }
  });

  // ─── PATCH /admin/pricing/:id (ROOT) ──────────────────────────────────────────
  app.patch<{ Params: { id: string } }>(
    '/admin/pricing/:id',
    { preHandler: [adminAuthenticate, requireRole('ROOT')] },
    async (req, reply) => {
      const parsed = pricingPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const db = getDb();
      const existing = await db('tier_pricing').where({ id: req.params.id }).first();
      if (!existing) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Pricing row not found.'));
      }
      const update: Record<string, unknown> = {};
      if (parsed.data.unitPrice !== undefined) update.unit_price = parsed.data.unitPrice;
      if (parsed.data.includedQuantity !== undefined)
        update.included_quantity = parsed.data.includedQuantity;
      if (parsed.data.overagePrice !== undefined) update.overage_price = parsed.data.overagePrice;
      await db('tier_pricing').where({ id: req.params.id }).update(update);

      await getAuditLogger()
        .log({
          actorType: 'operator',
          actorId: req.operator!.id,
          action: 'pricing.update',
          resourceType: 'tier_pricing',
          resourceId: req.params.id,
          metadata: parsed.data,
        })
        .catch((err) => logger.warn({ err }, 'audit log failed'));

      const row = await db('tier_pricing').where({ id: req.params.id }).first();
      return reply.send(pricingRowDto(row));
    },
  );

  // ─── GET /admin/dlq ───────────────────────────────────────────────────────────
  app.get('/admin/dlq', { preHandler: [adminAuthenticate] }, async (req, reply) => {
    const parsed = dlqListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const db = getDb();
    try {
      const q = db('webhook_dlq')
        .select('*')
        .orderBy('first_received_at', 'desc')
        .limit(parsed.data.limit + 1);
      if (parsed.data.status) q.andWhere('status', parsed.data.status);
      if (parsed.data.provider) q.andWhere('provider', parsed.data.provider);
      if (parsed.data.after) q.andWhere('id', '<', parsed.data.after);
      const rows = await q;
      const hasMore = rows.length > parsed.data.limit;
      const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;

      const counts = await db('webhook_dlq')
        .select('status')
        .count<{ status: string; count: string }[]>('* as count')
        .groupBy('status');
      const summary = { pending: 0, retrying: 0, resolved: 0, abandoned: 0 };
      for (const c of counts) {
        const n = Number(c.count);
        if (c.status === 'PENDING') summary.pending = n;
        else if (c.status === 'RETRYING') summary.retrying = n;
        else if (c.status === 'RESOLVED') summary.resolved = n;
        else if (c.status === 'ABANDONED') summary.abandoned = n;
      }

      return reply.send({
        data: page.map(dlqEntryDto),
        pagination: {
          count: page.length,
          after: hasMore ? page[page.length - 1].id : null,
        },
        summary,
      });
    } catch (err) {
      logger.warn({ err }, 'admin/dlq query failed');
      return reply.send({
        data: [],
        pagination: { count: 0, after: null },
        summary: { pending: 0, retrying: 0, resolved: 0, abandoned: 0 },
      });
    }
  });

  // ─── POST /admin/dlq/:id/abandon (ROOT|SRE) ───────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/admin/dlq/:id/abandon',
    { preHandler: [adminAuthenticate, requireRole('ROOT', 'SRE')] },
    async (req, reply) => {
      const db = getDb();
      const row = await db('webhook_dlq').where({ id: req.params.id }).first();
      if (!row) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'DLQ entry not found.'));
      }
      await db('webhook_dlq')
        .where({ id: req.params.id })
        .update({ status: 'ABANDONED', resolved_at: new Date() });

      await getAuditLogger()
        .log({
          actorType: 'operator',
          actorId: req.operator!.id,
          action: 'dlq.abandon',
          resourceType: 'webhook_dlq',
          resourceId: req.params.id,
        })
        .catch((err) => logger.warn({ err }, 'audit log failed'));

      return reply.send({ success: true, id: req.params.id });
    },
  );

  // ─── PATCH /admin/operators/:id (ROOT) ────────────────────────────────────────
  app.patch<{ Params: { id: string } }>(
    '/admin/operators/:id',
    { preHandler: [adminAuthenticate, requireRole('ROOT')] },
    async (req, reply) => {
      const params = operatorIdParamsSchema.safeParse(req.params);
      if (!params.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, params.error.message));
      }
      const parsed = operatorUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const db = getDb();
      const op = await db('operators').where({ id: params.data.id }).first();
      if (!op) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Operator not found'));
      }
      // Self-protection: don't let a ROOT lock or demote themselves out of access.
      if (params.data.id === req.operator!.id) {
        if (parsed.data.isActive === false || (parsed.data.role && parsed.data.role !== 'ROOT')) {
          return reply
            .status(400)
            .type('application/problem+json')
            .send(rfc7807('self-lockout', 'Bad Request', 400, 'Cannot demote or deactivate your own account.'));
        }
      }

      const update: Record<string, unknown> = { updated_at: new Date() };
      if (parsed.data.name !== undefined) update.name = parsed.data.name;
      if (parsed.data.role !== undefined) update.role = parsed.data.role;
      if (parsed.data.isActive !== undefined) update.is_active = parsed.data.isActive;
      if (parsed.data.password !== undefined) {
        update.password_hash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);
      }
      await db('operators').where({ id: params.data.id }).update(update);

      await getAuditLogger()
        .log({
          actorType: 'operator',
          actorId: req.operator!.id,
          action: 'operator.update',
          resourceType: 'operator',
          resourceId: params.data.id,
          metadata: { fields: Object.keys(parsed.data) },
        })
        .catch((err) => logger.warn({ err }, 'audit log failed'));

      const updated = await db('operators').where({ id: params.data.id }).first();
      return reply.send(operatorDto(updated));
    },
  );

  // ─── POST /admin/cpaas/:provider/force-open|force-close (ROOT|SRE) ────────────
  for (const [suffix, state] of [
    ['force-open', 'OPEN'],
    ['force-close', 'CLOSED'],
  ] as const) {
    app.post<{ Params: { provider: string } }>(
      `/admin/cpaas/:provider/${suffix}`,
      { preHandler: [adminAuthenticate, requireRole('ROOT', 'SRE')] },
      async (req, reply) => {
        const params = cpaasProviderParams.safeParse(req.params);
        if (!params.success) {
          return reply
            .status(400)
            .type('application/problem+json')
            .send(rfc7807('validation', 'Bad Request', 400, params.error.message));
        }
        await getCircuitBreaker(params.data.provider).forceState(state);
        await getAuditLogger()
          .log({
            actorType: 'operator',
            actorId: req.operator!.id,
            action: `cpaas.${suffix}`,
            resourceType: 'circuit_breaker',
            resourceId: params.data.provider,
          })
          .catch((err) => logger.warn({ err }, 'audit log failed'));
        return reply.send({ success: true, provider: params.data.provider, state });
      },
    );
  }
}
