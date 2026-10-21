import { UpstreamError } from '../common/errors';
import type { MarketPriceProvider, Quote } from './market-price.port';

/**
 * Yahoo Finance's chart endpoint. Free and keyless, covers the ASX (".AX")
 * and US listings and reports the currency, but it is UNOFFICIAL: no SLA,
 * no published terms for this use, may rate-limit or change without notice.
 * Opt in with MARKET_PRICE_PROVIDER=yahoo. Prices may be delayed.
 */
export class YahooPriceProvider implements MarketPriceProvider {
  readonly name = 'yahoo';

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/',
    private readonly timeoutMs = 5000,
  ) {}

  async getQuote(symbol: string): Promise<Quote | null> {
    const url = `${this.baseUrl}${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Money personal tracker)', Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new UpstreamError(`Yahoo price lookup for ${symbol} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new UpstreamError(`Yahoo price lookup for ${symbol} failed with HTTP ${response.status}`);
    const body = (await response.json()) as YahooChartResponse;
    const meta = body.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number' || !meta.currency) return null;
    return {
      symbol: symbol.toUpperCase(),
      // Yahoo returns a float; keep it as written, no float arithmetic on it
      price: String(meta.regularMarketPrice),
      currency: meta.currency.toUpperCase(),
      asOf: new Date((meta.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString(),
      source: this.name,
      isMock: false,
    };
  }
}

type YahooChartResponse = {
  chart?: { result?: { meta?: { regularMarketPrice?: number; currency?: string; regularMarketTime?: number } }[] | null };
};
