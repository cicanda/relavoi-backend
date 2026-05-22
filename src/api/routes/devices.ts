import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPhone } from '../../utils/crypto';
import { authenticate } from '../middleware/auth';
import { tierRateLimit } from '../middleware/tier-rate-limit';
import { getDeviceTokenManager } from '../../services/device-token-manager';
import { getPresenceManager } from '../../services/presence-manager';

const E164 = /^\+[1-9]\d{1,14}$/;

function rfc7807(slug: string, title: string, status: number, detail: string): Record<string, unknown> {
  return { type: `https://api.relavoi.com/errors/${slug}`, title, status, detail };
}

const registerTokenSchema = z.object({
  userPhone: z.string().regex(E164, 'userPhone must be E.164'),
  token: z.string().min(1),
  platform: z.enum(['ios', 'android']),
  appBundleId: z.string().optional(),
});

const deactivateTokenSchema = z.object({
  token: z.string().min(1),
});

const presenceUpdateSchema = z.object({
  userPhone: z.string().regex(E164, 'userPhone must be E.164'),
  status: z.enum(['online', 'background', 'offline']),
  platform: z.enum(['ios', 'android']),
});

const presenceQuerySchema = z.object({
  userPhone: z.string().regex(E164, 'userPhone must be E.164'),
});

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  // POST /devices/token
  app.post('/devices/token', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = registerTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const tenant = req.tenant!;
    const userPhoneHash = hashPhone(parsed.data.userPhone, tenant.id);
    await getDeviceTokenManager().register({
      tenantId: tenant.id,
      userPhoneHash,
      token: parsed.data.token,
      platform: parsed.data.platform,
      appBundleId: parsed.data.appBundleId,
    });
    return reply.status(204).send();
  });

  // DELETE /devices/token
  app.delete('/devices/token', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = deactivateTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    await getDeviceTokenManager().deactivateToken(parsed.data.token);
    return reply.status(204).send();
  });

  // POST /devices/presence
  app.post('/devices/presence', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = presenceUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const tenant = req.tenant!;
    const userPhoneHash = hashPhone(parsed.data.userPhone, tenant.id);
    await getPresenceManager().updatePresence({
      tenantId: tenant.id,
      userPhoneHash,
      status: parsed.data.status,
      platform: parsed.data.platform,
    });
    return reply.status(204).send();
  });

  // GET /devices/presence
  app.get('/devices/presence', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = presenceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const tenant = req.tenant!;
    const userPhoneHash = hashPhone(parsed.data.userPhone, tenant.id);
    const state = await getPresenceManager().getPresence(tenant.id, userPhoneHash);
    return reply.send(state ?? { status: 'unknown' });
  });
}
