import { loadConfig } from '../config/env.config';
import { MockPriceProvider, MOCK_MISSING_SUFFIX, MOCK_STALE_SUFFIX } from '../market-prices/mock-price.provider';
import { SEED_SUBJECT_PREFIX, SEED_USERS } from './seed-dataset';
import { seedRefusal } from './seed-guard';

const configFor = (env: Record<string, string>) => loadConfig({ NODE_ENV: 'development', ...env } as NodeJS.ProcessEnv);

describe('seedRefusal', () => {
  it('allows embedded PGlite and loopback Postgres with mock prices', () => {
    expect(seedRefusal(configFor({}), {})).toBeNull();
    expect(seedRefusal(configFor({ DATABASE_URL: 'postgres://u:p@localhost:5432/money' }), {})).toBeNull();
    expect(seedRefusal(configFor({ DATABASE_URL: 'postgres://u:p@127.0.0.1/money' }), {})).toBeNull();
    expect(seedRefusal(configFor({ DATABASE_URL: 'postgres://u:p@[::1]:5432/money' }), {})).toBeNull();
  });

  it('refuses production', () => {
    const config = configFor({ DATABASE_URL: 'postgres://u:p@localhost/money' });
    expect(seedRefusal({ ...config, nodeEnv: 'production' }, {})).toMatch(/NODE_ENV=production/);
    expect(seedRefusal(config, { NODE_ENV: 'production' })).toMatch(/NODE_ENV=production/);
  });

  it('refuses the in-memory database', () => {
    expect(seedRefusal(configFor({ DATABASE_MODE: 'memory' }), {})).toMatch(/DATABASE_MODE=memory/);
  });

  it('refuses a non-loopback database unless explicitly allowed', () => {
    const config = configFor({ DATABASE_URL: 'postgres://u:p@money-db.prod.svc:5432/money' });
    expect(seedRefusal(config, {})).toMatch(/only localhost databases/);
    expect(seedRefusal(config, { SEED_ALLOW_NON_LOCAL_DATABASE: 'true' })).toBeNull();
  });

  it('refuses a real price provider', () => {
    expect(seedRefusal(configFor({ MARKET_PRICE_PROVIDER: 'yahoo' }), {})).toMatch(/MARKET_PRICE_PROVIDER=mock/);
  });
});

describe('reserved mock ticker suffixes', () => {
  const mock = new MockPriceProvider();
  const range = { from: '2026-06-01', to: '2026-06-30' };
  const now = new Date('2026-07-01T00:00:00Z');

  it(`${MOCK_MISSING_SUFFIX} has no quote and no closes`, async () => {
    expect(await mock.getQuote(`ABC${MOCK_MISSING_SUFFIX}`)).toBeNull();
    expect(await mock.getDailyCloses(`ABC${MOCK_MISSING_SUFFIX}`, range, now)).toBeNull();
  });

  it(`${MOCK_STALE_SUFFIX} fails quotes but serves closes`, async () => {
    await expect(mock.getQuote(`ABC${MOCK_STALE_SUFFIX}`)).rejects.toThrow(/unavailable/);
    const series = await mock.getDailyCloses(`ABC${MOCK_STALE_SUFFIX}`, range, now);
    expect(series?.closes.length).toBeGreaterThan(0);
  });
});

describe('seed dataset', () => {
  it('uses only synthetic identities, marked as such', () => {
    for (const user of SEED_USERS) {
      expect(user.subject.startsWith(SEED_SUBJECT_PREFIX)).toBe(true);
      expect(user.email.endsWith('.invalid')).toBe(true);
      expect(user.displayName).toMatch(/\(synthetic\)$/);
    }
    expect(new Set(SEED_USERS.map((u) => u.subject)).size).toBe(SEED_USERS.length);
  });

  it('prices every trade within the mock provider\'s daily swing of its base price', async () => {
    const mock = new MockPriceProvider();
    for (const user of SEED_USERS) {
      for (const item of user.activity) {
        if (item.kind !== 'transaction' || (item.input.type !== 'BUY' && item.input.type !== 'SELL')) continue;
        const symbol = item.input.symbol.toUpperCase();
        if (symbol.endsWith(MOCK_MISSING_SUFFIX) || symbol.endsWith(MOCK_STALE_SUFFIX)) continue;
        const base = Number((await mock.getQuote(symbol))!.price);
        const price = Number(item.input.unitPrice);
        expect({ symbol, ratio: Math.abs(price / base - 1) <= 0.05 }).toEqual({ symbol, ratio: true });
      }
    }
  });
});
