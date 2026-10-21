import type { CreateCategoryRequest, UpdateCategoryRequest } from '@money/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../app/api';
import { queryKeys } from '../shared/queryKeys';

export function useCategories() {
  const { run } = useApi();
  return useQuery({ queryKey: queryKeys.categories, queryFn: ({ signal }) => run((c) => c.categories.listCategories({ signal })) });
}

export function useHoldingCategories(accountId: string) {
  const { run } = useApi();
  return useQuery({
    queryKey: queryKeys.holdingCategories(accountId),
    queryFn: ({ signal }) => run((c) => c.categories.listHoldingCategories({ accountId, signal })),
  });
}

function useInvalidateCategories() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.categories });
    void queryClient.invalidateQueries({ queryKey: ['holding-categories'] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
    void queryClient.invalidateQueries({ queryKey: ['account'] });
    void queryClient.invalidateQueries({ queryKey: ['reports'] });
  };
}

export function useCreateCategory() {
  const { run } = useApi();
  const invalidate = useInvalidateCategories();
  return useMutation({ mutationFn: (body: CreateCategoryRequest) => run((c) => c.categories.createCategory({ body })), onSuccess: invalidate });
}

export function useUpdateCategory() {
  const { run } = useApi();
  const invalidate = useInvalidateCategories();
  return useMutation({
    mutationFn: ({ categoryId, body }: { categoryId: string; body: UpdateCategoryRequest }) => run((c) => c.categories.updateCategory({ categoryId, body })),
    onSuccess: invalidate,
  });
}

export function useDeleteCategory() {
  const { run } = useApi();
  const invalidate = useInvalidateCategories();
  return useMutation({
    mutationFn: ({ categoryId, unassign }: { categoryId: string; unassign: boolean }) =>
      run((c) => c.categories.deleteCategory({ categoryId, unassign: unassign ? 'true' : undefined })),
    onSuccess: invalidate,
  });
}

/** Sets a holding's own category, or clears it (null) so it inherits the account's */
export function useSetHoldingCategory(accountId: string) {
  const { run } = useApi();
  const invalidate = useInvalidateCategories();
  return useMutation({
    mutationFn: ({ symbol, categoryId }: { symbol: string; categoryId: string | null }) =>
      run((c) =>
        categoryId === null
          ? c.categories.clearHoldingCategory({ accountId, symbol })
          : c.categories.setHoldingCategory({ accountId, symbol, body: { categoryId } }),
      ),
    onSuccess: invalidate,
  });
}
