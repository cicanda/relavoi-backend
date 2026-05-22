import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  // Runtime
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SERVICE_MODE: z.enum(['api', 'webhook', 'worker']).default('api'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_PREFIX: z.string().default('relavoi:'),

  // Auth / Crypto
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRY: z.string().default('15m'),
  ENCRYPTION_MASTER_KEY: z.string().min(64, 'ENCRYPTION_MASTER_KEY must be at least 64 characters'),

  // Africa's Talking
  AT_API_KEY: z.string().min(1, 'AT_API_KEY is required'),
  AT_USERNAME: z.string().default('sandbox'),
  AT_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),

  // Twilio (optional)
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),

  // Firebase (optional)
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),

  // Webhooks
  WEBHOOK_BASE_URL: z.string().url().default('https://api.relavoi.com'),
  WEBHOOK_HMAC_ALGO: z.string().default('sha256'),

  // Number Pool
  POOL_COOLDOWN_MINUTES: z.coerce.number().int().nonnegative().default(5),
  POOL_LOW_THRESHOLD_PERCENT: z.coerce.number().min(0).max(100).default(20),
  POOL_AUTO_PROVISION_THRESHOLD_PERCENT: z.coerce.number().min(0).max(100).default(20),

  // Session
  SESSION_DEFAULT_GRACE_PERIOD_MINUTES: z.coerce.number().int().nonnegative().default(15),
  SESSION_DEFAULT_MAX_DURATION_MINUTES: z.coerce.number().int().positive().default(120),
  SESSION_EXPIRY_CHECK_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),

  // Circuit Breaker (per architecture spec: 5 failures or >10% err rate in 2-min window)
  CB_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  CB_ERROR_RATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.1),
  CB_ERROR_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(120),
  CB_HEALTH_CHECK_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  CB_RECOVERY_CHECK_COUNT: z.coerce.number().int().positive().default(5),
  CB_HALF_OPEN_TRAFFIC_PERCENT: z.coerce.number().min(0).max(100).default(10),

  // Load test
  LOAD_TEST_MODE: z.coerce.boolean().default(false),
});

export type Config = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config: Config = parsed.data;
