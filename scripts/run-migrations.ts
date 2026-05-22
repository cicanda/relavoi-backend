#!/usr/bin/env tsx
import path from 'path';
import fs from 'fs';
import type { Knex } from 'knex';
import { getDb, connectDb, disconnectDb } from '../src/config/database';
import { logger } from '../src/utils/logger';

const MIGRATIONS_DIR = path.resolve(__dirname, '../src/migrations');
const TABLE = 'schema_migrations';

interface MigrationModule {
  up: (knex: Knex) => Promise<void>;
  down: (knex: Knex) => Promise<void>;
}

async function ensureMigrationsTable(db: Knex): Promise<void> {
  const exists = await db.schema.hasTable(TABLE);
  if (!exists) {
    await db.schema.createTable(TABLE, (t) => {
      t.text('id').primary();
      t.timestamp('applied_at', { useTz: true }).defaultTo(db.fn.now());
    });
    logger.info({ table: TABLE }, 'Created migrations tracking table');
  }
}

function listMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.(ts|js)$/.test(f))
    .sort((a, b) => a.localeCompare(b, 'en'));
  return files;
}

async function isApplied(db: Knex, id: string): Promise<boolean> {
  const row = await db(TABLE).where({ id }).first();
  return !!row;
}

async function recordApplied(db: Knex, id: string): Promise<void> {
  await db(TABLE).insert({ id, applied_at: new Date() });
}

async function loadMigration(filename: string): Promise<MigrationModule> {
  const fullPath = path.join(MIGRATIONS_DIR, filename);
  const mod = (await import(fullPath)) as MigrationModule;
  if (typeof mod.up !== 'function' || typeof mod.down !== 'function') {
    throw new Error(`Migration ${filename} must export up() and down() functions`);
  }
  return mod;
}

async function main(): Promise<void> {
  await connectDb();
  const db = getDb();

  try {
    await ensureMigrationsTable(db);

    const files = listMigrationFiles();
    if (files.length === 0) {
      logger.warn({ dir: MIGRATIONS_DIR }, 'No migration files found');
      return;
    }

    let applied = 0;
    let skipped = 0;

    for (const file of files) {
      const id = file.replace(/\.(ts|js)$/, '');
      if (await isApplied(db, id)) {
        logger.info({ id }, 'Migration already applied, skipping');
        skipped++;
        continue;
      }

      logger.info({ id }, 'Applying migration');
      const mod = await loadMigration(file);
      const startedAt = Date.now();

      try {
        await mod.up(db);
        await recordApplied(db, id);
        applied++;
        logger.info({ id, durationMs: Date.now() - startedAt }, 'Migration applied');
      } catch (err) {
        logger.error({ err, id }, 'Migration failed — halting');
        throw err;
      }
    }

    logger.info({ applied, skipped, total: files.length }, 'Migrations complete');
  } finally {
    await disconnectDb();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.fatal({ err }, 'Migration runner failed');
    process.exit(1);
  });
