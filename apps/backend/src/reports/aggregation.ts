/**
 * Pure aggregation for the account and category reports. No I/O: the
 * service derives valuation items from the ledgers and prices, and these
 * functions group and total them.
 *
 * Invariant: every valuation item belongs to exactly one account and gets
 * exactly one effective category. Totals are only ever sums of distinct
 * items, so nothing is counted twice.
 */
import { MoneyDecimal, ZERO, dec, fmt } from '../common/decimal';
import { ValidationError } from '../common/errors';
import { ancestorsOf, childrenIndex, type HierarchyNode } from '../accounts/hierarchy';

/** One cash balance (one currency in one account) or one holding (one symbol in one account) */
export type ValuationItem = {
  accountId: string;
  kind: 'cash' | 'holding';
  /** null for cash */
  symbol: string | null;
  currency: string;
  value: MoneyDecimal;
  /** Holdings only */
  quantity?: MoneyDecimal;
  costBase?: MoneyDecimal;
  /** How value was worked out: cash balance, market price, or cost base */
  basis: 'cash' | 'market' | 'cost';
  price?: { price: string; asOf: string; source: string; isMock: boolean; isStale: boolean } | null;
};

export type FxPolicy = { baseCurrency: string; rates: Readonly<Record<string, string>> };

export type CurrencyTotalView = { currency: string; cash: string; holdings: string; total: string };
export type TotalsView = {
  /** Always given. Amounts in different currencies are never added together here. */
  byCurrency: CurrencyTotalView[];
  /** Only with an FX policy: every currency converted at the caller's rate */
  converted: { baseCurrency: string; cash: string; holdings: string; total: string } | null;
};

/**
 * Checks that the policy has a rate for every currency the items use (the
 * base currency itself needs none). A missing rate fails the request rather
 * than silently leaving that money out of the converted total.
 */
export function assertRatesCover(items: readonly ValuationItem[], fx: FxPolicy | null): void {
  if (!fx) return;
  const missing = [...new Set(items.map((i) => i.currency))].filter((c) => c !== fx.baseCurrency && fx.rates[c] === undefined).sort();
  if (missing.length > 0) {
    throw new ValidationError(
      `Missing fxRates for ${missing.join(', ')} (units of ${fx.baseCurrency} per unit). Supply them, or omit baseCurrency to get per-currency totals only.`,
      { missingRates: missing, baseCurrency: fx.baseCurrency },
    );
  }
}

function rateFor(currency: string, fx: FxPolicy): MoneyDecimal {
  if (currency === fx.baseCurrency) return dec(1);
  const rate = fx.rates[currency];
  // assertRatesCover runs first; this is a programming error, not bad input
  if (rate === undefined) throw new Error(`No FX rate for ${currency}`);
  return dec(rate);
}

export function totalsOf(items: readonly ValuationItem[], fx: FxPolicy | null): TotalsView {
  const byCurrency = new Map<string, { cash: MoneyDecimal; holdings: MoneyDecimal }>();
  for (const item of items) {
    const t = byCurrency.get(item.currency) ?? { cash: ZERO, holdings: ZERO };
    if (item.kind === 'cash') t.cash = t.cash.plus(item.value);
    else t.holdings = t.holdings.plus(item.value);
    byCurrency.set(item.currency, t);
  }
  let converted: TotalsView['converted'] = null;
  if (fx) {
    let cash = ZERO;
    let holdings = ZERO;
    for (const [currency, t] of byCurrency) {
      const rate = rateFor(currency, fx);
      cash = cash.plus(t.cash.times(rate));
      holdings = holdings.plus(t.holdings.times(rate));
    }
    converted = { baseCurrency: fx.baseCurrency, cash: fmt(cash), holdings: fmt(holdings), total: fmt(cash.plus(holdings)) };
  }
  return {
    byCurrency: [...byCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, t]) => ({ currency, cash: fmt(t.cash), holdings: fmt(t.holdings), total: fmt(t.cash.plus(t.holdings)) })),
    converted,
  };
}

// ── Categories ──────────────────────────────────────────────────────────────

export type CategorizedAccount = HierarchyNode & { categoryId: string | null };

