import type { Dashboard, DashboardItem } from '@money/client';
import { Link } from 'react-router';
import { AllocationBar, Amount, ButtonLink, Card, EmptyState, Stack, Swatch, Table, Text, seriesColor, type Column } from '../../ui';
import { useDashboardContext } from './DashboardLayout';
import { ASSET_CLASS_LABELS } from './DashboardOverview';
import { ConvertedAmount, Percent, PriceStatusBadge, allPercents } from './parts';

type CategoryRow = Dashboard['categories'][number];

const nameOf = (row: CategoryRow) => row.category?.name ?? 'Uncategorized';

/** Your own categories (emergency fund, term deposits, alpha, …): each cash balance and holding in exactly one */
export function DashboardCategories() {
  const { dashboard } = useDashboardContext();
  const rows = dashboard.categories;
  // A category's own colour when it has one, else its slot in the fixed series order
  const colorOf = (row: CategoryRow) => row.category?.color ?? seriesColor(rows.indexOf(row));

  if (rows.length === 1 && rows[0].category === null) {
    return (
      <EmptyState title="No categories yet" action={<ButtonLink to="/categories">Create categories</ButtonLink>}>
        Create categories such as Emergency fund, Term deposits, Alpha or Broad-market ETF, then assign them to accounts or holdings to see your money split by
        them.
      </EmptyState>
    );
  }

  const columns: Column<CategoryRow>[] = [
    {
      key: 'name',
      header: 'Category',
      render: (row) => (
        <Stack gap={1}>
          <span>
            <Swatch color={colorOf(row)} /> {nameOf(row)}
          </span>
          {row.items.length > 0 ? (
            <details>
              <summary>
                <Text size="sm" as="span">
                  {row.items.length} balance(s) and holding(s)
                </Text>
              </summary>
              <CategoryItems items={row.items} />
            </details>
          ) : (
            <Text size="xs" tone="muted" as="span">
              Nothing assigned
            </Text>
          )}
        </Stack>
      ),
    },
    { key: 'value', header: 'Value', numeric: true, render: (row) => <ConvertedAmount totals={row.totals} /> },
    { key: 'percent', header: '% of total', numeric: true, render: (row) => <Percent value={row.percentOfTotal} /> },
  ];

  return (
    <Card title="By category">
      <Stack gap={3}>
        {allPercents(rows, (r) => r.percentOfTotal) && (
          <AllocationBar
            label="Categories"
            segments={rows.map((r) => ({ key: r.category?.id ?? 'none', name: nameOf(r), label: nameOf(r), percent: r.percentOfTotal!, color: colorOf(r) }))}
          />
        )}
        <Table label="Categories" columns={columns} rows={rows} rowKey={(r) => r.category?.id ?? 'none'} />
        <Text size="xs" tone="muted">
          A holding's own category wins, else its account's, else the nearest parent account's, else Uncategorized, so the rows add up to the total. Categories
          are current labels: changing one also changes past figures.
        </Text>
      </Stack>
    </Card>
  );
}

function CategoryItems({ items }: { items: DashboardItem[] }) {
  return (
    <ul>
      {items.map((item) => (
        <li key={`${item.accountId}|${item.kind}|${item.symbol ?? item.currency}`}>
          <Link to={`/accounts/${item.accountId}`}>{item.accountPath.join(' / ')}</Link>:{' '}
          {item.kind === 'cash' ? `${item.currency} cash` : item.symbol} <Amount value={item.value} currency={item.currency} />{' '}
          <Text size="xs" tone="muted" as="span">
            ({ASSET_CLASS_LABELS[item.assetClass]})
          </Text>{' '}
          {item.priceStatus && item.priceStatus !== 'MARKET' && <PriceStatusBadge status={item.priceStatus} />}
        </li>
      ))}
    </ul>
  );
}
