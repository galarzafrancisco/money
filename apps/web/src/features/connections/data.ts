import type { UpAccount, UpStatus } from '@money/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../app/api';
import { queryKeys } from '../shared/queryKeys';

export type UpVisibility = 'visible' | 'all';

export function useUpStatus() {
  const { run } = useApi();
  return useQuery({ queryKey: queryKeys.upStatus, queryFn: ({ signal }) => run((c) => c.up.getUpStatus({ signal })) });
}

/** 'visible' = the accounts the user chose to show; 'all' is the deliberate "show all" view */
export function useUpAccounts(visibility: UpVisibility, enabled = true) {
  const { run } = useApi();
  return useQuery({
    queryKey: queryKeys.upAccounts(visibility),
    queryFn: ({ signal }) => run((c) => c.up.listUpAccounts({ visibility, signal })),
    enabled,
  });
}

const UP_PAGE_SIZE = 50;

/** One page of an Up account's imported transactions (read-only; works for hidden accounts too) */
export function useUpTransactions(accountId: string, offset: number) {
  const { run } = useApi();
  return useQuery({
    queryKey: queryKeys.upTransactions(accountId, offset),
    queryFn: ({ signal }) => run((c) => c.up.listUpTransactions({ accountId, limit: UP_PAGE_SIZE, offset, signal })),
  });
}

export { UP_PAGE_SIZE };

function useInvalidateUp() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['up'] });
}

/** The token goes to the backend once; it is never kept in the browser */
export function useConnectUp() {
  const { run } = useApi();
  const invalidate = useInvalidateUp();
  return useMutation({ mutationFn: (token: string) => run((c) => c.up.connectUp({ body: { token } })), onSuccess: invalidate });
}

export function useDisconnectUp() {
  const { run } = useApi();
  const invalidate = useInvalidateUp();
  return useMutation({ mutationFn: (purge: boolean) => run((c) => c.up.disconnectUp({ purge })), onSuccess: invalidate });
}

export function useSyncUp() {
  const { run } = useApi();
  const invalidate = useInvalidateUp();
  return useMutation({ mutationFn: () => run((c) => c.up.syncUp()), onSuccess: invalidate });
}

export function useUpdateUpAccount() {
  const { run } = useApi();
  const invalidate = useInvalidateUp();
  return useMutation({
    mutationFn: ({ accountId, body }: { accountId: string; body: { visible?: boolean; categoryId?: string | null } }) =>
      run((c) => c.up.updateUpAccount({ accountId, body })),
    onSuccess: invalidate,
  });
}

export type { UpAccount, UpStatus };
