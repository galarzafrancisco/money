import type { Account, RecordTransactionRequest, Transaction } from '@money/client';
import { useState } from 'react';
import { DecimalField, Form, Grid, Stack, TextField } from '../../../ui';
import { ApiErrorCallout } from '../../shared/ApiErrorCallout';
import { useRecordTransaction } from '../data';
import { AnyOfHint, anyOfStatus, CalculatedBadge, checks, compact, FormActions, todayIso, type FieldErrors } from './common';

const LABELS = { fromAmount: 'Amount converted', toAmount: 'Amount received', rate: 'Rate' };

/** Records a currency conversion inside the account: any two of the amounts and the rate */
export function FxForm({ account, onRecorded }: { account: Account; onRecorded: (tx: Transaction) => void }) {
  const record = useRecordTransaction(account.id);
  const [f, setF] = useState({ date: todayIso(), fromCurrency: account.reportingCurrency, toCurrency: '', fromAmount: '', toAmount: '', rate: '', fees: '', description: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [key]: e.target.value }));
  const status = anyOfStatus({ fromAmount: f.fromAmount, toAmount: f.toAmount, rate: f.rate }, 2);

  const submit = () => {
    const found: FieldErrors = {};
    const add = (key: string, error: string | null) => error && (found[key] = error);
    add('date', checks.date(f.date));
    add('fromCurrency', checks.currency(f.fromCurrency));
    add('toCurrency', checks.currency(f.toCurrency));
    if (!found.toCurrency && f.fromCurrency.trim().toUpperCase() === f.toCurrency.trim().toUpperCase()) found.toCurrency = 'Choose a different currency from the one converted.';
    for (const key of ['fromAmount', 'toAmount', 'rate', 'fees'] as const) add(key, checks.optionalAmount(f[key]));
    if (!status.enough) found.fromAmount = found.fromAmount ?? 'Enter any two of the amount converted, the amount received and the rate.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    record.mutate(
      compact({
        type: 'FX_CONVERSION',
        date: f.date,
        fromCurrency: f.fromCurrency.trim().toUpperCase(),
        toCurrency: f.toCurrency.trim().toUpperCase(),
        fromAmount: f.fromAmount.trim(),
        toAmount: f.toAmount.trim(),
        rate: f.rate.trim(),
        fees: f.fees.trim(),
        description: f.description.trim(),
      }) as RecordTransactionRequest,
      { onSuccess: onRecorded },
    );
  };

  const from = f.fromCurrency.toUpperCase() || 'from';
  const to = f.toCurrency.toUpperCase() || 'to';
  return (
    <Form onSubmit={submit} label="Record a currency conversion">
      <Stack>
        <Grid size="narrow">
          <TextField label="Date" type="date" value={f.date} onChange={set('date')} error={errors.date} />
          <TextField label="From currency" value={f.fromCurrency} onChange={set('fromCurrency')} error={errors.fromCurrency} maxLength={3} />
          <TextField label="To currency" value={f.toCurrency} onChange={set('toCurrency')} error={errors.toCurrency} maxLength={3} />
        </Grid>
        <AnyOfHint labels={LABELS} need={2} status={status} />
        <Grid size="narrow">
          <DecimalField label={`Amount converted (${from})`} value={f.fromAmount} onChange={set('fromAmount')} error={errors.fromAmount} badge={<CalculatedBadge show={status.calculated === 'fromAmount'} />} hint="Excluding fees." />
          <DecimalField label={`Amount received (${to})`} value={f.toAmount} onChange={set('toAmount')} error={errors.toAmount} badge={<CalculatedBadge show={status.calculated === 'toAmount'} />} />
          <DecimalField label={`Rate (${to} per ${from})`} value={f.rate} onChange={set('rate')} error={errors.rate} badge={<CalculatedBadge show={status.calculated === 'rate'} />} />
          <DecimalField label={`Fees (${from})`} value={f.fees} onChange={set('fees')} error={errors.fees} hint="Charged on top of the amount converted. Default 0." />
        </Grid>
        <TextField label="Note" value={f.description} onChange={set('description')} />
        <ApiErrorCallout error={record.error} />
        <FormActions pending={record.isPending} label="Record conversion" />
      </Stack>
    </Form>
  );
}
