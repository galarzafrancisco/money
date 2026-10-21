import { createHash } from 'node:crypto';
import { UpstreamError } from '../common/errors';
import { dec, fmt } from '../common/decimal';
import { dateRange, isWeekend, zonedTimeToUtc } from './market-calendar';
import type { DailyClose, DailyCloseSeries, MarketPriceProvider, Quote } from './market-price.port';

/**
 * MOCK prices, for development and tests. A symbol's price is derived from a
 * hash of its name (stable between calls, between 5 and 505), unless a test
 * sets one. Currency is guessed from the suffix: .AX → AUD, .L → GBP,
 * .TO → CAD, otherwise USD. Every quote says `source: "mock"`.
 *
 * Daily closes are just as made up: one per weekday (no holidays unless a
 * test adds some), varying a little around the symbol's base price, final
 * once the exchange's scheduled close has passed in its time zone.
 */
export class MockPriceProvider implements MarketPriceProvider {
  readonly name = 'mock';
  private readonly overrides = new Map<string, { price: string; currency?: string }>();
  private readonly closeOverrides = new Map<string, string>();
  private readonly holidays = new Set<string>();
  private readonly failing = new Set<string>();
  /** Calls to getDailyCloses, for tests */
  dailyCloseCalls = 0;

  setPrice(symbol: string, price: string, currency?: string): void {
    this.overrides.set(symbol.toUpperCase(), { price, currency });
  }

  /** Sets the close of one session */
  setClose(symbol: string, tradingDate: string, close: string): void {
    this.closeOverrides.set(`${symbol.toUpperCase()}|${tradingDate}`, close);
  }

  /** A weekday with no session on any exchange */
  addHoliday(date: string): void {
    this.holidays.add(date);
  }

  /** Makes history lookups for a symbol fail as if the provider were down; '*' fails all */
  setFailing(symbol: string, failing = true): void {
    if (failing) this.failing.add(symbol.toUpperCase());
    else this.failing.delete(symbol.toUpperCase());
  }

  clear(): void {
    this.overrides.clear();
    this.closeOverrides.clear();
    this.holidays.clear();
    this.failing.clear();
    this.dailyCloseCalls = 0;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const upper = symbol.toUpperCase();
    const override = this.overrides.get(upper);
    return {
      symbol: upper,
      price: override?.price ?? basePrice(upper),
      currency: override?.currency ?? guessCurrency(upper),
      asOf: new Date().toISOString(),
      source: this.name,
      isMock: true,
    };
  }

  async getDailyCloses(symbol: string, range: { from: string; to: string }, now: Date): Promise<DailyCloseSeries> {
    this.dailyCloseCalls++;
    const upper = symbol.toUpperCase();
    if (this.failing.has(upper) || this.failing.has('*')) {
      throw new UpstreamError(`Mock price history for ${upper} is unavailable (simulated provider failure)`);
    }
    const override = this.overrides.get(upper);
    const { timeZone, closeAt } = mockExchange(upper);
    const closes: DailyClose[] = [];
    for (const date of dateRange(range.from, range.to)) {
      if (isWeekend(date) || this.holidays.has(date)) continue;
      const closeTime = zonedTimeToUtc(date, closeAt, timeZone);
      if (closeTime.getTime() > now.getTime()) continue;
      const close = this.closeOverrides.get(`${upper}|${date}`) ?? override?.price ?? mockClose(upper, date);
      closes.push({ tradingDate: date, close, closeTime: closeTime.toISOString() });
    }
    return {
      symbol: upper,
      currency: override?.currency ?? guessCurrency(upper),
      exchangeTimezone: timeZone,
      source: this.name,
      isMock: true,
      closes,
    };
  }
}

function hashOf(value: string): number {
  return createHash('sha256').update(value).digest().readUInt32BE(0);
}

function basePrice(symbol: string): string {
  return (5 + (hashOf(symbol) % 50000) / 100).toFixed(2);
}

/** Base price moved by up to ±5%, stable for a (symbol, date) */
function mockClose(symbol: string, date: string): string {
  const swing = (hashOf(`${symbol}|${date}`) % 1001) - 500; // −500..500 → ±5%
  return fmt(dec(basePrice(symbol)).times(dec(1).plus(dec(swing).dividedBy(10000))).toDecimalPlaces(2));
}

function guessCurrency(symbol: string): string {
  if (symbol.endsWith('.AX')) return 'AUD';
  if (symbol.endsWith('.L')) return 'GBP';
  if (symbol.endsWith('.TO')) return 'CAD';
  return 'USD';
}

function mockExchange(symbol: string): { timeZone: string; closeAt: string } {
  if (symbol.endsWith('.AX')) return { timeZone: 'Australia/Sydney', closeAt: '16:00' };
  if (symbol.endsWith('.L')) return { timeZone: 'Europe/London', closeAt: '16:30' };
  if (symbol.endsWith('.TO')) return { timeZone: 'America/Toronto', closeAt: '16:00' };
  return { timeZone: 'America/New_York', closeAt: '16:00' };
}

