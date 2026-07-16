import { logger } from '../utils/logger';
import { getEventBus, type EventHandler } from '../services/event-bus';
import { getTenantWebhookDelivery } from '../services/tenant-webhook-delivery';
import { getBillingManager, type BillingMetric } from '../services/billing-manager';
import { getPushService } from '../services/push-notification';

/**
 * Event consumers wire concrete business actions onto the Event Bus.
 *
 * Each consumer is registered with a stable group name so that multiple
 * replicas share work via Redis Streams consumer groups. Handlers must:
 *   - Be idempotent (events may be delivered more than once)
 *   - Never throw to the consumer loop (try/catch each)
 */

interface EventPayload {
  tenantId?: string;
  sessionId?: string;
  [k: string]: unknown;
}

function getTenantId(payload: EventPayload): string | null {
  if (typeof payload.tenantId === 'string') return payload.tenantId;
  const tid = (payload as Record<string, unknown>).tenant_id;
  if (typeof tid === 'string') return tid;
  return null;
}

function getSessionId(payload: EventPayload): string | null {
  if (typeof payload.sessionId === 'string') return payload.sessionId;
  const sid = (payload as Record<string, unknown>).session_id;
  if (typeof sid === 'string') return sid;
  return null;
}

const KNOWN_METRICS = new Set<BillingMetric>([
  'session_created',
  'call_minute',
  'sms_sent',
  'sms_received',
  'number_rental',
]);

async function safeMeterUsage(
  tenantId: string | null,
  metric: string,
  quantity: number,
): Promise<void> {
  if (!tenantId) return;
  if (!KNOWN_METRICS.has(metric as BillingMetric)) return;
  try {
    await getBillingManager().recordUsage(tenantId, metric as BillingMetric, quantity);
  } catch (err) {
    logger.warn({ err, tenantId, metric }, 'event-consumers: meter usage failed');
  }
}

async function safeDeliverWebhook(
  tenantId: string | null,
  eventType: string,
  payload: EventPayload,
): Promise<void> {
  if (!tenantId) return;
  try {
    const delivery = getTenantWebhookDelivery();
    await delivery.deliver({ tenantId, eventType, payload });
  } catch (err) {
    logger.warn({ err, tenantId, eventType }, 'event-consumers: webhook deliver failed');
  }
}

async function safePush(payload: EventPayload): Promise<void> {
  const tenantId = getTenantId(payload);
  const sessionId = getSessionId(payload);
  const customerPhoneHash =
    typeof payload.customerPhoneHash === 'string'
      ? payload.customerPhoneHash
      : typeof (payload as Record<string, unknown>).customer_phone_hash === 'string'
        ? ((payload as Record<string, unknown>).customer_phone_hash as string)
        : null;
  if (!tenantId || !sessionId || !customerPhoneHash) return;
  try {
    await getPushService().sendCallNotification(tenantId, customerPhoneHash, sessionId);
  } catch (err) {
    logger.warn({ err, tenantId, sessionId }, 'event-consumers: push failed');
  }
}

const CONSUMER = `consumer-${process.pid}`;

/**
 * Adapt a payload-oriented handler to the EventBus contract. The bus invokes
 * handlers with the full envelope `{ id, type, payload }`; every consumer here
 * only cares about the payload. Reading the envelope directly (the original
 * bug) meant `tenantId` was always undefined and metering/webhooks/push
 * silently no-op'd.
 */
function onPayload(fn: (payload: EventPayload) => Promise<void> | void): EventHandler {
  return (event) => fn(event.payload as EventPayload);
}

