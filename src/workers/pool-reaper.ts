import { getDb } from '../config/database';
import { logger } from '../utils/logger';
import type { NumberPool } from '../services/number-pool';

/**
 * PoolReaperWorker
 *
 * Periodically returns proxy numbers whose cooldown has elapsed from COOLDOWN
 * back to AVAILABLE. Without this, every expired session permanently shrinks
 * the usable pool until a manual reseed. Delegates the actual move to
 * NumberPool.reapCooldown(), which keeps Redis and Postgres in sync, and runs
 * it once per region that currently has numbers provisioned.
 */
const INTERVAL_MS = 30_000;

export class PoolReaperWorker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(private readonly pool: NumberPool) {}

  start(): void {
    if (this.timer) return;
    logger.info({ intervalMs: INTERVAL_MS }, 'PoolReaperWorker started');
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('PoolReaperWorker stopped');
    }
  }

  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const db = getDb();
      const regionRows = await db('proxy_numbers').distinct('region').select('region');
      const regions = regionRows
        .map((r) => (r.region as string) ?? null)
        .filter((r): r is string => !!r);
      if (regions.length === 0) regions.push('lagos');

      let total = 0;
      for (const region of regions) {
        total += await this.pool.reapCooldown(region);
      }
      if (total > 0) {
        logger.info({ count: total }, 'PoolReaperWorker: returned numbers from cooldown');
      }
    } catch (err) {
      logger.error({ err }, 'PoolReaperWorker: tick error');
    } finally {
      this.inFlight = false;
    }
  }
}
