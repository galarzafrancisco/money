import type { Transaction, Transfer } from '@money/client';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Amount, Button, ButtonLink, Callout, Card, DescriptionList, Loading, Row, SegmentedControl, Stack } from '../../ui';
import { useAccountContext } from '../accounts/AccountLayout';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { TransferForm } from '../transfers/TransferForm';
import { CashForm } from './forms/CashForm';
import { DividendForm } from './forms/DividendForm';
import { FxForm } from './forms/FxForm';
import { RecordingNote } from './forms/common';
import { TradeForm } from './forms/TradeForm';
import { SaleAllocationsTable } from './SaleAllocationsTable';
import { CalculatedValue, TransactionSummary } from './TransactionSummary';
import { TYPE_LABELS, useSaleAllocations } from './data';

const KINDS = ['DEPOSIT', 'WITHDRAWAL', 'FX_CONVERSION', 'BUY', 'SELL', 'DIVIDEND', 'TRANSFER'] as const;
type Kind = (typeof KINDS)[number];
const KIND_LABELS: Record<Kind, string> = { ...TYPE_LABELS, TRANSFER: 'Transfer' } as Record<Kind, string>;

type Recorded = { kind: 'transaction'; tx: Transaction } | { kind: 'transfer'; transfer: Transfer };

/** Record something that already happened in this account (the kind is in the URL: ?type=BUY) */
export function RecordActivityPage() {
  const { account, accounts } = useAccountContext();
  const [params, setParams] = useSearchParams();
  const requested = params.get('type') as Kind | null;
  const kind: Kind = requested && (KINDS as readonly string[]).includes(requested) ? requested : 'DEPOSIT';
  const symbol = params.get('symbol') ?? '';
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [formKey, setFormKey] = useState(0);

  const choose = (next: Kind) => {
    setRecorded(null);
    setParams({ type: next }, { replace: true });
  };
  const again = () => {
    setRecorded(null);
    setFormKey((k) => k + 1);
  };
  const onTransaction = (tx: Transaction) => setRecorded({ kind: 'transaction', tx });

  return (
    <Stack gap={5}>
      <Card title="Record activity">
        <Stack>
          <SegmentedControl legend="What happened?" name="activity-kind" value={kind} onChange={choose} options={KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))} />
          <RecordingNote />
          {recorded ? (
            <RecordedResult recorded={recorded} accountId={account.id} onAgain={again} accounts={accounts} />
          ) : (
            <div key={`${kind}-${formKey}`}>
              {(kind === 'DEPOSIT' || kind === 'WITHDRAWAL') && <CashForm account={account} type={kind} onRecorded={onTransaction} />}
              {kind === 'FX_CONVERSION' && <FxForm account={account} onRecorded={onTransaction} />}
              {(kind === 'BUY' || kind === 'SELL') && <TradeForm account={account} side={kind} onRecorded={onTransaction} defaultSymbol={symbol} />}
              {kind === 'DIVIDEND' && <DividendForm account={account} onRecorded={onTransaction} defaultSymbol={symbol} />}
              {kind === 'TRANSFER' && <TransferForm account={account} accounts={accounts} onRecorded={(transfer) => setRecorded({ kind: 'transfer', transfer })} />}
            </div>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}

/** What was saved, including the figure Money calculated and, for a sale, how it used lots */
function RecordedResult({ recorded, accountId, onAgain, accounts }: { recorded: Recorded; accountId: string; onAgain: () => void; accounts: ReturnType<typeof useAccountContext>['accounts'] }) {
  const sale = recorded.kind === 'transaction' && recorded.tx.type === 'SELL' ? recorded.tx.id : null;
  const allocations = useSaleAllocations(sale);
  return (
    <Stack>
      <Callout tone="success" title="Recorded">
        {recorded.kind === 'transaction' ? (
          <Stack gap={2}>
            <TransactionSummary tx={recorded.tx} accounts={accounts} />
            <CalculatedValue tx={recorded.tx} />
          </Stack>
        ) : (
          <DescriptionList
            items={[
              { term: 'Sent', detail: <Amount value={recorded.transfer.fromAmount} currency={recorded.transfer.fromCurrency} /> },
              { term: 'Received', detail: <Amount value={recorded.transfer.toAmount} currency={recorded.transfer.toCurrency} /> },
              ...(recorded.transfer.isFx ? [{ term: 'Rate', detail: <Amount value={recorded.transfer.rate} kind="rate" /> }] : []),
              { term: 'Fees', detail: <Amount value={recorded.transfer.fees} currency={recorded.transfer.fromCurrency} /> },
            ]}
          />
        )}
      </Callout>
      {sale && (
        <>
          {allocations.isPending && <Loading label="Loading how the sale used lots…" />}
          {allocations.isError && <ApiErrorCallout error={allocations.error} />}
          {allocations.data && <SaleAllocationsTable data={allocations.data} />}
        </>
      )}
      <Row gap={2}>
        <Button variant="primary" onClick={onAgain}>
          Record another
        </Button>
        <ButtonLink to={recorded.kind === 'transfer' ? `/accounts/${accountId}/transfers` : `/accounts/${accountId}/transactions`}>View history</ButtonLink>
        <ButtonLink to={`/accounts/${accountId}`} variant="ghost">
          Back to overview
        </ButtonLink>
      </Row>
    </Stack>
  );
}
