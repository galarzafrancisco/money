/**
 * The port every market-price source implements. Money only reads prices;
 * nothing is ever traded through a provider.
 */
export type Quote = {
  symbol: string;
  /** Decimal string */
  price: string;
  currency: string;
  /** When the provider says the price is from (ISO 8601) */
  asOf: string;
  /** Which provider produced it. "mock" prices are made up and must not be relied on. */
  source: string;
  isMock: boolean;
  /**
   * LAST: the provider's latest regular-market price (may be intraday and
   * delayed). CLOSE: the official close of a finished session.
   */
  priceType?: 'LAST' | 'CLOSE';
};

/**
 * The latest exchange rate between two currencies: `rate` units of `to` per
 * one unit of `from`. A market price like any other: read only, with its
 * source and time.
 */
export type FxQuote = {
  from: string;
  to: string;
  /** Decimal string */
  rate: string;
  /** When the provider says the rate is from (ISO 8601) */
  asOf: string;
  source: string;
  /** Made-up development data; never rely on it */
  isMock: boolean;
};

/** The official closing price of one trading session */
export type DailyClose = {
  /** The session's date in the exchange's time zone (YYYY-MM-DD) */
  tradingDate: string;
  /** Decimal string, in the series currency */
  close: string;
  /** When the session closed (ISO 8601), or null if the provider does not say */
  closeTime: string | null;
};

/** A stock split: one share before became numerator/denominator shares from `date` (exchange trading date) */
export type Split = { date: string; numerator: string; denominator: string };

/**
 * Daily closes of one symbol. Only FINISHED sessions are included: a
 * provider must leave out a session that has not closed yet, so an intraday
 * price is never presented as a close.
 */
export type DailyCloseSeries = {
  symbol: string;
  currency: string;
  /** IANA time zone of the exchange, e.g. Australia/Sydney */
  exchangeTimezone: string;
  source: string;
  /** Made-up development data; never rely on it */
  isMock: boolean;
  /**
   * AS_TRADED: the closes are the prices the shares actually traded at on
   * each date (not adjusted for later splits or dividends), so they can be
   * multiplied by the ledger's historical quantities. Providers must return
   * AS_TRADED closes; the Yahoo adapter reverses Yahoo's split adjustment.
   */
  adjustment: 'AS_TRADED';
  /** Splits known in or after the requested range (ascending by date) */
  splits: Split[];
  /** Ascending by tradingDate */
  closes: DailyClose[];
};

export interface MarketPriceProvider {
  readonly name: string;
  /** The latest price, or null when the provider does not know the symbol */
  getQuote(symbol: string): Promise<Quote | null>;
  /**
   * Closing prices for sessions whose trading date is within [from, to],
   * as known at `now`. Null when the provider does not know the symbol.
   * Throws (UpstreamError) when the provider cannot be reached.
   */
  getDailyCloses(symbol: string, range: { from: string; to: string }, now: Date): Promise<DailyCloseSeries | null>;
  /**
   * The latest rate for converting `from` into `to` (both ISO 4217 codes),
   * or null when the provider does not know the pair. Throws (UpstreamError)
   * when the provider cannot be reached.
   */
  getFxRate(from: string, to: string): Promise<FxQuote | null>;
}

export const MARKET_PRICE_PROVIDER = Symbol('MARKET_PRICE_PROVIDER');
