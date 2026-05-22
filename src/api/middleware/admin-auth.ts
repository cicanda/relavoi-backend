import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { logger } from '../../utils/logger';

function unauthorized(reply: FastifyReply, detail: string): FastifyReply {
  return reply.status(401).type('application/problem+json').send({
    type: 'https://api.relavoi.com/errors/unauthorized',
    title: 'Unauthorized',
    status: 401,
    detail,
  });
}

function forbidden(reply: FastifyReply, detail: string): FastifyReply {
  return reply.status(403).type('application/problem+json').send({
    type: 'https://api.relavoi.com/errors/forbidden',
    title: 'Forbidden',
    status: 403,
    detail,
  });
}

/**
 * Verifies a JWT with `type: 'operator'`. Rejects any other token (tenant SDK
 * tokens and tenant_user dashboard tokens cannot access /admin/*).
 *
 * Attaches req.operator = { id, role }.
 */
export async function adminAuthenticate(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await req.jwtVerify();
  } catch (err) {
    logger.debug({ err }, 'adminAuthenticate: jwtVerify failed');
    return void unauthorized(reply, 'Invalid or missing operator access token.');
  }

  const payload = req.user as { type?: string; operatorId?: string; role?: string };

  if (payload.type !== 'operator' || !payload.operatorId || !payload.role) {
    return void unauthorized(reply, 'Operator credentials required.');
  }

  req.operator = {
    id: payload.operatorId,
    role: payload.role as 'ROOT' | 'SRE' | 'SUPPORT',
  };
}

/**
 * Factory: returns a preHandler enforcing req.operator.role ∈ roles.
 * Must be used AFTER `adminAuthenticate`.
 */
export function requireRole(
  ...roles: Array<'ROOT' | 'SRE' | 'SUPPORT'>
): preHandlerAsyncHookHandler {
  return async function operatorRoleGuard(req, reply) {
    if (!req.operator) {
      return void forbidden(reply, 'Operator authentication required.');
    }
    if (!roles.includes(req.operator.role)) {
      return void forbidden(
        reply,
        `Requires operator role ${roles.join(' or ')}; you have ${req.operator.role}.`,
      );
    }
  };
}
