/**
 * Pure helpers for the dashboard. No I/O: DashboardService loads the
 * valuation items (ReportsService) and FX rates, and these classify, group
 * and compare them.
 *
 * Every grouping here is a partition of the same items, so groups always add
 * up to the total and nothing is counted twice.
 */
import { MoneyDecimal, dec, fmt } from '../common/decimal';
import { ancestorsOf, type HierarchyNode } from '../accounts/hierarchy';
import type { AccountType } from '../accounts/account.entity';
import type { ValuationItem } from '../reports/aggregation';

export const ASSET_CLASSES = ['cash', 'shares', 'super'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/** A market price older than this many days is reported as STALE */
export const STALE_PRICE_DAYS = 5;

export type TypedAccount = HierarchyNode & { type: AccountType };

/**
 * Everything in a SUPERANNUATION account, or in any subaccount of one, is
 * super (whether it is the fund's balance as cash or listed shares held in
 * it). Otherwise holdings are shares and cash is cash.
 */
export function assetClassOf(item: Pick<ValuationItem, 'accountId' | 'kind'>, byId: ReadonlyMap<string, TypedAccount>): AssetClass {
  const account = byId.get(item.accountId);
  if (account?.type === 'SUPERANNUATION' || ancestorsOf(item.accountId, byId).some((a) => a.type === 'SUPERANNUATION')) return 'super';
  return item.kind === 'holding' ? 'shares' : 'cash';
}

/** Groups items by a key, keeping first-seen order */
export function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return groups;
}

/** part / whole as a percentage (2 dp), or null when either is unknown or the whole is zero */
export function percentOf(part: string | null | undefined, whole: string | null | undefined): string | null {
  if (part === null || part === undefined || whole === null || whole === undefined) return null;
  const w = dec(whole);
  if (w.isZero()) return null;
  return fmt(dec(part).dividedBy(w).times(100).toDecimalPlaces(2));
}

export type PriceStatus = 'MARKET' | 'STALE' | 'MOCK' | 'COST_FALLBACK';

/**
 * How trustworthy one holding's value is. COST_FALLBACK: no usable price, so
 * valued at cost base. MOCK: made-up development price. STALE: a real price
 * older than STALE_PRICE_DAYS. MARKET: a recent real price.
 */
export function priceStatusOf(item: Pick<ValuationItem, 'basis' | 'price'>, now: Date): PriceStatus {
  if (item.basis !== 'market' || !item.price) return 'COST_FALLBACK';
  if (item.price.isMock) return 'MOCK';
  const ageMs = now.getTime() - Date.parse(item.price.asOf);
  if (!Number.isFinite(ageMs) || ageMs > STALE_PRICE_DAYS * 24 * 60 * 60 * 1000) return 'STALE';
  return 'MARKET';
}

const STATUS_RANK: Record<PriceStatus, number> = { MARKET: 0, MOCK: 1, STALE: 2, COST_FALLBACK: 3 };

/** The least trustworthy of several statuses */
export function worstStatus(statuses: readonly PriceStatus[]): PriceStatus {
  return statuses.reduce<PriceStatus>((worst, s) => (STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst), 'MARKET');
}

/** Sum of decimal values */
export function sum(values: readonly MoneyDecimal[]): MoneyDecimal {
  return values.reduce((acc, v) => acc.plus(v), dec(0));
}

/** Largest first by `amount`; nulls last; then by `name` */
export function byAmountDesc<T>(amount: (row: T) => string | null, name: (row: T) => string) {
  return (a: T, b: T): number => {
    const x = amount(a);
    const y = amount(b);
    if (x !== null && y !== null) {
      const c = dec(y).comparedTo(dec(x));
      if (c !== 0) return c;
    } else if (x !== y) {
      return x === null ? 1 : -1;
    }
    return name(a).localeCompare(name(b));
  };
}