export async function startEventConsumers(): Promise<void> {
  const bus = getEventBus();

  // session.created → metering + tenant-webhook
  await bus.subscribe('session.created', 'metering', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safeMeterUsage(getTenantId(payload), 'session_created', 1);
    } catch (err) {
      logger.warn({ err }, 'session.created/metering handler error');
    }
  }));
  await bus.subscribe('session.created', 'tenant-webhook', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safeDeliverWebhook(getTenantId(payload), 'session.created', payload);
    } catch (err) {
      logger.warn({ err }, 'session.created/tenant-webhook handler error');
    }
  }));

  // session.activated → tenant-webhook
  await bus.subscribe('session.activated', 'tenant-webhook', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safeDeliverWebhook(getTenantId(payload), 'session.activated', payload);
    } catch (err) {
      logger.warn({ err }, 'session.activated/tenant-webhook handler error');
    }
  }));

  // session.expired → metering + tenant-webhook
  await bus.subscribe('session.expired', 'metering', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      // No additional metering on expiry by default — placeholder for future "session_lifetime" metric.
      await safeMeterUsage(getTenantId(payload), 'session_expired', 1);
    } catch (err) {
      logger.warn({ err }, 'session.expired/metering handler error');
    }
  }));
  await bus.subscribe('session.expired', 'tenant-webhook', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safeDeliverWebhook(getTenantId(payload), 'session.expired', payload);
    } catch (err) {
      logger.warn({ err }, 'session.expired/tenant-webhook handler error');
    }
  }));

  // call.incoming → push + tenant-webhook
  await bus.subscribe('call.incoming', 'push', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safePush(payload);
    } catch (err) {
      logger.warn({ err }, 'call.incoming/push handler error');
    }
  }));
  await bus.subscribe('call.incoming', 'tenant-webhook', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safeDeliverWebhook(getTenantId(payload), 'call.incoming', payload);
    } catch (err) {
      logger.warn({ err }, 'call.incoming/tenant-webhook handler error');
    }
  }));

  // call.answered → tenant-webhook
  await bus.subscribe('call.answered', 'tenant-webhook', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safeDeliverWebhook(getTenantId(payload), 'call.answered', payload);
    } catch (err) {
      logger.warn({ err }, 'call.answered/tenant-webhook handler error');
    }
  }));

  // call.ended → tenant-webhook + metering (call_minute)
  await bus.subscribe('call.ended', 'tenant-webhook', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safeDeliverWebhook(getTenantId(payload), 'call.ended', payload);
    } catch (err) {
      logger.warn({ err }, 'call.ended/tenant-webhook handler error');
    }
  }));
  await bus.subscribe('call.ended', 'metering', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      const tenantId = getTenantId(payload);
      const seconds = Number((payload as Record<string, unknown>).durationSeconds ?? 0);
      const minutes = Math.max(1, Math.ceil(seconds / 60));
      await safeMeterUsage(tenantId, 'call_minute', minutes);
    } catch (err) {
      logger.warn({ err }, 'call.ended/metering handler error');
    }
  }));

  // call.failed → tenant-webhook + metering
  await bus.subscribe('call.failed', 'tenant-webhook', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safeDeliverWebhook(getTenantId(payload), 'call.failed', payload);
    } catch (err) {
      logger.warn({ err }, 'call.failed/tenant-webhook handler error');
    }
  }));
  await bus.subscribe('call.failed', 'metering', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safeMeterUsage(getTenantId(payload), 'call_failed', 1);
    } catch (err) {
      logger.warn({ err }, 'call.failed/metering handler error');
    }
  }));

  // sms.sent → metering + tenant-webhook
  await bus.subscribe('sms.sent', 'metering', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safeMeterUsage(getTenantId(payload), 'sms_sent', 1);
    } catch (err) {
      logger.warn({ err }, 'sms.sent/metering handler error');
    }
  }));
  await bus.subscribe('sms.sent', 'tenant-webhook', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safeDeliverWebhook(getTenantId(payload), 'sms.sent', payload);
    } catch (err) {
      logger.warn({ err }, 'sms.sent/tenant-webhook handler error');
    }
  }));

  // sms.received → metering + tenant-webhook
  await bus.subscribe('sms.received', 'metering', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safeMeterUsage(getTenantId(payload), 'sms_received', 1);
    } catch (err) {
      logger.warn({ err }, 'sms.received/metering handler error');
    }
  }));
  await bus.subscribe('sms.received', 'tenant-webhook', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      await safeDeliverWebhook(getTenantId(payload), 'sms.received', payload);
    } catch (err) {
      logger.warn({ err }, 'sms.received/tenant-webhook handler error');
    }
  }));

  // pool.low_availability → log + metric
  await bus.subscribe('pool.low_availability', 'alerting', CONSUMER, onPayload(async (payload: EventPayload) => {
    try {
      logger.warn({ payload }, 'pool.low_availability event received');
    } catch (err) {
      logger.warn({ err }, 'pool.low_availability handler error');
    }
  }));

  logger.info('event-consumers: started');
}

export async function stopEventConsumers(): Promise<void> {
  try {
    const bus = getEventBus();
    await bus.close();
    logger.info('event-consumers: stopped');
  } catch (err) {
    logger.warn({ err }, 'event-consumers: stop failed');
  }
}
