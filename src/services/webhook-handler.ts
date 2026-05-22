import crypto from 'crypto';
import { getRedis } from '../config/redis';
import { getDb } from '../config/database';
import { logger } from '../utils/logger';
import { webhookProcessingDuration, webhookDlqDepth } from '../utils/metrics';
import { getCallRouter, RouteDecision } from './call-router';
import { getSmsRouter, SmsRouteDecision } from './sms-router';
import { getEventBus } from './event-bus';
import { ParsedVoiceWebhook } from './africastalking/webhook-parser';
import { ParsedSmsWebhook } from './africastalking/sms-parser';

const DEDUP_TTL_SEC = 60;

export interface VoiceWebhookResult {
  decision?: RouteDecision;
  cached: boolean;
  action: 'routed' | 'status_update' | 'ignored';
}

export interface SmsWebhookResult {
  decision: SmsRouteDecision;
  cached: boolean;
}

export class WebhookHandler {
  private readonly redis = getRedis();

  /**
   * HMAC signature verification.
   * Uses timingSafeEqual to defeat timing attacks.
   */
  verifySignature(
    rawBody: string | Buffer,
    signature: string,
    secret: string,
    algo: string = 'sha256',
  ): boolean {
    if (!signature || !secret) return false;
    try {
      const expected = crypto
        .createHmac(algo, secret)
        .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
        .digest('hex');

      // Allow common forms: "sha256=<hex>" or just "<hex>"
      const provided = signature.includes('=') ? signature.split('=')[1] : signature;
      if (!provided) return false;
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(provided, 'utf8');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch (e) {
      logger.warn({ err: e }, 'WebhookHandler: signature verify error');
      return false;
    }
  }

  async handleVoiceWebhook(parsed: ParsedVoiceWebhook): Promise<VoiceWebhookResult> {
    const end = webhookProcessingDuration.startTimer({ type: 'voice' });

    try {
      // Dedup check first
      try {
        const cached = await this.redis.get(`webhook:dedup:${parsed.eventId}`);
        if (cached) {
          end();
          return {
            decision: JSON.parse(cached) as RouteDecision,
            cached: true,
            action: 'routed',
          };
        }
      } catch (e) {
        logger.warn({ err: e, eventId: parsed.eventId }, 'WebhookHandler: dedup check failed');
      }

      if (parsed.eventType === 'incoming_call') {
        const router = getCallRouter();
        const decision = await router.routeIncomingCall({
          proxyNumber: parsed.destinationNumber,
          callerPhone: parsed.callerNumber,
          eventId: parsed.eventId,
        });

        // Publish call.incoming
        if (decision.sessionId && decision.tenantId) {
          void getEventBus().publish('call.incoming', {
            tenantId: decision.tenantId,
            sessionId: decision.sessionId,
            proxyNumber: parsed.destinationNumber,
            timestamp: new Date().toISOString(),
          });
        }

        end();
        return { decision, cached: false, action: 'routed' };
      }

      // Status events update call_records & emit events
      await this.handleStatusEvent(parsed);
      // Cache empty decision so a CPaaS retry sees the dedup
      await this.redis.set(
        `webhook:dedup:${parsed.eventId}`,
        JSON.stringify({ action: 'status_processed' }),
        'EX',
        DEDUP_TTL_SEC,
      );

      end();
      return { cached: false, action: 'status_update' };
    } catch (err) {
      end();
      logger.error({ err, eventId: parsed.eventId }, 'WebhookHandler: voice handler failed');
      await this.pushToDlq(parsed.eventId, 'AFRICASTALKING', parsed.raw, err);
      throw err;
    }
  }

  async handleSmsWebhook(parsed: ParsedSmsWebhook): Promise<SmsWebhookResult> {
    const end = webhookProcessingDuration.startTimer({ type: 'sms' });
    try {
      try {
        const cached = await this.redis.get(`webhook:dedup:${parsed.eventId}`);
        if (cached) {
          end();
          return { decision: JSON.parse(cached) as SmsRouteDecision, cached: true };
        }
      } catch (e) {
        logger.warn({ err: e, eventId: parsed.eventId }, 'WebhookHandler: sms dedup check failed');
      }

      const router = getSmsRouter();
      const decision = await router.routeIncomingSms({
        proxyNumber: parsed.to,
        fromPhone: parsed.from,
        body: parsed.text,
        eventId: parsed.eventId,
      });

      if (decision.action === 'forward' && decision.tenantId) {
        void getEventBus().publish('sms.received', {
          tenantId: decision.tenantId,
          sessionId: decision.sessionId,
          smsRecordId: decision.smsRecordId,
          timestamp: new Date().toISOString(),
        });
      }

      end();
      return { decision, cached: false };
    } catch (err) {
      end();
      logger.error({ err, eventId: parsed.eventId }, 'WebhookHandler: sms handler failed');
      await this.pushToDlq(parsed.eventId, 'AFRICASTALKING', parsed.raw, err);
      throw err;
    }
  }

  private async handleStatusEvent(parsed: ParsedVoiceWebhook): Promise<void> {
    const db = getDb();
    const updates: Record<string, unknown> = {};

    if (parsed.eventType === 'answered') {
      updates.status = 'ANSWERED';
      updates.answered_at = new Date();
    } else if (parsed.eventType === 'completed') {
      updates.status = 'COMPLETED';
      updates.ended_at = new Date();
      if (parsed.durationInSeconds) updates.duration_seconds = parsed.durationInSeconds;
      if (parsed.recordingUrl) updates.recording_url = parsed.recordingUrl;
    } else if (parsed.eventType === 'missed') {
      updates.status = 'MISSED';
      updates.ended_at = new Date();
    } else if (parsed.eventType === 'failed') {
      updates.status = 'FAILED';
      updates.ended_at = new Date();
    } else if (parsed.eventType === 'ringing') {
      updates.status = 'RINGING';
    } else {
      return;
    }

    let sessionRow: { session_id?: string } | undefined;
    try {
      const updated = await db('call_records')
        .where({ cpaas_call_id: parsed.cpaasSessionId })
        .update(updates)
        .returning(['session_id']);
      sessionRow = Array.isArray(updated) && updated.length > 0 ? updated[0] : undefined;
    } catch (e) {
      logger.warn({ err: e, eventId: parsed.eventId }, 'WebhookHandler: call_records update failed');
    }

    if (sessionRow?.session_id) {
      const evType =
        parsed.eventType === 'answered'
          ? 'call.answered'
          : parsed.eventType === 'completed'
            ? 'call.ended'
            : parsed.eventType === 'failed'
              ? 'call.failed'
              : parsed.eventType === 'missed'
                ? 'call.missed'
                : null;
      if (evType) {
        // tenant for fan-out
        let tenantId: string | undefined;
        try {
          const s = await db('sessions')
            .where({ id: sessionRow.session_id })
            .first('tenant_id');
          tenantId = s?.tenant_id;
        } catch {
          /* ignore */
        }
        void getEventBus().publish(evType, {
          tenantId,
          sessionId: sessionRow.session_id,
          cpaasSessionId: parsed.cpaasSessionId,
          durationSeconds: parsed.durationInSeconds,
          recordingUrl: parsed.recordingUrl,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  private async pushToDlq(
    eventId: string,
    provider: string,
    payload: Record<string, unknown>,
    err: unknown,
  ): Promise<void> {
    try {
      const db = getDb();
      await db('webhook_dlq').insert({
        event_id: eventId,
        provider,
        payload: JSON.stringify(payload),
        error_message: err instanceof Error ? err.message : String(err),
        retry_count: 0,
        max_retries: 3,
        status: 'PENDING',
        first_received_at: new Date(),
      });
      const depth = await db('webhook_dlq')
        .whereIn('status', ['PENDING', 'RETRYING'])
        .count<{ count: string }[]>('* as count');
      const count = depth.length > 0 ? Number(depth[0].count) : 0;
      webhookDlqDepth.set(count);
    } catch (dbErr) {
      logger.error({ err: dbErr, eventId }, 'WebhookHandler: DLQ push failed');
    }
  }
}

let instance: WebhookHandler | null = null;
export function getWebhookHandler(): WebhookHandler {
  if (!instance) instance = new WebhookHandler();
  return instance;
}
