import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { getDb } from '../../config/database';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import { authenticate, requireUserRole } from '../middleware/auth';

const BCRYPT_COST = 10;

// ─── Helpers ────────────────────────────────────────────────────────────────────
function rfc7807(slug: string, title: string, status: number, detail: string): Record<string, unknown> {
  return { type: `https://api.relavoi.com/errors/${slug}`, title, status, detail };
}

function generateApiKey(): string {
  return `rk_live_${crypto.randomBytes(24).toString('hex')}`;
}

function generateApiSecret(): string {
  return `rs_${crypto.randomBytes(32).toString('hex')}`;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function generateTempPassword(): string {
  // 16 chars from base64url
  return crypto.randomBytes(12).toString('base64url');
}

function mapTenantDto(t: Record<string, unknown>): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    tier: t.tier,
    status: t.status ?? 'ACTIVE',
    webhookUrl: t.webhook_url ?? null,
    defaultGracePeriod: t.default_grace_period,
    expiredCallBehavior: t.expired_call_behavior,
    supportPhone: t.support_phone ?? null,
    recordingEnabled: t.recording_enabled,
    recordingConsentMode: t.recording_consent_mode,
    recordingConsentAudioUrl: t.recording_consent_audio_url ?? null,
    pushConfig: t.push_config ?? {},
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

// ─── Schemas ────────────────────────────────────────────────────────────────────
const tokenBodySchema = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
});

const signupBodySchema = z.object({
  companyName: z.string().min(1).max(255),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  companySize: z.string().optional(),
  useCase: z.string().optional(),
});

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const inviteBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

const configPatchSchema = z
  .object({
    webhookUrl: z.string().url().nullable().optional(),
    defaultGracePeriod: z.number().int().nonnegative().optional(),
    expiredCallBehavior: z.enum(['DEAD_LINE', 'REDIRECT_SUPPORT', 'PLAY_MESSAGE']).optional(),
    supportPhone: z
      .string()
      .regex(/^\+[1-9]\d{1,14}$/, 'must be E.164')
      .nullable()
      .optional(),
    recordingEnabled: z.boolean().optional(),
    recordingConsentMode: z.enum(['DEFAULT', 'CUSTOM', 'NONE']).optional(),
    recordingConsentAudioUrl: z.string().url().nullable().optional(),
    pushConfig: z.record(z.unknown()).optional(),
  })
  .strict();

