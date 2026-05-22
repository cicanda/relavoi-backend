import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { z } from 'zod';
import { getDb } from '../../config/database';
import { logger } from '../../utils/logger';
import { authenticate } from '../middleware/auth';
import { tierRateLimit } from '../middleware/tier-rate-limit';
import { getWebhookHandler } from '../../services/webhook-handler';
import { parseVoiceWebhook } from '../../services/africastalking/webhook-parser';
import { parseSmsWebhook } from '../../services/africastalking/sms-parser';
import {
  buildDialResponse,
  buildRejectResponse,
  buildPlayMessageResponse,
  buildRedirectResponse,
  buildEmptyResponse,
} from '../../services/africastalking/response-builder';

function rfc7807(slug: string, title: string, status: number, detail: string): Record<string, unknown> {
  return { type: `https://api.relavoi.com/errors/${slug}`, title, status, detail };
}

const registerBodySchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
});

const logsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  after: z.string().optional(),
});

function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

function deliveryLogDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    event: row.event,
    url: row.url,
    statusCode: row.status_code,
    success: row.success,
    attemptCount: row.attempt_count,
    error: row.error,
    requestedAt: row.requested_at ?? row.created_at,
    completedAt: row.completed_at,
  };
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // ─── CPaaS-facing webhooks ────────────────────────────────────────────────────

  // POST /webhooks/cpaas/voice
  app.post('/webhooks/cpaas/voice', async (req, reply) => {
    try {
      const event = parseVoiceWebhook(req.body as Record<string, string>);
      const result = await getWebhookHandler().handleVoiceWebhook(event);
      reply.type('text/xml');

      const decision = result.decision;
      if (!decision) {
        return reply.status(200).send(buildEmptyResponse());
      }
      switch (decision.action) {
        case 'forward':
          return reply.status(200).send(
            buildDialResponse({
              destination: decision.destination ?? '',
              callerId: decision.callerId ?? '',
              recordingEnabled: false,
            }),
          );
        case 'consent_then_forward':
          return reply.status(200).send(
            buildDialResponse({
              destination: decision.destination ?? '',
              callerId: decision.callerId ?? '',
              recordingEnabled: true,
              consentAudioUrl: decision.audioUrl,
              consentText: decision.message,
            }),
          );
        case 'dead_line':
          return reply
            .status(200)
            .send(buildRejectResponse({ reason: 'expired', message: decision.message }));
        case 'redirect':
          return reply.status(200).send(buildRedirectResponse(decision.destination ?? ''));
        case 'play_message':
          return reply.status(200).send(buildPlayMessageResponse(decision.audioUrl ?? ''));
        default:
          return reply.status(200).send(buildEmptyResponse());
      }
    } catch (err) {
      logger.error({ err }, 'voice webhook processing failed');
      reply.type('text/xml');
      return reply.status(200).send(buildEmptyResponse());
    }
  });

  // POST /webhooks/cpaas/sms
  app.post('/webhooks/cpaas/sms', async (req, reply) => {
    try {
      const event = parseSmsWebhook(req.body as Record<string, string>);
      await getWebhookHandler().handleSmsWebhook(event);
      return reply.status(200).send({ ok: true });
    } catch (err) {
      logger.error({ err }, 'sms webhook processing failed');
      return reply.status(200).send({ ok: false });
    }
  });

  // ─── Tenant-facing webhook management ─────────────────────────────────────────

  // POST /webhooks — register tenant webhook URL
  app.post('/webhooks', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = registerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const tenant = req.tenant!;
    const db = getDb();
    const secret = generateWebhookSecret();

    await db('tenants').where({ id: tenant.id }).update({
      webhook_url: parsed.data.url,
      webhook_secret: secret,
      updated_at: new Date(),
    });

    // Replace subscription rows
    try {
      await db('tenant_webhooks').where({ tenant_id: tenant.id }).delete();
      const rows = parsed.data.events.map((event) => ({
        tenant_id: tenant.id,
        event,
        url: parsed.data.url,
      }));
      if (rows.length > 0) await db('tenant_webhooks').insert(rows);
    } catch (err) {
      // Table may not exist on minimal deploys; do not fail registration.
      logger.warn({ err }, 'tenant_webhooks subscription rows not persisted');
    }

    return reply.status(201).send({
      url: parsed.data.url,
      secret,
      events: parsed.data.events,
    });
  });

  // GET /webhooks — current registration + recent delivery logs
  app.get('/webhooks', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const tenant = req.tenant!;
    const db = getDb();
    const t = await db('tenants').where({ id: tenant.id }).first();
    if (!t) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(rfc7807('not-found', 'Not Found', 404, 'Tenant not found.'));
    }

    let events: string[] = [];
    try {
      events = (
        await db('tenant_webhooks').where({ tenant_id: tenant.id }).select('event')
      ).map((r) => r.event as string);
    } catch {
      events = [];
    }

    let logs: Array<Record<string, unknown>> = [];
    try {
      const rows = await db('webhook_delivery_logs')
        .where({ tenant_id: tenant.id })
        .orderBy('created_at', 'desc')
        .limit(50);
      logs = rows.map(deliveryLogDto);
    } catch {
      logs = [];
    }

    return reply.send({
      url: t.webhook_url ?? null,
      events,
      hasSecret: !!t.webhook_secret,
      recentDeliveries: logs,
    });
  });

  // POST /webhooks/test — trigger a fake session.created delivery
  app.post('/webhooks/test', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const tenant = req.tenant!;
    const db = getDb();
    const t = await db('tenants').where({ id: tenant.id }).first();
    if (!t || !t.webhook_url) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(
          rfc7807(
            'no-webhook',
            'Bad Request',
            400,
            'No webhook URL configured. Register one via POST /webhooks first.',
          ),
        );
    }

    const payload = {
      id: `evt_test_${crypto.randomBytes(8).toString('hex')}`,
      type: 'session.created',
      createdAt: new Date().toISOString(),
      data: {
        sessionId: `sess_test_${crypto.randomBytes(6).toString('hex')}`,
        tenantId: tenant.id,
        proxyNumber: '+2348000000000',
        test: true,
      },
    };

    // Fire-and-forget — the actual delivery is handled by tenant-webhook-delivery.
    try {
      const { getTenantWebhookDelivery } = await import('../../services/tenant-webhook-delivery');
      await getTenantWebhookDelivery().deliver({
        tenantId: tenant.id,
        eventType: payload.type,
        payload,
      });
    } catch (err) {
      logger.warn({ err }, 'webhook test enqueue failed');
    }

    return reply.status(202).send({ enqueued: true, event: payload });
  });

  // GET /webhooks/logs — paginated delivery logs
  app.get('/webhooks/logs', { preHandler: [authenticate, tierRateLimit] }, async (req, reply) => {
    const parsed = logsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(rfc7807('validation', 'Bad Request', 400, parsed.error.message));
    }
    const tenant = req.tenant!;
    const db = getDb();
    try {
      const q = db('webhook_delivery_logs')
        .where({ tenant_id: tenant.id })
        .orderBy('created_at', 'desc')
        .limit(parsed.data.limit + 1);
      if (parsed.data.after) q.andWhere('id', '<', parsed.data.after);
      const rows = await q;
      const hasMore = rows.length > parsed.data.limit;
      const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
      const data = page.map(deliveryLogDto);
      return reply.send({
        data,
        pagination: {
          count: data.length,
          after: hasMore ? page[page.length - 1].id : null,
        },
      });
    } catch (err) {
      logger.warn({ err }, 'webhook logs query failed');
      return reply.send({ data: [], pagination: { count: 0, after: null } });
    }
  });
}
