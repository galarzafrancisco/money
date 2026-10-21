import type { Account, RecordTransactionRequest, Transaction } from '@money/client';
import { useState } from 'react';
import { DecimalField, Form, Grid, Stack, TextField } from '../../../ui';
import { ApiErrorCallout } from '../../shared/ApiErrorCallout';
import { useRecordTransaction } from '../data';
import { AnyOfHint, anyOfStatus, CalculatedBadge, checks, compact, FormActions, todayIso, type FieldErrors } from './common';

const LABELS = { grossAmount: 'Gross dividend', withholdingTax: 'Tax withheld', netAmount: 'Net received' };

/** Records a dividend: any two of gross, tax withheld and net, plus optional franking credits */
export function DividendForm({ account, onRecorded, defaultSymbol = '' }: { account: Account; onRecorded: (tx: Transaction) => void; defaultSymbol?: string }) {
  const record = useRecordTransaction(account.id);
  const [f, setF] = useState({ date: todayIso(), symbol: defaultSymbol, currency: account.reportingCurrency, grossAmount: '', withholdingTax: '', netAmount: '', frankingCredits: '', description: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [key]: e.target.value }));
  const status = anyOfStatus({ grossAmount: f.grossAmount, withholdingTax: f.withholdingTax, netAmount: f.netAmount }, 2);

  const submit = () => {
    const found: FieldErrors = {};
    const add = (key: string, error: string | null) => error && (found[key] = error);
    add('date', checks.date(f.date));
    add('symbol', checks.symbol(f.symbol));
    add('currency', checks.currency(f.currency));
    for (const key of ['grossAmount', 'withholdingTax', 'netAmount', 'frankingCredits'] as const) add(key, checks.optionalAmount(f[key]));
    if (!status.enough) found.grossAmount = found.grossAmount ?? 'Enter any two of gross, tax withheld and net. Use 0 for tax withheld when none was.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    record.mutate(
      compact({
        type: 'DIVIDEND',
        date: f.date,
        symbol: f.symbol.trim().toUpperCase(),
        currency: f.currency.trim().toUpperCase(),
        grossAmount: f.grossAmount.trim(),
        withholdingTax: f.withholdingTax.trim(),
        netAmount: f.netAmount.trim(),
        frankingCredits: f.frankingCredits.trim(),
        description: f.description.trim(),
      }) as RecordTransactionRequest,
      { onSuccess: onRecorded },
    );
  };

  return (
    <Form onSubmit={submit} label="Record a dividend">
      <Stack>
        <Grid size="narrow">
          <TextField label="Payment date" type="date" value={f.date} onChange={set('date')} error={errors.date} />
          <TextField label="Symbol" value={f.symbol} onChange={set('symbol')} error={errors.symbol} hint="e.g. VAS.AX" autoCapitalize="characters" />
          <TextField label="Currency" value={f.currency} onChange={set('currency')} error={errors.currency} maxLength={3} hint="The currency it was paid in." />
        </Grid>
        <AnyOfHint labels={LABELS} need={2} status={status} />
        <Grid size="narrow">
          <DecimalField label="Gross dividend" value={f.grossAmount} onChange={set('grossAmount')} error={errors.grossAmount} badge={<CalculatedBadge show={status.calculated === 'grossAmount'} />} />
          <DecimalField label="Tax withheld" value={f.withholdingTax} onChange={set('withholdingTax')} error={errors.withholdingTax} badge={<CalculatedBadge show={status.calculated === 'withholdingTax'} />} hint="e.g. US withholding. Use 0 if none." />
          <DecimalField label="Net received" value={f.netAmount} onChange={set('netAmount')} error={errors.netAmount} badge={<CalculatedBadge show={status.calculated === 'netAmount'} />} hint="Cash credited to the account." />
          <DecimalField label="Franking credits" value={f.frankingCredits} onChange={set('frankingCredits')} error={errors.frankingCredits} hint="Optional. Not cash; recorded as stated on the statement." />
        </Grid>
        <TextField label="Note" value={f.description} onChange={set('description')} />
        <ApiErrorCallout error={record.error} />
        <FormActions pending={record.isPending} label="Record dividend" />
      </Stack>
    </Form>
  );
}
