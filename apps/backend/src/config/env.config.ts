/**
 * All environment variables are read here, once, and validated. Nothing
 * else reads process.env.
 */
export type MarketPriceProviderName = 'mock' | 'yahoo';

export type AppConfig = {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  /** Public URL of this backend, without trailing slash. Token audiences and resource metadata are built from it. */
  publicBaseUrl: string;
  database:
    | { driver: 'postgres'; url: string; ssl: boolean; poolMax: number }
    | { driver: 'pglite'; dataDir: string };
  auth: {
    /** The `iss` Taico access tokens carry */
    issuer: string;
    jwksUrl: string;
    /** Authorization servers advertised in protected-resource metadata */
    authorizationServers: string[];
    /** Protected resources: the MCP endpoint and the REST API */
    mcpResourceUrl: string;
    apiResourceUrl: string;
  };
  marketPrices: {
    provider: MarketPriceProviderName;
    cacheSeconds: number;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const port = parseInt(env.PORT ?? '4180', 10);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a positive integer, got ${env.PORT}`);
  const publicBaseUrl = stripSlash(env.PUBLIC_BASE_URL ?? `http://localhost:${port}`);

  let database: AppConfig['database'];
  if (env.DATABASE_URL) {
    database = { driver: 'postgres', url: env.DATABASE_URL, ssl: env.DATABASE_SSL === 'true', poolMax: parseInt(env.DATABASE_POOL_MAX ?? '10', 10) };
  } else if (nodeEnv === 'production') {
    throw new Error('DATABASE_URL is required in production (embedded PGlite is for development and tests only)');
  } else {
    database = { driver: 'pglite', dataDir: env.PGLITE_DATA_DIR ?? '.data/pglite' };
  }

  if (nodeEnv === 'production' && !env.TAICO_ISSUER) {
    throw new Error('TAICO_ISSUER is required in production');
  }
  const issuer = stripSlash(env.TAICO_ISSUER ?? 'http://localhost:3000');
  const authorizationServers = (env.TAICO_AUTHORIZATION_SERVERS ?? issuer)
    .split(',')
    .map((value) => stripSlash(value.trim()))
    .filter(Boolean);

  const provider = (env.MARKET_PRICE_PROVIDER ?? 'mock') as MarketPriceProviderName;
  if (provider !== 'mock' && provider !== 'yahoo') {
    throw new Error(`MARKET_PRICE_PROVIDER must be "mock" or "yahoo", got ${provider}`);
  }

  return {
    nodeEnv,
    port,
    publicBaseUrl,
    database,
    auth: {
      issuer,
      jwksUrl: env.TAICO_JWKS_URL ?? `${issuer}/.well-known/jwks.json`,
      authorizationServers,
      mcpResourceUrl: `${publicBaseUrl}/mcp`,
      apiResourceUrl: `${publicBaseUrl}/api`,
    },
    marketPrices: {
      provider,
      cacheSeconds: parseInt(env.MARKET_PRICE_CACHE_SECONDS ?? '300', 10),
    },
  };
}

function parseNodeEnv(value: string | undefined): AppConfig['nodeEnv'] {
  if (value === 'production' || value === 'test') return value;
  return 'development';
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export const APP_CONFIG = Symbol('APP_CONFIG');
