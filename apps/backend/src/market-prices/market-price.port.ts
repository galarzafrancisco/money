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
}

export const MARKET_PRICE_PROVIDER = Symbol('MARKET_PRICE_PROVIDER');
