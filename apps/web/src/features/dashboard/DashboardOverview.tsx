import type { Dashboard } from '@money/client';
import { useState } from 'react';
import { Link } from 'react-router';
import { AllocationBar, Amount, Badge, Card, Heading, Loading, SegmentedControl, Stack, Table, Text, TrendLine, type Column } from '../../ui';
import { ACCOUNT_TYPE_LABELS } from '../accounts/data';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { CurrencyLines } from '../shared/CurrencyTotals';
import { useDashboardContext } from './DashboardLayout';
import { useShareHistory } from './data';
import { ConvertedAmount, Percent, allPercents } from './parts';

type AssetClassRow = Dashboard['assetClasses'][number];
type AccountRow = Dashboard['accounts'][number];

export const ASSET_CLASS_LABELS: Record<AssetClassRow['assetClass'], string> = { cash: 'Cash', shares: 'Shares', super: 'Super (retirement)' };
const ASSET_CLASS_HELP: Record<AssetClassRow['assetClass'], string> = {
  cash: 'Cash in bank, savings and brokerage accounts',
  shares: 'Share holdings outside super',
  super: 'Everything in super accounts and their subaccounts',
};

/** Total tracked assets, split by asset class and top-level account, and the share-holdings trend */
export function DashboardOverview() {
  const { dashboard } = useDashboardContext();
  const { total } = dashboard;

  const classColumns: Column<AssetClassRow>[] = [
    {
      key: 'class',
      header: 'Asset class',
      render: (row) => (
        <Stack gap={1}>
          <span>{ASSET_CLASS_LABELS[row.assetClass]}</span>
          <Text size="xs" tone="muted" as="span">
            {ASSET_CLASS_HELP[row.assetClass]}
          </Text>
          {row.accounts.length > 0 && (
            <details>
              <summary>
                <Text size="sm" as="span">
                  {row.accounts.length} account(s)
                </Text>
              </summary>
              <ul>
                {row.accounts.map((a) => (
                  <li key={a.accountId}>
                    <Link to={`/accounts/${a.accountId}`}>{a.accountPath.join(' / ')}</Link> <ConvertedAmount totals={a.totals} />{' '}
                    {a.percentOfClass !== null && (
                      <Text size="xs" tone="muted" as="span">
                        (<Amount value={a.percentOfClass} kind="percent" /> of class)
                      </Text>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Stack>
      ),
    },
    { key: 'value', header: 'Value', numeric: true, render: (row) => <ConvertedAmount totals={row.totals} /> },
    { key: 'percent', header: '% of total', numeric: true, render: (row) => <Percent value={row.percentOfTotal} /> },
  ];

  const accountColumns: Column<AccountRow>[] = [
    {
      key: 'name',
      header: 'Account',
      render: (row) => (
        <span>
          <Link to={`/accounts/${row.id}`}>{row.name}</Link> <Badge>{ACCOUNT_TYPE_LABELS[row.type]}</Badge>
          {row.subaccounts > 0 && (
            <Text size="xs" tone="muted" as="span">
              {' '}
              incl. {row.subaccounts} subaccount(s)
            </Text>
          )}
        </span>
      ),
    },
    { key: 'value', header: 'Value', numeric: true, render: (row) => <ConvertedAmount totals={row.totals} /> },
    { key: 'percent', header: '% of total', numeric: true, render: (row) => <Percent value={row.percentOfTotal} /> },
  ];

  return (
    <Stack gap={4}>
      <Card title="Total tracked assets">
          <Stack gap={2}>
            {total.converted ? (
              <Heading level={2}>
                <Amount value={total.converted.total} currency={total.converted.baseCurrency} />
              </Heading>
            ) : (
              <Text tone="warning" size="sm">
                Not converted to {dashboard.displayCurrency}: an exchange rate is missing. Per currency:
              </Text>
            )}
            <DailyChange dashboard={dashboard} />
            <Text size="sm" tone="muted" as="div">
              By currency held:
            </Text>
            <CurrencyLines lines={total.byCurrency.map((t) => ({ currency: t.currency, amount: t.total }))} />
          </Stack>
      </Card>

      <Card title="By asset class">
        <Stack gap={3}>
          {allPercents(dashboard.assetClasses, (c) => c.percentOfTotal) ? (
            <AllocationBar
              label="Asset classes"
              segments={dashboard.assetClasses.map((c) => ({ key: c.assetClass, name: ASSET_CLASS_LABELS[c.assetClass], label: ASSET_CLASS_LABELS[c.assetClass], percent: c.percentOfTotal! }))}
            />
          ) : null}
          <Table label="Asset classes" columns={classColumns} rows={dashboard.assetClasses} rowKey={(r) => r.assetClass} />
        </Stack>
      </Card>

      <Card title="By account" flush>
        <Table
          label="Top-level accounts"
          columns={accountColumns}
          rows={dashboard.accounts}
          rowKey={(r) => r.id}
          caption="Each account includes its subaccounts. Rows add up to the total."
        />
      </Card>

      <ShareHistory dashboard={dashboard} />
    </Stack>
  );
}

/** Daily share-holdings value from the valuation history: not cash, not total wealth */
type HistoryRange = '3m' | '1y' | '3y' | 'all';
const RANGE_MONTHS: Record<Exclude<HistoryRange, 'all'>, number> = { '3m': 3, '1y': 12, '3y': 36 };

function rangeStart(range: HistoryRange, lastDate: string): string | null {
  if (range === 'all') return null;
  const d = new Date(`${lastDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - RANGE_MONTHS[range]);
  return d.toISOString().slice(0, 10);
}

function ShareHistory({ dashboard }: { dashboard: Dashboard }) {
  const [range, setRange] = useState<HistoryRange>('all');
  const history = useShareHistory(dashboard);
  const title = 'Share holdings over time';
  if (history.isPending) return <Card title={title}><Loading label="Loading history…" /></Card>;
  if (history.isError) return <Card title={title}><ApiErrorCallout error={history.error} title="History is unavailable right now" /></Card>;
  const inRange = history.data.days.length === 0 ? [] : history.data.days.filter((d) => {
    const start = rangeStart(range, history.data.days[history.data.days.length - 1].date);
    return start === null || d.date >= start;
  });
  const days = inRange.filter((d) => d.totals.converted);
  const unconverted = inRange.length - days.length;
  if (days.length < 2) {
    return (
      <Card title={title}>
        <Text size="sm" tone="muted">
          {unconverted > 0
            ? `No exchange rate to ${dashboard.displayCurrency} for ${unconverted} day(s), so they cannot be charted.`
            : 'Not enough daily valuations yet. They are worked out after each market close.'}
        </Text>
      </Card>
    );
  }
  const first = days[0];
  const last = days[days.length - 1];
  const partial = days.filter((d) => !d.complete).length;
  const pending = days.filter((d) => d.pendingRecompute).length;
  return (
    <Card title={title}>
      <Stack gap={2}>
        <SegmentedControl
          legend="Period"
          name="share-history-range"
          value={range}
          onChange={setRange}
          options={[
            { value: '3m', label: '3 months' },
            { value: '1y', label: '1 year' },
            { value: '3y', label: '3 years' },
            { value: 'all', label: 'All' },
          ]}
        />
        <TrendLine
          label={`Share holdings value in ${dashboard.displayCurrency} from ${first.date} to ${last.date}`}
          points={days.map((d) => ({
            key: d.date,
            value: Number(d.totals.converted!.marketValue),
            title: `${d.date}: ${d.totals.converted!.marketValue} ${dashboard.displayCurrency}${d.complete ? '' : ' (partial)'}${d.includesMockPrices ? ' (mock prices)' : ''}`,
          }))}
        />
        <Text size="sm">
          {first.date}: <Amount value={first.totals.converted!.marketValue} currency={dashboard.displayCurrency} /> → {last.date}:{' '}
          <Amount value={last.totals.converted!.marketValue} currency={dashboard.displayCurrency} />
        </Text>
        <Text size="xs" tone="muted">
          Listed share holdings in every account (including any held in super) at daily closing prices. Cash, including super balances recorded as cash, is
          not included, so this is not your total wealth. Each day is converted at that day's closing exchange rate.
          {partial > 0 && ` ${partial} day(s) are partial: some holdings had no closing price.`}
          {unconverted > 0 && ` ${unconverted} day(s) are left out: no exchange rate for that day.`}
          {pending > 0 && ` ${pending} day(s) are being recalculated after a backdated change.`}
          {days.some((d) => d.includesMockPrices) && ' Includes mock prices.'}
        </Text>
      </Stack>
    </Card>
  );
}

/** Change since the previous close, green for a gain and red for a loss */
function DailyChange({ dashboard }: { dashboard: Dashboard }) {
  const { dailyChange } = dashboard;
  if (!dailyChange.converted) {
    return dailyChange.holdingsIncluded === 0 ? null : (
      <Text size="sm" tone="muted">
        Daily change is not available: an exchange rate is missing.
      </Text>
    );
  }
  return (
    <Text size="sm" as="div">
      <span data-testid="daily-change">
        <Amount value={dailyChange.converted.change} currency={dailyChange.converted.baseCurrency} signed />
        {dailyChange.percent !== null && (
          <>
            {' '}
            (<Amount value={dailyChange.percent} kind="percent" signed />)
          </>
        )}
      </span>{' '}
      <Text size="xs" tone="muted" as="span">
        since the previous close
        {!dailyChange.complete && ` · ${dailyChange.holdingsExcluded} holding(s) left out: no market price or previous close`}
      </Text>
    </Text>
  );
}
