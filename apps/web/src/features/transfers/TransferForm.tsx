import type { Account, RecordTransferRequest, Transfer } from '@money/client';
import { useState } from 'react';
import { DecimalField, EmptyState, Form, Grid, SegmentedControl, SelectField, Stack, TextField, ButtonLink } from '../../ui';
import { accountTree, flattenTree } from '../accounts/data';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { useRecordTransfer } from '../transactions/data';
import { AnyOfHint, anyOfStatus, CalculatedBadge, checks, compact, FormActions, todayIso, type FieldErrors } from '../transactions/forms/common';

const LABELS = { fromAmount: 'Amount sent', toAmount: 'Amount received', rate: 'Rate' };

/** Records money that moved between two of the user's own accounts (both ledgers change together) */
export function TransferForm({ account, accounts, onRecorded }: { account: Account; accounts: Account[]; onRecorded: (transfer: Transfer) => void }) {
  const record = useRecordTransfer();
  const others = flattenTree(accountTree(accounts)).filter((n) => n.account.id !== account.id);
  const [direction, setDirection] = useState<'OUT' | 'IN'>('OUT');
  const [f, setF] = useState({ otherAccountId: '', date: todayIso(), fromCurrency: account.reportingCurrency, toCurrency: account.reportingCurrency, fromAmount: '', toAmount: '', rate: '', fees: '', description: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [key]: e.target.value }));
  const isFx = f.fromCurrency.trim().toUpperCase() !== f.toCurrency.trim().toUpperCase();
  const status = anyOfStatus({ fromAmount: f.fromAmount, toAmount: f.toAmount, rate: f.rate }, 2);

  if (others.length === 0) {
    return (
      <EmptyState title="You need a second account" action={<ButtonLink to={`/accounts/new?parent=${account.id}`}>Create a subaccount</ButtonLink>}>
        A transfer moves money between two of your accounts, such as into a savings bucket.
      </EmptyState>
    );
  }

  const submit = () => {
    const found: FieldErrors = {};
    const add = (key: string, error: string | null) => error && (found[key] = error);
    if (!f.otherAccountId) found.otherAccountId = 'Choose the other account.';
    add('date', checks.date(f.date));
    add('fromCurrency', checks.currency(f.fromCurrency));
    add('toCurrency', checks.currency(f.toCurrency));
    add('fees', checks.optionalAmount(f.fees));
    if (isFx) {
      for (const key of ['fromAmount', 'toAmount', 'rate'] as const) add(key, checks.optionalAmount(f[key]));
      if (!status.enough) found.fromAmount = found.fromAmount ?? 'Enter any two of the amount sent, the amount received and the rate.';
    } else {
      add('fromAmount', checks.requiredAmount(f.fromAmount));
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const [fromAccountId, toAccountId] = direction === 'OUT' ? [account.id, f.otherAccountId] : [f.otherAccountId, account.id];
    record.mutate(
      compact({
        fromAccountId,
        toAccountId,
        date: f.date,
        fromCurrency: f.fromCurrency.trim().toUpperCase(),
        toCurrency: f.toCurrency.trim().toUpperCase(),
        fromAmount: f.fromAmount.trim(),
        toAmount: isFx ? f.toAmount.trim() : '',
        rate: isFx ? f.rate.trim() : '',
        fees: f.fees.trim(),
        description: f.description.trim(),
      }) as RecordTransferRequest,
      { onSuccess: onRecorded },
    );
  };

  const from = f.fromCurrency.toUpperCase();
  const to = f.toCurrency.toUpperCase();
  return (
    <Form onSubmit={submit} label="Record a transfer">
      <Stack>
        <SegmentedControl
          legend="Direction"
          name="transfer-direction"
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'OUT', label: `Out of ${account.name}` },
            { value: 'IN', label: `Into ${account.name}` },
          ]}
        />
        <SelectField label={direction === 'OUT' ? 'To account' : 'From account'} value={f.otherAccountId} onChange={set('otherAccountId')} error={errors.otherAccountId}>
          <option value="">Choose an account</option>
          {others.map((n) => (
            <option key={n.account.id} value={n.account.id}>
              {'— '.repeat(n.level)}
              {n.account.name}
            </option>
          ))}
        </SelectField>
        <Grid size="narrow">
          <TextField label="Date" type="date" value={f.date} onChange={set('date')} error={errors.date} />
          <TextField label="Currency sent" value={f.fromCurrency} onChange={set('fromCurrency')} error={errors.fromCurrency} maxLength={3} />
          <TextField label="Currency received" value={f.toCurrency} onChange={set('toCurrency')} error={errors.toCurrency} maxLength={3} hint="Different from the currency sent if it was converted on the way." />
        </Grid>
        {isFx && <AnyOfHint labels={LABELS} need={2} status={status} />}
        <Grid size="narrow">
          <DecimalField label={`Amount sent (${from})`} value={f.fromAmount} onChange={set('fromAmount')} error={errors.fromAmount} badge={<CalculatedBadge show={isFx && status.calculated === 'fromAmount'} />} hint="Excluding fees." />
          {isFx && (
            <>
              <DecimalField label={`Amount received (${to})`} value={f.toAmount} onChange={set('toAmount')} error={errors.toAmount} badge={<CalculatedBadge show={status.calculated === 'toAmount'} />} />
              <DecimalField label={`Rate (${to} per ${from})`} value={f.rate} onChange={set('rate')} error={errors.rate} badge={<CalculatedBadge show={status.calculated === 'rate'} />} />
            </>
          )}
          <DecimalField label={`Fees (${from})`} value={f.fees} onChange={set('fees')} error={errors.fees} hint="Charged to the sending account on top of the amount. Default 0." />
        </Grid>
        <TextField label="Note" value={f.description} onChange={set('description')} />
        <ApiErrorCallout error={record.error} />
        <FormActions pending={record.isPending} label="Record transfer" />
      </Stack>
    </Form>
  );
}
