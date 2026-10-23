import type { TransactionSearchPage, AccountSearchPage } from '@money/client';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useApi } from '../../app/api';

/** Data access for search: the generated client only, behind React Query */

export type SearchFilters = {
  merchantKey?: string;
  accountId?: string;
  text?: string;
  fromDate?: string;
  toDate?: string;
  currency?: string;
  minAmount?: string;
  maxAmount?: string;
  direction: 'any' | 'out' | 'in';
  timezone: string;
};

const PAGE_SIZE = 50;

/** Merchant candidates for a typed name. Only runs for two or more characters. */
export function useMerchantLookup(q: string) {
  const { run } = useApi();
  const enabled = q.trim().length >= 2;
  return useQuery({
    queryKey: ['search', 'merchants', q.trim()],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => run((c) => c.search.searchMerchants({ q: q.trim(), limit: 8, visibility: 'all', signal })),
  });
}

/** Accounts to scope a search to (manual and imported, hidden ones included) */
export function useSearchAccounts() {
  const { run } = useApi();
  return useQuery({
    queryKey: ['search', 'accounts'],
    // Page through every account so none is missing from the picker or the result labels
    queryFn: async ({ signal }) => {
      const items: AccountSearchPage['items'] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const start: number = offset;
        const page: AccountSearchPage = await run((c) => c.search.searchAccounts({ limit: 100, offset: start, visibility: 'all', signal }));
        items.push(...page.items);
        offset = page.nextOffset ?? null;
      }
      return { items, nextOffset: null };
    },
  });
}

/** Transactions matching the filters, paged by the server; "load more" asks for the next offset */
export function useTransactionSearch(filters: SearchFilters | null) {
  const { run } = useApi();
  return useInfiniteQuery({
    queryKey: ['search', 'transactions', filters],
    enabled: filters !== null,
    initialPageParam: 0,
    getNextPageParam: (page: TransactionSearchPage) => page.nextOffset ?? undefined,
    queryFn: ({ pageParam, signal }) => {
      const f = filters as SearchFilters;
      return run((c) =>
        c.search.searchTransactions({
          merchantKey: f.merchantKey,
          accountIds: f.accountId,
          text: f.text,
          fromDate: f.fromDate,
          toDate: f.toDate,
          currency: f.currency,
          minAmount: f.minAmount,
          maxAmount: f.maxAmount,
          direction: f.direction,
          timezone: f.timezone,
          // The UI covers every account the user can see, hidden ones too
          visibility: 'all',
          limit: PAGE_SIZE,
          offset: pageParam,
          signal,
        }),
      );
    },
  });
}
