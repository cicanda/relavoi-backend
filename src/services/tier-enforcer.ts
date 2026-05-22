import { getRedis } from '../config/redis';
import { logger } from '../utils/logger';

export type Tier = 'STARTER' | 'GROWTH' | 'ENTERPRISE';

export interface TierLimit {
  maxConcurrentSessions: number;
  maxApiReqPerMin: number;
}

export const TIER_LIMITS: Record<Tier, TierLimit> = {
  STARTER: { maxConcurrentSessions: 100, maxApiReqPerMin: 100 },
  GROWTH: { maxConcurrentSessions: 1000, maxApiReqPerMin: 500 },
  ENTERPRISE: { maxConcurrentSessions: 10_000, maxApiReqPerMin: 2000 },
};

export interface TierError extends Error {
  statusCode: number;
  code: string;
}

function tierErr(code: string, statusCode: number, message: string): TierError {
  const e = new Error(message) as TierError;
  e.code = code;
  e.statusCode = statusCode;
  return e;
}

function limitsFor(tier: Tier): TierLimit {
  return TIER_LIMITS[tier] ?? TIER_LIMITS.STARTER;
}

export class TierEnforcer {
  private readonly redis = getRedis();

  /**
   * Throws if the tenant has already hit its concurrent session cap.
   * Uses Redis SCARD on the tenant's active sessions set, populated by
   * SessionManager on create / cleared on expire.
   */
  async enforceSessionLimit(tenantId: string, tier: Tier): Promise<void> {
    const limit = limitsFor(tier).maxConcurrentSessions;
    let active = 0;
    try {
      active = await this.redis.scard(`tenant:${tenantId}:active_sessions`);
    } catch (err) {
      logger.warn({ err, tenantId }, 'TierEnforcer: redis scard failed — allowing through');
      return;
    }

    if (active >= limit) {
      throw tierErr(
        'TIER_SESSION_LIMIT_EXCEEDED',
        429,
        `Tier ${tier} permits at most ${limit} concurrent sessions (current: ${active})`,
      );
    }
  }

  /**
   * Sliding-window rate limit per tenant. Throws if exceeded.
   * Uses Redis sorted set with score=now_ms.
   */
  async enforceApiRateLimit(tenantId: string, tier: Tier): Promise<void> {
    const limit = limitsFor(tier).maxApiReqPerMin;
    const key = `tenant:${tenantId}:api_calls`;
    const now = Date.now();
    const windowStart = now - 60_000;

    try {
      // Pipeline for atomicity-ish
      const pipeline = this.redis.pipeline();
      pipeline.zadd(key, now, `${now}-${Math.random().toString(36).slice(2, 8)}`);
      pipeline.zremrangebyscore(key, 0, windowStart);
      pipeline.zcard(key);
      pipeline.expire(key, 120);
      const result = await pipeline.exec();
      if (!result) return;

      // result[2] is [err, value] of ZCARD
      const card = Number(result[2]?.[1] ?? 0);
      if (card > limit) {
        throw tierErr(
          'TIER_RATE_LIMIT_EXCEEDED',
          429,
          `Tier ${tier} rate limit (${limit} req/min) exceeded`,
        );
      }
    } catch (err) {
      if ((err as TierError).code === 'TIER_RATE_LIMIT_EXCEEDED') throw err;
      logger.warn({ err, tenantId }, 'TierEnforcer: rate limit check failed — allowing through');
    }
  }
}

let instance: TierEnforcer | null = null;
export function getTierEnforcer(): TierEnforcer {
  if (!instance) instance = new TierEnforcer();
  return instance;
}
