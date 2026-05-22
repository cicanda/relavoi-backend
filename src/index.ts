import Fastify from 'fastify';
import { config } from './config/env';
import { connectDb, disconnectDb } from './config/database';
import { disconnectRedis } from './config/redis';
import { logger } from './utils/logger';
import { registry } from './utils/metrics';

async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    disableRequestLogging: false,
    bodyLimit: 1_048_576, // 1 MB
  });

  // ─── Plugins ────────────────────────────────────────────────────────────────
  await app.register(import('@fastify/cors'), {
    origin:
      config.NODE_ENV === 'development'
        ? ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003']
        : ['https://app.relavoi.com', 'https://admin.relavoi.com'],
    credentials: true,
  });

  await app.register(import('@fastify/jwt'), {
    secret: config.JWT_SECRET,
  });

  await app.register(import('@fastify/formbody'));

  await app.register(import('@fastify/websocket'));

  await app.register(import('@fastify/rate-limit'), {
    global: config.LOAD_TEST_MODE ? false : true,
    max: 1000,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
    errorResponseBuilder: (_req, context) => ({
      type: 'https://api.relavoi.com/errors/rate-limit',
      title: 'Too Many Requests',
      status: 429,
      detail: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
    }),
  });

  // ─── Per-request metrics hook (global) ──────────────────────────────────────
  const { metricsHook } = await import('./api/middleware/metrics');
  app.addHook('onResponse', metricsHook);

  // ─── Metrics endpoint (always on, regardless of SERVICE_MODE) ───────────────
  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  // ─── Routes (conditional on SERVICE_MODE) ───────────────────────────────────
  const mode = config.SERVICE_MODE;

  // Health is exposed in every mode
  const { healthRoutes } = await import('./api/routes/health');
  await app.register(healthRoutes, { prefix: '/v1' });

  if (mode === 'api') {
    const { tenantRoutes } = await import('./api/routes/tenants');
    const { sessionRoutes } = await import('./api/routes/sessions');
    const { webhookRoutes } = await import('./api/routes/webhooks');
    const { deviceRoutes } = await import('./api/routes/devices');
    const { billingRoutes } = await import('./api/routes/billing');
    const { analyticsRoutes } = await import('./api/routes/analytics');
    const { callRoutes } = await import('./api/routes/calls');
    const { numberRoutes } = await import('./api/routes/numbers');
    const { adminRoutes } = await import('./api/routes/admin');

    await app.register(tenantRoutes, { prefix: '/v1' });
    await app.register(sessionRoutes, { prefix: '/v1' });
    await app.register(webhookRoutes, { prefix: '/v1' });
    await app.register(deviceRoutes, { prefix: '/v1' });
    await app.register(billingRoutes, { prefix: '/v1' });
    await app.register(analyticsRoutes, { prefix: '/v1' });
    await app.register(callRoutes, { prefix: '/v1' });
    await app.register(numberRoutes, { prefix: '/v1' });
    await app.register(adminRoutes, { prefix: '/v1' });

    const { setupWebSocketServer } = await import('./services/websocket-server');
    await setupWebSocketServer(app as unknown as Parameters<typeof setupWebSocketServer>[0]);
  } else if (mode === 'webhook') {
    const { webhookRoutes } = await import('./api/routes/webhooks');
    await app.register(webhookRoutes, { prefix: '/v1' });
  }
  // 'worker' mode: only /v1/health and /metrics, no other routes

  return app;
}

async function start(): Promise<void> {
  const mode = config.SERVICE_MODE;
  logger.info({ mode, port: config.PORT, host: config.HOST, env: config.NODE_ENV }, 'Starting Relavoi');

  await connectDb();

  const app = await buildApp();

  // ─── Workers (only in api/worker modes) ─────────────────────────────────────
  const workersStartable: Array<{ start: () => void; stop: () => void; name: string }> = [];

  if (mode === 'api' || mode === 'worker') {
    const { SessionExpiryWorker } = await import('./workers/session-expiry');
    const { MetricsUpdater } = await import('./workers/metrics-updater');
    const { CpaasHealthCheckWorker } = await import('./workers/cpaas-health-check');
    const { startEventConsumers, stopEventConsumers } = await import('./workers/event-consumers');

    const { getSessionManager } = await import('./services/session-manager');
    const sessionManager = getSessionManager();

    const expiry = new SessionExpiryWorker(sessionManager);
    const metricsUpdater = new MetricsUpdater();
    const cpaasHealth = new CpaasHealthCheckWorker();

    expiry.start();
    metricsUpdater.start();
    cpaasHealth.start();
    await startEventConsumers();

    workersStartable.push(
      { start: () => {}, stop: () => expiry.stop(), name: 'session-expiry' },
      { start: () => {}, stop: () => metricsUpdater.stop(), name: 'metrics-updater' },
      { start: () => {}, stop: () => cpaasHealth.stop(), name: 'cpaas-health' },
      { start: () => {}, stop: () => void stopEventConsumers(), name: 'event-consumers' },
    );
  }

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, host: config.HOST }, `Relavoi ${mode} listening`);

  // ─── Graceful shutdown ──────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown requested');

    try {
      for (const worker of workersStartable) {
        try {
          worker.stop();
          logger.debug({ worker: worker.name }, 'Worker stopped');
        } catch (err) {
          logger.warn({ err, worker: worker.name }, 'Worker stop failed');
        }
      }

      try {
        const { getEventBus } = await import('./services/event-bus');
        await getEventBus().close();
      } catch (err) {
        logger.warn({ err }, 'Event bus close failed');
      }

      await app.close();
      await disconnectRedis();
      await disconnectDb();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