// ─── Routes ─────────────────────────────────────────────────────────────────────
export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  // POST /auth/token — exchange apiKey/apiSecret for a short-lived JWT
  app.post('/auth/token', async (req, reply) => {
    const parsed = tokenBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }

    const db = getDb();

    // api_key_hash is SHA-256(apiKey) — index lookup, O(1).
    // api_secret_hash is bcrypt(apiSecret) — verified after the row is located.
    const apiKeyHash = sha256(parsed.data.apiKey);
    const matched = await db('tenants').where({ api_key_hash: apiKeyHash }).first();

    if (!matched) {
      return reply
        .status(401)
        .type('application/problem+json')
        .send(rfc7807('unauthorized', 'Unauthorized', 401, 'Invalid API credentials.'));
    }

    let secretOk = false;
    try {
      secretOk = await bcrypt.compare(parsed.data.apiSecret, matched.api_secret_hash);
    } catch {
      secretOk = false;
    }
    if (!secretOk) {
      return reply
        .status(401)
        .type('application/problem+json')
        .send(rfc7807('unauthorized', 'Unauthorized', 401, 'Invalid API credentials.'));
    }

    // Fire-and-forget last-used timestamp; never block auth on this
    db('tenants').where({ id: matched.id }).update({ api_key_last_used_at: new Date() })
      .catch((err) => logger.warn({ err, tenantId: matched.id }, 'failed to update api_key_last_used_at'));

    const accessToken = app.jwt.sign(
      { tenantId: matched.id as string, tier: (matched.tier as string) ?? 'STARTER' },
      { expiresIn: config.JWT_EXPIRY },
    );

    return reply.send({
      accessToken,
      expiresIn: 900,
      tokenType: 'Bearer',
    });
  });

  // POST /auth/signup — self-service signup, returns plaintext API creds ONCE
  app.post('/auth/signup', async (req, reply) => {
    const parsed = signupBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const { companyName, email, password } = parsed.data;

    const db = getDb();

    const existing = await db('tenant_users').where({ email: email.toLowerCase() }).first();
    if (existing) {
      return reply
        .status(409)
        .type('application/problem+json')
        .send(rfc7807('conflict', 'Conflict', 409, 'Email already registered.'));
    }

    const apiKey = generateApiKey();
    const apiSecret = generateApiSecret();

    const apiKeyHash = sha256(apiKey);
    const apiSecretHash = await bcrypt.hash(apiSecret, BCRYPT_COST);
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    let tenantId = '';
    let userId = '';

    try {
      await db.transaction(async (trx) => {
        const [tenant] = await trx('tenants')
          .insert({
            name: companyName,
            api_key_hash: apiKeyHash,
            api_secret_hash: apiSecretHash,
            tier: 'STARTER',
            billing_email: email.toLowerCase(),
          })
          .returning(['id']);
        tenantId = tenant.id;

        const [user] = await trx('tenant_users')
          .insert({
            tenant_id: tenantId,
            email: email.toLowerCase(),
            password_hash: passwordHash,
            name: email.split('@')[0],
            role: 'OWNER',
            is_active: true,
          })
          .returning(['id']);
        userId = user.id;
      });
    } catch (err) {
      logger.error({ err }, 'signup: failed to create tenant');
      return reply
        .status(500)
        .type('application/problem+json')
        .send(rfc7807('internal', 'Internal Server Error', 500, 'Could not create tenant.'));
    }

    const accessToken = app.jwt.sign(
      {
        type: 'tenant_user',
        tenantId,
        tier: 'STARTER',
        userId,
        role: 'OWNER',
      },
      { expiresIn: config.JWT_EXPIRY },
    );

    return reply.status(201).send({
      tenantId,
      apiKey,
      apiSecret,
      accessToken,
      user: { id: userId, email: email.toLowerCase(), role: 'OWNER', tenantId },
    });
  });

  // POST /auth/dashboard/login — dashboard email+password login
  app.post(
    '/auth/dashboard/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes',
          keyGenerator: (req): string => req.ip,
        },
      },
    },
    async (req, reply) => {
      const parsed = loginBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }

      const db = getDb();
      const user = await db('tenant_users')
        .where({ email: parsed.data.email.toLowerCase() })
        .first();

      if (!user) {
        return reply
          .status(401)
          .type('application/problem+json')
          .send(rfc7807('unauthorized', 'Unauthorized', 401, 'Invalid email or password.'));
      }

      const ok = await bcrypt.compare(parsed.data.password, user.password_hash);
      if (!ok) {
        return reply
          .status(401)
          .type('application/problem+json')
          .send(rfc7807('unauthorized', 'Unauthorized', 401, 'Invalid email or password.'));
      }

      if (user.status && user.status !== 'ACTIVE') {
        return reply
          .status(403)
          .type('application/problem+json')
          .send(rfc7807('forbidden', 'Forbidden', 403, `User status is ${user.status}.`));
      }

      const tenant = await db('tenants').where({ id: user.tenant_id }).first();
      if (!tenant) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Tenant not found.'));
      }

      const accessToken = app.jwt.sign(
        {
          type: 'tenant_user',
          tenantId: tenant.id,
          tier: tenant.tier ?? 'STARTER',
          userId: user.id,
          role: user.role,
        },
        { expiresIn: config.JWT_EXPIRY },
      );

      return reply.send({
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          tenantId: tenant.id,
        },
        tenant: {
          id: tenant.id,
          name: tenant.name,
          tier: tenant.tier ?? 'STARTER',
          status: tenant.status ?? 'ACTIVE',
        },
      });
    },
  );

  // POST /auth/dashboard/invite — invite a teammate (OWNER/ADMIN)
  app.post(
    '/auth/dashboard/invite',
    { preHandler: [authenticate, requireUserRole('OWNER', 'ADMIN')] },
    async (req, reply) => {
      const parsed = inviteBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const tenant = req.tenant!;
      const { email, role } = parsed.data;

      const db = getDb();
      const existing = await db('tenant_users')
        .where({ email: email.toLowerCase() })
        .first();
      if (existing) {
        return reply
          .status(409)
          .type('application/problem+json')
          .send(rfc7807('conflict', 'Conflict', 409, 'Email already in use.'));
      }

      const tempPassword = generateTempPassword();
      const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_COST);

      const [user] = await db('tenant_users')
        .insert({
          tenant_id: tenant.id,
          email: email.toLowerCase(),
          password_hash: passwordHash,
          name: email.split('@')[0],
          role,
          is_active: true,
        })
        .returning(['id']);

      logger.info(
        { tenantId: tenant.id, invitedBy: req.user?.id, userId: user.id, role },
        'tenant_user invited',
      );

      // TODO: send invite email out of scope
      return reply.status(201).send({ userId: user.id, tempPassword });
    },
  );

  // POST /auth/dashboard/change-password
  app.post(
    '/auth/dashboard/change-password',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.user) {
        return reply
          .status(403)
          .type('application/problem+json')
          .send(rfc7807('forbidden', 'Forbidden', 403, 'Dashboard user token required.'));
      }
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const db = getDb();
      const user = await db('tenant_users').where({ id: req.user.id }).first();
      if (!user) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'User not found.'));
      }
      const ok = await bcrypt.compare(parsed.data.currentPassword, user.password_hash);
      if (!ok) {
        return reply
          .status(401)
          .type('application/problem+json')
          .send(rfc7807('unauthorized', 'Unauthorized', 401, 'Current password is incorrect.'));
      }
      const newHash = await bcrypt.hash(parsed.data.newPassword, BCRYPT_COST);
      await db('tenant_users')
        .where({ id: req.user!.id })
        .update({
          password_hash: newHash,
          updated_at: new Date(),
        });
      return reply.status(204).send();
    },
  );

  // POST /auth/rotate-key — rotate API key/secret (OWNER only)
  app.post(
    '/auth/rotate-key',
    { preHandler: [authenticate, requireUserRole('OWNER')] },
    async (req, reply) => {
      const tenant = req.tenant!;
      const apiKey = generateApiKey();
      const apiSecret = generateApiSecret();
      const apiKeyHash = sha256(apiKey);
      const apiSecretHash = await bcrypt.hash(apiSecret, BCRYPT_COST);

      const db = getDb();
      await db('tenants')
        .where({ id: tenant.id })
        .update({
          api_key_hash: apiKeyHash,
          api_secret_hash: apiSecretHash,
          updated_at: new Date(),
        });

      logger.info({ tenantId: tenant.id, by: req.user?.id }, 'tenant API key rotated');
      return reply.send({ apiKey, apiSecret });
    },
  );

  // GET /tenants/me
  app.get('/tenants/me', { preHandler: [authenticate] }, async (req, reply) => {
    const tenant = req.tenant!;
    const db = getDb();
    const t = await db('tenants').where({ id: tenant.id }).first();
    if (!t) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(rfc7807('not-found', 'Not Found', 404, 'Tenant not found.'));
    }
    const body: Record<string, unknown> = { tenant: mapTenantDto(t) };
    if (req.user && req.user.id) {
      const u = await db('tenant_users').where({ id: req.user.id }).first();
      if (u) {
        body.user = {
          id: u.id,
          email: u.email,
          role: u.role,
          tenantId: u.tenant_id,
        };
      }
    }
    return reply.send(body);
  });

  // GET /config — tenant config
  app.get('/config', { preHandler: [authenticate] }, async (req, reply) => {
    const tenant = req.tenant!;
    const db = getDb();
    const t = await db('tenants').where({ id: tenant.id }).first();
    if (!t) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(rfc7807('not-found', 'Not Found', 404, 'Tenant not found.'));
    }
    return reply.send(mapTenantDto(t));
  });

  // PATCH /config — update tenant config (OWNER/ADMIN only)
  app.patch(
    '/config',
    { preHandler: [authenticate, requireUserRole('OWNER', 'ADMIN')] },
    async (req, reply) => {
      const parsed = configPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
      }
      const tenant = req.tenant!;
      const db = getDb();

      const current = await db('tenants').where({ id: tenant.id }).first();
      if (!current) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(rfc7807('not-found', 'Not Found', 404, 'Tenant not found.'));
      }

      const update: Record<string, unknown> = { updated_at: new Date() };
      const body = parsed.data;
      if (body.webhookUrl !== undefined) update.webhook_url = body.webhookUrl;
      if (body.defaultGracePeriod !== undefined) update.default_grace_period = body.defaultGracePeriod;
      if (body.expiredCallBehavior !== undefined) update.expired_call_behavior = body.expiredCallBehavior;
      if (body.supportPhone !== undefined) update.support_phone = body.supportPhone;
      if (body.recordingEnabled !== undefined) update.recording_enabled = body.recordingEnabled;
      if (body.recordingConsentMode !== undefined) update.recording_consent_mode = body.recordingConsentMode;
      if (body.recordingConsentAudioUrl !== undefined)
        update.recording_consent_audio_url = body.recordingConsentAudioUrl;
      if (body.pushConfig !== undefined) update.push_config = JSON.stringify(body.pushConfig);

      // Invariant: recordingEnabled=true requires consentMode != NONE
      const effectiveRecording =
        body.recordingEnabled !== undefined ? body.recordingEnabled : current.recording_enabled;
      const effectiveConsent =
        body.recordingConsentMode !== undefined
          ? body.recordingConsentMode
          : current.recording_consent_mode;
      if (effectiveRecording && effectiveConsent === 'NONE') {
        return reply
          .status(400)
          .type('application/problem+json')
          .send(
            rfc7807(
              'validation',
              'Bad Request',
              400,
              'recordingEnabled=true requires recordingConsentMode to be DEFAULT or CUSTOM.',
            ),
          );
      }

      await db('tenants').where({ id: tenant.id }).update(update);
      const fresh = await db('tenants').where({ id: tenant.id }).first();
      return reply.send(mapTenantDto(fresh));
    },
  );
}
