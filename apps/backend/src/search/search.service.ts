import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { AccountsService } from '../accounts/accounts.service';
import { UpRepository } from '../up/up.repository';
import type { CurrentUser } from '../users/users.service';
import { dec, fmt } from '../common/decimal';
import { TransactionsRepository } from '../transactions/transactions.repository';
import type { TransactionEntity } from '../transactions/transaction.entity';
import type { UpTransactionEntity } from '../up/up.entities';
import { MATCH_RANK, matchName, merchantKeyOf, prepareQuery, type MatchType } from './name-match';
import { searchAccountsSchema, searchMerchantsSchema, searchTransactionsSchema } from './search.schemas';

export type MerchantResult = {
  merchantKey: string;
  name: string;
  aliases: string[];
  source: 'up';
  matchType: MatchType;
  transactionCount: number;
  firstTransactionAt: string;
  lastTransactionAt: string;
};

export type AccountResult = {
  id: string;
  name: string;
  source: 'manual' | 'up';
  type: string;
  currency: string;
  visible: boolean;
  parentAccountId: string | null;
  removed: boolean;
  matchType: MatchType | null;
};

const MAX_ALIASES = 10;

/**
 * Read-only discovery: resolve a name to a stable ID before querying
 * transactions. REST and MCP both call these two methods. Everything is
 * scoped to the signed-in user by the repositories.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly upRepo: UpRepository,
    private readonly accounts: AccountsService,
    private readonly transactionsRepo: TransactionsRepository,
  ) {}

  async merchants(user: CurrentUser, input: unknown) {
    const query = parseInput(searchMerchantsSchema, input);
    const upAccounts = await this.upRepo.listAccounts(user.id, null);
    let scope = upAccounts;
    if (query.accountId) {
      const one = isUuid(query.accountId) ? upAccounts.find((a) => a.id === query.accountId) : undefined;
      if (!one) throw new NotFoundError(`Up account ${query.accountId} not found`);
      scope = [one]; // asking for one account by ID reaches it even when hidden
    } else {
      const visibility = query.visibility ?? 'visible';
      scope = upAccounts.filter((a) => visibility === 'all' || (visibility === 'visible') === a.visible);
    }
    const labels = await this.upRepo.merchantLabels(user.id, scope.map((a) => a.id));

    // Fold spellings of one merchant together by key
    const merchants = new Map<string, { variants: typeof labels; count: number; first: Date; last: Date }>();
    for (const label of labels) {
      const key = merchantKeyOf(label.description);
      if (!key) continue;
      const entry = merchants.get(key) ?? { variants: [], count: 0, first: label.firstAt, last: label.lastAt };
      entry.variants.push(label);
      entry.count += label.transactionCount;
      if (label.firstAt < entry.first) entry.first = label.firstAt;
      if (label.lastAt > entry.last) entry.last = label.lastAt;
      merchants.set(key, entry);
    }

    const prepared = prepareQuery(query.q);
    const results: MerchantResult[] = [];
    for (const [merchantKey, entry] of merchants) {
      const variants = [...entry.variants].sort((a, b) => b.transactionCount - a.transactionCount || a.description.localeCompare(b.description));
      const name = variants[0].description.trim();
      // The best match over every spelling seen for this merchant
      let best: MatchType | null = null;
      for (const variant of variants) {
        const m = matchName(prepared, variant.description);
        if (m && (!best || MATCH_RANK[m] > MATCH_RANK[best])) best = m;
      }
      if (!best) continue;
      results.push({
        merchantKey,
        name,
        aliases: variants.slice(1, 1 + MAX_ALIASES).map((v) => v.description.trim()).filter((v) => v !== name),
        source: 'up',
        matchType: best,
        transactionCount: entry.count,
        firstTransactionAt: entry.first.toISOString(),
        lastTransactionAt: entry.last.toISOString(),
      });
    }
    results.sort(
      (a, b) => MATCH_RANK[b.matchType] - MATCH_RANK[a.matchType] || b.transactionCount - a.transactionCount || a.name.localeCompare(b.name) || a.merchantKey.localeCompare(b.merchantKey),
    );
    return paginate(results, query.limit, query.offset);
  }

  /**
   * Transaction search, filtered, sorted and paged in the database. Searches
   * imported Up transactions and manual cash-flow transactions (deposits,
   * withdrawals, buys, sells, dividends, transfer legs). Merchant filters are
   * Up-only because manual rows have no merchant. A manual transaction matched
   * to an Up transaction in scope is the same event and is listed once, as the
   * Up row. The two sources are each paged in the database for the first
   * `offset + limit` rows and merged newest first.
   */
  async transactions(user: CurrentUser, input: unknown) {
    const query = parseInput(searchTransactionsSchema, input);
    const upAccounts = await this.upRepo.listAccounts(user.id, null);
    const manualAccounts = await this.accounts.list(user);
    let upScope = upAccounts;
    let manualScope = manualAccounts.map((a) => a.id);
    if (query.accountIds && query.accountIds.length > 0) {
      upScope = [];
      manualScope = [];
      for (const id of query.accountIds) {
        const up = isUuid(id) ? upAccounts.find((a) => a.id === id) : undefined;
        if (up) {
          upScope.push(up);
          continue;
        }
        const manual = isUuid(id) ? manualAccounts.find((a) => a.id === id) : undefined;
        if (!manual) throw new NotFoundError(`Account ${id} not found`); // also for another user's account
        manualScope.push(manual.id);
      }
    } else {
      const visibility = query.visibility ?? 'visible';
      upScope = upAccounts.filter((a) => visibility === 'all' || (visibility === 'visible') === a.visible);
    }
    const scopeIds = upScope.map((a) => a.id);
    const hasMerchant = Boolean(query.merchantKey || query.merchant);
    // Manual rows have no merchant and are always settled
    if (hasMerchant || query.status === 'HELD') manualScope = [];

    let descriptions: string[] | undefined;
    let matchedMerchants: { merchantKey: string; name: string }[] | null = null;
    if (hasMerchant) {
      const labels = await this.upRepo.merchantLabels(user.id, scopeIds);
      const prepared = query.merchant ? prepareQuery(query.merchant) : null;
      const hits = labels.filter((l) => (query.merchantKey ? merchantKeyOf(l.description) === query.merchantKey : matchName(prepared!, l.description) !== null));
      descriptions = hits.map((l) => l.description);
      const byKey = new Map<string, { name: string; count: number }>();
      for (const l of hits) {
        const key = merchantKeyOf(l.description);
        const cur = byKey.get(key);
        if (!cur || l.transactionCount > cur.count) byKey.set(key, { name: l.description.trim(), count: l.transactionCount });
      }
      matchedMerchants = [...byKey].map(([merchantKey, v]) => ({ merchantKey, name: v.name })).sort((a, b) => a.merchantKey.localeCompare(b.merchantKey));
    }

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const timezone = query.timezone ?? 'UTC';
    const transfers = descriptions ? 'exclude' : (query.transfers ?? 'exclude');
    const direction = query.direction === 'any' ? undefined : query.direction;
    const both = scopeIds.length > 0 && manualScope.length > 0;
    const window = both ? { limit: offset + limit, offset: 0 } : { limit, offset };
    const upResult = await this.upRepo.searchTransactions(user.id, {
      upAccountIds: scopeIds,
      descriptions,
      text: query.text,
      fromDate: query.fromDate,
      toDate: query.toDate,
      timezone,
      minAmount: query.minAmount,
      maxAmount: query.maxAmount,
      currency: query.currency,
      direction,
      status: query.status,
      transfers,
      ...window,
    });
    const manualResult = await this.transactionsRepo.searchCash(user.id, {
      accountIds: manualScope,
      excludeMatchedByUpAccountIds: scopeIds,
      text: query.text,
      fromDate: query.fromDate,
      toDate: query.toDate,
      minAmount: query.minAmount,
      maxAmount: query.maxAmount,
      currency: query.currency,
      direction,
      transfers,
      ...window,
    });

    type Entry = { item: ReturnType<typeof searchItem> | ReturnType<typeof manualSearchItem>; day: string };
    const upItems: Entry[] = upResult.rows.map((t) => ({ item: searchItem(t), day: localDay(t.upCreatedAt, timezone) }));
    const manualItems: Entry[] = manualResult.rows.map((r) => ({ item: manualSearchItem(r.entity, r.cash), day: r.entity.date }));
    // Both lists are already newest first; merge, newest local day first, Up before manual on a tie
    const merged: Entry[] = [];
    let i = 0;
    let j = 0;
    while (i < upItems.length || j < manualItems.length) {
      if (j >= manualItems.length || (i < upItems.length && upItems[i].day >= manualItems[j].day)) merged.push(upItems[i++]);
      else merged.push(manualItems[j++]);
    }
    const items = (both ? merged.slice(offset, offset + limit) : merged).map((m) => m.item);

    const totals = new Map<string, { count: number; out: ReturnType<typeof dec>; in: ReturnType<typeof dec> }>();
    for (const c of [...upResult.byCurrency, ...manualResult.byCurrency]) {
      const cur = totals.get(c.currency) ?? { count: 0, out: dec('0'), in: dec('0') };
      totals.set(c.currency, { count: cur.count + c.count, out: cur.out.plus(dec(c.moneyOut)), in: cur.in.plus(dec(c.moneyIn)) });
    }
    const totalCount = upResult.total + manualResult.total;
    return {
      items,
      nextOffset: offset + limit < totalCount ? offset + limit : null,
      summary: {
        totalCount,
        byCurrency: [...totals]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, c]) => ({ currency, count: c.count, moneyOut: fmt(c.out), moneyIn: fmt(c.in), net: fmt(c.in.minus(c.out)) })),
      },
      matchedMerchants,
      scope: { accountCount: scopeIds.length + manualScope.length, timezone },
    };
  }

  async accountsSearch(user: CurrentUser, input: unknown) {
    const query = parseInput(searchAccountsSchema, input);
    const visibility = query.visibility ?? 'visible';
    const candidates: Omit<AccountResult, 'matchType'>[] = [];
    if (query.source !== 'up') {
      for (const a of await this.accounts.list(user)) {
        candidates.push({ id: a.id, name: a.name, source: 'manual', type: a.type, currency: a.reportingCurrency, visible: true, parentAccountId: a.parentAccountId, removed: false });
      }
    }
    if (query.source !== 'manual') {
      for (const a of await this.upRepo.listAccounts(user.id, null)) {
        if (visibility !== 'all' && (visibility === 'visible') !== a.visible) continue;
        candidates.push({ id: a.id, name: a.displayName, source: 'up', type: a.accountType, currency: a.currency, visible: a.visible, parentAccountId: null, removed: a.removedAt !== null });
      }
    }
    const prepared = query.q ? prepareQuery(query.q) : null;
    const results: AccountResult[] = [];
    for (const candidate of candidates) {
      if (!prepared) {
        results.push({ ...candidate, matchType: null });
        continue;
      }
      const matchType = matchName(prepared, candidate.name);
      if (matchType) results.push({ ...candidate, matchType });
    }
    results.sort(
      (a, b) =>
        (b.matchType ? MATCH_RANK[b.matchType] : 0) - (a.matchType ? MATCH_RANK[a.matchType] : 0) ||
        a.name.localeCompare(b.name) ||
        a.source.localeCompare(b.source) ||
        a.id.localeCompare(b.id),
    );
    return paginate(results, query.limit, query.offset);
  }
}

