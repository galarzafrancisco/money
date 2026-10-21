import type { Account, RecordTransactionRequest, Transaction } from '@money/client';
import { useState } from 'react';
import { DecimalField, Form, Grid, SegmentedControl, Stack, Text, TextField } from '../../../ui';
import { ApiErrorCallout, errorCode } from '../../shared/ApiErrorCallout';
import { useLots, useRecordTransaction } from '../data';
import { AnyOfHint, anyOfStatus, CalculatedBadge, checks, compact, FormActions, todayIso, type FieldErrors } from './common';
import { allocationsFrom, checkLotChoice, LotPicker, type LotChoice } from './LotPicker';

const LABELS = { quantity: 'Quantity', unitPrice: 'Price per share', fees: 'Fees', total: 'Total' };

/**
 * Records a share buy or sell that already happened at a broker. Any three
 * of quantity, price, fees and total; Money calculates the fourth. A sale
 * takes lots FIFO unless the user chooses lots.
 */
export function TradeForm({ account, side, onRecorded, defaultSymbol = '' }: { account: Account; side: 'BUY' | 'SELL'; onRecorded: (tx: Transaction) => void; defaultSymbol?: string }) {
  const record = useRecordTransaction(account.id);
  const [f, setF] = useState({ date: todayIso(), symbol: defaultSymbol, currency: account.reportingCurrency, quantity: '', unitPrice: '', fees: '', total: '', description: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [mode, setMode] = useState<'FIFO' | 'SPECIFIC'>('FIFO');
  const [choice, setChoice] = useState<LotChoice>({});
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [key]: e.target.value }));
  const status = anyOfStatus({ quantity: f.quantity, unitPrice: f.unitPrice, fees: f.fees, total: f.total }, 3);

  const symbol = f.symbol.trim().toUpperCase();
  const lotsWanted = side === 'SELL' && mode === 'SPECIFIC' && !checks.symbol(symbol) && !checks.date(f.date);
  const lots = useLots(account.id, { symbol, asOf: f.date, enabled: lotsWanted });
  const openLots = lots.data?.lots.filter((l) => l.status === 'OPEN');

  const submit = () => {
    const found: FieldErrors = {};
    const add = (key: string, error: string | null) => error && (found[key] = error);
    add('date', checks.date(f.date));
    add('symbol', checks.symbol(f.symbol));
    add('currency', checks.currency(f.currency));
    for (const key of ['quantity', 'unitPrice', 'fees', 'total'] as const) add(key, checks.optionalAmount(f[key]));
    if (!status.enough) found.quantity = found.quantity ?? 'Enter at least three of quantity, price, fees and total.';
    if (side === 'SELL' && mode === 'SPECIFIC') {
      if (!f.quantity.trim()) found.quantity = 'Enter the quantity sold to choose lots.';
      else if (!openLots || !checkLotChoice(openLots, choice, f.quantity).matches) found.lots = 'The shares chosen from lots must add up to the quantity sold.';
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = compact({
      type: side,
      date: f.date,
      symbol,
      currency: f.currency.trim().toUpperCase(),
      quantity: f.quantity.trim(),
      unitPrice: f.unitPrice.trim(),
      fees: f.fees.trim(),
      total: f.total.trim(),
      description: f.description.trim(),
      ...(side === 'SELL' && mode === 'SPECIFIC' && openLots ? { allocations: allocationsFrom(openLots, choice) } : {}),
    }) as RecordTransactionRequest;
    record.mutate(body, {
      onSuccess: onRecorded,
      // The history no longer allows this split (e.g. a lot has fewer shares left): show fresh lots
      onError: (error) => errorCode(error) === 'ledger_violation' && void lots.refetch(),
    });
  };

  const c = f.currency.toUpperCase() || 'currency';
  return (
    <Form onSubmit={submit} label={side === 'BUY' ? 'Record a buy' : 'Record a sale'}>
      <Stack>
        <Grid size="narrow">
          <TextField label="Trade date" type="date" value={f.date} onChange={set('date')} error={errors.date} />
          <TextField label="Symbol" value={f.symbol} onChange={set('symbol')} error={errors.symbol} hint="Use the exchange suffix outside the US, e.g. VAS.AX." autoCapitalize="characters" />
          <TextField label="Currency" value={f.currency} onChange={set('currency')} error={errors.currency} maxLength={3} hint="The currency the shares trade and settle in." />
        </Grid>
        <AnyOfHint labels={LABELS} need={3} status={status} />
        <Grid size="narrow">
          <DecimalField label="Quantity" value={f.quantity} onChange={set('quantity')} error={errors.quantity} badge={<CalculatedBadge show={status.calculated === 'quantity'} />} hint="Fractions allowed." />
          <DecimalField label={`Price per share (${c})`} value={f.unitPrice} onChange={set('unitPrice')} error={errors.unitPrice} badge={<CalculatedBadge show={status.calculated === 'unitPrice'} />} />
          <DecimalField label={`Fees (${c})`} value={f.fees} onChange={set('fees')} error={errors.fees} badge={<CalculatedBadge show={status.calculated === 'fees'} />} hint="Brokerage and other charges." />
          <DecimalField
            label={`Total (${c})`}
            value={f.total}
            onChange={set('total')}
            error={errors.total}
            badge={<CalculatedBadge show={status.calculated === 'total'} />}
            hint={side === 'BUY' ? 'Cash paid, including fees.' : 'Cash received, after fees.'}
          />
        </Grid>
        {side === 'SELL' && (
          <Stack gap={3}>
            <SegmentedControl
              legend="Which shares were sold?"
              name="lot-selection"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'FIFO', label: 'Oldest first (FIFO)' },
                { value: 'SPECIFIC', label: 'Choose lots' },
              ]}
            />
            {mode === 'FIFO' ? (
              <Text size="sm" tone="muted">Money takes the oldest open lots first. Choose lots if your broker sold specific parcels.</Text>
            ) : !lotsWanted ? (
              <Text size="sm" tone="muted">Enter the symbol and trade date to see the lots available on that date.</Text>
            ) : (
              <LotPicker lots={openLots} loading={lots.isPending} error={lots.error} choice={choice} onChange={setChoice} saleQuantity={f.quantity} symbol={symbol} />
            )}
            {errors.lots && <Text tone="danger" size="sm">{errors.lots}</Text>}
          </Stack>
        )}
        <TextField label="Note" value={f.description} onChange={set('description')} hint="Optional, e.g. the broker's contract note number." />
        <ApiErrorCallout error={record.error} />
        <FormActions pending={record.isPending} label={side === 'BUY' ? 'Record buy' : 'Record sale'} />
      </Stack>
    </Form>
  );
}
