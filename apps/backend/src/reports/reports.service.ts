import { Injectable } from '@nestjs/common';
import { AccountEntity } from '../accounts/account.entity';
import { AccountsRepository } from '../accounts/accounts.repository';
import { childrenIndex, descendantsOf } from '../accounts/hierarchy';
import { CategoriesRepository } from '../categories/categories.repository';
import { CategoryEntity } from '../categories/category.entity';
import { dec, fmt } from '../common/decimal';
import { NotFoundError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { replayLedger } from '../ledger/ledger-engine';
import { MarketPricesService, type QuoteResult } from '../market-prices/market-prices.service';
import { SplitsService } from '../splits/splits.service';
import { TransactionEntity } from '../transactions/transaction.entity';
import { TransactionsRepository } from '../transactions/transactions.repository';
import type { UpAccountEntity } from '../up/up.entities';
import { UpRepository } from '../up/up.repository';
import type { CurrentUser } from '../users/users.service';
import {
  assertRatesCover,
  buildAccountTree,
  effectiveAccountCategory,
  holdingKey,
  partitionByCategory,
  totalsOf,
  type AccountTreeNode,
  type CategorySource,
  type FxPolicy,
  type TotalsView,
  type ValuationItem,
} from './aggregation';
import { reportOptionsSchema, type ReportOptions, type ReportOptionsInput } from './reports.schemas';

type CategoryRef = { id: string; name: string; color: string | null } | null;

export type ItemView = {
  accountId: string;
  /** Account names from the top-level account down, e.g. ["Up!", "Emergency Fund"] */
  accountPath: string[];
  /** Where the account comes from: recorded by hand, or imported from Up (a snapshot balance) */
  source: 'manual' | 'up';
  kind: 'cash' | 'holding';
  symbol: string | null;
  currency: string;
  quantity: string | null;
  value: string;
  costBase: string | null;
  basis: 'cash' | 'market' | 'cost';
  price: { price: string; asOf: string; source: string; isMock: boolean; isStale: boolean } | null;
  category: CategoryRef;
  categorySource: CategorySource;
};

export type AccountReportNode = {
  id: string;
  name: string;
  type: AccountEntity['type'];
  source: 'manual' | 'up';
  parentAccountId: string | null;
  level: number;
  /** The account's own category (null = inherits) */
  categoryId: string | null;
  /** What applies to its cash: own, else nearest ancestor's, else null (Uncategorized) */
  effectiveCategory: CategoryRef;
  /** This account's own ledger only */
  own: TotalsView;
  /** This account plus every subaccount below it. Do not add rolledUp figures across levels. */
  rolledUp: TotalsView;
  items: ItemView[];
  children: AccountReportNode[];
};

type ReportEnvelope = {
  asOf: string;
  valuation: 'market' | 'cost';
  fx: FxPolicy | null;
  priceProvider: string;
  rootAccountId: string | null;
  /** Every cash balance and holding in scope, counted once */
  totals: TotalsView;
  warnings: string[];
  notes: string[];
};

export type AccountsReport = ReportEnvelope & { accounts: AccountReportNode[] };
export type CategoriesReport = ReportEnvelope & {
  categories: { category: CategoryRef; totals: TotalsView; items: ItemView[] }[];
};

const COMMON_NOTES = [
  'Amounts are per currency. Converted totals only appear when baseCurrency and fxRates are given; the rates are yours, not looked up.',
  'Categories are current labels, not history: changing one reclassifies every report, including past figures.',
  'Personal tracking only, not financial or tax advice.',
];

/**
 * Balances and valuations by account hierarchy and by category, for
 * dashboards. Both reports are built from one list of valuation items (each
 * cash balance and each holding of each account), so they always agree.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly categories: CategoriesRepository,
    private readonly transactions: TransactionsRepository,
    private readonly upRepo: UpRepository,
    private readonly prices: MarketPricesService,
    private readonly splits: SplitsService,
  ) {}

  async accountsReport(user: CurrentUser, input: ReportOptionsInput = {}): Promise<AccountsReport> {
    const ctx = await this.valuationContext(user, parseInput(reportOptionsSchema, input));
    const tree = buildAccountTree(ctx.allAccounts, ctx.items, ctx.rootId ? [ctx.rootId] : undefined);
    const toNode = (node: AccountTreeNode<AccountEntity>): AccountReportNode => ({
      id: node.account.id,
      name: node.account.name,
      type: node.account.type,
      source: ctx.sourceOf(node.account.id),
      parentAccountId: node.account.parentAccountId,
      level: node.level,
      categoryId: node.account.categoryId,
      effectiveCategory: ctx.categoryRef(effectiveAccountCategory(node.account.id, ctx.byId).categoryId),
      own: totalsOf(node.ownItems, ctx.fx),
      rolledUp: totalsOf(node.rolledUpItems, ctx.fx),
      items: node.ownItems.map(ctx.itemView),
      children: node.children.map(toNode),
    });
    return {
      ...ctx.envelope,
      accounts: tree.map(toNode),
      notes: [
        'Each transaction belongs to exactly one account. "own" is that account\'s ledger; "rolledUp" adds every subaccount below it.',
        '"totals" is the sum of every account\'s own figures, which equals the sum of the top-level rolledUp figures. Adding rolledUp figures across levels counts money twice.',
        ...COMMON_NOTES,
      ],
    };
  }

  async categoriesReport(user: CurrentUser, input: ReportOptionsInput = {}): Promise<CategoriesReport> {
    const ctx = await this.valuationContext(user, parseInput(reportOptionsSchema, input));
    const groups = partitionByCategory(ctx.items, ctx.byId, ctx.holdingCategories);
    const ordered: (CategoryEntity | null)[] = [...ctx.categoryList, null];
    return {
      ...ctx.envelope,
      categories: ordered.map((category) => {
        const items = groups.get(category?.id ?? null) ?? [];
        return { category: ctx.categoryRef(category?.id ?? null), totals: totalsOf(items, ctx.fx), items: items.map(ctx.itemView) };
      }),
      notes: [
        'Each cash balance and holding is in exactly one category: the holding\'s own, else its account\'s, else the nearest parent account\'s, else Uncategorized (category null). Category totals therefore add up to "totals".',
        ...COMMON_NOTES,
      ],
    };
  }

  /**
   * Loads everything the reports (and the dashboard) need and derives the
   * valuation items: one per cash balance and one per holding of each
   * account in scope, so each is counted exactly once.
   */
  async valuationContext(user: CurrentUser, options: ReportOptions) {
    const [manualAccounts, upAccounts, categoryList, holdingRows, rows] = await Promise.all([
      this.accounts.list(user.id),
      this.upRepo.listAccounts(user.id, null),
      this.categories.list(user.id),
      this.categories.listHoldingCategories(user.id),
      this.transactions.list(user.id, {}),
    ]);
    // Imported Up accounts are top-level cash accounts whose balance is the
    // one Up last reported. Hidden ones stay out of the default view but are
    // always reachable by ID.
    // Accounts Up stopped listing keep their last balance but are stale, so they
    // are left out everywhere (as account groups do), even by ID.
    const upInScope = upAccounts.filter((u) => !u.removedAt && (options.rootAccountId !== undefined || options.visibility === 'all' || (options.visibility === 'visible') === u.visible));
    const upAsAccounts = upInScope.map(upToAccount);
    const upBalances = new Map(upInScope.map((u) => [u.id, u]));
    const sourceOf = (accountId: string): 'manual' | 'up' => (upBalances.has(accountId) ? 'up' : 'manual');
    const accounts = [...manualAccounts, ...upAsAccounts];
    const byId = new Map(accounts.map((a) => [a.id, a]));

    let rootId: string | null = null;
    let inScope = accounts;
    if (options.rootAccountId !== undefined) {
      if (!isUuid(options.rootAccountId) || !byId.has(options.rootAccountId)) throw new NotFoundError(`Account ${options.rootAccountId} not found`);
      rootId = options.rootAccountId;
      const scopeIds = new Set([rootId, ...descendantsOf(rootId, childrenIndex(accounts)).map((a) => a.id)]);
      inScope = accounts.filter((a) => scopeIds.has(a.id));
    }

    const rowsByAccount = new Map<string, TransactionEntity[]>();
    for (const row of rows) {
      const list = rowsByAccount.get(row.accountId) ?? [];
      list.push(row);
      rowsByAccount.set(row.accountId, list);
    }
    const splits = await this.splits.index(rows.filter((r) => r.symbol).map((r) => r.symbol!));
    const states = inScope.map((account) => {
      const imported = upBalances.get(account.id);
      if (imported) return { account, state: { cash: new Map([[imported.currency, dec(imported.balance)]]), positions: new Map<string, never>() } };
      return { account, state: replayLedger(this.splits.presentEntriesWith(rowsByAccount.get(account.id) ?? [], splits)) };
    });

    const warnings: string[] = [];
    const symbols = [...new Set(states.flatMap(({ state }) => [...state.positions.keys()]))];
    const quotes: Map<string, QuoteResult> = options.valuation === 'market' ? await this.prices.getQuotes(symbols) : new Map();

    const items: ValuationItem[] = [];
    for (const { account, state } of states) {
      for (const [currency, balance] of state.cash) {
        if (balance.isZero()) continue;
        items.push({ accountId: account.id, kind: 'cash', symbol: null, currency, value: balance, basis: 'cash' });
      }
      for (const position of state.positions.values()) {
        const base = { accountId: account.id, kind: 'holding' as const, symbol: position.symbol, currency: position.currency, quantity: position.quantity, costBase: position.costBase };
        if (options.valuation === 'cost') {
          items.push({ ...base, value: position.costBase, basis: 'cost', price: null });
          continue;
        }
        const result = quotes.get(position.symbol);
        if (result && 'quote' in result && result.quote.currency === position.currency) {
          const { quote } = result;
          items.push({
            ...base,
            value: dec(quote.price).times(position.quantity),
            basis: 'market',
            price: { price: quote.price, asOf: quote.asOf, source: quote.source, isMock: quote.isMock, isStale: quote.isStale },
          });
          continue;
        }
        const reason =
          result && 'quote' in result
            ? `price is quoted in ${result.quote.currency} but the holding is in ${position.currency}`
            : result && 'error' in result
              ? result.error
              : 'no price';
        warnings.push(`${position.symbol} in "${account.name}" is valued at cost base: ${reason}`);
        items.push({ ...base, value: position.costBase, basis: 'cost', price: null });
      }
    }
    const stale = items.filter((i) => i.price?.isStale);
    if (stale.length > 0) {
      warnings.push(`The price provider could not be reached for ${[...new Set(stale.map((i) => i.symbol))].join(', ')}; the last known prices are used (isStale: true, see asOf).`);
    }
    if (items.some((i) => i.price?.isMock)) {
      warnings.push('Some prices are mock (made-up development data, isMock: true). Do not rely on these valuations.');
    }

    const fx: FxPolicy | null = options.baseCurrency ? { baseCurrency: options.baseCurrency, rates: options.fxRates ?? {} } : null;
    assertRatesCover(items, fx);

    const categoriesById = new Map(categoryList.map((c) => [c.id, c]));
    const categoryRef = (id: string | null): CategoryRef => {
      const c = id ? categoriesById.get(id) : undefined;
      return c ? { id: c.id, name: c.name, color: c.color } : null;
    };
    const holdingCategories = new Map(holdingRows.map((h) => [holdingKey(h.accountId, h.symbol), h.categoryId]));
    const pathOf = (accountId: string): string[] => {
      const path: string[] = [];
      let current = byId.get(accountId);
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        path.unshift(current.name);
        current = current.parentAccountId ? byId.get(current.parentAccountId) : undefined;
      }
      return path;
    };
    const itemView = (item: ValuationItem): ItemView => {
      const own = item.symbol ? holdingCategories.get(holdingKey(item.accountId, item.symbol)) : undefined;
      const effective = own
        ? { categoryId: own, source: 'holding' as const }
        : effectiveAccountCategory(item.accountId, byId);
      return {
        accountId: item.accountId,
        accountPath: pathOf(item.accountId),
        source: sourceOf(item.accountId),
        kind: item.kind,
        symbol: item.symbol,
        currency: item.currency,
        quantity: item.quantity ? fmt(item.quantity) : null,
        value: fmt(item.value),
        costBase: item.costBase ? fmt(item.costBase) : null,
        basis: item.basis,
        price: item.price ?? null,
        category: categoryRef(effective.categoryId),
        categorySource: effective.source,
      };
    };

    const envelope: Omit<ReportEnvelope, 'notes'> = {
      asOf: new Date().toISOString(),
      valuation: options.valuation,
      fx,
      priceProvider: this.prices.providerName,
      rootAccountId: rootId,
      totals: totalsOf(items, fx),
      warnings,
    };
    return { allAccounts: accounts, byId, items, fx, rootId, categoryList, holdingCategories, categoryRef, itemView, pathOf, sourceOf, envelope };
  }
}

/** An imported Up account as a top-level cash account, for the shared reporting path */
function upToAccount(u: UpAccountEntity): AccountEntity {
  return Object.assign(new AccountEntity(), {
    id: u.id,
    userId: u.userId,
    parentAccountId: null,
    categoryId: u.categoryId,
    name: u.displayName,
    type: 'CASH' as const,
    reportingCurrency: u.currency,
    description: null,
    createdAt: u.upCreatedAt,
    updatedAt: u.updatedAt,
  });
}
