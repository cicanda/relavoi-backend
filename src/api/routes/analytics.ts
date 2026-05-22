import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../config/database';
import { authenticate } from '../middleware/auth';
import { tierRateLimit } from '../middleware/tier-rate-limit';
import { getBillingManager } from '../../services/billing-manager';

function rfc7807(slug: string, title: string, status: number, detail: string): Record<string, unknown> {
  return { type: `https://api.relavoi.com/errors/${slug}`, title, status, detail };
}

const periodSchema = z.object({
  periodStart: z.string().datetime({ offset: true }),
  periodEnd: z.string().datetime({ offset: true }),
});

const bucketSchema = periodSchema.extend({
  granularity: z.enum(['hour', 'day']).default('day'),
});

const callsQuerySchema = periodSchema.extend({
  status: z.enum(['RINGING', 'ANSWERED', 'COMPLETED', 'MISSED', 'FAILED']).optional(),
  direction: z.enum(['A_TO_B', 'B_TO_A']).optional(),
});

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  // GET /analytics/usage — dashboard-formatted usage summary
  app.get('/analytics/usage', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
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

  // GET /analytics/sessions-over-time
  app.get(
    '/analytics/sessions-over-time',
    { preHandler: [authenticate, tierRateLimit] },
    async (req, reply) => {
      const parsed = bucketSchema.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const tenant = req.tenant!;
      const db = getDb();
      const rows = await db('sessions')
        .where({ tenant_id: tenant.id })
        .andWhere('created_at', '>=', parsed.data.periodStart)
        .andWhere('created_at', '<', parsed.data.periodEnd)
        .select(db.raw(`date_trunc(?, created_at) as ts`, [parsed.data.granularity]))
        .count<{ ts: Date; count: string }[]>('* as count')
        .groupBy('ts')
        .orderBy('ts');
      return reply.send(
        rows.map((r) => ({
          ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts,
          count: Number(r.count),
        })),
      );
    },
  );

  // GET /analytics/call-success-rate
  app.get(
    '/analytics/call-success-rate',
    { preHandler: [authenticate, tierRateLimit] },
    async (req, reply) => {
      const parsed = bucketSchema.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const tenant = req.tenant!;
      const db = getDb();

      const rows: Array<{
        ts: Date;
        total: string;
        answered: string;
        completed: string;
        missed: string;
        failed: string;
      }> = await db('call_records as cr')
        .join('sessions as s', 's.id', 'cr.session_id')
        .where('s.tenant_id', tenant.id)
        .andWhere('cr.initiated_at', '>=', parsed.data.periodStart)
        .andWhere('cr.initiated_at', '<', parsed.data.periodEnd)
        .select(db.raw(`date_trunc(?, cr.initiated_at) as ts`, [parsed.data.granularity]))
        .count<{ ts: Date; total: string }[]>('* as total')
        .select(
          db.raw(`SUM(CASE WHEN cr.status = 'ANSWERED' THEN 1 ELSE 0 END) as answered`),
          db.raw(`SUM(CASE WHEN cr.status = 'COMPLETED' THEN 1 ELSE 0 END) as completed`),
          db.raw(`SUM(CASE WHEN cr.status = 'MISSED' THEN 1 ELSE 0 END) as missed`),
          db.raw(`SUM(CASE WHEN cr.status = 'FAILED' THEN 1 ELSE 0 END) as failed`),
        )
        .groupBy('ts')
        .orderBy('ts');

      return reply.send(
        rows.map((r) => {
          const total = Number(r.total);
          const answered = Number(r.answered ?? 0);
          const completed = Number(r.completed ?? 0);
          const successful = answered + completed;
          return {
            ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts,
            total,
            answered,
            completed,
            missed: Number(r.missed ?? 0),
            failed: Number(r.failed ?? 0),
            rate: total > 0 ? +(successful / total).toFixed(4) : 0,
          };
        }),
      );
    },
  );

  // GET /analytics/calls — aggregated call metrics
  app.get('/analytics/calls', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = callsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const tenant = req.tenant!;
    const db = getDb();

    const q = db('call_records as cr')
      .join('sessions as s', 's.id', 'cr.session_id')
      .where('s.tenant_id', tenant.id)
      .andWhere('cr.initiated_at', '>=', parsed.data.periodStart)
      .andWhere('cr.initiated_at', '<', parsed.data.periodEnd);

    if (parsed.data.status) q.andWhere('cr.status', parsed.data.status);
    if (parsed.data.direction) q.andWhere('cr.direction', parsed.data.direction);

    const totalsQuery = q.clone();
    const [totals] = await totalsQuery
      .clearSelect()
      .count<{ total: string; avg_duration: string | null }[]>('* as total')
      .select(db.raw(`COALESCE(AVG(cr.duration_seconds), 0) as avg_duration`));

    const byStatus: Array<{ status: string; count: string }> = await q
      .clone()
      .clearSelect()
      .select('cr.status as status')
      .count('* as count')
      .groupBy('cr.status');

    const byDirection: Array<{ direction: string; count: string }> = await q
      .clone()
      .clearSelect()
      .select('cr.direction as direction')
      .count('* as count')
      .groupBy('cr.direction');

    return reply.send({
      periodStart: parsed.data.periodStart,
      periodEnd: parsed.data.periodEnd,
      total: Number(totals?.total ?? 0),
      avgDurationSeconds: Number(totals?.avg_duration ?? 0),
      byStatus: byStatus.map((r) => ({ status: r.status, count: Number(r.count) })),
      byDirection: byDirection.map((r) => ({ direction: r.direction, count: Number(r.count) })),
    });
  });
}
