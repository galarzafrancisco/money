import { UpstreamError } from '../common/errors';
import { YahooPriceProvider } from './yahoo-price.provider';

const respond = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('YahooPriceProvider', () => {
  it('reads price, currency and time from the chart metadata', async () => {
    const provider = new YahooPriceProvider(
      respond(200, { chart: { result: [{ meta: { regularMarketPrice: 108.96, currency: 'AUD', regularMarketTime: 1792556528 } }] } }),
    );
    expect(await provider.getQuote('VAS.AX')).toEqual({
      symbol: 'VAS.AX',
      price: '108.96',
      currency: 'AUD',
      asOf: new Date(1792556528 * 1000).toISOString(),
      source: 'yahoo',
      isMock: false,
      priceType: 'LAST',
    });
  });

  it('says whether the latest price is a finished session\'s close', async () => {
    const regular = { start: 1792589400, end: 1792612800 };
    const at = (time: number) => new YahooPriceProvider(respond(200, { chart: { result: [{ meta: { regularMarketPrice: 1, currency: 'USD', regularMarketTime: time, currentTradingPeriod: { regular } } }] } }));
    expect((await at(1792600000).getQuote('VOO'))!.priceType).toBe('LAST');
    expect((await at(regular.end).getQuote('VOO'))!.priceType).toBe('CLOSE');
  });

  it('marks rate limiting and server errors as retryable, with Retry-After', async () => {
    const limited = (async () => new Response('{}', { status: 429, headers: { 'retry-after': '7' } })) as unknown as typeof fetch;
    await expect(new YahooPriceProvider(limited).getQuote('VOO')).rejects.toMatchObject({ details: { retryable: true, retryAfterSeconds: 7 } });
    await expect(new YahooPriceProvider(respond(400, {})).getQuote('VOO')).rejects.toMatchObject({ details: { retryable: false } });
  });

  it('returns null for unknown symbols', async () => {
    expect(await new YahooPriceProvider(respond(404, {})).getQuote('NOPE')).toBeNull();
    expect(await new YahooPriceProvider(respond(200, { chart: { result: null } })).getQuote('NOPE')).toBeNull();
  });

  it('reports upstream failures', async () => {
    await expect(new YahooPriceProvider(respond(500, {})).getQuote('VOO')).rejects.toThrow(UpstreamError);
    const failing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(new YahooPriceProvider(failing).getQuote('VOO')).rejects.toThrow(/network down/);
  });

  describe('daily closes', () => {
    // Three ASX sessions (bars stamped at the 10:00 Sydney open), the last one still trading
    const chart = {
      chart: {
        result: [
          {
            meta: {
              currency: 'AUD',
              exchangeTimezoneName: 'Australia/Sydney',
              // Today's regular session: 10:00–16:00 AEDT on 2025-01-08
              currentTradingPeriod: { regular: { start: 1736290800, end: 1736312400 } },
            },
            timestamp: [1736118000, 1736204400, 1736290800],
            indicators: { quote: [{ close: [100.5, null, 102.25] }] },
          },
        ],
      },
    };

    it('keys closes by exchange trading date and leaves out sessions that have not closed', async () => {
      const provider = new YahooPriceProvider(respond(200, chart));
      // 2025-01-08 14:00 AEDT: the 8th is still trading
      const series = await provider.getDailyCloses('VAS.AX', { from: '2025-01-01', to: '2025-01-08' }, new Date('2025-01-08T03:00:00Z'));
      expect(series).toEqual({
        symbol: 'VAS.AX',
        currency: 'AUD',
        exchangeTimezone: 'Australia/Sydney',
        source: 'yahoo',
        isMock: false,
        adjustment: 'AS_TRADED',
        splits: [],
        // The 7th has no close (null) and is skipped
        closes: [{ tradingDate: '2025-01-06', close: '100.5', closeTime: '2025-01-06T05:00:00.000Z' }],
      });
      const later = await provider.getDailyCloses('VAS.AX', { from: '2025-01-01', to: '2025-01-08' }, new Date('2025-01-08T06:00:00Z'));
      expect(later!.closes.map((c) => c.tradingDate)).toEqual(['2025-01-06', '2025-01-08']);
    });

    it('converts prices quoted in pence to pounds', async () => {
      const pence = { chart: { result: [{ ...chart.chart.result[0], meta: { ...chart.chart.result[0].meta, currency: 'GBp', exchangeTimezoneName: 'Europe/London' } }] } };
      const series = await new YahooPriceProvider(respond(200, pence)).getDailyCloses('VUSA.L', { from: '2025-01-01', to: '2025-01-08' }, new Date('2025-01-09T00:00:00Z'));
      expect(series!.currency).toBe('GBP');
      expect(series!.closes[0].close).toBe('1.005');
    });

    it('undoes Yahoo\'s split adjustment, including splits after the range, so closes are as traded', async () => {
      // NVDA around its 10:1 split of 2024-06-10 (Yahoo reports 115.0 for the 1150 actually traded on 2024-06-03)
      const nvda = (splitsInRange: boolean) => ({
        chart: {
          result: [
            {
              meta: { currency: 'USD', exchangeTimezoneName: 'America/New_York', currentTradingPeriod: { regular: { start: 1718026200, end: 1718049600 } } },
              timestamp: [1717421400, 1718026200],
              events: splitsInRange ? { splits: { '1718026200': { date: 1718026200, numerator: 10, denominator: 1 } } } : undefined,
              indicators: { quote: [{ close: [115.0, 121.79000091552734] }] },
            },
          ],
        },
      });
      const series = await new YahooPriceProvider(respond(200, nvda(true))).getDailyCloses('NVDA', { from: '2024-06-01', to: '2024-06-10' }, new Date('2024-06-11T00:00:00Z'));
      expect(series).toMatchObject({ adjustment: 'AS_TRADED', splits: [{ date: '2024-06-10', numerator: '10', denominator: '1' }] });
      expect(series!.closes.map((c) => [c.tradingDate, c.close])).toEqual([
        ['2024-06-03', '1150'],
        ['2024-06-10', '121.79'],
      ]);

      // An older range: the split is after it, so a second, coarse request finds it
      const urls: string[] = [];
      const fetchImpl = (async (url: string) => {
        urls.push(url);
        const later = url.includes('interval=3mo');
        const body = nvda(later);
        if (!later) body.chart.result[0].timestamp = [1717421400];
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch;
      const older = await new YahooPriceProvider(fetchImpl).getDailyCloses('NVDA', { from: '2024-06-01', to: '2024-06-05' }, new Date('2025-01-01T00:00:00Z'));
      expect(urls).toHaveLength(2);
      expect(urls[1]).toMatch(/interval=3mo&events=split/);
      expect(older!.closes).toEqual([{ tradingDate: '2024-06-03', close: '1150', closeTime: '2024-06-03T20:00:00.000Z' }]);
    });

    it('returns null for unknown symbols and throws on upstream failures', async () => {
      const range = { from: '2025-01-01', to: '2025-01-08' };
      expect(await new YahooPriceProvider(respond(404, {})).getDailyCloses('NOPE', range, new Date())).toBeNull();
      await expect(new YahooPriceProvider(respond(503, {})).getDailyCloses('VOO', range, new Date())).rejects.toThrow(UpstreamError);
    });
  });
});
