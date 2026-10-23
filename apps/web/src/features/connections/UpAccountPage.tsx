import type { UpTransaction } from '@money/client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Amount, Badge, Button, ButtonLink, Card, EmptyState, Loading, Row, Table, Text, type Column } from '../../ui';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { PageHeader } from '../shared/PageHeader';
import { UP_PAGE_SIZE, useUpAccounts, useUpTransactions } from './data';

/** One imported Up account: balance and its imported transactions. Read-only, apart from the ledger. */
export function UpAccountPage() {
  const { upAccountId = '' } = useParams();
  const accounts = useUpAccounts('all');
  const [offset, setOffset] = useState(0);
  const transactions = useUpTransactions(upAccountId, offset);

  if (accounts.isPending) return <Loading label="Loading account…" />;
  if (accounts.isError) return <ApiErrorCallout error={accounts.error} title="Could not load this account" />;
  const account = accounts.data.find((a) => a.id === upAccountId);
  if (!account) {
    return (
      <EmptyState title="Account not found" action={<ButtonLink to="/accounts">Back to accounts</ButtonLink>}>
        It may have been removed, or Up is not connected.
      </EmptyState>
    );
  }

  const columns: Column<UpTransaction>[] = [
    { key: 'date', nowrap: true, header: 'Date', render: (tx) => (tx.settledAt ?? tx.createdAt).slice(0, 10) },
    {
      key: 'what',
      header: 'Details',
      render: (tx) => (
        <span>
          {tx.description}
          {tx.message && <Text tone="muted" size="xs">{tx.message}</Text>}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (tx) => (
        <Row gap={1}>
          <Badge tone={tx.status === 'HELD' ? 'warning' : undefined}>{tx.status === 'HELD' ? 'Held' : 'Settled'}</Badge>
          {tx.reconciliation === 'matched' && <Badge title="Linked to a manual Money transaction">Matched</Badge>}
          {tx.deletedAt && <Badge tone="warning">Deleted at Up</Badge>}
        </Row>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      render: (tx) => (
        <span>
          <Amount value={tx.amount} currency={tx.currency} />
          {tx.foreignAmount && tx.foreignCurrency && <Text tone="muted" size="xs"><Amount value={tx.foreignAmount} currency={tx.foreignCurrency} /></Text>}
        </span>
      ),
    },
  ];

  const page = transactions.data;
  return (
    <>
      <PageHeader
        eyebrow={<nav aria-label="Breadcrumb"><Link to="/accounts">Accounts</Link></nav>}
        title={account.displayName}
        subtitle={
          <Row gap={2} as="span">
            <Badge title="Imported from Up. Not part of your manual records.">Up</Badge>
            <Text tone="muted" size="sm" as="span">{account.accountType.toLowerCase()} · balance <Amount value={account.balance} currency={account.currency} /></Text>
            {!account.visible && <Badge tone="warning">Hidden</Badge>}
            {account.removedAt && <Badge tone="warning">No longer listed by Up</Badge>}
          </Row>
        }
      />
      <Card title="Transactions" flush>
        {transactions.isPending && <Loading label="Loading transactions…" />}
        {transactions.isError && <ApiErrorCallout error={transactions.error} title="Could not load transactions" />}
        {page && page.items.length === 0 && (
          <EmptyState title="No imported transactions">Sync Up from Connections to import them.</EmptyState>
        )}
        {page && page.items.length > 0 && <Table label="Up transactions" columns={columns} rows={page.items} rowKey={(tx) => tx.id} />}
        {page && (offset > 0 || page.nextOffset !== null) && (
          <Row gap={2}>
            <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - UP_PAGE_SIZE))}>Newer</Button>
            <Button size="sm" disabled={page.nextOffset === null} onClick={() => page.nextOffset !== null && setOffset(page.nextOffset)}>Older</Button>
          </Row>
        )}
      </Card>
    </>
  );
}
