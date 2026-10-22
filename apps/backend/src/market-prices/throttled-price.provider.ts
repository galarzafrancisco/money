import { DomainError } from '../common/errors';
import type { DailyCloseSeries, FxQuote, MarketPriceProvider, Quote } from './market-price.port';

export type ThrottleOptions = {
  /** Provider requests in flight at once, across every caller in this process */
  maxConcurrent: number;
  /** Minimum gap between the starts of two requests */
  minIntervalMs: number;
  /** Extra attempts after a retryable failure (HTTP 429/5xx, timeout, network) */
  retries: number;
  /** First retry delay; doubles each attempt. A Retry-After header wins, up to maxRetryDelayMs. */
  retryBaseMs: number;
  maxRetryDelayMs: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wraps the configured provider so every caller (quotes, the valuation job,
 * on-demand reconstruction, dashboards) shares one limit on concurrent
 * requests and request rate, and retries transient failures with backoff.
 * Unofficial free sources such as Yahoo rate-limit aggressive clients.
 */
export class ThrottledPriceProvider implements MarketPriceProvider {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private nextStart = 0;

  constructor(
    readonly inner: MarketPriceProvider,
    private readonly options: ThrottleOptions,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  getQuote(symbol: string): Promise<Quote | null> {
    return this.call(() => this.inner.getQuote(symbol));
  }

  getDailyCloses(symbol: string, range: { from: string; to: string }, now: Date): Promise<DailyCloseSeries | null> {
    return this.call(() => this.inner.getDailyCloses(symbol, range, now));
  }

  getFxRate(from: string, to: string): Promise<FxQuote | null> {
    return this.call(() => this.inner.getFxRate(from, to));
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.slot(fn);
      } catch (error) {
        const details = error instanceof DomainError ? error.details : undefined;
        if (attempt >= this.options.retries || details?.retryable !== true) throw error;
        const retryAfter = typeof details.retryAfterSeconds === 'number' ? details.retryAfterSeconds * 1000 : 0;
        await sleep(Math.min(this.options.maxRetryDelayMs, Math.max(retryAfter, this.options.retryBaseMs * 2 ** attempt)));
      }
    }
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    // A finishing call hands its slot straight to the next waiter, so `active` never exceeds the limit
    if (this.active >= this.options.maxConcurrent) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      const wait = this.nextStart - Date.now();
      this.nextStart = Math.max(Date.now(), this.nextStart) + this.options.minIntervalMs;
      if (wait > 0) await sleep(wait);
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
