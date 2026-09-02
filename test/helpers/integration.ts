/**
 * Shared integration-test helpers.
 *
 * Every integration test boots its own Fastify app (no workers, no event bus)
 * against the relavoi_test Postgres DB and the test-prefixed Redis namespace.
 * The helper exposes setup/teardown primitives and seeding shortcuts so each
 * spec file stays focused on the behaviour it's exercising.
 */
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import Fastify, { type FastifyInstance } from 'fastify';
import knex, { type Knex } from 'knex';
import { Client as PgClient } from 'pg';
import { logger } from '../../src/utils/logger';
import { config } from '../../src/config/env';
import { getRedis, disconnectRedis } from '../../src/config/redis';
import knexConfig from '../../src/config/knexfile';

export const TEST_TENANT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
export const TEST_TENANT_NAME = 'Chowdeck Test';
export const TEST_API_KEY = 'sk_test_relavoi_dev_0123456789abcdef';
export const TEST_API_SECRET = 'secret_test_relavoi_dev_fedcba9876543210';
export const TEST_USER_EMAIL = 'dev@chowdeck.test';
export const TEST_USER_PASSWORD = 'password123';
export const TEST_USER_NAME = 'Adaeze Test';
export const TEST_OPERATOR_EMAIL = 'admin@relavoi.test';
export const TEST_OPERATOR_PASSWORD = 'admin123';

const FK_SAFE_WIPE_ORDER = [
  'audit_log',
  'webhook_delivery_logs',
  'webhook_logs',
  'usage_records',
  'webhook_dlq',
  'device_tokens',
  'sms_records',
  'call_records',
  'sessions',
  'billing_periods',
  'tenant_users',
];

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Ensure the relavoi_test database exists. Connects to the default `postgres`
 * DB to issue CREATE DATABASE if missing.
 */
export async function ensureTestDatabase(): Promise<void> {
  const url = new URL(config.DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `ensureTestDatabase refused: DATABASE_URL points at "${dbName}", which doesn't end in _test`,
    );
  }
  const adminUrl = new URL(config.DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new PgClient({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      // CREATE DATABASE can't run inside a transaction; pg-driver handles this.
      await admin.query(`CREATE DATABASE "${dbName}"`);
      logger.info({ dbName }, 'created test database');
    }
  } finally {
    await admin.end();
  }
}

/**
 * Run knex.migrate.latest against the test DB. Idempotent — safe to call
 * repeatedly across spec files.
 */
export async function runTestMigrations(): Promise<void> {
  const db = knex(knexConfig.test);
  try {
    await db.migrate.latest();
  } finally {
    await db.destroy();
  }
}

/**
 * Truncate all tables in FK-safe order and flush the test Redis namespace.
 */
export async function cleanTables(db: Knex): Promise<void> {
  for (const t of FK_SAFE_WIPE_ORDER) {
    try {
      await db(t).del();
    } catch {
      /* table may not exist on first run */
    }
  }
  // tenants is referenced by billing_periods + many others; null FK first
  await db('tenants').update({ current_billing_period_id: null }).catch(() => {});
  await db('tenants').del().catch(() => {});
  await db('operators').del().catch(() => {});
  await db('proxy_numbers').del().catch(() => {});

  // Flush every prefixed key. ioredis doesn't auto-prefix SCAN MATCH patterns,
  // so spell out the prefix explicitly and strip it back before DEL.
  const redis = getRedis();
  const prefix = config.REDIS_PREFIX;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) {
      const unprefixed = keys.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k));
      await redis.del(...unprefixed);
    }
  } while (cursor !== '0');
}

/**
 * Reset only session-related state (sessions, call_records, sms_records,
 * proxy_numbers status, Redis session/pool keys). Faster than a full clean.
 */
