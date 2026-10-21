import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { staticJwks } from '@taico/auth';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import request from 'supertest';
import { AppModule } from '../app.module';
import { loadConfig, type AppConfig } from '../config/env.config';
import { MockPriceProvider } from '../market-prices/mock-price.provider';

export const ISSUER = 'https://taico.test';
export const BASE_URL = 'http://money.test';

export type TestApp = {
  app: INestApplication;
  http: ReturnType<typeof request>;
  config: AppConfig;
  prices: MockPriceProvider;
  /** Signs an access token the way Taico would */
  token: (options?: TokenOptions) => Promise<string>;
  close: () => Promise<void>;
};

export type TokenOptions = {
  subject?: string;
  audience?: string;
  issuer?: string;
  expiresInSeconds?: number;
  /** Sign with a key the app does not trust */
  foreignKey?: boolean;
  claims?: Record<string, unknown>;
};

/**
 * Starts an in-memory PGlite in a child process, reachable over the Postgres
 * protocol. Each test file gets its own empty database.
 */
async function startDatabase(): Promise<{ url: string; stop: () => Promise<void> }> {
  const child: ChildProcess = fork(join(__dirname, '..', '..', 'test', 'pglite-server.mjs'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const address = await new Promise<string>((resolve, reject) => {
    child.once('message', (message: { address: string }) => resolve(message.address));
    child.once('exit', (code) => reject(new Error(`PGlite test server exited with ${code}`)));
  });
  return {
    url: `postgres://postgres:postgres@${address}/postgres`,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.send('stop');
      }),
  };
}

/**
 * With TEST_POSTGRES_URL (an admin connection to a real Postgres server),
 * each test file creates and later drops its own database instead.
 */
async function startPostgresDatabase(adminUrl: string): Promise<{ url: string; stop: () => Promise<void>; poolMax: number }> {
  const { Client } = await import('pg');
  const name = `money_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    poolMax: 5,
    stop: async () => {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** True when tests run against a real Postgres server with a connection pool */
export const usingRealPostgres = Boolean(process.env.TEST_POSTGRES_URL);

export type TestAppOptions = {
  /** Extra environment variables */
  env?: Record<string, string>;
  /** Stands in for Taico's authorization server in browser sign-in tests */
  webAuthFetch?: typeof fetch;
  /** Adjusts the app before init, as main.ts does (e.g. serving the web app) */
  configure?: (app: INestApplication) => void;
};

/** Boots the real app on its own database, trusting a key pair generated for the test */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const database = process.env.TEST_POSTGRES_URL
    ? await startPostgresDatabase(process.env.TEST_POSTGRES_URL)
    : { ...(await startDatabase()), poolMax: 1 };
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const kid = 'test-key';
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };

  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: BASE_URL,
    DATABASE_URL: database.url,
    // PGlite: one connection, as it is single-session; this also catches any query issued outside its transaction
    DATABASE_POOL_MAX: String(database.poolMax),
    TAICO_ISSUER: ISSUER,
    MARKET_PRICE_CACHE_SECONDS: '0',
    TAICO_WEB_CLIENT_ID: 'money-web-test',
    ...options.env,
  } as NodeJS.ProcessEnv);
  const prices = new MockPriceProvider();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, jwks: staticJwks([jwk]), priceProvider: prices, webAuthFetch: options.webAuthFetch })],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  options.configure?.(app);
  await app.init();

  const sign = async (key: CryptoKey, options: TokenOptions) =>
    new SignJWT({ client_id: 'test-client', scope: '', ...options.claims })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(options.issuer ?? ISSUER)
      .setSubject(options.subject ?? 'user-a')
      .setAudience(options.audience ?? config.auth.apiResourceUrl)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 600))
      .sign(key);

  return {
    app,
    http: request(app.getHttpServer()),
    config,
    prices,
    token: (options = {}) => sign(options.foreignKey ? foreign.privateKey : privateKey, options),
    close: async () => {
      await app.close();
      await database.stop();
    },
  };
}

/** Calls an MCP tool over the Streamable HTTP endpoint and returns the parsed result */
export async function callTool(
  test: TestApp,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; data: any; status: number }> {
  const response = await test.http
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (response.status !== 200) return { isError: true, data: response.body, status: response.status };
  const result = response.body.result;
  if (!result) return { isError: true, data: response.body.error, status: response.status };
  const text = result.content?.[0]?.text;
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON: SDK-level validation messages are plain text
  }
  return { isError: Boolean(result.isError), data, status: response.status };
}
