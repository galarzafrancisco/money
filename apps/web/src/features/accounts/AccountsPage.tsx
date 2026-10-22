import type { AccountReportNode } from '@money/client';
import { Link } from 'react-router';
import { Badge, ButtonLink, Callout, Card, EmptyState, Loading, Stack, Swatch, Table, Text, type Column } from '../../ui';
import { UpAccountsSummary } from '../connections/UpAccountsSummary';
import { useCategories } from '../categories/data';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { CurrencyLines } from '../shared/CurrencyTotals';
import { PageHeader } from '../shared/PageHeader';
import { ACCOUNT_TYPE_LABELS, accountTree, flattenTree, useAccounts, useAccountsReport, type AccountNode } from './data';
import './accounts.css';

function flattenReport(nodes: AccountReportNode[]): AccountReportNode[] {
  return nodes.flatMap((n) => [n, ...flattenReport(n.children)]);
}

/** Every account the signed-in user has, as a tree, with per-currency totals from the backend's report */
export function AccountsPage() {
  const accounts = useAccounts();
  const report = useAccountsReport();
  const categories = useCategories();

  const header = (
    <PageHeader
      title="Accounts"
      subtitle="Your accounts and subaccounts, with what they hold. Money records activity; it never moves money."
      actions={
        <ButtonLink to="/accounts/new" variant="primary">
          New account
        </ButtonLink>
      }
    />
  );

  if (accounts.isPending) return <>{header}<Loading label="Loading accounts…" /></>;
  if (accounts.isError) return <>{header}<ApiErrorCallout error={accounts.error} title="Could not load your accounts" /></>;

  if (accounts.data.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          title="No accounts yet"
          action={
            <ButtonLink to="/accounts/new" variant="primary">
              Create your first account
            </ButtonLink>
          }
        >
          Add a brokerage, bank or savings account, then record the deposits, trades and dividends that happen in it.
        </EmptyState>
        <UpAccountsSummary />
      </>
    );
  }

  const reportById = new Map(flattenReport(report.data?.accounts ?? []).map((n) => [n.id, n]));
  const categoryById = new Map((categories.data ?? []).map((c) => [c.id, c]));
  const rows = flattenTree(accountTree(accounts.data));

  const columns: Column<AccountNode>[] = [
    {
      key: 'name',
      header: 'Account',
      render: ({ account, level }) => (
        <span className="account-name" style={{ ['--level' as string]: level }}>
          {level > 0 && <span className="account-name__branch" aria-hidden>└</span>}
          <Link to={`/accounts/${account.id}`}>{account.name}</Link>
          <Badge>{ACCOUNT_TYPE_LABELS[account.type]}</Badge>
        </span>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      render: ({ account }) => {
        const own = account.categoryId ? categoryById.get(account.categoryId) : undefined;
        const effective = reportById.get(account.id)?.effectiveCategory;
        if (own) return <span><Swatch color={own.color} /> {own.name}</span>;
        if (effective) return <Text tone="muted" size="sm" as="span">{effective.name} (inherited)</Text>;
        return <Text tone="muted" size="sm" as="span">Uncategorized</Text>;
      },
    },
    {
      key: 'total',
      header: 'Value per currency',
      numeric: true,
      render: ({ account, children }) => {
        if (report.isPending) return <Text tone="muted" size="sm" as="span">…</Text>;
        const node = reportById.get(account.id);
        if (!node) return <Text tone="muted" size="sm" as="span">—</Text>;
        const totals = children.length > 0 ? node.rolledUp : node.own;
        return (
          <Stack gap={1}>
            <CurrencyLines lines={totals.byCurrency.map((t) => ({ currency: t.currency, amount: t.total }))} />
            {children.length > 0 && <Text tone="muted" size="xs" as="span">incl. subaccounts</Text>}
          </Stack>
        );
      },
    },
  ];

  return (
    <>
      {header}
      <Card flush>
        <Table label="Accounts" columns={columns} rows={rows} rowKey={(r) => r.account.id} />
      </Card>
      <UpAccountsSummary />
      {report.isError && <ApiErrorCallout error={report.error} title="Totals are unavailable right now" />}
      {report.data && report.data.warnings.length > 0 && (
        <Callout tone="warning" title="Some holdings are valued at cost">
          <ul>{report.data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </Callout>
      )}
      <Text tone="muted" size="sm">
        Values are cash plus holdings at the latest price ({report.data?.priceProvider === 'mock' ? 'mock prices, not real market data' : `source: ${report.data?.priceProvider ?? '…'}`}), shown separately for each currency.
        A parent's figure includes its subaccounts, so don't add rows together. Personal tracking only, not tax advice.
      </Text>
    </>
  );
}
