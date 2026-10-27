import type {
  CreateTaxAssetRequest,
  CreateTaxEvidenceRequest,
  CreateTaxItemRequest,
  CreateTaxLinkRequest,
  FileTaxYearRequest,
  SetTaxAssetYearRequest,
  UpdateTaxAssetRequest,
  UpdateTaxItemRequest,
} from '@money/client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../app/api';

/** Data access for the tax ledger and asset register: the generated client only, behind React Query */

export const taxKeys = {
  all: ['tax'] as const,
  years: ['tax', 'years'] as const,
  year: (taxYear: string) => ['tax', 'year', taxYear] as const,
  report: (taxYear: string, version?: string) => ['tax', 'report', taxYear, version ?? 'live'] as const,
  items: (filter: object) => ['tax', 'items', filter] as const,
  item: (id: string) => ['tax', 'item', id] as const,
  assets: ['tax', 'assets'] as const,
  asset: (id: string, throughYear?: string) => ['tax', 'asset', id, throughYear ?? 'default'] as const,
  categories: ['tax', 'categories'] as const,
};

export type ItemFilter = { taxYear?: string; status?: 'TO_REVIEW' | 'CONFIRMED' | 'EXCLUDED'; category?: string; source?: 'linked' | 'unlinked'; evidence?: 'present' | 'missing'; q?: string };

export function useTaxYears() {
  const { run } = useApi();
  return useQuery({ queryKey: taxKeys.years, queryFn: ({ signal }) => run((c) => c.tax.listTaxYears({ signal })) });
}

export function useTaxYear(taxYear: string) {
  const { run } = useApi();
  return useQuery({ queryKey: taxKeys.year(taxYear), queryFn: ({ signal }) => run((c) => c.tax.getTaxYear({ taxYear, signal })) });
}

export function useTaxReport(taxYear: string, enabled: boolean, version?: string) {
  const { run } = useApi();
  return useQuery({ queryKey: taxKeys.report(taxYear, version), enabled, queryFn: ({ signal }) => run((c) => c.tax.getTaxYearReport({ taxYear, version, signal })) });
}

export function useTaxItems(filter: ItemFilter) {
  const { run } = useApi();
  return useQuery({ queryKey: taxKeys.items(filter), placeholderData: keepPreviousData, queryFn: ({ signal }) => run((c) => c.tax.listTaxItems({ ...filter, signal })) });
}

export function useTaxItem(itemId: string) {
  const { run } = useApi();
  return useQuery({ queryKey: taxKeys.item(itemId), queryFn: ({ signal }) => run((c) => c.tax.getTaxItem({ itemId, signal })) });
}

export function useTaxAssets() {
  const { run } = useApi();
  return useQuery({ queryKey: taxKeys.assets, queryFn: ({ signal }) => run((c) => c.tax.listTaxAssets({ signal })) });
}

export function useTaxAsset(assetId: string, throughYear?: string) {
  const { run } = useApi();
  return useQuery({ queryKey: taxKeys.asset(assetId, throughYear), placeholderData: keepPreviousData, queryFn: ({ signal }) => run((c) => c.tax.getTaxAsset({ assetId, throughYear, signal })) });
}

export function useTaxCategories() {
  const { run } = useApi();
  return useQuery({ queryKey: taxKeys.categories, staleTime: Infinity, queryFn: ({ signal }) => run((c) => c.tax.listTaxCategories({ signal })) });
}

/** Outgoing transactions (manual and Up) matching a text, to pick a source to link */
export function useLinkCandidates(text: string) {
  const { run } = useApi();
  const q = text.trim();
  return useQuery({
    queryKey: ['tax', 'link-candidates', q],
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => run((c) => c.search.searchTransactions({ text: q, direction: 'out', visibility: 'all', transfers: 'exclude', limit: 10, timezone: 'Australia/Sydney', signal })),
  });
}

/** Every tax view depends on the others (links, years, schedules), so a write refreshes them all */
function useTaxMutation<V, R>(call: (vars: V) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: call, onSuccess: () => queryClient.invalidateQueries({ queryKey: taxKeys.all }) });
}

export function useCreateTaxItem() {
  const { run } = useApi();
  return useTaxMutation((body: CreateTaxItemRequest) => run((c) => c.tax.createTaxItem({ body })));
}

export function useUpdateTaxItem() {
  const { run } = useApi();
  return useTaxMutation(({ itemId, body }: { itemId: string; body: UpdateTaxItemRequest }) => run((c) => c.tax.updateTaxItem({ itemId, body })));
}

export function useDeleteTaxItem() {
  const { run } = useApi();
  return useTaxMutation((itemId: string) => run((c) => c.tax.deleteTaxItem({ itemId })));
}

export function useLinkTransaction() {
  const { run } = useApi();
  return useTaxMutation((body: CreateTaxLinkRequest) => run((c) => c.tax.linkTaxTransaction({ body })));
}

export function useUnlinkTransaction() {
  const { run } = useApi();
  return useTaxMutation((linkId: string) => run((c) => c.tax.unlinkTaxTransaction({ linkId })));
}

export function useAddEvidence() {
  const { run } = useApi();
  return useTaxMutation((body: CreateTaxEvidenceRequest) => run((c) => c.tax.addTaxEvidence({ body })));
}

export function useRemoveEvidence() {
  const { run } = useApi();
  return useTaxMutation((evidenceId: string) => run((c) => c.tax.removeTaxEvidence({ evidenceId })));
}

export function useRegisterAsset() {
  const { run } = useApi();
  return useTaxMutation((body: CreateTaxAssetRequest) => run((c) => c.tax.registerTaxAsset({ body })));
}

export function useUpdateAsset() {
  const { run } = useApi();
  return useTaxMutation(({ assetId, body }: { assetId: string; body: UpdateTaxAssetRequest }) => run((c) => c.tax.updateTaxAsset({ assetId, body })));
}

export function useDeleteAsset() {
  const { run } = useApi();
  return useTaxMutation((assetId: string) => run((c) => c.tax.deleteTaxAsset({ assetId })));
}

export function useSetAssetYear() {
  const { run } = useApi();
  return useTaxMutation(({ assetId, taxYear, body }: { assetId: string; taxYear: string; body: SetTaxAssetYearRequest }) => run((c) => c.tax.setTaxAssetYear({ assetId, taxYear, body })));
}

export function useFileYear() {
  const { run } = useApi();
  return useTaxMutation(({ taxYear, body }: { taxYear: string; body: FileTaxYearRequest }) => run((c) => c.tax.fileTaxYear({ taxYear, body })));
}

export function useReopenYear() {
  const { run } = useApi();
  return useTaxMutation(({ taxYear, reason }: { taxYear: string; reason: string }) => run((c) => c.tax.reopenTaxYear({ taxYear, body: { reason } })));
}

export function useUpdateYearNotes() {
  const { run } = useApi();
  return useTaxMutation(({ taxYear, notes }: { taxYear: string; notes: string | null }) => run((c) => c.tax.updateTaxYear({ taxYear, body: { notes } })));
}
