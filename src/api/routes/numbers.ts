import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireUserRole } from '../middleware/auth';
import { tierRateLimit } from '../middleware/tier-rate-limit';
import { getNumberPool } from '../../services/number-pool';

function rfc7807(slug: string, title: string, status: number, detail: string): Record<string, unknown> {
  return { type: `https://api.relavoi.com/errors/${slug}`, title, status, detail };
}

const provisionBodySchema = z.object({
  region: z.string().min(1),
  count: z.number().int().positive().max(100),
  provider: z.enum(['AFRICASTALKING', 'TWILIO', 'PLIVO']).optional(),
});

export async function numberRoutes(app: FastifyInstance): Promise<void> {
  // GET /numbers/pool
  app.get('/numbers/pool', { preHandler: [authenticate, tierRateLimit] }, async (_req, reply) => {
    const rows = await getNumberPool().getPoolStatus();
    // Aggregate per-region, dropping the internal CPaaS provider dimension.
    // Which vendor a number is provisioned through is an internal detail the
    // tenant must not see.
    const byRegion = new Map<
      string,
      { region: string; total: number; available: number; inUse: number; cooldown: number }
    >();
    for (const r of rows) {
      const acc =
        byRegion.get(r.region) ??
        { region: r.region, total: 0, available: 0, inUse: 0, cooldown: 0 };
      acc.total += r.total;
      acc.available += r.available;
      acc.inUse += r.inUse;
      acc.cooldown += r.cooldown;
      byRegion.set(r.region, acc);
    }
    return reply.send({ pools: Array.from(byRegion.values()) });
  });

  // POST /numbers/provision — OWNER only. Not yet implemented in MVP.
  app.post(
    '/numbers/provision',
    { preHandler: [authenticate, requireUserRole('OWNER'), tierRateLimit] },
    async (req, reply) => {
      const parsed = provisionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      return reply.status(501).send({
        error: 'Number provisioning via API is not yet available. Contact support.',
      });
    },
  );
}
