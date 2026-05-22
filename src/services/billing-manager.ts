import { randomUUID } from 'crypto';
import { getDb } from '../config/database';
import { logger } from '../utils/logger';

export type BillingMetric =
  | 'session_created'
  | 'call_minute'
  | 'sms_sent'
  | 'sms_received'
  | 'number_rental';

export interface UsageSummary {
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  metrics: Record<BillingMetric, number>;
  totalEvents: number;
}

export interface UsageEventRow {
  id: string;
  tenant_id: string;
  metric: BillingMetric;
  quantity: number;
  created_at: Date;
}

const ALL_METRICS: BillingMetric[] = [
  'session_created',
  'call_minute',
  'sms_sent',
  'sms_received',
  'number_rental',
];

function emptyMetrics(): Record<BillingMetric, number> {
  return ALL_METRICS.reduce<Record<BillingMetric, number>>(
    (acc, m) => {
      acc[m] = 0;
      return acc;
    },
    {} as Record<BillingMetric, number>,
  );
}

export class BillingManager {
  /**
   * Record a usage event. Fire-and-forget — never throws. Billing data is
   * eventually consistent; we'd rather lose a metric than fail a customer
   * call.
   */
  async recordUsage(tenantId: string, metric: BillingMetric, quantity: number = 1): Promise<void> {
    try {
      if (!tenantId) return;
      if (!Number.isFinite(quantity) || quantity <= 0) return;

      const db = getDb();
      await db('usage_records').insert({
        id: randomUUID(),
        tenant_id: tenantId,
        metric,
        quantity,
        created_at: new Date(),
      });
    } catch (err) {
      logger.warn({ err, tenantId, metric }, 'BillingManager.recordUsage failed (swallowed)');
    }
  }

  async getUsageSummary(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<UsageSummary> {
    const metrics = emptyMetrics();
    let totalEvents = 0;

    try {
      const db = getDb();
      const rows = await db('usage_records')
        .select('metric')
        .sum<{ metric: BillingMetric; sum: string }[]>('quantity as sum')
        .count<{ metric: BillingMetric; sum: string; count: string }[]>('* as count')
        .where({ tenant_id: tenantId })
        .andWhere('created_at', '>=', periodStart)
        .andWhere('created_at', '<', periodEnd)
        .groupBy('metric');

      for (const r of rows as Array<{ metric: BillingMetric; sum: string; count: string }>) {
        const m = r.metric;
        if (ALL_METRICS.includes(m)) {
          metrics[m] = Number(r.sum ?? 0);
        }
        totalEvents += Number(r.count ?? 0);
      }
    } catch (err) {
      logger.error({ err, tenantId }, 'BillingManager.getUsageSummary failed');
    }

    return { tenantId, periodStart, periodEnd, metrics, totalEvents };
  }

  async getUsageEvents(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date,
    metric?: BillingMetric,
    limit: number = 100,
    offset: number = 0,
  ): Promise<UsageEventRow[]> {
    try {
      const db = getDb();
      const query = db<UsageEventRow>('usage_records')
        .where({ tenant_id: tenantId })
        .andWhere('created_at', '>=', periodStart)
        .andWhere('created_at', '<', periodEnd)
        .orderBy('created_at', 'desc')
        .limit(Math.min(Math.max(limit, 1), 1000))
        .offset(Math.max(offset, 0));
      if (metric) query.andWhere({ metric });
      return await query;
    } catch (err) {
      logger.error({ err, tenantId }, 'BillingManager.getUsageEvents failed');
      return [];
    }
  }
}

let instance: BillingManager | null = null;
export function getBillingManager(): BillingManager {
  if (!instance) instance = new BillingManager();
  return instance;
}
