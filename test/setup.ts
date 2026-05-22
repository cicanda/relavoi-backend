/**
 * Vitest global setup for unit tests.
 *
 * Stubs all required env vars so that importing `src/config/env` does not
 * abort the process. Unit tests must NOT hit real Postgres/Redis/CPaaS —
 * they should mock those calls.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/relavoi_test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.REDIS_PREFIX = process.env.REDIS_PREFIX ?? 'relavoi-test:';

// JWT secret must be >= 32 chars
process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? 'test-jwt-secret-must-be-at-least-32-characters-long-aaaa';

// Encryption master key must be >= 64 chars
process.env.ENCRYPTION_MASTER_KEY =
  process.env.ENCRYPTION_MASTER_KEY ??
  'test-encryption-master-key-must-be-at-least-64-characters-long-for-validation-aaaaaaaaaa';

process.env.AT_API_KEY = process.env.AT_API_KEY ?? 'test-at-api-key';
process.env.AT_USERNAME = process.env.AT_USERNAME ?? 'sandbox';

// Firebase placeholders
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? 'test-project';
process.env.FIREBASE_CLIENT_EMAIL =
  process.env.FIREBASE_CLIENT_EMAIL ?? 'test@test-project.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY =
  process.env.FIREBASE_PRIVATE_KEY ??
  '-----BEGIN PRIVATE KEY-----\nMIIBV...placeholder...AKEY\n-----END PRIVATE KEY-----\n';
