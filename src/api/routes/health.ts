import type { FastifyInstance } from 'fastify';
import { getDb } from '../../config/database';
import { getRedis } from '../../config/redis';
import { logger } from '../../utils/logger';

interface ProviderState {
  name: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'UNKNOWN';
  openedAt: string | null;
  lastError: string | null;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // GET /health
  app.get('/health', async (_req, reply) => {
    const checks: { postgres: 'ok' | 'down'; redis: 'ok' | 'down' } = {
      postgres: 'down',
      redis: 'down',
    };

    try {
      await getDb().raw('SELECT 1');
      checks.postgres = 'ok';
    } catch (err) {
      logger.warn({ err }, 'health: postgres check failed');
    }

    try {
      const pong = await getRedis().ping();
      if (pong === 'PONG') checks.redis = 'ok';
    } catch (err) {
      logger.warn({ err }, 'health: redis check failed');
    }

    const allUp = checks.postgres === 'ok' && checks.redis === 'ok';
    reply.status(allUp ? 200 : 503);
    return {
      status: allUp ? 'healthy' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    };
  });

  // GET /health/cpaas
  app.get('/health/cpaas', async (_req, reply) => {
    const redis = getRedis();
    const providers: ProviderState[] = [];

    const candidates = ['africastalking', 'twilio'];
    for (const name of candidates) {
      try {
        const hash = await redis.hgetall(`cb:${name}`);
        if (!hash || Object.keys(hash).length === 0) {
          // Skip providers with no recorded state — they may not be configured.
          if (name === 'africastalking') {
            providers.push({
              name,
              state: 'CLOSED',
              openedAt: null,
              lastError: null,
            });
          }
          continue;
        }
        providers.push({
          name,
          state: (hash.state as ProviderState['state']) ?? 'UNKNOWN',
          openedAt: hash.opened_at ?? hash.openedAt ?? null,
          lastError: hash.last_error ?? hash.lastError ?? null,
        });
      } catch (err) {
        logger.warn({ err, provider: name }, 'health/cpaas: failed to read circuit breaker');
        providers.push({
          name,
          state: 'UNKNOWN',
          openedAt: null,
          lastError: 'circuit breaker state unavailable',
        });
      }
    }

    const anyOpen = providers.some((p) => p.state === 'OPEN');
    reply.status(anyOpen ? 503 : 200);
    return { providers, timestamp: new Date().toISOString() };
  });
}
