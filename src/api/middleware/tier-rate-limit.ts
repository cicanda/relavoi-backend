import type { FastifyReply, FastifyRequest } from 'fastify';
import { getRedis } from '../../config/redis';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';

const WINDOW_SECONDS = 60;

const TIER_LIMITS: Record<string, number> = {
  STARTER: 100,
  GROWTH: 500,
  ENTERPRISE: 2000,
};

/**
 * Per-tenant sliding-window rate limit (1-minute window) enforced via Redis
 * sorted set: `tenant:{tenantId}:api_calls`.
 *
 * Adds standard rate-limit headers. On exceed → 429 RFC 7807 with
 * `retryAfterSeconds`.
 *
 * Skipped when LOAD_TEST_MODE=true.
 */
export async function tierRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (config.LOAD_TEST_MODE) return;

  const tenant = req.tenant;
  if (!tenant) {
    // Should never happen if `authenticate` ran first. Fail open on shape errors,
    // but log.
    logger.warn('tierRateLimit: no req.tenant set, skipping');
    return;
  }

  const limit = TIER_LIMITS[tenant.tier] ?? TIER_LIMITS.STARTER;
  const key = `tenant:${tenant.id}:api_calls`;
  const now = Date.now();
  const windowStart = now - WINDOW_SECONDS * 1000;
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

  const redis = getRedis();
  let count = 0;
  try {
    const pipeline = redis.multi();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zadd(key, now, member);
    pipeline.zcard(key);
    pipeline.expire(key, WINDOW_SECONDS + 5);
    const results = (await pipeline.exec()) ?? [];
    // results[2] is [err, count]
    const zcardResult = results[2];
    if (zcardResult && !zcardResult[0]) {
      count = Number(zcardResult[1] ?? 0);
    }
  } catch (err) {
    logger.error({ err, tenantId: tenant.id }, 'tierRateLimit: Redis failure, failing open');
    return;
  }

  const remaining = Math.max(0, limit - count);
  const resetEpochSec = Math.ceil((now + WINDOW_SECONDS * 1000) / 1000);

  reply.header('X-RateLimit-Limit', String(limit));
  reply.header('X-RateLimit-Remaining', String(remaining));
  reply.header('X-RateLimit-Reset', String(resetEpochSec));

  if (count > limit) {
    const retryAfterSeconds = WINDOW_SECONDS;
    reply.header('Retry-After', String(retryAfterSeconds));
    return void reply
      .status(429)
      .type('application/problem+json')
      .send({
        type: 'https://api.relavoi.com/errors/rate-limit',
        title: 'Too Many Requests',
        status: 429,
        detail: `API rate limit exceeded for tier ${tenant.tier} (${limit}/min).`,
        retryAfterSeconds,
      });
  }
}

export { TIER_LIMITS };
