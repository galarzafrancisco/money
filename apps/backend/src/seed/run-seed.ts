import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import { AppModule } from '../app.module';
import { loadConfig } from '../config/env.config';
import { ValuationJobService } from '../valuations/valuation-job.service';
import { ALEX, SEED_SUBJECT_PREFIX, SEED_USERS } from './seed-dataset';
import { PRODUCTION_REFUSAL, seedRefusal } from './seed-guard';
import { SeedRefusedError, SeedRunner, type SeedTarget } from './seed-runner';

const USAGE = `Synthetic seed data for development and tests (apps/backend/docs/seed-data.md).

  npm run seed                      reset and seed every synthetic user, then run valuations
  npm run seed -- --as <subject>    also seed Alex's dataset into your own local Taico identity
  npm run seed -- --anchor 2026-06-30   date the activity relative to this day (default: today, UTC)
  npm run seed -- --no-valuations   skip the valuation run
  npm run seed:reset                delete the synthetic data only

Stop the dev server first when it uses embedded PGlite: only one process can open it.`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      reset: { type: 'boolean', default: false },
      as: { type: 'string' },
      anchor: { type: 'string' },
      'no-valuations': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  // Before loading config, whose production checks would fail with a less useful message
  if (process.env.NODE_ENV === 'production') throw new SeedRefusedError(PRODUCTION_REFUSAL);
  const config = loadConfig();
  const refusal = seedRefusal(config);
  if (refusal) throw new SeedRefusedError(refusal);

  const anchor = values.anchor ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor) || Number.isNaN(Date.parse(`${anchor}T00:00:00Z`))) throw new Error(`--anchor must be YYYY-MM-DD, got ${anchor}`);
  if (anchor > new Date().toISOString().slice(0, 10)) throw new Error('--anchor cannot be in the future');
  const targets: SeedTarget[] = SEED_USERS.map((user) => ({ user }));
  if (values.as !== undefined) {
    const subject = values.as.trim();
    if (!subject || subject.startsWith(SEED_SUBJECT_PREFIX)) throw new Error(`--as takes your own Taico subject, not empty or a ${SEED_SUBJECT_PREFIX}* identity`);
    targets.push({ user: ALEX, subject });
  }

  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({ config: { ...config, valuations: { ...config.valuations, jobEnabled: false } } }),
    { logger: ['error', 'warn'] },
  );
  try {
    const runner = SeedRunner.fromApp(app);
    const issuer = config.auth.issuer;
    if (values.reset) {
      const result = await runner.reset(issuer, targets);
      for (const r of result) console.log(`${r.deleted ? 'Deleted' : 'Nothing to delete for'} ${issuer} / ${r.subject}`);
      return;
    }
    const seeded = await runner.reseed(issuer, anchor, targets);
    for (const s of seeded) {
      console.log(
        `${s.purpose === 'edge-case' ? 'Edge cases' : 'Seeded'}: ${issuer} / ${s.subject} (${s.key}): ${Object.keys(s.accounts).length} accounts, ${Object.keys(s.categories).length} categories, ${s.transactions} transactions, ${s.transfers} transfers${s.taxItems + s.taxAssets > 0 ? `, ${s.taxItems} tax items, ${s.taxAssets} tax assets` : ''}`,
      );
    }
    if (!values['no-valuations']) {
      const jobs = app.get(ValuationJobService);
      for (const s of seeded) {
        const summary = await jobs.runOnce(new Date(), { userId: s.userId });
        const u = summary.users[0];
        if (summary.skipped) console.warn(`Valuations skipped for ${s.subject}: ${summary.reason}`);
        else if (u?.error) console.warn(`Valuations for ${s.subject} failed: ${u.error}`);
        else console.log(`Valuations for ${s.subject}: ${u?.datesComputed ?? 0} days (${u?.partialDays ?? 0} partial)`);
      }
    }
    console.log(`Done. Anchor ${anchor}, issuer ${issuer}. All data is synthetic; prices are from the mock provider.`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof SeedRefusedError ? `Seed refused: ${error.message}` : error);
  process.exitCode = 1;
});
