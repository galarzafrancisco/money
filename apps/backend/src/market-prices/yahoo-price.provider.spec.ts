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
});
