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
    });
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

    it('returns null for unknown symbols and throws on upstream failures', async () => {
      const range = { from: '2025-01-01', to: '2025-01-08' };
      expect(await new YahooPriceProvider(respond(404, {})).getDailyCloses('NOPE', range, new Date())).toBeNull();
      await expect(new YahooPriceProvider(respond(503, {})).getDailyCloses('VOO', range, new Date())).rejects.toThrow(UpstreamError);
    });
  });
});
