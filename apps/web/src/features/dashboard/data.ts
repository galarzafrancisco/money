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

/** Rates the dashboard used, as the fxRates string the valuation history accepts */
export function ratesParam(dashboard: Dashboard): string | undefined {
  if (!dashboard.fx.complete || dashboard.fx.rates.length === 0) return undefined;
  return dashboard.fx.rates.map((r) => `${r.currency}:${r.rate}`).join(',');
}

/**
 * Daily value of share holdings (not cash, not total wealth) over the last
 * 90 days, converted at the dashboard's current rates (constant, not
 * historical FX). Only fetched when the conversion is complete.
 */
export function useShareHistory(dashboard: Dashboard | undefined) {
  const { run } = useApi();
  const fxRates = dashboard ? ratesParam(dashboard) : undefined;
  const enabled = Boolean(dashboard?.fx.complete);
  return useQuery({
    queryKey: queryKeys.shareHistory(dashboard?.displayCurrency ?? '', fxRates ?? ''),
    queryFn: ({ signal }) =>
      run((c) => c.valuations.getValuationHistory({ include: 'totals', baseCurrency: dashboard!.displayCurrency, fxRates, signal })),
    enabled,
  });
}
