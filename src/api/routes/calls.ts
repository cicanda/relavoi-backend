import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../config/database';
import { authenticate } from '../middleware/auth';
import { tierRateLimit } from '../middleware/tier-rate-limit';

function rfc7807(slug: string, title: string, status: number, detail: string): Record<string, unknown> {
  return { type: `https://api.relavoi.com/errors/${slug}`, title, status, detail };
}

const listQuerySchema = z.object({
  sessionId: z.string().optional(),
  status: z.enum(['RINGING', 'ANSWERED', 'COMPLETED', 'MISSED', 'FAILED']).optional(),
  direction: z.enum(['A_TO_B', 'B_TO_A']).optional(),
  periodStart: z.string().datetime({ offset: true }).optional(),
  periodEnd: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  after: z.string().optional(),
});

function callDto(c: Record<string, unknown>): Record<string, unknown> {
  return {
    id: c.id,
    sessionId: c.session_id,
    status: c.status,
    direction: c.direction,
    durationSeconds: c.duration_seconds,
    initiatedAt: c.initiated_at,
    answeredAt: c.answered_at,
    endedAt: c.ended_at,
    recordingUrl: c.recording_url,
  };
}

export async function callRoutes(app: FastifyInstance): Promise<void> {
  // GET /calls
  app.get('/calls', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
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
      .select(
        'cr.id',
        'cr.session_id',
        'cr.status',
        'cr.direction',
        'cr.duration_seconds',
        'cr.initiated_at',
        'cr.answered_at',
        'cr.ended_at',
        'cr.recording_url',
      )
      .orderBy('cr.id', 'desc')
      .limit(parsed.data.limit + 1);

    if (parsed.data.sessionId) q.andWhere('cr.session_id', parsed.data.sessionId);
    if (parsed.data.status) q.andWhere('cr.status', parsed.data.status);
    if (parsed.data.direction) q.andWhere('cr.direction', parsed.data.direction);
    if (parsed.data.periodStart) q.andWhere('cr.initiated_at', '>=', parsed.data.periodStart);
    if (parsed.data.periodEnd) q.andWhere('cr.initiated_at', '<', parsed.data.periodEnd);
    if (parsed.data.after) q.andWhere('cr.id', '<', parsed.data.after);

    const rows = await q;
    const hasMore = rows.length > parsed.data.limit;
    const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    const data = page.map((r) => callDto(r));

    return reply.send({
      data,
      pagination: {
        count: data.length,
        after: hasMore ? page[page.length - 1].id : null,
      },
    });
  });

  // GET /calls/:id
  app.get<{ Params: { id: string } }>(
    '/calls/:id',
    { preHandler: [authenticate, tierRateLimit] },
    async (req, reply) => {
      const tenant = req.tenant!;
      const db = getDb();
      const row = await db('call_records as cr')
        .join('sessions as s', 's.id', 'cr.session_id')
        .where('cr.id', req.params.id)
        .andWhere('s.tenant_id', tenant.id)
        .select(
          'cr.id',
          'cr.session_id',
          'cr.status',
          'cr.direction',
          'cr.duration_seconds',
          'cr.initiated_at',
          'cr.answered_at',
          'cr.ended_at',
          'cr.cpaas_call_id',
          'cr.cpaas_provider',
          'cr.recording_url',
        )
        .first();
      if (!row) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Call not found.'));
      }
      return reply.send(callDto(row));
    },
  );
}
