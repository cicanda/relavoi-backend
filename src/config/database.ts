import knex, { Knex } from 'knex';
import { config } from './env';
import { logger } from '../utils/logger';

let dbInstance: Knex | null = null;

export function getDb(): Knex {
  if (!dbInstance) {
    dbInstance = knex({
      client: 'pg',
      connection: config.DATABASE_URL,
      pool: {
        min: config.DB_POOL_MIN,
        max: config.DB_POOL_MAX,
        acquireTimeoutMillis: 30_000,
        idleTimeoutMillis: 30_000,
      },
      acquireConnectionTimeout: 30_000,
    });
  }
  return dbInstance;
}

export async function connectDb(): Promise<void> {
  const db = getDb();
  try {
    await db.raw('SELECT 1');
    logger.info('PostgreSQL connected');
  } catch (err) {
    logger.error({ err }, 'PostgreSQL connection failed');
    throw err;
  }
}

export async function disconnectDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.destroy();
    dbInstance = null;
    logger.info('PostgreSQL disconnected');
  }
}
