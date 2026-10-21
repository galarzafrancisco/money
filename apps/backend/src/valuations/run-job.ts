import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { loadConfig } from '../config/env.config';
import { ValuationJobService } from './valuation-job.service';

/**
 * Runs the daily valuation job once and exits, for operations and recovery:
 *   npm -w @money/backend run valuations:run
 * Uses the same configuration (DATABASE_URL, MARKET_PRICE_PROVIDER, VALUATION_*)
 * as the server; the database lease stops it overlapping a scheduled run.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger('ValuationRun');
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({ config: { ...config, valuations: { ...config.valuations, jobEnabled: false } } }),
  );
  try {
    const summary = await app.get(ValuationJobService).runOnce();
    logger.log(JSON.stringify(summary, null, 2));
    process.exitCode = summary.skipped || summary.users.some((u) => u.error) ? 1 : 0;
  } finally {
    await app.close();
  }
}

void main();
