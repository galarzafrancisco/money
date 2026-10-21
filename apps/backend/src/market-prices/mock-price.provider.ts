import { createHash } from 'node:crypto';
import type { MarketPriceProvider, Quote } from './market-price.port';

/**
 * MOCK prices, for development and tests. A symbol's price is derived from a
 * hash of its name (stable between calls, between 5 and 505), unless a test
 * sets one. Currency is guessed from the suffix: .AX → AUD, .L → GBP,
 * .TO → CAD, otherwise USD. Every quote says `source: "mock"`.
 */
export class MockPriceProvider implements MarketPriceProvider {
  readonly name = 'mock';
  private readonly overrides = new Map<string, { price: string; currency?: string }>();

  setPrice(symbol: string, price: string, currency?: string): void {
    this.overrides.set(symbol.toUpperCase(), { price, currency });
  }

  clear(): void {
    this.overrides.clear();
  }

  async getQuote(symbol: string): Promise<Quote> {
    const upper = symbol.toUpperCase();
    const override = this.overrides.get(upper);
    const hash = createHash('sha256').update(upper).digest().readUInt32BE(0);
    const price = override?.price ?? (5 + (hash % 50000) / 100).toFixed(2);
    return {
      symbol: upper,
      price,
      currency: override?.currency ?? guessCurrency(upper),
      asOf: new Date().toISOString(),
      source: this.name,
      isMock: true,
    };
  }
}

function guessCurrency(symbol: string): string {
  if (symbol.endsWith('.AX')) return 'AUD';
  if (symbol.endsWith('.L')) return 'GBP';
  if (symbol.endsWith('.TO')) return 'CAD';
  return 'USD';
}
