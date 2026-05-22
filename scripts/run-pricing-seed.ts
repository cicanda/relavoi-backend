#!/usr/bin/env tsx
import { connectDb, disconnectDb } from '../src/config/database';
import { runPricingSeed } from '../src/seeds/pricing-seed';
import { logger } from '../src/utils/logger';

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
