import { getDb } from '../config/database';
import { getRedis } from '../config/redis';
import { logger } from '../utils/logger';
import {
  numberPoolAvailable,
  numberPoolUtilization,
  webhookDlqDepth,
  activeSessionsGauge,
  circuitBreakerState,
} from '../utils/metrics';

const TICK_INTERVAL_MS = 30_000;

const STATE_TO_NUMBER: Record<string, number> = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
};

/**
 * MetricsUpdater
 *
 * Periodically polls Postgres and Redis to refresh Prometheus gauges. This
 * complements the inline metric updates done by services on hot paths — the
 * worker provides eventual consistency for gauges that need an accurate
 * point-in-time picture (pool depth, DLQ depth, active session counts).
 */
export class MetricsUpdater {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  start(): void {
    if (this.timer) return;
    logger.info({ intervalMs: TICK_INTERVAL_MS }, 'MetricsUpdater started');
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('MetricsUpdater stopped');
    }
  }

  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      await Promise.allSettled([
        this.updatePoolGauges(),
        this.updateDlqDepth(),
        this.updateActiveSessions(),
        this.updateCircuitBreakerState(),
      ]);
    } catch (err) {
      logger.error({ err }, 'MetricsUpdater: tick error');
    } finally {
      this.inFlight = false;
    }
  }

  private async updatePoolGauges(): Promise<void> {
    try {
      const db = getDb();
      const redis = getRedis();

      // Per (region, provider) totals & in_use from DB. Available we prefer
      // from Redis (the hot source of truth).
      const rows = (await db('proxy_numbers')
        .select('region', 'provider', 'status')
        .count<{ region: string; provider: string; status: string; count: string }[]>('* as count')
        .groupBy('region', 'provider', 'status')) as Array<{
        region: string;
        provider: string;
        status: string;
        count: string;
      }>;

      // Aggregate by region
      const byRegion = new Map<string, { total: number; inUse: number }>();
      const regionProviders = new Set<string>();

      for (const r of rows) {
        const region = r.region ?? 'NG';
        const provider = r.provider ?? 'AFRICASTALKING';
        regionProviders.add(`${region}::${provider}`);
        const agg = byRegion.get(region) ?? { total: 0, inUse: 0 };
        const c = Number(r.count);
        agg.total += c;
        if (r.status === 'IN_USE') agg.inUse += c;
        byRegion.set(region, agg);
      }

      // Set utilization per region
      for (const [region, agg] of byRegion.entries()) {
        const utilization = agg.total > 0 ? (agg.inUse / agg.total) * 100 : 0;
        numberPoolUtilization.set({ region }, utilization);
      }

      // Set available per (region, provider) from Redis SCARD
      for (const key of regionProviders) {
        const [region, provider] = key.split('::');
        try {
          const available = await redis.scard(`pool:${region}:available`);
          numberPoolAvailable.set({ region, provider }, available);
        } catch (err) {
          logger.debug({ err, region }, 'MetricsUpdater: redis scard failed');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'MetricsUpdater: updatePoolGauges failed');
    }
  }

  private async updateDlqDepth(): Promise<void> {
    try {
      const db = getDb();
      const result = (await db('webhook_dlq')
        .where({ status: 'PENDING' })
        .count<{ count: string }[]>('* as count')
        .first()) as { count: string } | undefined;
      const depth = Number(result?.count ?? 0);
      webhookDlqDepth.set(depth);
    } catch (err) {
      logger.warn({ err }, 'MetricsUpdater: updateDlqDepth failed');
    }
  }

  private async updateActiveSessions(): Promise<void> {
    try {
      const db = getDb();
      const rows = (await db('sessions')
        .select('tenant_id')
        .whereIn('state', ['ACTIVE', 'GRACE_PERIOD'])
        .count<{ tenant_id: string; count: string }[]>('* as count')
        .groupBy('tenant_id')) as Array<{ tenant_id: string; count: string }>;

      // Reset and re-apply
      activeSessionsGauge.reset();
      for (const r of rows) {
        activeSessionsGauge.set({ tenant_id: r.tenant_id }, Number(r.count));
      }
    } catch (err) {
      logger.warn({ err }, 'MetricsUpdater: updateActiveSessions failed');
    }
  }

  private async updateCircuitBreakerState(): Promise<void> {
    try {
      const redis = getRedis();
      const providers = ['AFRICASTALKING', 'TWILIO'];
      for (const provider of providers) {
        const hash = await redis.hgetall(`cb:${provider}`);
        const state = hash?.state;
        if (!state) continue;
        const numeric = STATE_TO_NUMBER[state] ?? 0;
        circuitBreakerState.set({ provider }, numeric);
      }
    } catch (err) {
      logger.warn({ err }, 'MetricsUpdater: updateCircuitBreakerState failed');
    }
  }
}
