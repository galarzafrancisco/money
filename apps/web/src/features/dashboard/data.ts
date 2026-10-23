import type { Dashboard } from '@money/client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useApi } from '../../app/api';
import { queryKeys } from '../shared/queryKeys';

/** The display currencies the toggle offers */
export const DISPLAY_CURRENCIES = ['AUD', 'USD'] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

export type DashboardSettings = {
  currency: DisplayCurrency;
  /** Manual rates, "USD:1.52,EUR:1.65": units of the display currency per unit */
  rates: string | null;
};

/**
 * Display settings live in the URL (?currency=USD&rates=EUR:1.6), so every
 * dashboard view is deep-linkable and survives a refresh. They only change
 * how figures are shown; nothing is written.
 */
export function useDashboardSettings(): [DashboardSettings, (next: Partial<DashboardSettings>) => void, string] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('currency')?.toUpperCase();
  const currency: DisplayCurrency = raw === 'USD' ? 'USD' : 'AUD';
  const rates = params.get('rates') || null;
  const update = (next: Partial<DashboardSettings>) => {
    const merged = { currency, rates, ...next };
    // Manual rates are per display currency, so a currency switch drops them
    if (next.currency && next.currency !== currency && next.rates === undefined) merged.rates = null;
    const search = new URLSearchParams();
    if (merged.currency !== 'AUD') search.set('currency', merged.currency);
    if (merged.rates) search.set('rates', merged.rates);
    setParams(search, { replace: true });
  };
  return [{ currency, rates }, update, params.toString() ? `?${params.toString()}` : ''];
}

export function useDashboard(settings: DashboardSettings) {
  const { run } = useApi();
  return useQuery({
    queryKey: queryKeys.dashboard(settings),
    queryFn: ({ signal }) => run((c) => c.dashboard.getDashboard({ displayCurrency: settings.currency, fxRates: settings.rates ?? undefined, signal })),
    placeholderData: keepPreviousData,
  });
}

/**
 * Daily value of share holdings (not cash, not total wealth) for all the data
 * available (the backend's longest range, about 10 years), each day converted at that day's historical exchange rate (the
 * backend's HISTORICAL policy). Today's or manual rates are never applied to
 * past days; a day without a rate has no converted total.
 */
/** The backend allows 3660 days per request; ask for that many and it returns what exists */
function historyStart(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 3659);
  return d.toISOString().slice(0, 10);
}

export function useShareHistory(dashboard: Dashboard | undefined) {
  const { run } = useApi();
  return useQuery({
    queryKey: queryKeys.shareHistory(dashboard?.displayCurrency ?? ''),
    queryFn: ({ signal }) => run((c) => c.valuations.getValuationHistory({ include: 'totals', baseCurrency: dashboard!.displayCurrency, fromDate: historyStart(), signal })),
    enabled: Boolean(dashboard),
  });
}
