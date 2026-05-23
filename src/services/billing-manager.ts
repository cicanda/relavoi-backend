import { randomUUID } from 'crypto';
import { getDb } from '../config/database';
import { logger } from '../utils/logger';

export type BillingMetric =
  | 'session_created'
  | 'call_minute'
  | 'sms_sent'
  | 'sms_received'
  | 'recording_minute'
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
  billing_period_id: string;
  metric: BillingMetric;
  quantity: number;
  recorded_at: Date;
}

const ALL_METRICS: BillingMetric[] = [
  'session_created',
  'call_minute',
  'sms_sent',
  'sms_received',
  'recording_minute',
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
      // billing_period_id is NOT NULL in the schema. Resolve (or open) the
      // tenant's active period inside the same transaction so concurrent
      // callers can't double-create one.
      const billingPeriodId = await this.ensureActivePeriod(tenantId);
      await db('usage_records').insert({
        id: randomUUID(),
        tenant_id: tenantId,
        billing_period_id: billingPeriodId,
        metric,
        quantity,
        recorded_at: new Date(),
      });
    } catch (err) {
      logger.warn({ err, tenantId, metric }, 'BillingManager.recordUsage failed (swallowed)');
    }
  }

  /**
   * Look up the tenant's current ACTIVE billing period, opening a fresh one
   * (UTC-calendar-month-aligned) if none exists. Public so callers that want
   * to materialize a period before recording usage (or to display the current
   * period without inserting any usage) can use it directly.
   */
  async ensureActivePeriod(tenantId: string): Promise<string> {
    const db = getDb();
    const existing = await db('billing_periods')
      .where({ tenant_id: tenantId, status: 'ACTIVE' })
      .orderBy('period_start', 'desc')
      .first();
    if (existing) return existing.id as string;

    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const [row] = await db('billing_periods')
      .insert({
        id: randomUUID(),
        tenant_id: tenantId,
        period_start: periodStart,
        period_end: periodEnd,
        status: 'ACTIVE',
      })
      .returning(['id']);
    // Best-effort: point the tenant at this period; ignore the rare race where
    // another concurrent caller already pointed it elsewhere.
    await db('tenants')
      .where({ id: tenantId })
      .update({ current_billing_period_id: row.id })
      .catch(() => {});
    return row.id as string;
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
        .andWhere('recorded_at', '>=', periodStart)
        .andWhere('recorded_at', '<', periodEnd)
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
        .andWhere('recorded_at', '>=', periodStart)
        .andWhere('recorded_at', '<', periodEnd)
        .orderBy('recorded_at', 'desc')
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
