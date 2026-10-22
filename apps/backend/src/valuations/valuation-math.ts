/**
 * Pure valuation logic for the daily job: what was held at the end of a
 * date, and which close values it. No I/O.
 */
import { MoneyDecimal, dec, fmt } from '../common/decimal';
import { compareEntries, replayLedger } from '../ledger/ledger-engine';
import type { LedgerEntry, Position } from '../ledger/ledger.types';
import { daysBetween, isWeekend } from '../market-prices/market-calendar';
import type { DailyClose, DailyCloseSeries } from '../market-prices/market-price.port';
import type { ValuationHoldingRow } from './valuations.repository';

/**
 * Open positions at the end of each date (every entry dated on or before
 * it), replaying the ledger as it stood then. Quantities are historical, not
 * today's. Dates must be ascending.
 */
export function positionsByDate(entries: readonly LedgerEntry[], dates: readonly string[]): Map<string, Position[]> {
  const sorted = [...entries].sort(compareEntries);
  const result = new Map<string, Position[]>();
  let included = -1;
  let current: Position[] = [];
  for (const date of dates) {
    let upTo = included;
    while (upTo + 1 < sorted.length && sorted[upTo + 1].date <= date) upTo++;
    if (upTo !== included) {
      // Prefixes of a valid ledger in (date, sequence) order are valid, so this does not throw for stored data
      current = [...replayLedger(sorted.slice(0, upTo + 1)).positions.values()];
      included = upTo;
    }
    result.set(date, current);
  }
  return result;
}

/**
 * - CLOSE: the close of the session on the valuation date.
 * - NON_TRADING_DAY: no session that day (weekend, or the provider has a
 *   later session but none for this date, e.g. a public holiday); the last
 *   close before it stands, as it is the latest real price.
 * - PRICE_PENDING: a weekday with no close yet and no later session, so it
 *   may just be late. The last close is carried as an indication, flagged;
 *   the day is re-tried.
 * - MISSING: no usable close (provider failure, unknown symbol, or last
 *   close older than the carry limit). Not valued.
 * - CURRENCY_MISMATCH: the price is in another currency than the holding
 *   was traded in. Not valued.
 */
export type PriceStatus = 'CLOSE' | 'NON_TRADING_DAY' | 'PRICE_PENDING' | 'MISSING' | 'CURRENCY_MISMATCH';

/** Statuses that are a final, correct valuation for the date */
export const FINAL_STATUSES: readonly PriceStatus[] = ['CLOSE', 'NON_TRADING_DAY'];

/** `warning`: the provider failed and only stored closes were used */
export type SeriesResult = { series: DailyCloseSeries | null; error?: undefined; warning?: string } | { series?: undefined; error: string; warning?: undefined };

export type PricedHolding = {
  status: PriceStatus;
  close: DailyClose | null;
  series: DailyCloseSeries | null;
  marketValue: MoneyDecimal | null;
  note: string | null;
};

export function priceHolding(
  position: Pick<Position, 'symbol' | 'currency' | 'quantity'> & { lots?: Position['lots'] },
  date: string,
  result: SeriesResult | undefined,
  maxCarryDays: number,
): PricedHolding {
  const priced = priceAtClose(position, date, result, maxCarryDays);
  const notes = [priced.note, splitWarning(position, date, priced.series)].filter((n): n is string => !!n);
  return { ...priced, note: notes.length > 0 ? notes.join('. ') : null };
}

/**
 * Closes are as traded and ledger quantities are as recorded; corporate
 * actions are not modelled. A split while the holding was held means the
 * recorded quantity no longer matches the shares really held after it.
 */
function splitWarning(position: { lots?: Position['lots'] }, date: string, series: DailyCloseSeries | null): string | null {
  const firstAcquired = position.lots?.reduce<string | null>((min, lot) => (min === null || lot.acquiredOn < min ? lot.acquiredOn : min), null);
  if (!series || !firstAcquired) return null;
  const split = series.splits.find((s) => s.date > firstAcquired && s.date <= date);
  if (!split) return null;
  return `${series.symbol} split ${split.numerator}:${split.denominator} on ${split.date}, while held; splits are not recorded in the ledger, so the quantity may not match the shares held after it`;
}

