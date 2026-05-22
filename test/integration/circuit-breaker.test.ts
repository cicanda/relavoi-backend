/**
 * Integration tests: CIRCUIT BREAKER service.
 *
 * Exercises the breaker class directly (no HTTP layer) against the real Redis
 * test namespace. Each test uses a unique provider name to avoid cross-test
 * contamination of the persisted state hash.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CircuitBreaker } from '../../src/services/circuit-breaker';
import { getRedis, disconnectRedis } from '../../src/config/redis';
import { config } from '../../src/config/env';

/**
 * Return a freshly-keyed CircuitBreaker. We use a per-test unique provider name
 * so state isolation is automatic, then defensively wipe the key in case a
 * previous run aborted mid-test.
 */
async function freshBreaker(label: string): Promise<{ cb: CircuitBreaker; provider: string }> {
  const provider = `test-cb-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const redis = getRedis();
  // getRedis() applies REDIS_PREFIX automatically — pass the unprefixed key.
  await redis.del(`cb:${provider}`);
  const cb = new CircuitBreaker(provider);
  return { cb, provider };
}

describe('CIRCUIT BREAKER', () => {
  beforeAll(() => {
    // Touch Redis to ensure connection happens early.
    getRedis();
  });

  afterAll(async () => {
    await disconnectRedis();
  });

  // ── a ────────────────────────────────────────────────────────────────────
  it('Starts in CLOSED', async () => {
    const { cb } = await freshBreaker('starts-closed');
    expect(await cb.getState()).toBe('CLOSED');
    expect(await cb.canRequest()).toBe(true);
  });

  // ── b ────────────────────────────────────────────────────────────────────
  it('OPEN after threshold failures', async () => {
    const { cb } = await freshBreaker('open-on-threshold');
    for (let i = 0; i < config.CB_FAILURE_THRESHOLD; i++) {
      await cb.recordFailure(new Error(`probe-${i}`));
    }
    expect(await cb.getState()).toBe('OPEN');
    expect(await cb.canRequest()).toBe(false);
  });

  // ── c ────────────────────────────────────────────────────────────────────
  it('OPEN -> HALF_OPEN after health checks', async () => {
    const { cb } = await freshBreaker('open-to-half');
    // Trip it.
    for (let i = 0; i < config.CB_FAILURE_THRESHOLD; i++) {
      await cb.recordFailure(new Error('boom'));
    }
    expect(await cb.getState()).toBe('OPEN');

    for (let i = 0; i < config.CB_RECOVERY_CHECK_COUNT; i++) {
      await cb.recordHealthCheckSuccess();
    }
    expect(await cb.getState()).toBe('HALF_OPEN');
  });

  // ── d ────────────────────────────────────────────────────────────────────
  it('~10% traffic admitted in HALF_OPEN', async () => {
    const { cb } = await freshBreaker('half-open-traffic');
    await cb.forceState('HALF_OPEN');

    const trials = 1000;
    let admitted = 0;
    for (let i = 0; i < trials; i++) {
      if (await cb.canRequest()) admitted++;
    }
    // Configured at 10% — 100 expected. Allow generous variance for randomness.
    expect(admitted).toBeGreaterThanOrEqual(40);
    expect(admitted).toBeLessThanOrEqual(160);
  });

  // ── e ────────────────────────────────────────────────────────────────────
  it('HALF_OPEN -> OPEN on single failure', async () => {
    const { cb } = await freshBreaker('half-to-open');
    await cb.forceState('HALF_OPEN');
    await cb.recordFailure(new Error('probe-fail'));
    expect(await cb.getState()).toBe('OPEN');
  });

  // ── f ────────────────────────────────────────────────────────────────────
  // CRITICAL: this verifies the transitionToHalfOpen() bug fix. We MUST get to
  // HALF_OPEN via the natural path (OPEN + 5 health checks) so that the private
  // transitionToHalfOpen zeros out the pre-trip error window. Without that fix,
  // the old failure counters poison the recovery rate and the breaker would
  // transition back to OPEN instead of CLOSED.
  it('HALF_OPEN -> CLOSED on sustained success', async () => {
    const { cb } = await freshBreaker('half-to-closed');

    // Step 1: trip the breaker (loads up error_window failure counters).
    for (let i = 0; i < config.CB_FAILURE_THRESHOLD; i++) {
      await cb.recordFailure(new Error('outage'));
    }
    expect(await cb.getState()).toBe('OPEN');

    // Step 2: natural OPEN → HALF_OPEN via health checks. This is the codepath
    // that must zero out error_window; otherwise recoveries are poisoned.
    for (let i = 0; i < config.CB_RECOVERY_CHECK_COUNT; i++) {
      await cb.recordHealthCheckSuccess();
    }
    expect(await cb.getState()).toBe('HALF_OPEN');

    // Step 3: sustained successes — feed CB_RECOVERY_CHECK_COUNT successful
    // probes. With success rate > 95%, breaker should close.
    for (let i = 0; i < config.CB_RECOVERY_CHECK_COUNT; i++) {
      await cb.recordSuccess();
    }
    expect(await cb.getState()).toBe('CLOSED');
  });

  // ── g ────────────────────────────────────────────────────────────────────
  it('Success resets failure count', async () => {
    const { cb } = await freshBreaker('success-resets');
    await cb.recordFailure(new Error('a'));
    await cb.recordFailure(new Error('b'));
    await cb.recordFailure(new Error('c'));
    // Successful call resets consecutiveFailures while CLOSED.
    await cb.recordSuccess();
    await cb.recordFailure(new Error('d'));
    await cb.recordFailure(new Error('e'));
    await cb.recordFailure(new Error('f'));
    await cb.recordFailure(new Error('g'));
    // Total: 7 failures, but never 5 IN A ROW (interrupted by a success at #4).
    // So consecutive counter resets to 0 after the success and only reached 4
    // after that. Breaker should still be CLOSED.
    expect(await cb.getState()).toBe('CLOSED');
  });

  // ── h ────────────────────────────────────────────────────────────────────
  it('Health checks ignored when CLOSED', async () => {
    const { cb } = await freshBreaker('health-noop-closed');
    expect(await cb.getState()).toBe('CLOSED');
    for (let i = 0; i < 10; i++) {
      await cb.recordHealthCheckSuccess();
    }
    expect(await cb.getState()).toBe('CLOSED');
    expect(await cb.canRequest()).toBe(true);
  });
});