export type CategorySource = 'holding' | 'account' | 'ancestor' | 'none';
export type EffectiveCategory = {
  categoryId: string | null;
  /** Where it came from: the holding's own category, the account's, an ancestor account's, or none (Uncategorized) */
  source: CategorySource;
  /** The account whose category applied, for 'account' and 'ancestor' */
  fromAccountId: string | null;
};

/** holdingCategories is keyed by `${accountId}|${symbol}` */
export function holdingKey(accountId: string, symbol: string): string {
  return `${accountId}|${symbol}`;
}

/** The account's own category, else its nearest ancestor's, else none */
export function effectiveAccountCategory(accountId: string, byId: ReadonlyMap<string, CategorizedAccount>): EffectiveCategory {
  const account = byId.get(accountId);
  if (account?.categoryId) return { categoryId: account.categoryId, source: 'account', fromAccountId: account.id };
  for (const ancestor of ancestorsOf(accountId, byId)) {
    if (ancestor.categoryId) return { categoryId: ancestor.categoryId, source: 'ancestor', fromAccountId: ancestor.id };
  }
  return { categoryId: null, source: 'none', fromAccountId: null };
}

/** A holding's own category overrides the account's; cash always takes the account's */
export function effectiveItemCategory(
  item: Pick<ValuationItem, 'accountId' | 'symbol'>,
  byId: ReadonlyMap<string, CategorizedAccount>,
  holdingCategories: ReadonlyMap<string, string>,
): EffectiveCategory {
  if (item.symbol) {
    const own = holdingCategories.get(holdingKey(item.accountId, item.symbol));
    if (own) return { categoryId: own, source: 'holding', fromAccountId: null };
  }
  return effectiveAccountCategory(item.accountId, byId);
}

/**
 * Groups items by effective category. Each item lands in exactly one group,
 * so the groups' totals add up to the total of all items.
 */
export function partitionByCategory<T extends Pick<ValuationItem, 'accountId' | 'symbol'>>(
  items: readonly T[],
  byId: ReadonlyMap<string, CategorizedAccount>,
  holdingCategories: ReadonlyMap<string, string>,
): Map<string | null, (T & { category: EffectiveCategory })[]> {
  const groups = new Map<string | null, (T & { category: EffectiveCategory })[]>();
  for (const item of items) {
    const category = effectiveItemCategory(item, byId, holdingCategories);
    const list = groups.get(category.categoryId) ?? [];
    list.push({ ...item, category });
    groups.set(category.categoryId, list);
  }
  return groups;
}

// ── Account tree ───────────────────────────────────────────────────────────

export type AccountTreeNode<A extends HierarchyNode> = {
  account: A;
  level: number;
  /** Items held directly in this account */
  ownItems: ValuationItem[];
  /** Items in this account and every account below it */
  rolledUpItems: ValuationItem[];
  children: AccountTreeNode<A>[];
};

/**
 * The tree under `rootIds` (top-level accounts when omitted). rolledUpItems
 * is built from distinct descendants' own items: an item is in exactly one
 * account's ownItems, and in the rolledUpItems of that account and its
 * ancestors only.
 */
export function buildAccountTree<A extends HierarchyNode & { name: string }>(
  accounts: readonly A[],
  items: readonly ValuationItem[],
  rootIds?: readonly string[],
): AccountTreeNode<A>[] {
  const children = childrenIndex(accounts);
  const itemsByAccount = new Map<string, ValuationItem[]>();
  for (const item of items) {
    const list = itemsByAccount.get(item.accountId) ?? [];
    list.push(item);
    itemsByAccount.set(item.accountId, list);
  }
  const byName = (a: A, b: A) => a.name.localeCompare(b.name);
  const seen = new Set<string>();
  const build = (account: A, level: number): AccountTreeNode<A> => {
    seen.add(account.id);
    const kids = [...((children.get(account.id) as A[] | undefined) ?? [])]
      .filter((kid) => !seen.has(kid.id))
      .sort(byName)
      .map((kid) => build(kid, level + 1));
    const ownItems = itemsByAccount.get(account.id) ?? [];
    return { account, level, ownItems, rolledUpItems: [...ownItems, ...kids.flatMap((k) => k.rolledUpItems)], children: kids };
  };
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const roots = rootIds ? rootIds.map((id) => byId.get(id)!).filter(Boolean) : accounts.filter((a) => !a.parentAccountId).sort(byName);
  return roots.map((root) => build(root, ancestorsOf(root.id, byId).length + 1));
}