function paginate<T>(all: T[], limit = 20, offset = 0): { items: T[]; nextOffset: number | null } {
  return { items: all.slice(offset, offset + limit), nextOffset: offset + limit < all.length ? offset + limit : null };
}

function searchItem(t: UpTransactionEntity) {
  return {
    id: t.id,
    accountId: t.upAccountId,
    merchant: t.description,
    merchantKey: merchantKeyOf(t.description),
    date: t.upCreatedAt.toISOString(),
    amount: fmt(dec(t.amount)),
    direction: dec(t.amount).isNegative() ? ('out' as const) : ('in' as const),
    currency: t.currency,
    status: t.status,
    transfer: t.transferUpAccountId !== null,
    note: t.message,
    source: 'up' as const,
    type: null,
    reconciliation: t.matchedTransactionId ? ('matched' as const) : ('unmatched' as const),
    matchedTransactionId: t.matchedTransactionId,
  };
}

/** The local calendar day (YYYY-MM-DD) of an instant in an IANA time zone */
function localDay(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function manualSearchItem(t: TransactionEntity, cash: string) {
  return {
    id: t.id,
    accountId: t.accountId,
    merchant: null,
    merchantKey: null,
    date: t.date,
    amount: fmt(dec(cash)),
    direction: dec(cash).isNegative() ? ('out' as const) : ('in' as const),
    currency: t.currency ?? '',
    status: 'SETTLED' as const,
    transfer: t.transferId !== null,
    note: t.description,
    source: 'manual' as const,
    type: t.type,
    reconciliation: null,
    matchedTransactionId: null,
  };
}