function priceAtClose(position: Pick<Position, 'symbol' | 'currency' | 'quantity'>, date: string, result: SeriesResult | undefined, maxCarryDays: number): PricedHolding {
  const missing = (note: string, series: DailyCloseSeries | null = null): PricedHolding => ({ status: 'MISSING', close: null, series, marketValue: null, note });
  if (!result) return missing('No price history was looked up');
  if (result.error !== undefined) return missing(result.error);
  const series = result.series;
  if (!series) return missing(`The price provider has no history for ${position.symbol}`);
  if (series.currency !== position.currency) {
    return {
      status: 'CURRENCY_MISMATCH',
      close: null,
      series,
      marketValue: null,
      note: `Prices are in ${series.currency} but the holding is in ${position.currency}; not valued`,
    };
  }
  let latest: DailyClose | null = null;
  let later = false;
  for (const close of series.closes) {
    if (close.tradingDate <= date) latest = close;
    else later = true;
  }
  if (!latest) return missing(`No close on or before ${date}`, series);
  const age = daysBetween(latest.tradingDate, date);
  if (age > maxCarryDays) return missing(`The last close (${latest.tradingDate}) is more than ${maxCarryDays} days before ${date}`, series);
  const value = dec(latest.close).times(position.quantity);
  if (age === 0) return { status: 'CLOSE', close: latest, series, marketValue: value, note: null };
  if (isWeekend(date) || later) {
    return {
      status: 'NON_TRADING_DAY',
      close: latest,
      series,
      marketValue: value,
      note: `No session on ${date}; valued at the ${latest.tradingDate} close`,
    };
  }
  return {
    status: 'PRICE_PENDING',
    close: latest,
    series,
    marketValue: value,
    note: `No close for ${date} yet (late, unavailable or an unknown holiday); provisionally valued at the ${latest.tradingDate} close`,
  };
}

/**
 * The snapshot rows for one valuation date: every open position, priced at
 * its close. Shared by the daily job and on-demand reconstruction, so both
 * give the same answer for the same ledger and closes.
 */
export function holdingsOn(
  positions: readonly { accountId: string; byDate: Map<string, Position[]> }[],
  date: string,
  series: Map<string, SeriesResult>,
  maxCarryDays: number,
): Omit<ValuationHoldingRow, 'date'>[] {
  const holdings: Omit<ValuationHoldingRow, 'date'>[] = [];
  for (const { accountId, byDate } of positions) {
    for (const position of byDate.get(date) ?? []) {
      const priced = priceHolding(position, date, series.get(position.symbol), maxCarryDays);
      const unit = priced.close ? fmt(dec(priced.close.close)) : null;
      holdings.push({
        accountId,
        symbol: position.symbol,
        currency: position.currency,
        quantity: fmt(position.quantity),
        costBase: fmt(position.costBase),
        priceStatus: priced.status,
        closePrice: unit,
        priceCurrency: priced.close ? priced.series!.currency : null,
        priceDate: priced.close?.tradingDate ?? null,
        priceCloseTime: priced.close?.closeTime ?? null,
        priceSource: priced.series?.source ?? null,
        priceIsMock: priced.series ? priced.series.isMock : null,
        exchangeTimezone: priced.series?.exchangeTimezone ?? null,
        marketValue: priced.marketValue ? fmt(priced.marketValue) : null,
        priceNote: priced.note,
        lots: position.lots.map((lot) => ({
          lotId: lot.lotId,
          acquiredOn: lot.acquiredOn,
          quantity: fmt(lot.remainingQuantity),
          costBase: fmt(lot.remainingCostBase),
          marketValue: priced.marketValue && unit ? fmt(lot.remainingQuantity.times(unit)) : null,
        })),
      });
    }
  }
  return holdings;
}
