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

const eventsQuerySchema = periodSchema.extend({
  metric: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
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

  // GET /billing/pricing — returns tier_pricing rows (public-ish)
  app.get('/billing/pricing', { preHandler: [authenticate, tierRateLimit] }, async (_req, reply) => {
    const db = getDb();
    try {
      const rows = await db('tier_pricing').select('*').orderBy('tier');
      return reply.send({ tiers: rows });
    } catch {
      return reply.send({ tiers: [] });
    }
  });
}
