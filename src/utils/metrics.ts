import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

registry.setDefaultLabels({ service: 'relavoi-api' });
collectDefaultMetrics({ register: registry });

// ─── HTTP ─────────────────────────────────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

// ─── Call Routing ─────────────────────────────────────────────────────────────

export const callRoutingDuration = new Histogram({
  name: 'call_routing_duration_seconds',
  help: 'Call routing decision latency (webhook → response)',
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

export const callRoutingTotal = new Counter({
  name: 'call_routing_total',
  help: 'Total call routing decisions',
  labelNames: ['result'], // routed | no_session | session_expired | failed
  registers: [registry],
});

// ─── Sessions ─────────────────────────────────────────────────────────────────

export const activeSessionsGauge = new Gauge({
  name: 'active_sessions',
  help: 'Currently active sessions',
  labelNames: ['tenant_id'],
  registers: [registry],
});

export const sessionCreatedTotal = new Counter({
  name: 'session_created_total',
  help: 'Sessions created',
  labelNames: ['tenant_id', 'status'], // success | failed
  registers: [registry],
});

// ─── Number Pool ──────────────────────────────────────────────────────────────

export const numberPoolAvailable = new Gauge({
  name: 'number_pool_available',
  help: 'Available proxy numbers',
  labelNames: ['region', 'provider'],
  registers: [registry],
});

export const numberPoolUtilization = new Gauge({
  name: 'number_pool_utilization_percent',
  help: 'Pool utilization (0-100)',
  labelNames: ['region'],
  registers: [registry],
});

// ─── Webhook ──────────────────────────────────────────────────────────────────

export const webhookProcessingDuration = new Histogram({
  name: 'webhook_processing_duration_seconds',
  help: 'CPaaS webhook processing duration',
  labelNames: ['type'], // voice | sms
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const webhookDlqDepth = new Gauge({
  name: 'webhook_dlq_depth',
  help: 'Webhook DLQ pending message count',
  registers: [registry],
});

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
  labelNames: ['provider'],
  registers: [registry],
});

// ─── Push Notifications ───────────────────────────────────────────────────────

export const pushNotificationTotal = new Counter({
  name: 'push_notification_total',
  help: 'Push notification dispatches',
  labelNames: ['result'], // success | failure | no_token
  registers: [registry],
});
