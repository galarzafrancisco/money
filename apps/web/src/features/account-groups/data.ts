import type { CreateAccountGroupRequest, UpdateAccountGroupRequest } from '@money/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../app/api';
import { queryKeys } from '../shared/queryKeys';

/** Logical groups with totals per currency (no FX conversion unless the user supplies rates) */
export function useAccountGroups() {
  const { run } = useApi();
  return useQuery({ queryKey: queryKeys.accountGroups, queryFn: ({ signal }) => run((c) => c.accountGroups.listAccountGroups({ valuation: 'market', signal })) });
}

function useInvalidateGroups() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.accountGroups });
}

export function useCreateAccountGroup() {
  const { run } = useApi();
  const invalidate = useInvalidateGroups();
  return useMutation({ mutationFn: (body: CreateAccountGroupRequest) => run((c) => c.accountGroups.createAccountGroup({ body })), onSuccess: invalidate });
}

export function useUpdateAccountGroup() {
  const { run } = useApi();
  const invalidate = useInvalidateGroups();
  return useMutation({
    mutationFn: ({ groupId, body }: { groupId: string; body: UpdateAccountGroupRequest }) => run((c) => c.accountGroups.updateAccountGroup({ groupId, body })),
    onSuccess: invalidate,
  });
}

export function useDeleteAccountGroup() {
  const { run } = useApi();
  const invalidate = useInvalidateGroups();
  return useMutation({ mutationFn: (groupId: string) => run((c) => c.accountGroups.deleteAccountGroup({ groupId })), onSuccess: invalidate });
}
