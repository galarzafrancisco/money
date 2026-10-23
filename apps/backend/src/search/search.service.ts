import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { AccountsService } from '../accounts/accounts.service';
import { UpRepository } from '../up/up.repository';
import type { CurrentUser } from '../users/users.service';
import { dec, fmt } from '../common/decimal';
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
   * Transaction search over imported Up transactions, filtered, sorted and
   * paged in the database. Manual ledger transactions have no merchant and are
   * not included; those matched to an Up transaction are the same event and are
   * not listed twice because only the Up side is searched.
   */
  async transactions(user: CurrentUser, input: unknown) {
    const query = parseInput(searchTransactionsSchema, input);
    const upAccounts = await this.upRepo.listAccounts(user.id, null);
    let scope = upAccounts;
    if (query.accountIds && query.accountIds.length > 0) {
      scope = query.accountIds.map((id) => {
        const one = isUuid(id) ? upAccounts.find((a) => a.id === id) : undefined;
        if (!one) throw new NotFoundError(`Up account ${id} not found`); // also for another user's account
        return one;
      });
    } else {
      const visibility = query.visibility ?? 'visible';
      scope = upAccounts.filter((a) => visibility === 'all' || (visibility === 'visible') === a.visible);
    }
    const scopeIds = scope.map((a) => a.id);

    let descriptions: string[] | undefined;
    let matchedMerchants: { merchantKey: string; name: string }[] | null = null;
    if (query.merchantKey || query.merchant) {
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
    const result = await this.upRepo.searchTransactions(user.id, {
      upAccountIds: scopeIds,
      descriptions,
      text: query.text,
      fromDate: query.fromDate,
      toDate: query.toDate,
      timezone,
      minAmount: query.minAmount,
      maxAmount: query.maxAmount,
      currency: query.currency,
      direction: query.direction === 'any' ? undefined : query.direction,
      status: query.status,
      transfers: descriptions ? 'exclude' : (query.transfers ?? 'exclude'),
      limit,
      offset,
    });
    return {
      items: result.rows.map(searchItem),
      nextOffset: offset + limit < result.total ? offset + limit : null,
      summary: {
        totalCount: result.total,
        byCurrency: result.byCurrency.map((c) => ({
          currency: c.currency,
          count: c.count,
          moneyOut: fmt(dec(c.moneyOut)),
          moneyIn: fmt(dec(c.moneyIn)),
          net: fmt(dec(c.moneyIn).minus(dec(c.moneyOut))),
        })),
      },
      matchedMerchants,
      scope: { accountCount: scopeIds.length, timezone },
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
    reconciliation: t.matchedTransactionId ? ('matched' as const) : ('unmatched' as const),
    matchedTransactionId: t.matchedTransactionId,
  };
}
