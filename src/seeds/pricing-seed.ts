import { getDb } from '../config/database';
import { logger } from '../utils/logger';

interface PricingRow {
  tier: 'STARTER' | 'GROWTH' | 'ENTERPRISE';
  metric: string;
  unit_price: string;          // NGN per unit (decimal as string for accuracy)
  included_quantity: number;   // included free per billing period
  overage_price: string | null; // per-unit price beyond included; null = same as unit_price
}

/**
 * Per-tier pricing in NGN. Each tier has 5 metered metrics:
 *   - session_created
 *   - call_minute
 *   - sms_sent
 *   - sms_received
 *   - number_rental (monthly per number)
 *
 * Pricing decreases as tier increases; included allowances increase.
 */
const PRICING: PricingRow[] = [
  // STARTER
  { tier: 'STARTER', metric: 'session_created', unit_price: '0',      included_quantity: 100,    overage_price: '5.00' },
  { tier: 'STARTER', metric: 'call_minute',     unit_price: '8.00',   included_quantity: 1_000,  overage_price: '8.00' },
  { tier: 'STARTER', metric: 'sms_sent',        unit_price: '4.00',   included_quantity: 500,    overage_price: '4.00' },
  { tier: 'STARTER', metric: 'sms_received',    unit_price: '0',      included_quantity: 0,      overage_price: null },
  { tier: 'STARTER', metric: 'number_rental',   unit_price: '500.00', included_quantity: 2,      overage_price: '500.00' },

  // GROWTH
  { tier: 'GROWTH', metric: 'session_created', unit_price: '0',      included_quantity: 1_000,   overage_price: '3.00' },
  { tier: 'GROWTH', metric: 'call_minute',     unit_price: '6.50',   included_quantity: 10_000,  overage_price: '6.50' },
  { tier: 'GROWTH', metric: 'sms_sent',        unit_price: '3.20',   included_quantity: 5_000,   overage_price: '3.20' },
  { tier: 'GROWTH', metric: 'sms_received',    unit_price: '0',      included_quantity: 0,       overage_price: null },
  { tier: 'GROWTH', metric: 'number_rental',   unit_price: '450.00', included_quantity: 10,      overage_price: '450.00' },

  // ENTERPRISE
  { tier: 'ENTERPRISE', metric: 'session_created', unit_price: '0',      included_quantity: 10_000,  overage_price: '1.00' },
  { tier: 'ENTERPRISE', metric: 'call_minute',     unit_price: '5.00',   included_quantity: 100_000, overage_price: '5.00' },
  { tier: 'ENTERPRISE', metric: 'sms_sent',        unit_price: '2.50',   included_quantity: 50_000,  overage_price: '2.50' },
  { tier: 'ENTERPRISE', metric: 'sms_received',    unit_price: '0',      included_quantity: 0,       overage_price: null },
  { tier: 'ENTERPRISE', metric: 'number_rental',   unit_price: '400.00', included_quantity: 50,      overage_price: '400.00' },
];

/**
 * Insert one currently-active row per (tier, metric).
 *
 * The schema uses (tier, metric, effective_from) as the unique key to support
 * historical pricing. For seeding we close out any prior open row, then insert
 * a fresh active row.
 */
export async function runPricingSeed(): Promise<void> {
  const db = getDb();
  logger.info({ rows: PRICING.length }, 'pricing-seed: refreshing tier_pricing');

  const now = new Date();

  // Close out any currently-active rows (effective_until IS NULL) so this seed
  // is the new source of truth without violating the unique constraint.
  await db('tier_pricing').whereNull('effective_until').update({ effective_until: now });

  for (const row of PRICING) {
    await db('tier_pricing').insert({
      tier: row.tier,
      metric: row.metric,
      unit_price: row.unit_price,
      included_quantity: row.included_quantity,
      overage_price: row.overage_price,
      currency: 'NGN',
      effective_from: now,
      effective_until: null,
    });
  }

  logger.info('pricing-seed: complete');
}
