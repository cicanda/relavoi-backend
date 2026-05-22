import bcrypt from 'bcrypt';
import { getDb } from '../config/database';
import { getRedis } from '../config/redis';
import { logger } from '../utils/logger';

const TENANT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TENANT_NAME = 'Test Tenant Corp';
const DEV_API_KEY = 'sk_test_relavoi_dev_0123456789abcdef';
const DEV_API_SECRET = 'secret_test_relavoi_dev_fedcba9876543210';
const TENANT_USER_EMAIL = 'adaeze@testcorp.com';
const TENANT_USER_PASSWORD = 'Test1234!';
const TENANT_USER_NAME = 'Adaeze Test';
const OPERATOR_EMAIL = 'admin@relavoi.com';
const OPERATOR_PASSWORD = 'Admin1234!';
const OPERATOR_NAME = 'Root Admin';

const BCRYPT_ROUNDS = 10;
const PROXY_PREFIX = '+234800000000';
const PROXY_COUNT = 10;
const REGION = 'NG';
const PROVIDER = 'AFRICASTALKING';

/**
 * Truncate all tenant-owned data and re-seed a known dev tenant.
 * Preserves: tier_pricing, operators (only inserts operator if missing).
 */
export async function runDevSeed(): Promise<void> {
  const db = getDb();
  const redis = getRedis();

  logger.info('dev-seed: clearing tenant-owned data');

  // Truncate in FK-safe order
  const TRUNCATE_ORDER = [
    'tenant_webhook_subscriptions',
    'billing_periods',
    'usage_records',
    'audit_log',
    'webhook_logs',
    'webhook_delivery_logs',
    'push_templates',
    'device_tokens',
    'sms_records',
    'call_records',
    'sessions',
    'proxy_numbers',
    'tenant_users',
    'tenants',
  ];

  for (const table of TRUNCATE_ORDER) {
    try {
      await db(table).del();
    } catch (err) {
      logger.warn({ err, table }, 'dev-seed: truncate failed (table may not exist yet)');
    }
  }

  // Tenant
  logger.info({ tenantId: TENANT_ID }, 'dev-seed: creating tenant');
  const apiKeyHash = await bcrypt.hash(DEV_API_KEY, BCRYPT_ROUNDS);
  const apiSecretHash = await bcrypt.hash(DEV_API_SECRET, BCRYPT_ROUNDS);

  await db('tenants').insert({
    id: TENANT_ID,
    name: TENANT_NAME,
    api_key_hash: apiKeyHash,
    api_secret_hash: apiSecretHash,
    webhook_url: null,
    webhook_secret: null,
    default_grace_period: 15,
    expired_call_behavior: 'DEAD_LINE',
    support_phone: null,
    push_config: JSON.stringify({}),
    recording_enabled: false,
    recording_consent_mode: 'DEFAULT',
    tier: 'GROWTH',
    status: 'ACTIVE',
  });

  // Tenant user
  logger.info({ email: TENANT_USER_EMAIL }, 'dev-seed: creating tenant user');
  const userPasswordHash = await bcrypt.hash(TENANT_USER_PASSWORD, BCRYPT_ROUNDS);
  await db('tenant_users').insert({
    tenant_id: TENANT_ID,
    email: TENANT_USER_EMAIL,
    password_hash: userPasswordHash,
    name: TENANT_USER_NAME,
    role: 'OWNER',
    is_active: true,
  });

  // Proxy numbers
  logger.info({ count: PROXY_COUNT }, 'dev-seed: creating proxy numbers');
  const numbers: string[] = [];
  for (let i = 0; i < PROXY_COUNT; i++) {
    numbers.push(`${PROXY_PREFIX}${i}`);
  }
  await db('proxy_numbers').insert(
    numbers.map((n) => ({
      number: n,
      region: REGION,
      provider: PROVIDER,
      status: 'AVAILABLE',
    })),
  );

  // Populate Redis available pool
  try {
    const poolKey = `pool:${REGION}:AFRICASTALKING:available`;
    const altPoolKey = `pool:${REGION}:available`;
    await redis.sadd(poolKey, ...numbers);
    await redis.sadd(altPoolKey, ...numbers);
    for (const n of numbers) {
      await redis.set(`proxy:${n}:region`, REGION);
      await redis.set(`proxy:${n}:provider`, PROVIDER);
    }
  } catch (err) {
    logger.warn({ err }, 'dev-seed: redis pool populate failed (continuing)');
  }

  // Operator — insert only if not exists
  const existingOp = await db('operators').where({ email: OPERATOR_EMAIL }).first('id');
  if (!existingOp) {
    logger.info({ email: OPERATOR_EMAIL }, 'dev-seed: creating root operator');
    const opPasswordHash = await bcrypt.hash(OPERATOR_PASSWORD, BCRYPT_ROUNDS);
    await db('operators').insert({
      email: OPERATOR_EMAIL,
      password_hash: opPasswordHash,
      name: OPERATOR_NAME,
      role: 'ROOT',
      is_active: true,
    });
  } else {
    logger.info({ email: OPERATOR_EMAIL }, 'dev-seed: operator exists, skipping');
  }

  logger.info(
    {
      tenantId: TENANT_ID,
      apiKey: DEV_API_KEY,
      apiSecret: DEV_API_SECRET,
      tenantUserEmail: TENANT_USER_EMAIL,
      tenantUserPassword: TENANT_USER_PASSWORD,
      operatorEmail: OPERATOR_EMAIL,
      operatorPassword: OPERATOR_PASSWORD,
      proxyCount: PROXY_COUNT,
      region: REGION,
    },
    'dev-seed: complete',
  );
}
