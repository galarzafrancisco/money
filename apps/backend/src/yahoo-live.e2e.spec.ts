import { addDays } from './market-prices/market-calendar';
import type { MarketPriceProvider } from './market-prices/market-price.port';
import { YahooPriceProvider } from './market-prices/yahoo-price.provider';
import { createTestApp, type TestApp } from './test-support/test-app';

/**
 * OPT-IN smoke test against the real (unofficial) Yahoo Finance endpoint:
 *
 *   MONEY_LIVE_YAHOO=1 npx jest src/yahoo-live.e2e.spec.ts
 *
 * Skipped otherwise, so CI and normal runs stay offline. It checks the
 * acceptance path end to end: a real quote with no mock label, dated closes
 * from Yahoo, and a second lookup of the same history served from the
 * database without another request.
 */
const live = process.env.MONEY_LIVE_YAHOO === '1';

(live ? describe : describe.skip)('live Yahoo Finance (opt-in)', () => {
  let t: TestApp;
  let token: string;
  const calls: string[] = [];

  beforeAll(async () => {
    const yahoo = new YahooPriceProvider();
    const counting: MarketPriceProvider = {
      name: yahoo.name,
      getQuote: (symbol) => (calls.push(`quote:${symbol}`), yahoo.getQuote(symbol)),
      getDailyCloses: (symbol, range, now) => (calls.push(`closes:${symbol}:${range.from}:${range.to}`), yahoo.getDailyCloses(symbol, range, now)),
      getFxRate: (from, to) => (calls.push(`fx:${from}${to}`), yahoo.getFxRate(from, to)),
    };
    t = await createTestApp({ priceProvider: counting, env: { MARKET_PRICE_PROVIDER: 'yahoo' } });
    token = await t.token({ subject: 'live-yahoo' });
  });
  afterAll(() => t?.close());

  it('serves a real quote and dated closes, then reuses the stored history', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const quote = (await t.http.get('/api/market-prices/VOO').set(auth).expect(200)).body;
    expect(quote).toMatchObject({ symbol: 'VOO', currency: 'USD', source: 'yahoo', isMock: false, isStale: false });

    const account = (await t.http.post('/api/accounts').set(auth).send({ name: 'Live broker' }).expect(201)).body;
    const today = new Date().toISOString().slice(0, 10);
    const date = addDays(today, -30);
    await t.http.post(`/api/accounts/${account.id}/transactions`).set(auth).send({ type: 'DEPOSIT', date: addDays(date, -5), currency: 'USD', amount: '10000' }).expect(201);
    await t.http.post(`/api/accounts/${account.id}/transactions`).set(auth).send({ type: 'BUY', date: addDays(date, -5), symbol: 'VOO', currency: 'USD', quantity: '2', unitPrice: '400', fees: '0' }).expect(201);

    const first = (await t.http.get(`/api/valuations/as-of?date=${date}&baseCurrency=AUD`).set(auth).expect(200)).body;
    const voo = first.holdings[0];
    expect(voo.price).toMatchObject({ source: 'yahoo', isMock: false, currency: 'USD', exchangeTimezone: 'America/New_York' });
    expect(['CLOSE', 'NON_TRADING_DAY']).toContain(voo.price.status);
    expect(voo.price.tradingDate <= date).toBe(true);
    expect(first.totals.converted.rates[0]).toMatchObject({ currency: 'USD', kind: 'HISTORICAL', source: 'yahoo' });

    const before = calls.filter((c) => c.startsWith('closes:')).length;
    const second = (await t.http.get(`/api/valuations/as-of?date=${date}&baseCurrency=AUD`).set(auth).expect(200)).body;
    expect(calls.filter((c) => c.startsWith('closes:')).length).toBe(before);
    expect(second.holdings).toEqual(first.holdings);
  });
});
