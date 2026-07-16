/**
 * Security fixes (2026-07 audit):
 *  1. CPaaS webhook HMAC signature enforcement outside sandbox
 *  3. Deactivated tenant users must not be able to log in
 *  4. GET /admin/operators requires ROOT
 *  5. Orphaned RLS on sessions disabled (no policy ever existed)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { config } from '../../src/config/env';
import {
  ensureTestDatabase,
  runTestMigrations,
  openTestDb,
  buildTestApp,
  cleanTables,
  seedTestTenantDeterministic,
  seedOperator,
  getOperatorToken,
  disconnectRedis,
  TEST_USER_EMAIL,
  TEST_USER_PASSWORD,
} from '../helpers/integration';

function signBody(body: string): string {
  return crypto.createHmac('sha256', config.AT_API_KEY).update(body, 'utf8').digest('hex');
}

async function postVoiceWebhook(
  app: FastifyInstance,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  const body = new URLSearchParams(fields).toString();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/cpaas/voice',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: body,
  });
  return { statusCode: res.statusCode, body: res.body };
}

async function postSmsWebhook(
  app: FastifyInstance,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  const body = new URLSearchParams(fields).toString();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/cpaas/sms',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: body,
  });
  return { statusCode: res.statusCode, body: res.body };
}

const VOICE_FIELDS = {
  isActive: '1',
  direction: 'Inbound',
  sessionId: 'ATVId_sec_test_1',
  callerNumber: '+2348012345678',
  destinationNumber: '+2348000000001',
};

const SMS_FIELDS = {
  id: 'ATXid_sec_test_1',
  from: '+2348012345678',
  to: '+2348000000001',
  text: 'hello',
  date: '2026-07-11 12:00:00',
};

describe('security fixes (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;

  beforeAll(async () => {
    await ensureTestDatabase();
    await runTestMigrations();
    db = openTestDb();
    await cleanTables(db);
    await seedTestTenantDeterministic(db);
    app = await buildTestApp();
  });

  afterAll(async () => {
    config.AT_ENVIRONMENT = 'sandbox';
    await app.close();
    await cleanTables(db);
    await db.destroy();
    await disconnectRedis();
  });

  describe('1. CPaaS webhook signature enforcement', () => {
    it('sandbox mode: unsigned voice webhook is accepted (200)', async () => {
      expect(config.AT_ENVIRONMENT).toBe('sandbox');
      const res = await postVoiceWebhook(app, VOICE_FIELDS);
      expect(res.statusCode).toBe(200);
    });

    it('production mode: unsigned voice webhook is rejected with 403 and empty XML', async () => {
      config.AT_ENVIRONMENT = 'production';
      try {
        const res = await postVoiceWebhook(app, VOICE_FIELDS);
        expect(res.statusCode).toBe(403);
        expect(res.body).toContain('<Response');
        expect(res.body).not.toContain('<Dial');
      } finally {
        config.AT_ENVIRONMENT = 'sandbox';
      }
    });

    it('production mode: voice webhook with a bad signature is rejected with 403', async () => {
      config.AT_ENVIRONMENT = 'production';
      try {
        const res = await postVoiceWebhook(app, VOICE_FIELDS, {
          'x-africastalking-signature': 'deadbeef'.repeat(8),
        });
        expect(res.statusCode).toBe(403);
      } finally {
        config.AT_ENVIRONMENT = 'sandbox';
      }
    });

    it('production mode: correctly signed voice webhook is accepted (200)', async () => {
      config.AT_ENVIRONMENT = 'production';
      try {
        const rawBody = new URLSearchParams(VOICE_FIELDS).toString();
        const res = await postVoiceWebhook(app, VOICE_FIELDS, {
          'x-africastalking-signature': signBody(rawBody),
        });
        expect(res.statusCode).toBe(200);
      } finally {
        config.AT_ENVIRONMENT = 'sandbox';
      }
    });

    it('production mode: unsigned sms webhook is rejected with 403', async () => {
      config.AT_ENVIRONMENT = 'production';
      try {
        const res = await postSmsWebhook(app, SMS_FIELDS);
        expect(res.statusCode).toBe(403);
      } finally {
        config.AT_ENVIRONMENT = 'sandbox';
      }
    });

    it('production mode: correctly signed sms webhook is accepted (200)', async () => {
      config.AT_ENVIRONMENT = 'production';
      try {
        const rawBody = new URLSearchParams(SMS_FIELDS).toString();
        const res = await postSmsWebhook(app, SMS_FIELDS, {
          'x-africastalking-signature': signBody(rawBody),
        });
        expect(res.statusCode).toBe(200);
      } finally {
        config.AT_ENVIRONMENT = 'sandbox';
      }
    });
  });

  describe('3. deactivated tenant user login', () => {
    it('active user can log in, deactivated user gets 401', async () => {
      // Active: succeeds
      const ok = await app.inject({
        method: 'POST',
        url: '/v1/auth/dashboard/login',
        payload: { email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD },
      });
      expect(ok.statusCode).toBe(200);

      // Deactivate directly in the DB
      await db('tenant_users').where({ email: TEST_USER_EMAIL }).update({ is_active: false });
      try {
        const denied = await app.inject({
          method: 'POST',
          url: '/v1/auth/dashboard/login',
          payload: { email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD },
        });
        expect(denied.statusCode).toBe(401);
      } finally {
        await db('tenant_users').where({ email: TEST_USER_EMAIL }).update({ is_active: true });
      }
    });
  });

  describe('4. GET /admin/operators requires ROOT', () => {
    it('ROOT operator can list operators; SUPPORT operator gets 403', async () => {
      await seedOperator(db); // ROOT, default creds
      const support = await seedOperator(db, {
        email: 'support-sec-test@relavoi.test',
        password: 'supportpw123',
        role: 'SUPPORT',
      });

      const rootToken = await getOperatorToken(app);
      const rootRes = await app.inject({
        method: 'GET',
        url: '/v1/admin/operators',
        headers: { authorization: `Bearer ${rootToken}` },
      });
      expect(rootRes.statusCode).toBe(200);

      const supportToken = await getOperatorToken(app, support.email, support.password);
      const supportRes = await app.inject({
        method: 'GET',
        url: '/v1/admin/operators',
        headers: { authorization: `Bearer ${supportToken}` },
      });
      expect(supportRes.statusCode).toBe(403);
    });
  });

  describe('5. orphaned RLS on sessions is disabled', () => {
    it('sessions table has row-level security disabled', async () => {
      const rows = await db
        .select('relrowsecurity')
        .from('pg_class')
        .where({ relname: 'sessions' });
      expect(rows).toHaveLength(1);
      expect(rows[0].relrowsecurity).toBe(false);
    });
  });
});
