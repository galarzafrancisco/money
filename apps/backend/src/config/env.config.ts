import { randomBytes } from 'node:crypto';

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
    /** Embedded PGlite on disk, in process. Development only */
    | { driver: 'pglite'; dataDir: string }
    /**
     * Embedded PGlite held in process memory, served over a loopback socket
     * (see database/in-memory-database.ts). NON-DURABLE: every restart or
     * redeploy starts from an empty database.
     */
    | { driver: 'memory' };
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
  /** Browser sign-in through Taico, with server-side sessions (see docs/web-auth.md) */
  webAuth: WebAuthConfig;
  marketPrices: {
    provider: MarketPriceProviderName;
    cacheSeconds: number;
  };
  /** The daily closing-price valuation job (see docs/valuations.md) */
  valuations: {
    /** Run the job on a timer in this process */
    jobEnabled: boolean;
    /** How often the job wakes up to look for due work */
    intervalMinutes: number;
    /** Valuation date D is due once D+1 at this UTC hour has passed (after the ASX and US closes of D) */
    settleHourUtc: number;
    /** How far back history is materialised */
    backfillDays: number;
    /** Days with pending or missing prices are re-tried for this many days */
    recheckDays: number;
    /** The oldest previous close that may stand in on a non-trading or pending day */
    maxCarryDays: number;
    /** Upper bound on dates computed per user per run; the rest wait for the next run */
    maxDaysPerRun: number;
  };
};

export type WebAuthConfig = {
  /** Taico registry entry whose URL is Money's REST API; its tokens carry aud = apiResourceUrl */
  serverId: string;
  /** Issuer identifier of that entry's authorization server; metadata is read from its well-known URL */
  authorizationServer: string;
  /**
   * Money's OAuth client_id at Taico: a dynamically registered ID, or the URL
   * of the client ID metadata document Money serves. Null when neither applies
   * (plain-http base URL and no TAICO_WEB_CLIENT_ID): sign-in is then unavailable.
   */
  clientId: string | null;
  /** URL of the client ID metadata document Money serves */
  clientMetadataUrl: string;
  /** Where Taico sends the browser back to */
  redirectUri: string;
  /** Origin and base path of the web app; post-login redirects stay under it */
  appUrl: string;
  /** AES-256-GCM key for tokens at rest */
  encryptionKey: Buffer;
  /** True when the key was generated for this process (development only): sessions end on restart */
  encryptionKeyEphemeral: boolean;
  /** Secure + __Host- cookies; true when the public base URL is https */
  secureCookies: boolean;
  sessionCookieName: string;
  loginCookieName: string;
  /** A session ends after this long without a request */
  idleTimeoutMinutes: number;
  /** A session ends this long after sign-in, whatever its activity */
  absoluteTimeoutHours: number;
  /** How long a started sign-in may take before its callback is refused */
  loginTimeoutSeconds: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const port = parseInt(env.PORT ?? '4180', 10);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a positive integer, got ${env.PORT}`);
  const publicBaseUrl = stripSlash(env.PUBLIC_BASE_URL ?? `http://localhost:${port}`);

  const database = loadDatabaseConfig(env, nodeEnv);

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
    webAuth: loadWebAuthConfig(env, nodeEnv, issuer, publicBaseUrl),
    marketPrices: {
      provider,
      cacheSeconds: parseInt(env.MARKET_PRICE_CACHE_SECONDS ?? '300', 10),
    },
    valuations: {
      jobEnabled: (env.VALUATION_JOB_ENABLED ?? (nodeEnv === 'test' ? 'false' : 'true')) === 'true',
      intervalMinutes: intEnv(env, 'VALUATION_JOB_INTERVAL_MINUTES', 60, 1, 24 * 60),
      settleHourUtc: intEnv(env, 'VALUATION_SETTLE_HOUR_UTC', 6, 0, 23),
      backfillDays: intEnv(env, 'VALUATION_BACKFILL_DAYS', 366, 1, 3660),
      recheckDays: intEnv(env, 'VALUATION_RECHECK_DAYS', 7, 0, 60),
      maxCarryDays: intEnv(env, 'VALUATION_MAX_CARRY_DAYS', 7, 1, 31),
      maxDaysPerRun: intEnv(env, 'VALUATION_MAX_DAYS_PER_RUN', 400, 1, 5000),
    },
  };
}

/** Version segment of Taico's per-server authorization server URLs */
const TAICO_AUTH_SERVER_VERSION = '0.0.0';

