import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { getDb } from '../config/database';
import { getRedis } from '../config/redis';
import { logger } from '../utils/logger';

const TENANT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TENANT_NAME = 'Chowdeck';
const BILLING_EMAIL = 'dev@chowdeck.com';
const DEV_API_KEY = 'sk_test_relavoi_dev_0123456789abcdef';
const DEV_API_SECRET = 'secret_test_relavoi_dev_fedcba9876543210';

const TENANT_USER_EMAIL = 'dev@chowdeck.com';
const TENANT_USER_PASSWORD = 'password123';
const TENANT_USER_NAME = 'Adaeze Okafor';

const OPERATOR_EMAIL = 'admin@relavoi.com';
const OPERATOR_PASSWORD = 'admin123';
const OPERATOR_NAME = 'Olu Kalubridge';

const PROXY_COUNT = 10;
const PROXY_REGION = 'lagos';
const PROXY_PROVIDER = 'AFRICASTALKING';

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export async function runDevSeed(): Promise<void> {
  const db = getDb();
  const redis = getRedis();

  // Wipe in FK-safe order — preserve tier_pricing (separate seed) and operators (we re-upsert)
  const wipeOrder = [
    'audit_log',
    'webhook_delivery_logs',
    'usage_records',
    'webhook_dlq',
    'device_tokens',
    'sms_records',
    'call_records',
    'sessions',
    'billing_periods',
    'tenant_users',
  ];
  for (const table of wipeOrder) {
    try {
      await db(table).del();
    } catch (err) {
      logger.warn({ err, table }, 'wipe: skipping (table may not exist)');
    }
  }
  // tenants has a FK from billing_periods; we cleared billing_periods first
  // but tenants.current_billing_period_id may still reference a now-gone row — null it
  try {
    await db('tenants').update({ current_billing_period_id: null });
    await db('tenants').del();
  } catch (err) {
    logger.warn({ err }, 'wipe: tenants');
  }
  try {
    await db('proxy_numbers').del();
  } catch (err) {
    logger.warn({ err }, 'wipe: proxy_numbers');
  }

  // Clear Redis pool sets for clean slate
  try {
    await redis.del(`pool:${PROXY_REGION}:available`);
    await redis.del(`pool:${PROXY_REGION}:${PROXY_PROVIDER}:available`);
  } catch (err) {
    logger.warn({ err }, 'wipe: redis pool');
  }

  // ─── Tenant ─────────────────────────────────────────────────────────────────
  const apiKeyHash = sha256(DEV_API_KEY);
  const apiSecretHash = await bcrypt.hash(DEV_API_SECRET, 10);

  await db('tenants').insert({
    id: TENANT_ID,
    name: TENANT_NAME,
    api_key_hash: apiKeyHash,
    api_secret_hash: apiSecretHash,
    billing_email: BILLING_EMAIL,
    tier: 'GROWTH',
    workspace_slug: 'chowdeck',
    country: 'NG',
    industry: 'Delivery',
    default_session_ttl_min: 120,
    cooldown_min: 5,
    requested_pool_size: 250,
    onboarding_metadata: JSON.stringify({
      expectedSessionsPerDay: '2,000-5,000',
      avgSessionLifespan: '1-3h',
      regions: ['Lagos', 'Abuja', 'Port Harcourt'],
      useCaseDetail: 'Delivery',
    }),
    push_enabled: true,
    push_title_template: 'Incoming Call',
    push_body_template: 'You are receiving a call from Chowdeck',
    billing_currency: 'NGN',
  });

  // ─── Tenant user (OWNER) ────────────────────────────────────────────────────
  const tenantUserPasswordHash = await bcrypt.hash(TENANT_USER_PASSWORD, 10);
  const [tenantUser] = await db('tenant_users')
    .insert({
      tenant_id: TENANT_ID,
      email: TENANT_USER_EMAIL,
      password_hash: tenantUserPasswordHash,
      name: TENANT_USER_NAME,
      role: 'OWNER',
      is_active: true,
    })
    .returning(['id']);

  // ─── Proxy numbers + Redis pool ─────────────────────────────────────────────
  // +2348000000001 through +2348000000010 (E.164: +234 + 8000000 + 3-digit suffix)
  const cleanNumbers = Array.from({ length: PROXY_COUNT }, (_, idx) => {
    const suffix = (idx + 1).toString().padStart(3, '0');
    return `+2348000000${suffix}`;
  });

  await db('proxy_numbers').insert(
    cleanNumbers.map((number) => ({
      number,
      region: PROXY_REGION,
      provider: PROXY_PROVIDER,
      status: 'AVAILABLE',
    })),
  );

  // Populate Redis pool set (the call-router + number-pool read from this)
  await redis.sadd(`pool:${PROXY_REGION}:available`, ...cleanNumbers);
  await redis.sadd(`pool:${PROXY_REGION}:${PROXY_PROVIDER}:available`, ...cleanNumbers);

  // ─── Operator (ROOT) ────────────────────────────────────────────────────────
  const operatorPasswordHash = await bcrypt.hash(OPERATOR_PASSWORD, 10);
  const existingOp = await db('operators').where({ email: OPERATOR_EMAIL }).first();
  let operatorId: string;
  if (existingOp) {
    operatorId = existingOp.id;
    await db('operators').where({ id: operatorId }).update({
      password_hash: operatorPasswordHash,
      name: OPERATOR_NAME,
      role: 'ROOT',
      is_active: true,
    });
  } else {
    const [op] = await db('operators')
      .insert({
        email: OPERATOR_EMAIL,
        password_hash: operatorPasswordHash,
        name: OPERATOR_NAME,
        role: 'ROOT',
        is_active: true,
      })
      .returning(['id']);
    operatorId = op.id;
  }

  // ─── Consent audit_log entries ──────────────────────────────────────────────
  await db('audit_log').insert([
    {
      actor_type: 'tenant',
      actor_id: tenantUser.id,
      action: 'consent.accepted',
      resource_type: 'tenant',
      resource_id: TENANT_ID,
      details: JSON.stringify({
        document: 'terms_of_service',
        version: '2026-01-01',
        acceptedAt: new Date().toISOString(),
      }),
    },
    {
      actor_type: 'tenant',
      actor_id: tenantUser.id,
      action: 'consent.accepted',
      resource_type: 'tenant',
      resource_id: TENANT_ID,
      details: JSON.stringify({
        document: 'ndpr_dpa',
        version: '2026-01-01',
        acceptedAt: new Date().toISOString(),
        scope: 'Phone-number masking + call recording with consent prompt',
      }),
    },
    {
      actor_type: 'tenant',
      actor_id: tenantUser.id,
      action: 'consent.accepted',
      resource_type: 'tenant',
      resource_id: TENANT_ID,
      details: JSON.stringify({
        document: 'ncc_type_approval_acknowledgement',
        version: '2026-01-01',
        acceptedAt: new Date().toISOString(),
        cpaasProvider: 'Africa\'s Talking',
      }),
    },
  ]);

  // ─── Console summary ────────────────────────────────────────────────────────
  /* eslint-disable no-console */
  console.log('\n========== Relavoi dev seed complete ==========');
  console.log(`  Tenant:           ${TENANT_NAME} (${TENANT_ID})`);
  console.log(`  Workspace slug:   chowdeck`);
  console.log(`  Tier:             GROWTH`);
  console.log(`  API Key:          ${DEV_API_KEY}`);
  console.log(`  API Secret:       ${DEV_API_SECRET}`);
  console.log('');
  console.log(`  Dashboard login:  ${TENANT_USER_EMAIL} / ${TENANT_USER_PASSWORD}`);
  console.log(`  Admin login:      ${OPERATOR_EMAIL} / ${OPERATOR_PASSWORD}`);
  console.log('');
  console.log(`  Proxy numbers:    ${cleanNumbers.length} (${cleanNumbers[0]} … ${cleanNumbers[cleanNumbers.length - 1]})`);
  console.log(`  Region/Provider:  ${PROXY_REGION} / ${PROXY_PROVIDER}`);
  console.log(`  Consent entries:  3 (ToS, NDPR DPA, NCC type-approval)`);
  console.log('===============================================\n');
  /* eslint-enable no-console */

  logger.info({ tenantId: TENANT_ID, tenantName: TENANT_NAME }, 'dev seed complete');
}
