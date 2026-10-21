import { loadConfig } from './env.config';

const PRODUCTION = { NODE_ENV: 'production', TAICO_ISSUER: 'https://taico.app', SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };

describe('loadConfig database selection', () => {
  it('uses Postgres when DATABASE_URL is set', () => {
    expect(loadConfig({ ...PRODUCTION, DATABASE_URL: 'postgresql://u:p@db:5432/money' }).database).toEqual({
      driver: 'postgres',
      url: 'postgresql://u:p@db:5432/money',
      ssl: false,
      poolMax: 10,
    });
  });

  it('refuses to start in production without DATABASE_URL or an explicit mode', () => {
    expect(() => loadConfig(PRODUCTION)).toThrow(/DATABASE_URL is required in production/);
  });

  it('allows the explicit non-durable in-memory mode in production', () => {
    expect(loadConfig({ ...PRODUCTION, DATABASE_MODE: 'memory' }).database).toEqual({ driver: 'memory' });
  });

  it('rejects DATABASE_MODE=memory together with DATABASE_URL', () => {
    expect(() => loadConfig({ ...PRODUCTION, DATABASE_MODE: 'memory', DATABASE_URL: 'postgresql://db/money' })).toThrow(/both set/);
  });

  it('never runs on-disk PGlite in production', () => {
    expect(() => loadConfig({ ...PRODUCTION, DATABASE_MODE: 'pglite' })).toThrow(/not allowed in production/);
  });

  it('requires DATABASE_URL for DATABASE_MODE=postgres', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', DATABASE_MODE: 'postgres' })).toThrow(/requires DATABASE_URL/);
  });

  it('rejects unknown modes', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', DATABASE_MODE: 'sqlite' })).toThrow(/DATABASE_MODE must be one of/);
  });

  it('defaults to on-disk PGlite outside production', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).database).toEqual({ driver: 'pglite', dataDir: '.data/pglite' });
    expect(loadConfig({ NODE_ENV: 'development', PGLITE_DATA_DIR: '/tmp/x' }).database).toEqual({ driver: 'pglite', dataDir: '/tmp/x' });
  });

  it('keeps JWT validation configured in memory mode', () => {
    const config = loadConfig({ ...PRODUCTION, DATABASE_MODE: 'memory', PUBLIC_BASE_URL: 'https://money.american-broomstick.com' });
    expect(config.auth.issuer).toBe('https://taico.app');
    expect(config.auth.mcpResourceUrl).toBe('https://money.american-broomstick.com/mcp');
    expect(config.auth.apiResourceUrl).toBe('https://money.american-broomstick.com/api');
    expect(() => loadConfig({ ...PRODUCTION, TAICO_ISSUER: undefined, DATABASE_MODE: 'memory' })).toThrow(/TAICO_ISSUER is required/);
  });
});
