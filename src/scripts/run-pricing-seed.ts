#!/usr/bin/env tsx
import { connectDb, disconnectDb } from '../config/database';
import { runPricingSeed } from '../seeds/pricing-seed';
import { logger } from '../utils/logger';

// Compiled into dist/scripts/run-pricing-seed.js so it can run inside the
// production/staging container (node dist/scripts/run-pricing-seed.js).
async function main(): Promise<void> {
  await connectDb();
  try {
    await runPricingSeed();
  } finally {
    await disconnectDb();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.fatal({ err }, 'Pricing seed failed');
    process.exit(1);
  });
