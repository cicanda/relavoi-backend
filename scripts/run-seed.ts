#!/usr/bin/env tsx
import { connectDb, disconnectDb } from '../src/config/database';
import { disconnectRedis } from '../src/config/redis';
import { runDevSeed } from '../src/seeds/dev-seed';
import { logger } from '../src/utils/logger';

async function main(): Promise<void> {
  await connectDb();
  try {
    await runDevSeed();
  } finally {
    await disconnectRedis().catch(() => undefined);
    await disconnectDb();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.fatal({ err }, 'Dev seed failed');
    process.exit(1);
  });
