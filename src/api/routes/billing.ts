import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../config/database';
import { authenticate } from '../middleware/auth';
import { tierRateLimit } from '../middleware/tier-rate-limit';
import { getBillingManager } from '../../services/billing-manager';

function rfc7807(slug: string, title: string, status: number, detail: string): Record<string, unknown> {
  return { type: `https://api.relavoi.com/errors/${slug}`, title, status, detail };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map a raw tier_pricing row to a camelCase DTO with numeric fields. */
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

const periodSchema = z.object({
  periodStart: z.string().datetime({ offset: true }),
  periodEnd: z.string().datetime({ offset: true }),
});

const eventsQuerySchema = periodSchema.extend({
  metric: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const periodsListSchema = z.object({
  limit: z.coerce.number().int().positive().max(24).default(12),
  after: z.string().uuid().optional(),
});

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // GET /billing/usage
  app.get('/billing/usage', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = periodSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const tenant = req.tenant!;
    const summary = await getBillingManager().getUsageSummary(
      tenant.id,
      new Date(parsed.data.periodStart),
      new Date(parsed.data.periodEnd),
    );
    return reply.send(summary);
  });

  // GET /billing/events
  app.get('/billing/events', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = eventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const tenant = req.tenant!;
    const result = await getBillingManager().getUsageEvents(
      tenant.id,
      new Date(parsed.data.periodStart),
      new Date(parsed.data.periodEnd),
      parsed.data.metric as never,
      parsed.data.limit,
      parsed.data.offset,
    );
    return reply.send({ events: result });
  });

  // GET /billing/periods — list the tenant's billing periods, newest first.
  // Cursor pagination by id: pass the last row's id as `after` to fetch older periods.
  app.get('/billing/periods', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = periodsListSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const tenant = req.tenant!;
    const db = getDb();
    const q = db('billing_periods')
      .where({ tenant_id: tenant.id })
      .orderBy('period_start', 'desc')
      .limit(parsed.data.limit);
    if (parsed.data.after) {
      // Periods are ordered by start date but the cursor is the id of the last row
      // we returned. Fetch periods strictly older than that row's start_date.
      const cursorRow = await db('billing_periods')
        .where({ id: parsed.data.after, tenant_id: tenant.id })
        .first('period_start');
      if (cursorRow) {
        q.andWhere('period_start', '<', cursorRow.period_start);
      }
    }
    const rows: Array<{
      id: string;
      period_start: Date;
      period_end: Date;
      status: string;
      created_at: Date;
      closed_at: Date | null;
    }> = await q;
    const data = rows.map((r) => ({
      id: r.id,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      status: r.status,
      createdAt: r.created_at,
      closedAt: r.closed_at,
    }));
    return reply.send({
      data,
      pagination: {
        count: data.length,
        after: data.length === parsed.data.limit ? data[data.length - 1].id : null,
      },
    });
  });

  // GET /billing/pricing — returns tier_pricing rows as camelCase DTOs with
  // numeric price/quantity fields (Postgres NUMERIC comes back as strings).
  app.get('/billing/pricing', { preHandler: [authenticate, tierRateLimit] }, async (_req, reply) => {
    const db = getDb();
    try {
      const rows = await db('tier_pricing').select('*').orderBy('tier');
      return reply.send({ tiers: rows.map(pricingRowDto) });
    } catch {
      return reply.send({ tiers: [] });
    }
  });
}
