#!/usr/bin/env tsx
import { connectDb, disconnectDb } from '../config/database';
import { disconnectRedis } from '../config/redis';
import { runDevSeed } from '../seeds/dev-seed';
import { runPricingSeed } from '../seeds/pricing-seed';
import { logger } from '../utils/logger';

// Seed runner compiled into dist/scripts/run-seed.js so it can run inside the
// production/staging container (node dist/scripts/run-seed.js). Runs the dev
// tenant seed (which prints the test credentials) followed by the pricing seed.
async function main(): Promise<void> {
  await connectDb();
  try {
    await runDevSeed();
    await runPricingSeed();
  } finally {
    await disconnectRedis().catch(() => undefined);
    await disconnectDb();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.fatal({ err }, 'Seed failed');
    process.exit(1);
  });
