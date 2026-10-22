import { MoneyDecimal, dec, fmt } from '../common/decimal';
import { UpstreamError } from '../common/errors';
import { addDays, dateInZone, isValidTimeZone, zonedParts, zonedTimeToUtc } from './market-calendar';
import type { DailyClose, DailyCloseSeries, FxQuote, MarketPriceProvider, Quote, Split } from './market-price.port';

/**
 * Yahoo Finance's chart endpoint. Free and keyless, covers the ASX (".AX")
 * and US listings and reports the currency, but it is UNOFFICIAL: no SLA,
 * no published terms for this use, may rate-limit or change without notice.
 * Opt in with MARKET_PRICE_PROVIDER=yahoo. Prices may be delayed.
 *
 * Daily closes come from the same endpoint with interval=1d. Yahoo's daily
 * "close" is adjusted for every split up to today (not for dividends). The
 * adapter asks for the split events too and multiplies the adjustment back
 * out, so the closes it returns are the prices actually traded on each date
 * (AS_TRADED), matching the ledger's unadjusted quantities. See
 * docs/market-prices.md.
 *
 * Failures that may pass (HTTP 429 and 5xx, timeouts, network errors) are
 * UpstreamErrors with details.retryable; ThrottledPriceProvider retries them.
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
    const time = meta.regularMarketTime;
    const regular = meta.currentTradingPeriod?.regular;
    // Outside the current regular session the latest price is that session's (or the previous one's) close
    const closed =
      typeof time === 'number' && typeof regular?.start === 'number' && typeof regular?.end === 'number' && (time >= regular.end || time < regular.start);
    return {
      symbol: symbol.toUpperCase(),
      // Yahoo returns a float; keep it as written, no float arithmetic on it
      price,
      currency,
      asOf: new Date((time ?? Date.now() / 1000) * 1000).toISOString(),
      source: this.name,
      isMock: false,
      priceType: closed ? 'CLOSE' : 'LAST',
    };
  }

  /** Yahoo lists currency pairs as e.g. "AUDUSD=X": USD per 1 AUD */
  async getFxRate(from: string, to: string): Promise<FxQuote | null> {
    const pair = `${from.toUpperCase()}${to.toUpperCase()}=X`;
    const body = await this.fetchChart(pair, 'range=1d&interval=1d');
    const meta = body?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number' || !(meta.regularMarketPrice > 0)) return null;
    return {
      from: from.toUpperCase(),
      to: to.toUpperCase(),
      rate: String(meta.regularMarketPrice),
      asOf: new Date((meta.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString(),
      source: this.name,
      isMock: false,
    };
  }

  async getDailyCloses(symbol: string, range: { from: string; to: string }, now: Date): Promise<DailyCloseSeries | null> {
    // A day either side, as trading dates are in the exchange's zone, not UTC
    const period1 = Math.floor(Date.parse(`${addDays(range.from, -1)}T00:00:00Z`) / 1000);
    const period2 = Math.floor(Date.parse(`${addDays(range.to, 2)}T00:00:00Z`) / 1000);
    const body = await this.fetchChart(symbol, `period1=${period1}&period2=${period2}&interval=1d&events=split`);
    const result = body?.chart?.result?.[0];
    const meta = result?.meta;
    if (!result || !meta?.currency) return null;
    const timeZone = meta.exchangeTimezoneName && isValidTimeZone(meta.exchangeTimezoneName) ? meta.exchangeTimezoneName : null;
    if (!timeZone) throw new UpstreamError(`Yahoo price history for ${symbol} has no usable exchange time zone`);

    // Yahoo adjusts every close for all splits up to today, so splits after the range matter too
    const splits = new Map<string, Split>();
    const addSplits = (events: YahooSplits | undefined) => {
      for (const event of Object.values(events ?? {})) {
        if (typeof event?.date !== 'number' || !(event.numerator! > 0) || !(event.denominator! > 0)) continue;
        const date = dateInZone(new Date(event.date * 1000), timeZone);
        splits.set(date, { date, numerator: String(event.numerator), denominator: String(event.denominator) });
      }
    };
    addSplits(result.events?.splits);
    if (period2 * 1000 < now.getTime()) {
      // One cheap coarse request for the split events from the range to today
      const later = await this.fetchChart(symbol, `period1=${period1}&period2=${Math.floor(now.getTime() / 1000)}&interval=3mo&events=split`);
      addSplits(later?.chart?.result?.[0]?.events?.splits);
    }
    const splitList = [...splits.values()].filter((s) => s.date > range.from).sort((a, b) => a.date.localeCompare(b.date));
    /** Undoes Yahoo's adjustment for the splits on or after the session after `tradingDate` */
    const asTraded = (tradingDate: string, close: MoneyDecimal) =>
      splitList.filter((s) => s.date > tradingDate).reduce((value, s) => value.times(s.numerator).dividedBy(s.denominator), close);

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
      // Yahoo's bar closes are single-precision floats (121.79 arrives as 121.79000091552734): 7 significant digits are real
      const close = fmt(asTraded(tradingDate, dec(majorUnits(meta.currency, String(raw)).price).toSignificantDigits(7)).toDecimalPlaces(10));
      byDate.set(tradingDate, { tradingDate, close, closeTime: closeTime?.toISOString() ?? null });
    }
    return {
      symbol: symbol.toUpperCase(),
      currency: majorUnits(meta.currency, '0').currency,
      exchangeTimezone: timeZone,
      source: this.name,
      isMock: false,
      adjustment: 'AS_TRADED',
      splits: splitList,
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
      throw new UpstreamError(`Yahoo price lookup for ${symbol} failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new UpstreamError(`Yahoo price lookup for ${symbol} failed with HTTP ${response.status}`, {
        retryable: response.status === 429 || response.status >= 500,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      });
    }
    try {
      return (await response.json()) as YahooChartResponse;
    } catch {
      throw new UpstreamError(`Yahoo price lookup for ${symbol} returned a body that is not JSON`, { retryable: true });
    }
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
          events?: { splits?: YahooSplits };
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[]
      | null;
  };
};

type YahooSplits = Record<string, { date?: number; numerator?: number; denominator?: number } | undefined>;