function loadWebAuthConfig(env: NodeJS.ProcessEnv, nodeEnv: AppConfig['nodeEnv'], issuer: string, publicBaseUrl: string): WebAuthConfig {
  const serverId = env.TAICO_WEB_SERVER_ID ?? 'money-api';
  if (!/^[A-Za-z0-9._-]+$/.test(serverId)) throw new Error(`TAICO_WEB_SERVER_ID has unexpected characters: ${serverId}`);
  const secureCookies = publicBaseUrl.startsWith('https://');
  const clientMetadataUrl = `${publicBaseUrl}/auth/client-metadata.json`;
  // Taico only fetches client ID metadata documents over https from a public address
  const clientId = env.TAICO_WEB_CLIENT_ID?.trim() || (secureCookies ? clientMetadataUrl : null);

  let encryptionKey: Buffer;
  let encryptionKeyEphemeral = false;
  if (env.SESSION_ENCRYPTION_KEY) {
    encryptionKey = Buffer.from(env.SESSION_ENCRYPTION_KEY, 'base64');
    if (encryptionKey.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  } else if (nodeEnv === 'production') {
    throw new Error('SESSION_ENCRYPTION_KEY is required in production (openssl rand -base64 32)');
  } else {
    encryptionKey = randomBytes(32);
    encryptionKeyEphemeral = true;
  }

  const appUrl = stripSlash(env.WEB_APP_URL ?? publicBaseUrl);
  if (!/^https?:\/\//.test(appUrl)) throw new Error(`WEB_APP_URL must be an http(s) URL, got ${appUrl}`);

  return {
    serverId,
    authorizationServer: stripSlash(env.TAICO_WEB_AUTHORIZATION_SERVER ?? `${issuer}/mcp/${serverId}/${TAICO_AUTH_SERVER_VERSION}`),
    clientId,
    clientMetadataUrl,
    redirectUri: `${publicBaseUrl}/auth/callback`,
    appUrl,
    encryptionKey,
    encryptionKeyEphemeral,
    secureCookies,
    // __Host- cookies must be Secure, host-only and Path=/; browsers drop them over plain http
    sessionCookieName: secureCookies ? '__Host-money_session' : 'money_session',
    loginCookieName: secureCookies ? '__Host-money_login' : 'money_login',
    idleTimeoutMinutes: intEnv(env, 'WEB_SESSION_IDLE_MINUTES', 12 * 60, 5, 30 * 24 * 60),
    absoluteTimeoutHours: intEnv(env, 'WEB_SESSION_MAX_HOURS', 7 * 24, 1, 90 * 24),
    loginTimeoutSeconds: 600,
  };
}

export const DATABASE_MODES = ['postgres', 'pglite', 'memory'] as const;
export type DatabaseMode = (typeof DATABASE_MODES)[number];

/**
 * DATABASE_MODE picks the database explicitly:
 * - `postgres`: DATABASE_URL (required). The only durable production option.
 * - `pglite`: embedded PGlite on disk at PGLITE_DATA_DIR. Development and tests only.
 * - `memory`: embedded PGlite held in process memory. Allowed in production as a
 *   temporary, NON-DURABLE stopgap: all data and sessions are lost on restart.
 * Unset means `postgres` when DATABASE_URL is set, else `pglite` outside
 * production. Production never falls back to an embedded database on its own.
 */
function loadDatabaseConfig(env: NodeJS.ProcessEnv, nodeEnv: AppConfig['nodeEnv']): AppConfig['database'] {
  const rawMode = env.DATABASE_MODE?.trim();
  if (rawMode && !(DATABASE_MODES as readonly string[]).includes(rawMode)) {
    throw new Error(`DATABASE_MODE must be one of ${DATABASE_MODES.join(', ')}, got ${rawMode}`);
  }
  const mode = rawMode as DatabaseMode | undefined;

  if (mode === 'memory' || mode === 'pglite') {
    if (env.DATABASE_URL) {
      throw new Error(`DATABASE_MODE=${mode} and DATABASE_URL are both set; unset one so the database in use is unambiguous`);
    }
    if (mode === 'memory') return { driver: 'memory' };
    if (nodeEnv === 'production') {
      throw new Error('DATABASE_MODE=pglite is not allowed in production; use DATABASE_URL, or DATABASE_MODE=memory for a temporary non-durable deployment');
    }
    return pgliteOnDisk(env);
  }

  if (env.DATABASE_URL) {
    return { driver: 'postgres', url: env.DATABASE_URL, ssl: env.DATABASE_SSL === 'true', poolMax: parseInt(env.DATABASE_POOL_MAX ?? '10', 10) };
  }
  if (mode === 'postgres') throw new Error('DATABASE_MODE=postgres requires DATABASE_URL');
  if (nodeEnv === 'production') {
    throw new Error(
      'DATABASE_URL is required in production. Set DATABASE_MODE=memory only for a temporary deployment whose data may be lost on every restart',
    );
  }
  return pgliteOnDisk(env);
}

function pgliteOnDisk(env: NodeJS.ProcessEnv): AppConfig['database'] {
  return { driver: 'pglite', dataDir: env.PGLITE_DATA_DIR ?? '.data/pglite' };
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got ${raw}`);
  }
  return value;
}

function parseNodeEnv(value: string | undefined): AppConfig['nodeEnv'] {
  if (value === 'production' || value === 'test') return value;
  return 'development';
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export const APP_CONFIG = Symbol('APP_CONFIG');
