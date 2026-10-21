import type { Transfer } from '@money/client';
import { useState } from 'react';
import { Link } from 'react-router';
import { Amount, Badge, Button, ButtonLink, Card, EmptyState, Loading, Row, Stack, Table, Text, type Column } from '../../ui';
import { useAccountContext } from '../accounts/AccountLayout';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { useDeleteTransfer, useTransfers } from '../transactions/data';

/** Transfers into or out of this account, with both sides' amounts as recorded */
export function AccountTransfers() {
  const { account, accounts } = useAccountContext();
  const transfers = useTransfers(account.id);
  const remove = useDeleteTransfer();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const name = (id: string) => accounts.find((a) => a.id === id);

  const columns: Column<Transfer>[] = [
    { key: 'date', nowrap: true, header: 'Date', render: (t) => t.date },
    {
      key: 'direction',
      header: 'Between',
      render: (t) => {
        const outgoing = t.fromAccountId === account.id;
        const other = name(outgoing ? t.toAccountId : t.fromAccountId);
        return (
          <span>
            <Badge tone={outgoing ? 'neutral' : 'success'}>{outgoing ? 'Out to' : 'In from'}</Badge>{' '}
            {other ? <Link to={`/accounts/${other.id}`}>{other.name}</Link> : 'another account'}
            {t.description && <Text tone="muted" size="xs">{t.description}</Text>}
          </span>
        );
      },
    },
    {
      key: 'amounts',
      header: 'Amounts',
      numeric: true,
      render: (t) => (
        <Stack gap={1}>
          <span><Amount value={t.fromAmount} currency={t.fromCurrency} /> → <Amount value={t.toAmount} currency={t.toCurrency} /></span>
          {t.isFx && <Text tone="muted" size="xs" as="span">rate <Amount value={t.rate} kind="rate" /></Text>}
          {t.fees !== '0' && <Text tone="muted" size="xs" as="span">fees <Amount value={t.fees} currency={t.fromCurrency} /></Text>}
        </Stack>
      ),
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      render: (t) =>
        confirmId === t.id ? (
          <Row gap={1}>
            <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => remove.mutate({ transferId: t.id, accountIds: [t.fromAccountId, t.toAccountId] }, { onSuccess: () => setConfirmId(null) })}>
              Confirm delete
            </Button>
            <Button size="sm" onClick={() => setConfirmId(null)}>Cancel</Button>
          </Row>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => { remove.reset(); setConfirmId(t.id); }}>
            Delete
          </Button>
        ),
    },
  ];

  return (
    <Card title="Transfers" flush actions={<ButtonLink to={`/accounts/${account.id}/record?type=TRANSFER`} size="sm" variant="primary">Record transfer</ButtonLink>}>
      {transfers.isPending && <Loading />}
      {transfers.isError && <ApiErrorCallout error={transfers.error} />}
      <ApiErrorCallout error={remove.error} title="Could not delete the transfer" />
      {transfers.data && transfers.data.length === 0 && (
        <EmptyState title="No transfers">Record money that moved between two of your accounts, including subaccounts.</EmptyState>
      )}
      {transfers.data && transfers.data.length > 0 && <Table label="Transfers" columns={columns} rows={[...transfers.data].reverse()} rowKey={(t) => t.id} />}
    </Card>
  );
}
