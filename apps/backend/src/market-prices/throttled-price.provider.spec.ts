import { UpstreamError } from '../common/errors';
import type { MarketPriceProvider, Quote } from './market-price.port';
import { ThrottledPriceProvider } from './throttled-price.provider';

const quote = (symbol: string): Quote => ({ symbol, price: '1', currency: 'USD', asOf: '2025-01-01T00:00:00.000Z', source: 'test', isMock: false });

function fakeProvider(getQuote: (symbol: string) => Promise<Quote | null>): MarketPriceProvider {
  return { name: 'test', getQuote, getDailyCloses: async () => null, getFxRate: async () => null };
}

const options = { maxConcurrent: 2, minIntervalMs: 0, retries: 2, retryBaseMs: 1, maxRetryDelayMs: 5 };

describe('ThrottledPriceProvider', () => {
  it('never has more requests in flight than the limit', async () => {
    let active = 0;
    let peak = 0;
    const provider = new ThrottledPriceProvider(
      fakeProvider(async (symbol) => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return quote(symbol);
      }),
      options,
    );
    const results = await Promise.all(Array.from({ length: 9 }, (_, i) => provider.getQuote(`S${i}`)));
    expect(results.map((r) => r!.symbol)).toEqual(Array.from({ length: 9 }, (_, i) => `S${i}`));
    expect(peak).toBe(2);
  });

  it('retries retryable failures with backoff, then gives up', async () => {
    let calls = 0;
    const flaky = new ThrottledPriceProvider(
      fakeProvider(async (symbol) => {
        if (++calls < 3) throw new UpstreamError('HTTP 429', { retryable: true });
        return quote(symbol);
      }),
      options,
    );
    expect(await flaky.getQuote('VOO')).toMatchObject({ symbol: 'VOO' });
    expect(calls).toBe(3);

    calls = 0;
    const down = new ThrottledPriceProvider(
      fakeProvider(async () => {
        calls++;
        throw new UpstreamError('HTTP 503', { retryable: true });
      }),
      options,
    );
    await expect(down.getQuote('VOO')).rejects.toThrow('HTTP 503');
    expect(calls).toBe(3);
  });

  it('does not retry failures that will not pass', async () => {
    let calls = 0;
    const provider = new ThrottledPriceProvider(
      fakeProvider(async () => {
        calls++;
        throw new UpstreamError('HTTP 400', { retryable: false });
      }),
      options,
    );
    await expect(provider.getQuote('VOO')).rejects.toThrow('HTTP 400');
    expect(calls).toBe(1);
  });

  it('spaces out request starts', async () => {
    const starts: number[] = [];
    const provider = new ThrottledPriceProvider(
      fakeProvider(async (symbol) => {
        starts.push(Date.now());
        return quote(symbol);
      }),
      { ...options, maxConcurrent: 4, minIntervalMs: 20 },
    );
    await Promise.all(['A', 'B', 'C'].map((s) => provider.getQuote(s)));
    expect(starts[2] - starts[0]).toBeGreaterThanOrEqual(35);
  });
});
