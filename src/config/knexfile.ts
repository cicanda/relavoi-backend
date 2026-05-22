import type { Knex } from 'knex';
import { config } from './env';

const knexConfig: { [key: string]: Knex.Config } = {
  development: {
    client: 'pg',
    connection: config.DATABASE_URL,
    pool: { min: config.DB_POOL_MIN, max: config.DB_POOL_MAX },
    migrations: { directory: '../migrations', extension: 'ts' },
    seeds: { directory: '../seeds', extension: 'ts' },
  },
  production: {
    client: 'pg',
    connection: config.DATABASE_URL,
    pool: { min: config.DB_POOL_MIN, max: config.DB_POOL_MAX },
    migrations: { directory: '../migrations', extension: 'js' },
    seeds: { directory: '../seeds', extension: 'js' },
  },
  test: {
    client: 'pg',
    connection: config.DATABASE_URL,
    pool: { min: 1, max: 5 },
    migrations: { directory: '../migrations', extension: 'ts' },
    seeds: { directory: '../seeds', extension: 'ts' },
  },
};

export default knexConfig;
