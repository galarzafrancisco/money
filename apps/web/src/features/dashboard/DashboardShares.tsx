import type { Dashboard } from '@money/client';
import { Link } from 'react-router';
import { AllocationBar, Amount, Card, DescriptionList, EmptyState, Stack, Table, Text, type AllocationSegment, type Column } from '../../ui';
import { sumDecimals } from '../../lib/decimal';
import { useDashboardContext } from './DashboardLayout';
import { ConvertedAmount, Percent, PriceStatusBadge, allPercents } from './parts';

type TickerRow = Dashboard['shares']['tickers'][number];

/** Tickers shown in the bar by name; the rest fold into "Other" */
const NAMED_TICKERS = 7;

/** Each share across all accounts, and how concentrated the share portfolio is */
export function DashboardShares() {
  const { dashboard } = useDashboardContext();
  const { shares } = dashboard;
  const tickers = shares.tickers;

  if (tickers.length === 0) {
    return (
      <EmptyState title="No share holdings">
        Record buys in an investment account to see each share's value and concentration here. Shares held inside super accounts count as super instead.
      </EmptyState>
    );
  }

  const columns: Column<TickerRow>[] = [
    {
      key: 'symbol',
      header: 'Share',
      render: (row) => (
        <Stack gap={1}>
          <Text strong as="span">
            {row.symbol}
          </Text>
          <details>
            <summary>
              <Text size="sm" as="span">
                {row.positions.length === 1 ? row.positions[0].accountPath.join(' / ') : `${row.positions.length} accounts`}
              </Text>
            </summary>
            <ul>
              {row.positions.map((p) => (
                <li key={p.accountId}>
                  <Link to={`/accounts/${p.accountId}`}>{p.accountPath.join(' / ')}</Link>: <Amount value={p.quantity} kind="quantity" /> units,{' '}
                  <Amount value={p.value} currency={row.currency} />
                  {p.basis === 'cost' && ' (at cost)'}
                </li>
              ))}
            </ul>
          </details>
        </Stack>
      ),
    },
    { key: 'quantity', header: 'Units', numeric: true, render: (row) => <Amount value={row.quantity} kind="quantity" /> },
    {
      key: 'price',
      header: 'Price',
      numeric: true,
      render: (row) => (
        <Stack gap={1}>
          {row.price ? <Amount value={row.price.price} currency={row.currency} kind="rate" /> : <Text tone="muted" size="sm" as="span">—</Text>}
          <span>
            <PriceStatusBadge status={row.priceStatus} />
          </span>
          {row.price && !row.price.isMock && (
            <Text size="xs" tone="muted" as="span">
              {row.price.source} · {row.price.asOf.slice(0, 10)}
            </Text>
          )}
        </Stack>
      ),
    },
    { key: 'value', header: 'Value', numeric: true, render: (row) => <Amount value={row.value} currency={row.currency} /> },
    {
      key: 'converted',
      header: `In ${dashboard.displayCurrency}`,
      numeric: true,
      render: (row) => <Amount value={row.convertedValue} currency={row.convertedValue === null ? null : dashboard.displayCurrency} />,
    },
    { key: 'ofShares', header: '% of shares', numeric: true, render: (row) => <Percent value={row.percentOfShares} /> },
    { key: 'ofTotal', header: '% of total assets', numeric: true, render: (row) => <Percent value={row.percentOfTotal} /> },
  ];

  let segments: AllocationSegment[] | null = null;
  if (allPercents(tickers, (t) => t.percentOfShares)) {
    const named = tickers.slice(0, NAMED_TICKERS).map((t) => ({ key: t.symbol, name: t.symbol, label: t.symbol, percent: t.percentOfShares! }));
    const rest = tickers.slice(NAMED_TICKERS);
    segments = rest.length > 0 ? [...named, { key: 'other', name: `${rest.length} other(s)`, label: `${rest.length} other(s)`, percent: sumDecimals(rest.map((t) => t.percentOfShares!)), color: 'var(--chart-other)' }] : named;
  }

  return (
    <Stack gap={4}>
      <Card title="Share portfolio">
        <Stack gap={3}>
          <DescriptionList
            items={[
              { term: 'Value', detail: <ConvertedAmount totals={shares.totals} part="holdings" /> },
              { term: 'Share of total assets', detail: <Percent value={shares.percentOfTotal} /> },
              { term: 'Largest holding', detail: `${tickers[0].symbol}${tickers[0].percentOfShares ? ` (${tickers[0].percentOfShares}% of shares)` : ''}` },
            ]}
          />
          {segments && <AllocationBar label="Concentration by share" segments={segments} />}
        </Stack>
      </Card>
      <Card title="Each share" flush>
        <Table
          label="Shares"
          columns={columns}
          rows={tickers}
          rowKey={(r) => `${r.symbol}|${r.currency}`}
          caption="Each share is added up across your accounts. % of shares divides by the share portfolio; % of total assets divides by everything you track. Shares held in super count as super, not here."
        />
      </Card>
    </Stack>
  );
}
