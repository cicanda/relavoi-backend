import { getRedis } from '../config/redis';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { circuitBreakerState } from '../utils/metrics';

export type CbState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CbRedisHash {
  state?: string;
  openedAt?: string;
  halfOpenSuccessCount?: string;
  halfOpenFailureCount?: string;
  errorWindowStart?: string;
  errorWindowCount?: string;
  errorWindowFailureCount?: string;
  consecutiveFailures?: string;
  healthCheckSuccesses?: string;
  lastError?: string;
}

const STATE_LABEL: Record<CbState, number> = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
};

/**
 * CircuitBreaker — Redis-persisted, per-provider.
 *
 * State machine:
 *   CLOSED   → OPEN     : 5 consecutive failures OR >10% error rate in 2-min window
 *   OPEN     → HALF_OPEN: 5 consecutive successful health checks
 *   HALF_OPEN → CLOSED  : success rate > 95% over CB_RECOVERY_CHECK_COUNT samples
 *   HALF_OPEN → OPEN    : ANY failure
 */
export class CircuitBreaker {
  private readonly redis = getRedis();
  private readonly key: string;

  constructor(public readonly provider: string) {
    this.key = `cb:${provider}`;
  }

  async getState(): Promise<CbState> {
    const s = (await this.redis.hget(this.key, 'state')) ?? 'CLOSED';
    const state = (s as CbState) || 'CLOSED';
    circuitBreakerState.set({ provider: this.provider }, STATE_LABEL[state]);
    return state;
  }

  async canRequest(): Promise<boolean> {
    const state = await this.getState();
    if (state === 'CLOSED') return true;
    if (state === 'OPEN') return false;
    // HALF_OPEN — admit traffic with configured probability
    return Math.random() * 100 < config.CB_HALF_OPEN_TRAFFIC_PERCENT;
  }

  async recordSuccess(): Promise<void> {
    const state = await this.getState();
    if (state === 'CLOSED') {
      // reset consecutive failures
      await this.redis.hset(this.key, 'consecutiveFailures', '0');
      return;
    }

    if (state === 'HALF_OPEN') {
      const success = await this.redis.hincrby(this.key, 'halfOpenSuccessCount', 1);
      const failure = Number((await this.redis.hget(this.key, 'halfOpenFailureCount')) ?? '0');
      const total = success + failure;
      const target = config.CB_RECOVERY_CHECK_COUNT;
      if (total >= target) {
        const rate = success / total;
        if (rate > 0.95) {
          await this.transitionToClosed();
        } else {
          await this.transitionToOpen('half-open recovery rate insufficient');
        }
      }
    }
  }

  async recordFailure(err?: unknown): Promise<void> {
    const state = await this.getState();
    const now = Date.now();
    const errMsg = err instanceof Error ? err.message : err ? String(err) : '';

    if (state === 'HALF_OPEN') {
      // Any failure during HALF_OPEN trips back to OPEN immediately
      await this.redis.hincrby(this.key, 'halfOpenFailureCount', 1);
      await this.transitionToOpen(errMsg || 'half-open probe failed');
      return;
    }

    if (state === 'OPEN') {
      // Already open. Just update last error.
      await this.redis.hset(this.key, 'lastError', errMsg);
      return;
    }

    // CLOSED state — evaluate trip conditions
    const consecutive = await this.redis.hincrby(this.key, 'consecutiveFailures', 1);

    // Sliding error window
    const winStartRaw = await this.redis.hget(this.key, 'errorWindowStart');
    const winStart = winStartRaw ? Number(winStartRaw) : 0;
    const windowMs = config.CB_ERROR_RATE_WINDOW_SECONDS * 1000;

    let winFailures: number;
    let winTotal: number;

    if (!winStart || now - winStart > windowMs) {
      // start a new window with this single failure
      await this.redis.hset(this.key, {
        errorWindowStart: String(now),
        errorWindowCount: '1',
        errorWindowFailureCount: '1',
        lastError: errMsg,
      });
      winFailures = 1;
      winTotal = 1;
    } else {
      winTotal = await this.redis.hincrby(this.key, 'errorWindowCount', 1);
      winFailures = await this.redis.hincrby(this.key, 'errorWindowFailureCount', 1);
      await this.redis.hset(this.key, 'lastError', errMsg);
    }

    const errorRate = winTotal > 0 ? winFailures / winTotal : 0;

    if (consecutive >= config.CB_FAILURE_THRESHOLD) {
      await this.transitionToOpen(`${consecutive} consecutive failures`);
      return;
    }

    if (winTotal >= 10 && errorRate > config.CB_ERROR_RATE_THRESHOLD) {
      await this.transitionToOpen(
        `error rate ${(errorRate * 100).toFixed(1)}% exceeds threshold over ${winTotal} samples`,
      );
    }
  }

