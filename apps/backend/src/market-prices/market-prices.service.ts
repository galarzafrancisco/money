import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotFoundError } from '../common/errors';
import { parseInput } from '../common/validation';
import { tickerSymbol } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { MARKET_PRICE_PROVIDER, type FxQuote, type MarketPriceProvider, type Quote } from './market-price.port';
import { PriceStoreRepository } from './price-store.repository';

/**
 * A quote as served: fresh from the provider (isStale false), or, when the
 * provider fails, the last one fetched or the latest stored close, flagged
 * isStale with the reason. Never a made-up or cost-based price.
 */
export type QuoteView = Quote & { priceType: 'LAST' | 'CLOSE'; isStale: boolean; staleReason: string | null };
export type FxRateView = FxQuote & { isStale: boolean; staleReason: string | null };

export type QuoteResult = { quote: QuoteView } | { error: string };
export type FxRateResult = { rate: FxRateView } | { error: string };

/**
 * Read-only latest prices through the configured provider. Fresh quotes are
 * reused for MARKET_PRICE_CACHE_SECONDS. When the provider is down, the last
 * good quote in this process, or else the latest close in the shared price
 * store, is served instead, with isStale and its age (asOf) shown.
 */
@Injectable()
export class MarketPricesService {
  private readonly logger = new Logger('MarketPrices');
  private readonly cache = new Map<string, { quote: QuoteView; expires: number }>();
  private readonly fxCache = new Map<string, { rate: FxRateView; expires: number }>();

  constructor(
    @Inject(MARKET_PRICE_PROVIDER) private readonly provider: MarketPriceProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: PriceStoreRepository,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  async getQuote(rawSymbol: string): Promise<QuoteView> {
    const symbol = parseInput(tickerSymbol, rawSymbol);
    const cached = this.cache.get(symbol);
    if (cached && cached.expires > Date.now()) return cached.quote;
    let quote: Quote | null;
    try {
      quote = await this.provider.getQuote(symbol);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const fallback = cached?.quote ?? (await this.storedQuote(symbol));
      if (!fallback) throw error;
      this.logger.warn(`${reason}; serving a stale price for ${symbol} from ${fallback.asOf}`);
      return { ...fallback, isStale: true, staleReason: `${reason}. Showing the last known price, from ${fallback.asOf}.` };
    }
    if (!quote) throw new NotFoundError(`No price found for ${symbol} from provider ${this.provider.name}`);
    const view: QuoteView = { ...quote, priceType: quote.priceType ?? 'LAST', isStale: false, staleReason: null };
    // Kept past expiry as the fallback for an outage; expiry only decides when to ask again
    this.cache.set(symbol, { quote: view, expires: Date.now() + this.config.marketPrices.cacheSeconds * 1000 });
    return view;
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

  /**
   * The latest rate converting `from` into `to` (units of `to` per `from`).
   * A failure or unknown pair gives an error instead of throwing, so a caller
   * can report the rate as unavailable rather than fail outright. During an
   * outage the last known rate is served, flagged isStale.
   */
  async getFxRate(from: string, to: string): Promise<FxRateResult> {
    const key = `${from}|${to}`;
    const cached = this.fxCache.get(key);
    if (cached && cached.expires > Date.now()) return { rate: cached.rate };
    try {
      const rate = await this.provider.getFxRate(from, to);
      if (!rate) return { error: `No ${from}→${to} exchange rate from provider ${this.provider.name}` };
      const view: FxRateView = { ...rate, isStale: false, staleReason: null };
      this.fxCache.set(key, { rate: view, expires: Date.now() + this.config.marketPrices.cacheSeconds * 1000 });
      return { rate: view };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const fallback = cached?.rate ?? (await this.storedFxRate(from, to));
      if (!fallback) return { error: reason };
      return { rate: { ...fallback, isStale: true, staleReason: `${reason}. Showing the last known rate, from ${fallback.asOf}.` } };
    }
  }

  clearCache(): void {
    this.fxCache.clear();
    this.cache.clear();
  }

  private async storedQuote(symbol: string): Promise<QuoteView | null> {
    const close = await this.store.latestClose(symbol, this.provider.name);
    if (!close) return null;
    return {
      symbol,
      price: close.close,
      currency: close.currency,
      asOf: close.closeTime ?? `${close.tradingDate}T00:00:00.000Z`,
      source: this.provider.name,
      isMock: close.isMock,
      priceType: 'CLOSE',
      isStale: true,
      staleReason: null,
    };
  }

  /** The latest stored daily close of the pair, as recorded by historical FX lookups */
  private async storedFxRate(from: string, to: string): Promise<FxRateView | null> {
    const close = await this.store.latestClose(`${from}${to}=X`, this.provider.name);
    if (!close || close.currency !== to) return null;
    return { from, to, rate: close.close, asOf: close.closeTime ?? `${close.tradingDate}T00:00:00.000Z`, source: this.provider.name, isMock: close.isMock, isStale: true, staleReason: null };
  }
}
