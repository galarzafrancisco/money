import type { AppConfig } from '../config/env.config';

export const PRODUCTION_REFUSAL = 'Seeding is refused with NODE_ENV=production: synthetic data is for development and tests only.';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Seeding is for development and tests only. Returns why it is refused for
 * this configuration, or null when it may run:
 * - never with NODE_ENV=production;
 * - never on DATABASE_MODE=memory (a separate process would get its own empty database);
 * - only on a loopback Postgres, unless SEED_ALLOW_NON_LOCAL_DATABASE=true
 *   (e.g. a Docker Compose service name), so a production DATABASE_URL in
 *   the shell cannot be seeded by mistake;
 * - only with the mock price provider: the dataset's trade prices are
 *   coherent with mock closes and nothing else.
 */
export function seedRefusal(config: AppConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  if (config.nodeEnv === 'production' || env.NODE_ENV === 'production') {
    return PRODUCTION_REFUSAL;
  }
  if (config.database.driver === 'memory') {
    return 'Seeding cannot reach DATABASE_MODE=memory: that database lives inside the server process. Use the default PGlite on disk or a local Postgres.';
  }
  if (config.database.driver === 'postgres' && env.SEED_ALLOW_NON_LOCAL_DATABASE !== 'true') {
    const host = databaseHost(config.database.url);
    if (!host || !LOOPBACK_HOSTS.has(host)) {
      return `Seeding is refused on DATABASE_URL host "${host ?? '?'}": only localhost databases are seeded. Set SEED_ALLOW_NON_LOCAL_DATABASE=true if this really is a development database.`;
    }
  }
  if (config.marketPrices.provider !== 'mock') {
    return `Seeding needs MARKET_PRICE_PROVIDER=mock (got ${config.marketPrices.provider}): the synthetic trades are priced to match mock closes.`;
  }
  return null;
}

function databaseHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
