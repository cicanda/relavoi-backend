import { getDb } from '../config/database';
import { logger } from '../utils/logger';

interface PricingRow {
  tier: 'STARTER' | 'GROWTH' | 'ENTERPRISE';
  metric: string;
  unit_price_ngn: string; // decimal as string for accuracy
  included_quantity: number;
}

/**
 * Per-tier pricing in NGN. Each tier has 5 metered metrics:
 *   - session_created
 *   - call_minute
 *   - sms_sent
 *   - sms_received
 *   - number_rental (monthly per number)
 *
 * Pricing decreases as tier increases.
 */
const PRICING: PricingRow[] = [
  // STARTER (cheapest baseline, smaller allowances)
  { tier: 'STARTER', metric: 'session_created', unit_price_ngn: '0', included_quantity: 100 },
  { tier: 'STARTER', metric: 'call_minute', unit_price_ngn: '8.00', included_quantity: 1000 },
  { tier: 'STARTER', metric: 'sms_sent', unit_price_ngn: '4.00', included_quantity: 500 },
  { tier: 'STARTER', metric: 'sms_received', unit_price_ngn: '0', included_quantity: 0 },
  { tier: 'STARTER', metric: 'number_rental', unit_price_ngn: '500.00', included_quantity: 2 },

  // GROWTH (mid-tier, lower unit prices + larger allowances)
  { tier: 'GROWTH', metric: 'session_created', unit_price_ngn: '0', included_quantity: 1000 },
  { tier: 'GROWTH', metric: 'call_minute', unit_price_ngn: '6.50', included_quantity: 10_000 },
  { tier: 'GROWTH', metric: 'sms_sent', unit_price_ngn: '3.20', included_quantity: 5_000 },
  { tier: 'GROWTH', metric: 'sms_received', unit_price_ngn: '0', included_quantity: 0 },
  { tier: 'GROWTH', metric: 'number_rental', unit_price_ngn: '450.00', included_quantity: 10 },

  // ENTERPRISE (best unit pricing, largest allowances)
  { tier: 'ENTERPRISE', metric: 'session_created', unit_price_ngn: '0', included_quantity: 10_000 },
  { tier: 'ENTERPRISE', metric: 'call_minute', unit_price_ngn: '5.00', included_quantity: 100_000 },
  { tier: 'ENTERPRISE', metric: 'sms_sent', unit_price_ngn: '2.50', included_quantity: 50_000 },
  { tier: 'ENTERPRISE', metric: 'sms_received', unit_price_ngn: '0', included_quantity: 0 },
  { tier: 'ENTERPRISE', metric: 'number_rental', unit_price_ngn: '400.00', included_quantity: 50 },
];

export async function runPricingSeed(): Promise<void> {
  const db = getDb();
  logger.info({ rows: PRICING.length }, 'pricing-seed: upserting tier_pricing');

  for (const row of PRICING) {
    await db('tier_pricing')
      .insert({
        tier: row.tier,
        metric: row.metric,
        unit_price_ngn: row.unit_price_ngn,
        included_quantity: row.included_quantity,
        currency: 'NGN',
        updated_at: new Date(),
      })
      .onConflict(['tier', 'metric'])
      .merge();
  }

  logger.info('pricing-seed: complete');
}
