import type { Account, RecordTransactionRequest, Transaction } from '@money/client';
import { useState } from 'react';
import { DecimalField, Fieldset, Form, Grid, Stack, TextField } from '../../../ui';
import { ApiErrorCallout } from '../../shared/ApiErrorCallout';
import { useRecordTransaction } from '../data';
import { checks, compact, FormActions, todayIso, type FieldErrors } from './common';

/** Records a deposit or a withdrawal that already happened */
export function CashForm({ account, type, onRecorded }: { account: Account; type: 'DEPOSIT' | 'WITHDRAWAL'; onRecorded: (tx: Transaction) => void }) {
  const record = useRecordTransaction(account.id);
  const [f, setF] = useState({ date: todayIso(), currency: account.reportingCurrency, amount: '', externalCurrency: '', externalAmount: '', description: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [key]: e.target.value }));

  const submit = () => {
    const found: FieldErrors = {};
    const add = (key: string, error: string | null) => error && (found[key] = error);
    add('date', checks.date(f.date));
    add('currency', checks.currency(f.currency));
    add('amount', checks.requiredAmount(f.amount));
    add('externalAmount', checks.optionalAmount(f.externalAmount));
    if (Boolean(f.externalCurrency.trim()) !== Boolean(f.externalAmount.trim())) found.externalAmount = 'Give both the other currency and amount, or neither.';
    else if (f.externalCurrency.trim()) add('externalCurrency', checks.currency(f.externalCurrency));
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = compact({
      type,
      date: f.date,
      currency: f.currency.trim().toUpperCase(),
      amount: f.amount.trim(),
      externalCurrency: f.externalCurrency.trim().toUpperCase(),
      externalAmount: f.externalAmount.trim(),
      description: f.description.trim(),
    }) as RecordTransactionRequest;
    record.mutate(body, { onSuccess: onRecorded });
  };

  const verb = type === 'DEPOSIT' ? 'credited to' : 'debited from';
  return (
    <Form onSubmit={submit} label={type === 'DEPOSIT' ? 'Record a deposit' : 'Record a withdrawal'}>
      <Stack>
        <Grid size="narrow">
          <TextField label="Date" type="date" value={f.date} onChange={set('date')} error={errors.date} />
          <TextField label="Currency" value={f.currency} onChange={set('currency')} error={errors.currency} maxLength={3} />
          <DecimalField label="Amount" value={f.amount} onChange={set('amount')} error={errors.amount} hint={`The amount ${verb} this account.`} />
        </Grid>
        <Fieldset legend="Other side (optional)">
          <Grid size="narrow">
            <TextField label="Other-side currency" value={f.externalCurrency} onChange={set('externalCurrency')} error={errors.externalCurrency} maxLength={3} hint="e.g. AUD that left your bank for a USD deposit." />
            <DecimalField label="Other-side amount" value={f.externalAmount} onChange={set('externalAmount')} error={errors.externalAmount} hint="Informational; it does not change balances." />
          </Grid>
        </Fieldset>
        <TextField label="Note" value={f.description} onChange={set('description')} hint="Optional, e.g. the bank reference." />
        <ApiErrorCallout error={record.error} />
        <FormActions pending={record.isPending} label={type === 'DEPOSIT' ? 'Record deposit' : 'Record withdrawal'} />
      </Stack>
    </Form>
  );
}
