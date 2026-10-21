import { dec, fmt } from '../common/decimal';
import { UpstreamError } from '../common/errors';
import { addDays, dateInZone, isValidTimeZone, zonedParts, zonedTimeToUtc } from './market-calendar';
import type { DailyClose, DailyCloseSeries, MarketPriceProvider, Quote } from './market-price.port';

/**
 * Yahoo Finance's chart endpoint. Free and keyless, covers the ASX (".AX")
 * and US listings and reports the currency, but it is UNOFFICIAL: no SLA,
 * no published terms for this use, may rate-limit or change without notice.
 * Opt in with MARKET_PRICE_PROVIDER=yahoo. Prices may be delayed.
 *
 * Daily closes come from the same endpoint with interval=1d. Yahoo's daily
 * "close" is adjusted for splits (not for dividends); see docs/valuations.md.
 */
export class YahooPriceProvider implements MarketPriceProvider {
  readonly name = 'yahoo';

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/',
    private readonly timeoutMs = 5000,
    /** How long after the scheduled close a session's bar is trusted as the final close */
    private readonly settleMinutes = 30,
  ) {}

  async getQuote(symbol: string): Promise<Quote | null> {
    const body = await this.fetchChart(symbol, 'range=1d&interval=1d');
    const meta = body?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number' || !meta.currency) return null;
    const { currency, price } = majorUnits(meta.currency, String(meta.regularMarketPrice));
    return {
      symbol: symbol.toUpperCase(),
      // Yahoo returns a float; keep it as written, no float arithmetic on it
      price,
      currency,
      asOf: new Date((meta.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString(),
      source: this.name,
      isMock: false,
    };
  }

  async getDailyCloses(symbol: string, range: { from: string; to: string }, now: Date): Promise<DailyCloseSeries | null> {
    // A day either side, as trading dates are in the exchange's zone, not UTC
    const period1 = Math.floor(Date.parse(`${addDays(range.from, -1)}T00:00:00Z`) / 1000);
    const period2 = Math.floor(Date.parse(`${addDays(range.to, 2)}T00:00:00Z`) / 1000);
    const body = await this.fetchChart(symbol, `period1=${period1}&period2=${period2}&interval=1d&events=`);
    const result = body?.chart?.result?.[0];
    const meta = result?.meta;
    if (!result || !meta?.currency) return null;
    const timeZone = meta.exchangeTimezoneName && isValidTimeZone(meta.exchangeTimezoneName) ? meta.exchangeTimezoneName : null;
    if (!timeZone) throw new UpstreamError(`Yahoo price history for ${symbol} has no usable exchange time zone`);
    const regularEnd = meta.currentTradingPeriod?.regular?.end;
    // The scheduled closing time of day, e.g. 16:00:00; half-day sessions are not known
    const closeAt = typeof regularEnd === 'number' ? zonedParts(new Date(regularEnd * 1000), timeZone).time : null;
    const timestamps = result.timestamp ?? [];
    const rawCloses = result.indicators?.quote?.[0]?.close ?? [];
    const byDate = new Map<string, DailyClose>();
    for (let i = 0; i < timestamps.length; i++) {
      const raw = rawCloses[i];
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
      const tradingDate = dateInZone(new Date(timestamps[i] * 1000), timeZone);
      if (tradingDate < range.from || tradingDate > range.to) continue;
      const closeTime = closeAt ? zonedTimeToUtc(tradingDate, closeAt, timeZone) : null;
      // Leave out a session that has not finished: its "close" is the latest intraday price
      const finalAfter = closeTime ? closeTime.getTime() + this.settleMinutes * 60_000 : null;
      if (finalAfter !== null ? now.getTime() < finalAfter : tradingDate >= dateInZone(now, timeZone)) continue;
      byDate.set(tradingDate, { tradingDate, close: majorUnits(meta.currency, String(raw)).price, closeTime: closeTime?.toISOString() ?? null });
    }
    return {
      symbol: symbol.toUpperCase(),
      currency: majorUnits(meta.currency, '0').currency,
      exchangeTimezone: timeZone,
      source: this.name,
      isMock: false,
      closes: [...byDate.values()].sort((a, b) => a.tradingDate.localeCompare(b.tradingDate)),
    };
  }

  private async fetchChart(symbol: string, query: string): Promise<YahooChartResponse | null> {
    const url = `${this.baseUrl}${encodeURIComponent(symbol)}?${query}`;
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
    return (await response.json()) as YahooChartResponse;
  }
}

/**
 * Some listings are quoted in minor units: London in pence (GBp/GBX),
 * Johannesburg in cents (ZAc), Tel Aviv in agorot (ILA). Converted to the
 * major currency so the price matches trades recorded in GBP/ZAR/ILS.
 */
export function majorUnits(currency: string, price: string): { currency: string; price: string } {
  const minor: Record<string, string> = { GBp: 'GBP', GBX: 'GBP', ZAc: 'ZAR', ZAC: 'ZAR', ILA: 'ILS' };
  const major = minor[currency];
  if (major) return { currency: major, price: fmt(dec(price).dividedBy(100)) };
  return { currency: currency.toUpperCase(), price };
}

type YahooChartResponse = {
  chart?: {
    result?:
      | {
          meta?: {
            regularMarketPrice?: number;
            currency?: string;
            regularMarketTime?: number;
            exchangeTimezoneName?: string;
            currentTradingPeriod?: { regular?: { start?: number; end?: number } };
          };
          timestamp?: number[];
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[]
      | null;
  };
};
