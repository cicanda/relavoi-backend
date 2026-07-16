import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { getDb } from '../config/database';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export interface DeliverArgs {
  tenantId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

interface TenantWebhookConfig {
  webhook_url: string | null;
  webhook_secret: string | null;
}

interface RetryItem {
  url: string;
  body: string;
  headers: Record<string, string>;
  attempt: number;
  tenantId: string;
  eventType: string;
}

// Backoff schedule per spec: 30s, 2min, 10min
const BACKOFF_MS = [30_000, 120_000, 600_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1; // initial + retries

/**
 * Tenant webhook delivery: signs and POSTs JSON payload to the tenant's
 * configured webhook_url. Retries with exponential backoff. Logs each attempt
 * to webhook_delivery_logs. Fire-and-forget — never throws to caller.
 */
export class TenantWebhookDelivery {
  async deliver(args: DeliverArgs): Promise<void> {
    let tenant: TenantWebhookConfig | undefined;
    try {
      const db = getDb();
      tenant = await db('tenants')
        .where({ id: args.tenantId })
        .first('webhook_url', 'webhook_secret');
    } catch (err) {
      logger.warn({ err, tenantId: args.tenantId }, 'TenantWebhookDelivery: tenant lookup failed');
      return;
    }

    if (!tenant?.webhook_url) return; // no destination configured

    const body = JSON.stringify({
      event: args.eventType,
      timestamp: new Date().toISOString(),
      data: args.payload,
    });
    const deliveryId = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = tenant.webhook_secret
      ? crypto
          .createHmac(config.WEBHOOK_HMAC_ALGO, tenant.webhook_secret)
          .update(`${timestamp}.${body}`)
          .digest('hex')
      : '';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Relavoi-Event': args.eventType,
      'X-Relavoi-Delivery': deliveryId,
      'X-Relavoi-Timestamp': timestamp,
      'User-Agent': 'Relavoi-Webhook/1.0',
    };
    if (signature) {
      headers['X-Relavoi-Signature'] = `${config.WEBHOOK_HMAC_ALGO}=${signature}`;
    }

    const item: RetryItem = {
      url: tenant.webhook_url,
      body,
      headers,
      attempt: 1,
      tenantId: args.tenantId,
      eventType: args.eventType,
    };

    // Fire and schedule retries in-memory. Never await — return immediately.
    void this.attempt(item);
  }

  private async attempt(item: RetryItem): Promise<void> {
    const start = Date.now();
    let statusCode = 0;
    let succeeded = false;
    let errorMsg = '';

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(item.url, {
          method: 'POST',
          headers: item.headers,
          body: item.body,
          signal: controller.signal,
        });
        statusCode = res.status;
        succeeded = res.status >= 200 && res.status < 300;
        if (!succeeded) {
          errorMsg = `HTTP ${res.status}`;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    // Log attempt
    try {
      const db = getDb();
      await db('webhook_delivery_logs').insert({
        id: randomUUID(),
        tenant_id: item.tenantId,
        event_type: item.eventType,
        delivery_url: item.url,
        http_status: statusCode,
        response_body: errorMsg ?? null,
        attempt_number: item.attempt,
        success: succeeded,
        delivered_at: new Date(),
      });
    } catch (logErr) {
      logger.warn({ err: logErr }, 'TenantWebhookDelivery: log insert failed');
    }

    const elapsed = Date.now() - start;

    if (succeeded) {
      logger.debug(
        {
          tenantId: item.tenantId,
          eventType: item.eventType,
          attempt: item.attempt,
          statusCode,
          elapsedMs: elapsed,
        },
        'Tenant webhook delivered',
      );
      return;
    }

    logger.warn(
      {
        tenantId: item.tenantId,
        eventType: item.eventType,
        attempt: item.attempt,
        statusCode,
        errorMsg,
      },
      'Tenant webhook attempt failed',
    );

    if (item.attempt >= MAX_ATTEMPTS) {
      logger.error(
        { tenantId: item.tenantId, eventType: item.eventType, attempts: item.attempt },
        'Tenant webhook giving up after max attempts',
      );
      return;
    }

    const backoff = BACKOFF_MS[item.attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    const nextItem: RetryItem = { ...item, attempt: item.attempt + 1 };
    setTimeout(() => {
      void this.attempt(nextItem);
    }, backoff).unref();
  }
}

let instance: TenantWebhookDelivery | null = null;
export function getTenantWebhookDelivery(): TenantWebhookDelivery {
  if (!instance) instance = new TenantWebhookDelivery();
  return instance;
}
