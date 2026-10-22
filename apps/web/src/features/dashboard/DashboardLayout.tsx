import type { Dashboard } from '@money/client';
import { Outlet, useOutletContext } from 'react-router';
import { InAppNav } from '../../app/InAppNav';
import { Button, ButtonLink, Card, EmptyState, Loading, SegmentedControl, Stack, Text } from '../../ui';
import { ApiErrorCallout, errorCode } from '../shared/ApiErrorCallout';
import { PageHeader } from '../shared/PageHeader';
import { DISPLAY_CURRENCIES, useDashboard, useDashboardSettings, type DisplayCurrency } from './data';
import { DataQuality } from './parts';

export type DashboardContext = { dashboard: Dashboard; search: string };

export function useDashboardContext(): DashboardContext {
  return useOutletContext<DashboardContext>();
}

/**
 * The portfolio dashboard: a display-currency toggle, how the figures were
 * valued, and in-app sections (overview, categories, shares). Every figure
 * comes from GET /api/dashboard; this only lays them out.
 */
export function DashboardLayout() {
  const [settings, update, search] = useDashboardSettings();
  const dashboard = useDashboard(settings);

  const header = (
    <PageHeader
      title="Dashboard"
      subtitle="What you track, in one currency: by asset class, category, account and share. Personal tracking only, not financial or tax advice."
      actions={
        <SegmentedControl<DisplayCurrency>
          legend="Show in"
          name="display-currency"
          value={settings.currency}
          options={DISPLAY_CURRENCIES.map((c) => ({ value: c, label: c }))}
          onChange={(currency) => update({ currency })}
        />
      }
    />
  );

  if (dashboard.isPending) return <>{header}<Loading label="Loading your dashboard…" /></>;
  if (dashboard.isError) {
    return (
      <>
        {header}
        <ApiErrorCallout error={dashboard.error} title="Could not load your dashboard">
          {errorCode(dashboard.error) === 'validation_failed' && settings.rates && (
            <div>
              <Button size="sm" onClick={() => update({ rates: null })}>
                Clear manual rates
              </Button>
            </div>
          )}
        </ApiErrorCallout>
      </>
    );
  }

  const data = dashboard.data;
  if (data.accounts.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          title="Nothing to show yet"
          action={
            <ButtonLink to="/accounts/new" variant="primary">
              Create an account
            </ButtonLink>
          }
        >
          Add your bank, brokerage and super accounts, then record their balances, trades and dividends. The dashboard totals them here.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      {header}
      <Card>
        <Stack gap={2}>
          <DataQuality dashboard={data} onManualRates={(rates) => update({ rates })} />
          {dashboard.isFetching && (
            <Text size="xs" tone="muted">
              Updating…
            </Text>
          )}
        </Stack>
      </Card>
      <InAppNav
        label="Dashboard sections"
        items={[
          { to: `/dashboard${search}`, label: 'Overview', end: true },
          { to: `/dashboard/categories${search}`, label: 'Categories' },
          { to: `/dashboard/shares${search}`, label: 'Shares' },
        ]}
      />
      <Outlet context={{ dashboard: data, search } satisfies DashboardContext} />
      <Text tone="muted" size="sm">
        Valued {data.asOf.slice(0, 16).replace('T', ' ')} UTC with {data.priceProvider === 'mock' ? 'mock prices (not real market data)' : `${data.priceProvider} prices`}. Changing the
        currency only changes how figures are shown; your records keep their own currencies.
      </Text>
    </>
  );
}
