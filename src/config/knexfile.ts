import type { Knex } from 'knex';
import path from 'path';
import { config } from './env';

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');
const SEEDS_DIR = path.resolve(__dirname, '../seeds');

const baseMigrations = {
  directory: MIGRATIONS_DIR,
  extension: 'ts' as const,
  loadExtensions: ['.ts', '.js'],
  tableName: 'knex_migrations',
};

const baseSeeds = {
  directory: SEEDS_DIR,
  extension: 'ts' as const,
  loadExtensions: ['.ts', '.js'],
};

const knexConfig: { [key: string]: Knex.Config } = {
  development: {
    client: 'pg',
    connection: config.DATABASE_URL,
    pool: { min: config.DB_POOL_MIN, max: config.DB_POOL_MAX },
    migrations: baseMigrations,
    seeds: baseSeeds,
  },
  production: {
    client: 'pg',
    connection: config.DATABASE_URL,
    pool: { min: config.DB_POOL_MIN, max: config.DB_POOL_MAX },
    migrations: { ...baseMigrations, extension: 'js' as const, loadExtensions: ['.js'] },
    seeds: { ...baseSeeds, extension: 'js' as const, loadExtensions: ['.js'] },
  },
  test: {
    client: 'pg',
    connection: config.DATABASE_URL,
    pool: { min: 1, max: 5 },
    migrations: baseMigrations,
    seeds: baseSeeds,
  },
};

export default knexConfig;
