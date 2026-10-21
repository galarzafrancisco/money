import type { Account, CreateAccountRequest, UpdateAccountRequest } from '@money/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../app/api';
import { queryKeys } from '../shared/queryKeys';

/** Data access for accounts: the generated client only, behind React Query */
export function useAccounts() {
  const { run } = useApi();
  return useQuery({ queryKey: queryKeys.accounts, queryFn: ({ signal }) => run((c) => c.accounts.listAccounts({ signal })) });
}

export function useAccount(accountId: string) {
  const { run } = useApi();
  return useQuery({ queryKey: queryKeys.account(accountId), queryFn: ({ signal }) => run((c) => c.accounts.getAccount({ accountId, signal })) });
}

/** Per-account totals per currency (own and incl. subaccounts), at market value with cost fallback */
export function useAccountsReport() {
  const { run } = useApi();
  return useQuery({
    queryKey: queryKeys.accountsReport,
    queryFn: ({ signal }) => run((c) => c.reports.getAccountsReport({ valuation: 'market', signal })),
  });
}

export function usePortfolio(accountId: string) {
  const { run } = useApi();
  return useQuery({ queryKey: queryKeys.portfolio(accountId), queryFn: ({ signal }) => run((c) => c.portfolio.getAccountPortfolio({ accountId, signal })) });
}

export function useCreateAccount() {
  const { run } = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAccountRequest) => run((c) => c.accounts.createAccount({ body })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
      void queryClient.invalidateQueries({ queryKey: queryKeys.accountsReport });
    },
  });
}

export function useUpdateAccount(accountId: string) {
  const { run } = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAccountRequest) => run((c) => c.accounts.updateAccount({ accountId, body })),
    onSuccess: (account: Account) => {
      queryClient.setQueryData(queryKeys.account(accountId), account);
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
      void queryClient.invalidateQueries({ queryKey: queryKeys.accountsReport });
      void queryClient.invalidateQueries({ queryKey: queryKeys.portfolio(accountId) });
    },
  });
}

export function useDeleteAccount(accountId: string) {
  const { run } = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deleteTransactions: boolean) => run((c) => c.accounts.deleteAccount({ accountId, deleteTransactions: deleteTransactions ? 'true' : undefined })),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.account(accountId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
      void queryClient.invalidateQueries({ queryKey: queryKeys.accountsReport });
      void queryClient.invalidateQueries({ queryKey: queryKeys.transfers() });
    },
  });
}

/** Accounts ordered as a tree: parents first, children indented under them */
export type AccountNode = { account: Account; level: number; children: AccountNode[] };

export function accountTree(accounts: readonly Account[]): AccountNode[] {
  const byParent = new Map<string | null, Account[]>();
  const ids = new Set(accounts.map((a) => a.id));
  for (const account of accounts) {
    const parent = account.parentAccountId && ids.has(account.parentAccountId) ? account.parentAccountId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), account]);
  }
  const build = (parent: string | null, level: number, seen: Set<string>): AccountNode[] =>
    (byParent.get(parent) ?? [])
      .filter((a) => !seen.has(a.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((account) => ({ account, level, children: build(account.id, level + 1, new Set([...seen, account.id])) }));
  return build(null, 0, new Set());
}

export function flattenTree(nodes: AccountNode[]): AccountNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

/** Names from the top-level account down to this one */
export function accountPath(accountId: string, accounts: readonly Account[]): Account[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const path: Account[] = [];
  let current = byId.get(accountId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentAccountId ? byId.get(current.parentAccountId) : undefined;
  }
  return path;
}

/** IDs of the account and every account below it */
export function descendantIds(accountId: string, accounts: readonly Account[]): Set<string> {
  const result = new Set<string>([accountId]);
  let added = true;
  while (added) {
    added = false;
    for (const a of accounts) {
      if (a.parentAccountId && result.has(a.parentAccountId) && !result.has(a.id)) {
        result.add(a.id);
        added = true;
      }
    }
  }
  return result;
}

export const ACCOUNT_TYPE_LABELS: Record<Account['type'], string> = {
  INVESTMENT: 'Investment',
  CASH: 'Cash',
  OTHER: 'Other',
};

export const ACCOUNT_TYPE_HELP: Record<Account['type'], string> = {
  INVESTMENT: 'A brokerage or share account: record buys, sells and dividends as well as cash.',
  CASH: 'A bank or savings account, or a bucket of cash within one.',
  OTHER: 'Anything else you want to track, such as a term deposit.',
};
