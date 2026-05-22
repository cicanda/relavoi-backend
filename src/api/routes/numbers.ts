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
    return reply.send({ pools: rows });
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
      return reply
        .status(501)
        .type('application/problem+json')
        .send(
          rfc7807(
            'not-implemented',
            'Not Implemented',
            501,
            'Number provisioning is a roadmap feature. Contact support to request additional numbers for your region.',
          ),
        );
    },
  );
}
