import type { Transaction } from '@money/client';
import { useSearchParams } from 'react-router';
import { Link } from 'react-router';
import { Badge, ButtonLink, Card, EmptyState, Loading, Row, SelectField, Table, Text, type Column } from '../../ui';
import { useAccountContext } from '../accounts/AccountLayout';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { CashEffect, TransactionSummary } from './TransactionSummary';
import { TYPE_LABELS, useTransactions, type TransactionType } from './data';

const FILTERS = Object.keys(TYPE_LABELS) as TransactionType[];

/** The account's transactions in ledger order, newest first, filterable by type (filter is in the URL) */
export function AccountTransactions() {
  const { account, accounts } = useAccountContext();
  const [params, setParams] = useSearchParams();
  const type = (FILTERS as string[]).includes(params.get('type') ?? '') ? (params.get('type') as TransactionType) : undefined;
  const transactions = useTransactions(account.id, { type });

  const columns: Column<Transaction>[] = [
    { key: 'date', nowrap: true, header: 'Date', render: (tx) => <Link to={`/accounts/${account.id}/transactions/${tx.id}`}>{tx.date}</Link> },
    { key: 'type', header: 'Type', render: (tx) => <Badge>{TYPE_LABELS[tx.type]}</Badge> },
    {
      key: 'what',
      header: 'Details',
      render: (tx) => (
        <span>
          <TransactionSummary tx={tx} accounts={accounts} />
          {tx.description && (
            <Text tone="muted" size="xs">
              {tx.description}
            </Text>
          )}
        </span>
      ),
    },
    { key: 'cash', header: 'Cash', numeric: true, render: (tx) => <CashEffect tx={tx} /> },
  ];

  const rows = [...(transactions.data ?? [])].reverse();

  return (
    <Card
      title="Transactions"
      flush
      actions={
        <Row gap={2}>
          <SelectField
            label={<span className="visually-hidden">Show</span>}
            value={type ?? ''}
            onChange={(e) => setParams(e.target.value ? { type: e.target.value } : {}, { replace: true })}
          >
            <option value="">All types</option>
            {FILTERS.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </SelectField>
          <ButtonLink to={`/accounts/${account.id}/record`} size="sm" variant="primary">
            Record activity
          </ButtonLink>
        </Row>
      }
    >
      {transactions.isPending && <Loading label="Loading transactions…" />}
      {transactions.isError && <ApiErrorCallout error={transactions.error} title="Could not load transactions" />}
      {transactions.data && rows.length === 0 && (
        <EmptyState title={type ? `No ${TYPE_LABELS[type].toLowerCase()} records` : 'Nothing recorded yet'} action={<ButtonLink to={`/accounts/${account.id}/record`}>Record activity</ButtonLink>}>
          Record deposits, trades, conversions and dividends that already happened.
        </EmptyState>
      )}
      {rows.length > 0 && <Table label="Transactions" columns={columns} rows={rows} rowKey={(tx) => tx.id} />}
    </Card>
  );
}
