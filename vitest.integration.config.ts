import { defineConfig } from 'vitest/config';
import path from 'path';

// Set env BEFORE any module loads (config/env.ts is parsed on first import).
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';
process.env.DATABASE_URL = 'postgresql://relavoi:relavoi_dev@localhost:5432/relavoi_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.REDIS_PREFIX = 'relavoi_test:';
process.env.JWT_SECRET = 'test-jwt-secret-minimum-32-characters-long';
process.env.ENCRYPTION_MASTER_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.AT_API_KEY = 'test_key';
process.env.AT_USERNAME = 'sandbox';
process.env.AT_ENVIRONMENT = 'sandbox';
process.env.WEBHOOK_BASE_URL = 'http://localhost:8080/v1/webhooks/cpaas';
process.env.POOL_COOLDOWN_MINUTES = '0';
process.env.SESSION_EXPIRY_CHECK_INTERVAL_SECONDS = '9999';
process.env.LOAD_TEST_MODE = 'true'; // bypass per-tenant rate limit during tests

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: false, // tests share the relavoi_test database
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
