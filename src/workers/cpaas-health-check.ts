import { config } from '../config/env';
import { logger } from '../utils/logger';
import { getCircuitBreaker } from '../services/circuit-breaker';

/**
 * CpaasHealthCheckWorker
 *
 * When the circuit breaker is OPEN, periodically probes the Africa's Talking
 * API to determine if upstream has recovered. On success, advances the breaker
 * toward HALF_OPEN. On failure, resets the recovery counter.
 *
 * Only runs the actual probe when the breaker is OPEN — during CLOSED state,
 * live traffic provides healthier signal than a synthetic ping, and during
 * HALF_OPEN, a percentage of real traffic is already exercising the upstream.
 */
export class CpaasHealthCheckWorker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private readonly intervalMs: number;
  private readonly provider = 'AFRICASTALKING';
  private readonly endpoint = 'https://api.africastalking.com/version1/user';

  constructor() {
    this.intervalMs = config.CB_HEALTH_CHECK_INTERVAL_SECONDS * 1000;
  }

  start(): void {
    if (this.timer) return;
    logger.info({ intervalMs: this.intervalMs }, 'CpaasHealthCheckWorker started');
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('CpaasHealthCheckWorker stopped');
    }
  }

  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const cb = getCircuitBreaker(this.provider);
      const state = await cb.getState();

      // Only probe when OPEN — that's the only state for which the health-check
      // signal matters. CLOSED uses live traffic; HALF_OPEN uses real partial traffic.
      if (state !== 'OPEN') {
        return;
      }

      const ok = await this.probe();
      if (ok) {
        await cb.recordHealthCheckSuccess();
        logger.info({ provider: this.provider }, 'CpaasHealthCheckWorker: probe ok');
      } else {
        await cb.recordFailure(new Error('Health check probe failed'));
        logger.warn({ provider: this.provider }, 'CpaasHealthCheckWorker: probe failed');
      }
    } catch (err) {
      logger.error({ err }, 'CpaasHealthCheckWorker: tick error');
    } finally {
      this.inFlight = false;
    }
  }

  private async probe(): Promise<boolean> {
    const url = `${this.endpoint}?username=${encodeURIComponent(config.AT_USERNAME)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          apiKey: config.AT_API_KEY,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      return res.status === 200;
    } catch (err) {
      logger.debug({ err }, 'CpaasHealthCheckWorker: probe network error');
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
