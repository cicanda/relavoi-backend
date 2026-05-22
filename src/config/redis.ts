import Redis from 'ioredis';
import { config } from './env';
import { logger } from '../utils/logger';

let redisInstance: Redis | null = null;
let redisSubInstance: Redis | null = null;

function buildClient(opts: { withPrefix: boolean; role: string }): Redis {
  const client = new Redis(config.REDIS_URL, {
    keyPrefix: opts.withPrefix ? config.REDIS_PREFIX : undefined,
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ETIMEDOUT'];
      return targetErrors.some((e) => err.message.includes(e));
    },
  });

  client.on('connect', () => logger.info({ role: opts.role }, 'Redis connected'));
  client.on('ready', () => logger.debug({ role: opts.role }, 'Redis ready'));
  client.on('error', (err) => logger.error({ err, role: opts.role }, 'Redis error'));
  client.on('close', () => logger.warn({ role: opts.role }, 'Redis connection closed'));
  client.on('reconnecting', (ms: number) =>
    logger.info({ role: opts.role, delayMs: ms }, 'Redis reconnecting'),
  );

  return client;
}

export function getRedis(): Redis {
  if (!redisInstance) {
    redisInstance = buildClient({ withPrefix: true, role: 'main' });
  }
  return redisInstance;
}

// Pub/Sub subscriber MUST NOT have a keyPrefix — subscribe channels must match
// the exact channel name the publisher uses, and ioredis only adds prefix to keys, not channels,
// but keeping a clean subscriber client is the standard convention. Also, a connection in
// subscriber mode cannot execute normal commands, so it's strictly separated.
export function getRedisSub(): Redis {
  if (!redisSubInstance) {
    redisSubInstance = buildClient({ withPrefix: false, role: 'subscriber' });
  }
  return redisSubInstance;
}

export async function disconnectRedis(): Promise<void> {
  const closes: Promise<unknown>[] = [];
  if (redisInstance) {
    closes.push(redisInstance.quit().catch(() => redisInstance?.disconnect()));
    redisInstance = null;
  }
  if (redisSubInstance) {
    closes.push(redisSubInstance.quit().catch(() => redisSubInstance?.disconnect()));
    redisSubInstance = null;
  }
  await Promise.all(closes);
  logger.info('Redis disconnected');
}
