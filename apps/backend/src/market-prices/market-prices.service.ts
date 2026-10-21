import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../common/errors';
import { parseInput } from '../common/validation';
import { tickerSymbol } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { MARKET_PRICE_PROVIDER, type MarketPriceProvider, type Quote } from './market-price.port';

export type QuoteResult = { quote: Quote } | { error: string };

/** Read-only price lookups through the configured provider, with a short in-memory cache */
@Injectable()
export class MarketPricesService {
  private readonly cache = new Map<string, { quote: Quote; expires: number }>();

  constructor(
    @Inject(MARKET_PRICE_PROVIDER) private readonly provider: MarketPriceProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  async getQuote(rawSymbol: string): Promise<Quote> {
    const symbol = parseInput(tickerSymbol, rawSymbol);
    const cached = this.cache.get(symbol);
    if (cached && cached.expires > Date.now()) return cached.quote;
    const quote = await this.provider.getQuote(symbol);
    if (!quote) throw new NotFoundError(`No price found for ${symbol} from provider ${this.provider.name}`);
    this.cache.set(symbol, { quote, expires: Date.now() + this.config.marketPrices.cacheSeconds * 1000 });
    return quote;
  }

  /** Quotes for several symbols; a failed lookup gives an error for that symbol instead of failing them all */
  async getQuotes(symbols: string[]): Promise<Map<string, QuoteResult>> {
    const results = await Promise.all(
      symbols.map(async (symbol): Promise<[string, QuoteResult]> => {
        try {
          return [symbol, { quote: await this.getQuote(symbol) }];
        } catch (error) {
          return [symbol, { error: error instanceof Error ? error.message : String(error) }];
        }
      }),
    );
    return new Map(results);
  }

  clearCache(): void {
    this.cache.clear();
  }
}
