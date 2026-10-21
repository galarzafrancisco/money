import type { Transaction } from '@money/client';
import { moneyErrorOf } from '@money/client';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Amount, Badge, Button, ButtonLink, Callout, Card, DescriptionList, EmptyState, Loading, Row, Stack, Text } from '../../ui';
import { useAccountContext } from '../accounts/AccountLayout';
import { ApiErrorCallout, errorCode } from '../shared/ApiErrorCallout';
import { SaleAllocationsTable } from './SaleAllocationsTable';
import { FIELD_LABELS, TYPE_LABELS, useDeleteTransaction, useSaleAllocations, useTransaction } from './data';

type Item = { term: ReactNode; detail: ReactNode; key: string };

function amountItems(tx: Transaction): Item[] {
  const calc = (field: string) => (tx.calculatedField === field ? <Badge tone="accent" title="Money worked this out from the other values">calculated</Badge> : null);
  const money = (field: keyof Transaction, currency: string | null | undefined, kind: 'money' | 'quantity' | 'rate' = 'money'): Item => ({
    key: field,
    term: FIELD_LABELS[field] ?? field,
    detail: (
      <Row gap={2} as="span">
        <Amount value={tx[field] as string | null | undefined} currency={currency} kind={kind} />
        {calc(field)}
      </Row>
    ),
  });
  switch (tx.type) {
    case 'DEPOSIT':
    case 'WITHDRAWAL':
      return [money('amount', tx.currency), ...(tx.externalAmount ? [{ key: 'ext', term: 'Other side', detail: <Amount value={tx.externalAmount} currency={tx.externalCurrency} /> }] : [])];
    case 'FX_CONVERSION':
      return [money('fromAmount', tx.fromCurrency), money('toAmount', tx.toCurrency), money('rate', null, 'rate'), money('fees', tx.fromCurrency)];
    case 'BUY':
    case 'SELL':
      return [
        { key: 'symbol', term: 'Symbol', detail: tx.symbol },
        money('quantity', null, 'quantity'),
        money('unitPrice', tx.currency, 'rate'),
        money('fees', tx.currency),
        money('total', tx.currency),
      ];
    case 'DIVIDEND':
      return [
        { key: 'symbol', term: 'Symbol', detail: tx.symbol },
        money('grossAmount', tx.currency),
        money('withholdingTax', tx.currency),
        money('netAmount', tx.currency),
        { key: 'franking', term: 'Franking credits', detail: <Amount value={tx.frankingCredits} currency={tx.currency} /> },
      ];
    case 'TRANSFER_OUT':
    case 'TRANSFER_IN':
      return [money('amount', tx.currency), ...(tx.type === 'TRANSFER_OUT' ? [money('fees', tx.currency)] : [])];
  }
}

/** One recorded transaction: its figures, how a sale used lots, and deletion */
export function TransactionDetail() {
  const { account, accounts } = useAccountContext();
  const { transactionId = '' } = useParams();
  const navigate = useNavigate();
  const transaction = useTransaction(transactionId);
  const isSell = transaction.data?.type === 'SELL';
  const allocations = useSaleAllocations(isSell ? transactionId : null);
  const remove = useDeleteTransaction(account.id);
  const [confirming, setConfirming] = useState(false);

  if (transaction.isPending) return <Loading />;
  if (transaction.isError) {
    if (errorCode(transaction.error) === 'not_found') return <EmptyState title="Transaction not found" action={<ButtonLink to={`/accounts/${account.id}/transactions`}>Back to transactions</ButtonLink>} />;
    return <ApiErrorCallout error={transaction.error} />;
  }
  const tx = transaction.data;
  const isLeg = tx.type === 'TRANSFER_OUT' || tx.type === 'TRANSFER_IN';
  const other = tx.counterpartyAccountId ? accounts.find((a) => a.id === tx.counterpartyAccountId) : undefined;
  const dependentSales = (moneyErrorOf(remove.error)?.details?.saleTransactionIds as string[] | undefined) ?? [];

  return (
    <Stack gap={5}>
      <Card title={`${TYPE_LABELS[tx.type]} on ${tx.date}`} actions={<ButtonLink to={`/accounts/${account.id}/transactions`} size="sm" variant="ghost">All transactions</ButtonLink>}>
        <Stack>
          <DescriptionList
            items={[
              { key: 'date', term: 'Date', detail: tx.date },
              ...amountItems(tx),
              ...(isLeg ? [{ key: 'other', term: tx.type === 'TRANSFER_OUT' ? 'To' : 'From', detail: other ? <Link to={`/accounts/${other.id}/transfers`}>{other.name}</Link> : 'Another account' }] : []),
              { key: 'description', term: 'Note', detail: tx.description ?? '—' },
              { key: 'recorded', term: 'Recorded', detail: <Text size="sm" tone="muted" as="span">{tx.createdAt.slice(0, 16).replace('T', ' ')} UTC</Text> },
            ]}
          />
          {isLeg ? (
            <Text tone="muted" size="sm">
              This is one side of a transfer. Change or delete it from the account&apos;s Transfers section.
            </Text>
          ) : confirming ? (
            <Callout tone="warning" title="Delete this record?">
              <Stack gap={3}>
                <Text size="sm">Balances, lots and gains are recalculated without it. This does not undo anything outside Money.</Text>
                <Row gap={2}>
                  <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(tx.id, { onSuccess: () => navigate(`/accounts/${account.id}/transactions`) })}>
                    {remove.isPending ? 'Deleting…' : 'Delete'}
                  </Button>
                  <Button onClick={() => { setConfirming(false); remove.reset(); }}>Cancel</Button>
                </Row>
              </Stack>
            </Callout>
          ) : (
            <div>
              <Button variant="ghost" onClick={() => setConfirming(true)}>Delete record</Button>
            </div>
          )}
          <ApiErrorCallout error={remove.error} title="Could not delete">
            {dependentSales.length > 0 && (
              <ul>
                {dependentSales.map((id) => (
                  <li key={id}>
                    <Link to={`/accounts/${account.id}/transactions/${id}`}>Sale using this purchase</Link>
                  </li>
                ))}
              </ul>
            )}
          </ApiErrorCallout>
        </Stack>
      </Card>
      {isSell && (
        <Card title="Lots sold">
          {allocations.isPending && <Loading />}
          {allocations.isError && <ApiErrorCallout error={allocations.error} />}
          {allocations.data && <SaleAllocationsTable data={allocations.data} />}
        </Card>
      )}
    </Stack>
  );
}
