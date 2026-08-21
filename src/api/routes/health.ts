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
  //
  // Tenant-facing monitoring endpoint. The underlying CPaaS vendor is an
  // internal implementation detail, so provider entries are reported by their
  // generic role (`primary`, `failover`) — never the vendor name. The circuit
  // breaker Redis hashes are still keyed by the internal vendor id.
  app.get('/health/cpaas', async (_req, reply) => {
    const redis = getRedis();
    const providers: ProviderState[] = [];

    const roles: { name: string; cbKey: string; alwaysReport: boolean }[] = [
      { name: 'primary', cbKey: 'africastalking', alwaysReport: true },
      { name: 'failover', cbKey: 'twilio', alwaysReport: false },
    ];

    for (const { name, cbKey, alwaysReport } of roles) {
      try {
        const hash = await redis.hgetall(`cb:${cbKey}`);
        if (!hash || Object.keys(hash).length === 0) {
          // No recorded state — report the primary as healthy-by-default, skip
          // an unconfigured failover.
          if (alwaysReport) {
            providers.push({ name, state: 'CLOSED', openedAt: null, lastError: null });
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
