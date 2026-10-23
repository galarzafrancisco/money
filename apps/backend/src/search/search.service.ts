import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { AccountsService } from '../accounts/accounts.service';
import { UpRepository } from '../up/up.repository';
import type { CurrentUser } from '../users/users.service';
import { MATCH_RANK, matchName, merchantKeyOf, prepareQuery, type MatchType } from './name-match';
import { searchAccountsSchema, searchMerchantsSchema } from './search.schemas';

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
