import type { Holding } from '@money/client';
import { Amount, Badge, ButtonLink, Card, EmptyState, Grid, Loading, SelectField, Stack, Table, Text, type Column } from '../../ui';
import { useCategories, useHoldingCategories, useSetHoldingCategory } from '../categories/data';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { CurrencyLines } from '../shared/CurrencyTotals';
import { PriceProvenance } from '../shared/PriceProvenance';
import { useAccountContext } from './AccountLayout';
import { usePortfolio } from './data';

/** Cash per currency, holdings with prices and gains, realized gains and dividends: all derived by the backend */
export function AccountOverview() {
  const { account } = useAccountContext();
  const portfolio = usePortfolio(account.id);
  const categories = useCategories();
  const holdingCategories = useHoldingCategories(account.id);
  const setCategory = useSetHoldingCategory(account.id);

  if (portfolio.isPending) return <Loading label="Working out balances and holdings…" />;
  if (portfolio.isError) return <ApiErrorCallout error={portfolio.error} title="Could not load balances and holdings" />;
  const p = portfolio.data;
  const record = (type: string) => `/accounts/${account.id}/record?type=${type}`;
  const ownCategory = new Map((holdingCategories.data ?? []).map((h) => [h.symbol, h.categoryId]));

  const holdingColumns: Column<Holding>[] = [
    { key: 'symbol', header: 'Symbol', render: (h) => <Text strong as="span">{h.symbol}</Text> },
    { key: 'quantity', header: 'Quantity', numeric: true, render: (h) => <Amount value={h.quantity} kind="quantity" /> },
    { key: 'avg', header: 'Average cost', numeric: true, render: (h) => <Amount value={h.averageUnitCost} currency={h.currency} kind="rate" /> },
    { key: 'cost', header: 'Cost base', numeric: true, render: (h) => <Amount value={h.costBase} currency={h.currency} /> },
    { key: 'price', header: 'Price', numeric: true, render: (h) => <PriceProvenance price={h.price} error={h.priceError} /> },
    { key: 'value', header: 'Market value', numeric: true, render: (h) => <Amount value={h.marketValue} currency={h.currency} /> },
    {
      key: 'gain',
      header: 'Unrealized gain',
      numeric: true,
      render: (h) => (
        <Stack gap={1}>
          <Amount value={h.unrealizedGain} currency={h.currency} signed />
          {h.unrealizedGainPercent && (
            <Text size="xs" tone="muted" as="span">
              <Amount value={h.unrealizedGainPercent} kind="percent" signed />
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      render: (h) => (
        <SelectField
          label={<span className="visually-hidden">Category for {h.symbol}</span>}
          value={ownCategory.get(h.symbol) ?? ''}
          disabled={setCategory.isPending || categories.isPending}
          onChange={(e) => setCategory.mutate({ symbol: h.symbol, categoryId: e.target.value || null })}
        >
          <option value="">Account&apos;s category</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
      ),
    },
  ];

  return (
    <Stack gap={5}>
      <Grid size="wide">
        <Card title="Cash" actions={<ButtonLink to={record('DEPOSIT')} size="sm">Record deposit</ButtonLink>}>
          {p.cash.length === 0 ? (
            <Text tone="muted">No cash recorded yet.</Text>
          ) : (
            <Table label="Cash balances" columns={[
              { key: 'currency', header: 'Currency', render: (c) => c.currency },
              { key: 'balance', header: 'Balance', numeric: true, render: (c) => <Amount value={c.balance} currency={c.currency} /> },
            ]} rows={p.cash} rowKey={(c) => c.currency} />
          )}
        </Card>
        <Card title="Realized and income">
          <Stack gap={3}>
            <div>
              <Text tone="muted" size="sm">Realized gains (net of fees)</Text>
              <CurrencyLines lines={p.realized.totals.map((t) => ({ currency: t.currency, amount: t.gain }))} empty="No sales yet" />
            </div>
            <div>
              <Text tone="muted" size="sm">Dividends received (net)</Text>
              <CurrencyLines lines={p.dividends.totals.map((t) => ({ currency: t.currency, amount: t.netAmount }))} empty="No dividends yet" />
            </div>
          </Stack>
        </Card>
      </Grid>

      {setCategory.isError && <ApiErrorCallout error={setCategory.error} title="Could not change the holding's category" />}

      <Card title="Holdings" flush actions={<ButtonLink to={record('BUY')} size="sm">Record buy</ButtonLink>}>
        {p.holdings.length === 0 ? (
          <EmptyState title="No shares held">Record a buy to start tracking a holding.</EmptyState>
        ) : (
          <Table label="Holdings" columns={holdingColumns} rows={p.holdings} rowKey={(h) => h.symbol} />
        )}
      </Card>

      {p.dividends.bySymbol.length > 0 && (
        <Card title="Dividends by holding" flush>
          <Table
            label="Dividends by holding"
            columns={[
              { key: 'symbol', header: 'Symbol', render: (d) => d.symbol },
              { key: 'gross', header: 'Gross', numeric: true, render: (d) => <Amount value={d.grossAmount} currency={d.currency} /> },
              { key: 'withheld', header: 'Tax withheld', numeric: true, render: (d) => <Amount value={d.withholdingTax} currency={d.currency} /> },
              { key: 'net', header: 'Net', numeric: true, render: (d) => <Amount value={d.netAmount} currency={d.currency} /> },
              { key: 'franking', header: 'Franking credits', numeric: true, render: (d) => <Amount value={d.frankingCredits} currency={d.currency} /> },
            ]}
            rows={p.dividends.bySymbol}
            rowKey={(d) => `${d.symbol}-${d.currency}`}
          />
        </Card>
      )}

      <details>
        <summary>
          <Text as="span" size="sm" tone="muted">
            How these figures are worked out {p.priceProvider === 'mock' && <Badge tone="warning">Mock prices</Badge>}
          </Text>
        </summary>
        <ul>
          {p.notes.map((note) => (
            <li key={note}>
              <Text size="sm" tone="muted" as="span">{note}</Text>
            </li>
          ))}
        </ul>
      </details>
    </Stack>
  );
}
