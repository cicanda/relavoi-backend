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

const operatorCreateSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(['ROOT', 'SRE', 'SUPPORT']),
  password: z.string().min(12).max(128),
});

const auditQuery = z.object({
  actorType: z.string().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  after: z.string().optional(),
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
    status: o.status ?? 'ACTIVE',
    createdAt: o.created_at,
    lastLoginAt: o.last_login_at ?? null,
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
    if (op.status && op.status !== 'ACTIVE') {
      return reply
        .status(403)
        .type('application/problem+json')
        .send(rfc7807('forbidden', 'Forbidden', 403, `Operator status is ${op.status}.`));
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
  app.get('/admin/fleet', { preHandler: [adminAuthenticate] }, async (_req, reply) => {
    const pools = await getNumberPool().getPoolStatus();
    return reply.send({ pools });
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

  // ─── GET /admin/operators ─────────────────────────────────────────────────────
  app.get('/admin/operators', { preHandler: [adminAuthenticate] }, async (_req, reply) => {
    const db = getDb();
    const rows = await db('operators')
      .select('id', 'email', 'name', 'role', 'is_active', 'created_at', 'last_login_at')
      .orderBy('created_at', 'desc');
    return reply.send({ data: rows.map(operatorDto) });
  });

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
      return reply.send({ tiers: rows });
    } catch {
      return reply.send({ tiers: [] });
    }
  });
}
