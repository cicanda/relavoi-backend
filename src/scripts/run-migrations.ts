#!/usr/bin/env tsx
import knex from 'knex';
import knexConfig from '../config/knexfile';
import { logger } from '../utils/logger';
import { config } from '../config/env';

async function main(): Promise<void> {
  const cfg = knexConfig[config.NODE_ENV] ?? knexConfig.development;
  const db = knex(cfg);
  try {
    logger.info('Running knex migrations...');
    const [batch, applied] = await db.migrate.latest();
    if ((applied as string[]).length === 0) {
      logger.info('No new migrations to apply');
    } else {
      logger.info({ batch, applied }, 'Migrations applied');
    }
  } finally {
    await db.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.fatal({ err }, 'Migration runner failed');
    process.exit(1);
  });
