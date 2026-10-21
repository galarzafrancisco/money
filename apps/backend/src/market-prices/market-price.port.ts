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

export interface MarketPriceProvider {
  readonly name: string;
  /** The latest price, or null when the provider does not know the symbol */
  getQuote(symbol: string): Promise<Quote | null>;
}

export const MARKET_PRICE_PROVIDER = Symbol('MARKET_PRICE_PROVIDER');