export async function resetSessionState(db: Knex, opts: { region?: string; provider?: string } = {}): Promise<void> {
  const region = opts.region ?? 'lagos';
  const provider = opts.provider ?? 'AFRICASTALKING';

  await db('audit_log').del().catch(() => {});
  await db('usage_records').del().catch(() => {});
  await db('webhook_dlq').del().catch(() => {});
  await db('sms_records').del().catch(() => {});
  await db('call_records').del().catch(() => {});
  await db('sessions').del().catch(() => {});

  await db('proxy_numbers')
    .update({ status: 'AVAILABLE', cooldown_until: null, last_used_at: null })
    .catch(() => {});

  // Flush only session/proxy/phone keys, not pool/tenant config we still need.
  // ioredis applies keyPrefix to keys passed to DEL but NOT to SCAN MATCH
  // patterns — so include the prefix in the pattern explicitly and strip
  // it back off before passing to DEL.
  const redis = getRedis();
  const prefix = config.REDIS_PREFIX;
  const patterns = ['session:*', 'proxy:*', 'phone:*', 'webhook:dedup:*', 'call:active:*'];
  for (const p of patterns) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}${p}`, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) {
        const unprefixed = keys.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k));
        await redis.del(...unprefixed);
      }
    } while (cursor !== '0');
  }

  // Re-sync the pool from DB into Redis
  const rows: Array<{ number: string }> = await db('proxy_numbers')
    .where({ region, provider, status: 'AVAILABLE' })
    .select('number');
  if (rows.length > 0) {
    const nums = rows.map((r) => r.number);
    await redis.del(`pool:${region}:available`, `pool:${region}:${provider}:available`);
    await redis.sadd(`pool:${region}:available`, ...nums);
    await redis.sadd(`pool:${region}:${provider}:available`, ...nums);
  }
}

/**
 * Seed the canonical test tenant + tenant_user (OWNER).
 * Returns the inserted tenantId and userId.
 */
export async function seedTestTenant(db: Knex): Promise<{ tenantId: string; userId: string }> {
  const apiKeyHash = sha256(TEST_API_KEY);
  const apiSecretHash = await bcrypt.hash(TEST_API_SECRET, 4); // low cost for tests
  await db('tenants').insert({
    id: TEST_TENANT_ID,
    name: TEST_TENANT_NAME,
    api_key_hash: apiKeyHash,
    api_secret_hash: apiSecretHash,
    billing_email: TEST_USER_EMAIL,
    tier: 'GROWTH',
    workspace_slug: `chowdeck-test-${Date.now()}`,
    country: 'NG',
    industry: 'Delivery',
    default_session_ttl_min: 120,
    cooldown_min: 0,
    push_enabled: true,
  });

  const passwordHash = await bcrypt.hash(TEST_USER_PASSWORD, 4);
  const [user] = await db('tenant_users')
    .insert({
      tenant_id: TEST_TENANT_ID,
      email: `${Date.now()}-${TEST_USER_EMAIL}`, // unique per spec run to dodge global unique constraint
      password_hash: passwordHash,
      name: TEST_USER_NAME,
      role: 'OWNER',
      is_active: true,
    })
    .returning(['id']);

  return { tenantId: TEST_TENANT_ID, userId: user.id };
}

/**
 * Seed the canonical test tenant with a DETERMINISTIC email
 * (no Date.now() suffix). Use only when the test specifically logs in
 * via /v1/auth/dashboard/login with TEST_USER_EMAIL.
 */
export async function seedTestTenantDeterministic(db: Knex): Promise<{ tenantId: string; userId: string }> {
  const apiKeyHash = sha256(TEST_API_KEY);
  const apiSecretHash = await bcrypt.hash(TEST_API_SECRET, 4);
  await db('tenants').insert({
    id: TEST_TENANT_ID,
    name: TEST_TENANT_NAME,
    api_key_hash: apiKeyHash,
    api_secret_hash: apiSecretHash,
    billing_email: TEST_USER_EMAIL,
    tier: 'GROWTH',
    country: 'NG',
    industry: 'Delivery',
    cooldown_min: 0,
  });

  const passwordHash = await bcrypt.hash(TEST_USER_PASSWORD, 4);
  const [user] = await db('tenant_users')
    .insert({
      tenant_id: TEST_TENANT_ID,
      email: TEST_USER_EMAIL,
      password_hash: passwordHash,
      name: TEST_USER_NAME,
      role: 'OWNER',
      is_active: true,
    })
    .returning(['id']);

  return { tenantId: TEST_TENANT_ID, userId: user.id };
}

/**
 * Seed an operator (ROOT by default). Returns inserted id.
 */
export async function seedOperator(
  db: Knex,
  opts: { email?: string; password?: string; name?: string; role?: 'ROOT' | 'SRE' | 'SUPPORT' | 'VIEWER' } = {},
): Promise<{ id: string; email: string; password: string }> {
  const email = opts.email ?? TEST_OPERATOR_EMAIL;
  const password = opts.password ?? TEST_OPERATOR_PASSWORD;
  const passwordHash = await bcrypt.hash(password, 4);
  const [op] = await db('operators')
    .insert({
      email,
      password_hash: passwordHash,
      name: opts.name ?? 'Test Operator',
      role: opts.role ?? 'ROOT',
      is_active: true,
    })
    .returning(['id']);
  return { id: op.id, email, password };
}

/**
 * Seed N proxy numbers AND populate the Redis pool sets so allocation works.
 * Returns the inserted E.164 numbers.
 */
export async function seedProxyNumbers(
  db: Knex,
  opts: { count?: number; region?: string; provider?: string; startAt?: number } = {},
): Promise<string[]> {
  const count = opts.count ?? 5;
  const region = opts.region ?? 'lagos';
  const provider = opts.provider ?? 'AFRICASTALKING';
  const startAt = opts.startAt ?? 1;

  const numbers = Array.from({ length: count }, (_, idx) => {
    const n = startAt + idx;
    const suffix = n.toString().padStart(3, '0');
    return `+2348000000${suffix}`;
  });

  await db('proxy_numbers').insert(
    numbers.map((number) => ({
      number,
      region,
      provider,
      status: 'AVAILABLE',
    })),
  );

  const redis = getRedis();
  await redis.sadd(`pool:${region}:available`, ...numbers);
  await redis.sadd(`pool:${region}:${provider}:available`, ...numbers);

  return numbers;
}

/**
 * Build a Fastify app with the same plugins + routes as src/index.ts but
 * without workers, the event bus, or the WebSocket server. Each test owns
 * its own app instance so route handlers see fresh state.
 */
export async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger, trustProxy: true });

  // Mirror production body handling (empty JSON body parsed as {}).
  const { registerJsonBodyParser } = await import('../../src/api/json-body-parser');
  registerJsonBodyParser(app);

  await app.register(import('@fastify/cors'), { origin: true });
  await app.register(import('@fastify/jwt'), { secret: config.JWT_SECRET });
  await app.register(import('@fastify/formbody'));
  await app.register(import('@fastify/rate-limit'), {
    global: false,
    max: 10_000,
    timeWindow: '1 minute',
  });

  const { healthRoutes } = await import('../../src/api/routes/health');
  const { tenantRoutes } = await import('../../src/api/routes/tenants');
  const { sessionRoutes } = await import('../../src/api/routes/sessions');
  const { webhookRoutes } = await import('../../src/api/routes/webhooks');
  const { deviceRoutes } = await import('../../src/api/routes/devices');
  const { billingRoutes } = await import('../../src/api/routes/billing');
  const { analyticsRoutes } = await import('../../src/api/routes/analytics');
  const { callRoutes } = await import('../../src/api/routes/calls');
  const { numberRoutes } = await import('../../src/api/routes/numbers');
  const { adminRoutes } = await import('../../src/api/routes/admin');

  await app.register(healthRoutes, { prefix: '/v1' });
  await app.register(tenantRoutes, { prefix: '/v1' });
  await app.register(sessionRoutes, { prefix: '/v1' });
  await app.register(webhookRoutes, { prefix: '/v1' });
  await app.register(deviceRoutes, { prefix: '/v1' });
  await app.register(billingRoutes, { prefix: '/v1' });
  await app.register(analyticsRoutes, { prefix: '/v1' });
  await app.register(callRoutes, { prefix: '/v1' });
  await app.register(numberRoutes, { prefix: '/v1' });
  await app.register(adminRoutes, { prefix: '/v1' });

  await app.ready();
  return app;
}

/**
 * Exchange the test tenant's API key+secret for an SDK JWT.
 */
export async function getSdkToken(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/token',
    payload: { apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET },
  });
  if (res.statusCode !== 200) {
    throw new Error(`getSdkToken failed: ${res.statusCode} ${res.body}`);
  }
  return (res.json() as { accessToken: string }).accessToken;
}

/**
 * Log in via /v1/auth/dashboard/login and return the dashboard JWT.
 * Assumes seedTestTenantDeterministic was used (deterministic email).
 */
export async function getDashboardToken(
  app: FastifyInstance,
  email = TEST_USER_EMAIL,
  password = TEST_USER_PASSWORD,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/dashboard/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`getDashboardToken failed: ${res.statusCode} ${res.body}`);
  }
  return (res.json() as { accessToken: string }).accessToken;
}

/**
 * Log in an operator and return the operator JWT.
 */
export async function getOperatorToken(
  app: FastifyInstance,
  email = TEST_OPERATOR_EMAIL,
  password = TEST_OPERATOR_PASSWORD,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/admin/auth/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`getOperatorToken failed: ${res.statusCode} ${res.body}`);
  }
  return (res.json() as { accessToken: string }).accessToken;
}

/**
 * Open a fresh Knex pool that the test owns. Tests must call db.destroy() in afterAll.
 */
export function openTestDb(): Knex {
  return knex(knexConfig.test);
}

export { disconnectRedis };
