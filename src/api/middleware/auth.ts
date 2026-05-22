import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { logger } from '../../utils/logger';

// ─── Type augmentation ──────────────────────────────────────────────────────────
// req.user is owned by the @fastify/jwt augmentation below, so we don't redeclare
// it here. req.tenant + req.operator are our own additions.
declare module 'fastify' {
  interface FastifyRequest {
    tenant?: { id: string; tier: string };
    operator?: { id: string; role: 'ROOT' | 'SRE' | 'SUPPORT' };
  }
}

// Raw JWT payload union — what we sign and what jwtVerify decodes.
export type JwtPayload =
  | { tenantId: string; tier: string }
  | {
      type: 'tenant_user';
      tenantId: string;
      tier: string;
      userId: string;
      role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
    }
  | { type: 'operator'; operatorId: string; role: 'ROOT' | 'SRE' | 'SUPPORT' };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    // After our middleware runs, req.user is the narrowed dashboard-user shape
    // (or undefined for SDK tokens). Type it as that, since middleware-aware
    // route handlers see this shape, not the raw payload.
    user: { id: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' };
  }
}

// ─── RFC 7807 helpers ──────────────────────────────────────────────────────────
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

// ─── authenticate ───────────────────────────────────────────────────────────────
/**
 * Verifies a tenant SDK JWT or a dashboard user JWT.
 * REJECTS operator tokens (those go through adminAuthenticate).
 *
 * Attaches:
 *   req.tenant = { id, tier }
 *   req.user   = { id, role } when the token is a dashboard token
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify();
  } catch (err) {
    logger.debug({ err }, 'authenticate: jwtVerify failed');
    return void unauthorized(reply, 'Invalid or missing access token.');
  }

  const payload = req.user as unknown as JwtPayload;

  if ('type' in payload && payload.type === 'operator') {
    return void unauthorized(reply, 'Operator tokens are not accepted on tenant endpoints.');
  }

  if ('type' in payload && payload.type === 'tenant_user') {
    req.tenant = { id: payload.tenantId, tier: payload.tier };
    req.user = { id: payload.userId, role: payload.role };
    return;
  }

  // SDK token: no dashboard user — leave req.user as the JWT payload (routes
  // should only access req.user when known to be a tenant_user token).
  if (!('tenantId' in payload) || !payload.tenantId) {
    return void unauthorized(reply, 'Token missing tenantId claim.');
  }
  req.tenant = { id: payload.tenantId, tier: payload.tier };
}

// ─── requireUserRole ────────────────────────────────────────────────────────────
/**
 * Factory returning a preHandler that enforces req.user.role ∈ roles.
 * Must be used AFTER `authenticate` and only on dashboard endpoints.
 */
export function requireUserRole(
  ...roles: Array<'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER'>
): preHandlerAsyncHookHandler {
  return async function userRoleGuard(req, reply) {
    if (!req.user || !req.user.role) {
      return void forbidden(reply, 'This endpoint requires a dashboard user token.');
    }
    if (!roles.includes(req.user.role)) {
      return void forbidden(
        reply,
        `Requires role ${roles.join(' or ')}; you have ${req.user.role}.`,
      );
    }
  };
}

// Reference `FastifyInstance` to silence unused-import warnings if tree-shaken.
export type _FastifyInstance = FastifyInstance;