  /**
   * Also called by callers wrapping a successful request that is NOT a failure
   * — counts toward the rate-window sample size.
   */
  async recordRequest(): Promise<void> {
    const state = await this.getState();
    if (state !== 'CLOSED') return;
    const now = Date.now();
    const winStartRaw = await this.redis.hget(this.key, 'errorWindowStart');
    const winStart = winStartRaw ? Number(winStartRaw) : 0;
    const windowMs = config.CB_ERROR_RATE_WINDOW_SECONDS * 1000;
    if (!winStart || now - winStart > windowMs) {
      await this.redis.hset(this.key, {
        errorWindowStart: String(now),
        errorWindowCount: '1',
        errorWindowFailureCount: '0',
      });
    } else {
      await this.redis.hincrby(this.key, 'errorWindowCount', 1);
    }
  }

  async recordHealthCheckSuccess(): Promise<void> {
    const state = await this.getState();
    if (state !== 'OPEN') {
      await this.redis.hset(this.key, 'healthCheckSuccesses', '0');
      return;
    }
    const count = await this.redis.hincrby(this.key, 'healthCheckSuccesses', 1);
    if (count >= config.CB_RECOVERY_CHECK_COUNT) {
      await this.transitionToHalfOpen();
    }
  }

  async recordHealthCheckFailure(): Promise<void> {
    await this.redis.hset(this.key, 'healthCheckSuccesses', '0');
  }

  async getDetail(): Promise<{
    provider: string;
    state: CbState;
    openedAt: number;
    consecutiveFailures: number;
    errorWindowCount: number;
    errorWindowFailureCount: number;
    healthCheckSuccesses: number;
    halfOpenSuccessCount: number;
    halfOpenFailureCount: number;
    lastError: string;
  }> {
    const h = (await this.redis.hgetall(this.key)) as CbRedisHash;
    return {
      provider: this.provider,
      state: (h.state as CbState) || 'CLOSED',
      openedAt: Number(h.openedAt ?? 0),
      consecutiveFailures: Number(h.consecutiveFailures ?? 0),
      errorWindowCount: Number(h.errorWindowCount ?? 0),
      errorWindowFailureCount: Number(h.errorWindowFailureCount ?? 0),
      healthCheckSuccesses: Number(h.healthCheckSuccesses ?? 0),
      halfOpenSuccessCount: Number(h.halfOpenSuccessCount ?? 0),
      halfOpenFailureCount: Number(h.halfOpenFailureCount ?? 0),
      lastError: h.lastError ?? '',
    };
  }

  async forceState(state: CbState): Promise<void> {
    await this.redis.hset(this.key, 'state', state);
    circuitBreakerState.set({ provider: this.provider }, STATE_LABEL[state]);
    logger.warn({ provider: this.provider, state }, 'CircuitBreaker: state forced');
  }

  private async transitionToOpen(reason: string): Promise<void> {
    await this.redis.hset(this.key, {
      state: 'OPEN',
      openedAt: String(Date.now()),
      healthCheckSuccesses: '0',
      halfOpenSuccessCount: '0',
      halfOpenFailureCount: '0',
      lastError: reason,
    });
    circuitBreakerState.set({ provider: this.provider }, STATE_LABEL.OPEN);
    logger.warn({ provider: this.provider, reason }, 'CircuitBreaker: transitioned to OPEN');
  }

  /**
   * CRITICAL FIX: when transitioning to HALF_OPEN, clear the pre-trip error
   * window counters so HALF_OPEN judgment uses only probe traffic.
   * Without this, the breaker stays "bad" forever because the old failure count
   * dominates the new rate calculation.
   */
  private async transitionToHalfOpen(): Promise<void> {
    await this.redis.hset(this.key, {
      state: 'HALF_OPEN',
      halfOpenSuccessCount: '0',
      halfOpenFailureCount: '0',
      consecutiveFailures: '0',
      errorWindowStart: '0',
      errorWindowCount: '0',
      errorWindowFailureCount: '0',
    });
    circuitBreakerState.set({ provider: this.provider }, STATE_LABEL.HALF_OPEN);
    logger.info({ provider: this.provider }, 'CircuitBreaker: transitioned to HALF_OPEN');
  }

  private async transitionToClosed(): Promise<void> {
    await this.redis.hset(this.key, {
      state: 'CLOSED',
      openedAt: '0',
      consecutiveFailures: '0',
      errorWindowStart: '0',
      errorWindowCount: '0',
      errorWindowFailureCount: '0',
      healthCheckSuccesses: '0',
      halfOpenSuccessCount: '0',
      halfOpenFailureCount: '0',
    });
    circuitBreakerState.set({ provider: this.provider }, STATE_LABEL.CLOSED);
    logger.info({ provider: this.provider }, 'CircuitBreaker: transitioned to CLOSED');
  }
}

const instances = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(provider: string): CircuitBreaker {
  let cb = instances.get(provider);
  if (!cb) {
    cb = new CircuitBreaker(provider);
    instances.set(provider, cb);
  }
  return cb;
}
