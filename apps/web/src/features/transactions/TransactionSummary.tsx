import type { Account, Transaction } from '@money/client';
import { Link } from 'react-router';
import { Amount, Badge, Row, Text } from '../../ui';
import { FIELD_LABELS } from './data';

/** One-line description of a transaction, using only the values the backend returned */
export function TransactionSummary({ tx, accounts }: { tx: Transaction; accounts: Account[] }) {
  const other = tx.counterpartyAccountId ? accounts.find((a) => a.id === tx.counterpartyAccountId) : undefined;
  switch (tx.type) {
    case 'DEPOSIT':
    case 'WITHDRAWAL':
      return (
        <span>
          {tx.type === 'DEPOSIT' ? 'Deposited' : 'Withdrew'} <Amount value={tx.amount} currency={tx.currency} />
          {tx.externalAmount && (
            <Text tone="muted" size="xs" as="span">
              {' '}(other side <Amount value={tx.externalAmount} currency={tx.externalCurrency} />)
            </Text>
          )}
        </span>
      );
    case 'GAIN_LOSS':
      return (
        <span>
          {tx.amount?.startsWith('-') ? 'Loss of' : 'Gain of'} <Amount value={tx.amount?.replace(/^-/, '')} currency={tx.currency} />
        </span>
      );
    case 'FX_CONVERSION':
      return (
        <span>
          <Amount value={tx.fromAmount} currency={tx.fromCurrency} /> → <Amount value={tx.toAmount} currency={tx.toCurrency} />{' '}
          <Text tone="muted" size="xs" as="span">at <Amount value={tx.rate} kind="rate" /></Text>
        </span>
      );
    case 'BUY':
    case 'SELL':
      return (
        <span>
          {tx.type === 'BUY' ? 'Bought' : 'Sold'} <Amount value={tx.quantity} kind="quantity" /> <Text strong as="span">{tx.symbol}</Text> at{' '}
          <Amount value={tx.unitPrice} currency={tx.currency} kind="rate" />
          {tx.type === 'SELL' && (
            <>
              {' '}
              <Badge tone={tx.lotSelection === 'SPECIFIC' ? 'accent' : 'neutral'}>{tx.lotSelection === 'SPECIFIC' ? 'Chosen lots' : 'FIFO'}</Badge>
            </>
          )}
        </span>
      );
    case 'DIVIDEND':
      return (
        <span>
          <Text strong as="span">{tx.symbol}</Text> dividend, gross <Amount value={tx.grossAmount} currency={tx.currency} />
          {tx.withholdingTax && tx.withholdingTax !== '0' && (
            <Text tone="muted" size="xs" as="span">, <Amount value={tx.withholdingTax} currency={tx.currency} /> withheld</Text>
          )}
        </span>
      );
    case 'TRANSFER_OUT':
    case 'TRANSFER_IN':
      return (
        <span>
          {tx.type === 'TRANSFER_OUT' ? 'Transfer to ' : 'Transfer from '}
          {other ? <Link to={`/accounts/${other.id}`}>{other.name}</Link> : 'another account'}
        </span>
      );
  }
}

/** The transaction's effect on the account's cash, as a signed display of the backend's figure */
export function CashEffect({ tx }: { tx: Transaction }) {
  const out = (value: string | null | undefined, currency: string | null | undefined) => (value ? <Amount value={`-${value}`} currency={currency} signed /> : <Amount value={null} />);
  const inn = (value: string | null | undefined, currency: string | null | undefined) => <Amount value={value} currency={currency} signed />;
  switch (tx.type) {
    case 'DEPOSIT':
    case 'GAIN_LOSS':
    case 'TRANSFER_IN':
      return inn(tx.amount, tx.currency);
    case 'WITHDRAWAL':
      return out(tx.amount, tx.currency);
    case 'TRANSFER_OUT':
      return (
        <span>
          {out(tx.amount, tx.currency)}
          {tx.fees && tx.fees !== '0' && (
            <Text tone="muted" size="xs" as="span">
              {' '}+ <Amount value={tx.fees} currency={tx.currency} /> fees
            </Text>
          )}
        </span>
      );
    case 'BUY':
      return out(tx.total, tx.currency);
    case 'SELL':
      return inn(tx.total, tx.currency);
    case 'DIVIDEND':
      return inn(tx.netAmount, tx.currency);
    case 'FX_CONVERSION':
      return <Text tone="muted" size="sm" as="span">between currencies</Text>;
  }
}

/** The figure Money worked out from the others, with its unit */
export function CalculatedValue({ tx }: { tx: Transaction }) {
  const field = tx.calculatedField;
  if (!field) return null;
  const value = tx[field as keyof Transaction] as string | null | undefined;
  const currency = field === 'fromAmount' ? tx.fromCurrency : field === 'toAmount' ? tx.toCurrency : field === 'quantity' || field === 'rate' ? null : tx.currency;
  const kind = field === 'quantity' ? 'quantity' : field === 'rate' || field === 'unitPrice' ? 'rate' : 'money';
  return (
    <Row gap={2}>
      <Badge tone="accent">calculated</Badge>
      <Text size="sm" as="span">
        {FIELD_LABELS[field] ?? field}: <Amount value={value} currency={currency} kind={kind} />
      </Text>
    </Row>
  );
}
