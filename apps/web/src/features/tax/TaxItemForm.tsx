import type { TaxItem } from '@money/client';
import { useState } from 'react';
import { Button, DecimalField, Form, Row, SelectField, Stack, TextAreaField, TextField } from '../../ui';
import { isPercent } from './parts';
import { isDecimal } from '../../lib/decimal';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { useTaxCategories } from './data';
import { KIND_LABELS } from './parts';

export type ItemDraft = {
  taxYear: string;
  kind: TaxItem['kind'];
  category: string;
  description: string;
  date: string;
  currency: string;
  amount: string;
  claimPercent: string;
  status: TaxItem['status'];
  rationale: string;
  notes: string;
  claimedAmount: string;
};

export function draftOf(item: TaxItem): ItemDraft {
  return {
    taxYear: item.taxYear,
    kind: item.kind,
    category: item.category,
    description: item.description,
    date: item.date ?? '',
    currency: item.currency,
    amount: item.amount ?? '',
    claimPercent: item.claimPercent,
    status: item.status,
    rationale: item.rationale ?? '',
    notes: item.notes ?? '',
    claimedAmount: item.claimedAmount ?? '',
  };
}

type Errors = Partial<Record<keyof ItemDraft, string>>;

function validate(d: ItemDraft): Errors {
  const e: Errors = {};
  if (!d.description.trim()) e.description = 'Say what it is.';
  if (d.amount.trim() && !isDecimal(d.amount.trim())) e.amount = 'Use a number such as 899.00.';
  if (!isPercent(d.claimPercent)) e.claimPercent = 'Use a percentage from 0 to 100.';
  if (d.claimedAmount.trim() && !isDecimal(d.claimedAmount.trim())) e.claimedAmount = 'Use a number such as 449.50.';
  if (!/^[A-Za-z]{3}$/.test(d.currency.trim())) e.currency = 'Use a 3-letter code such as AUD.';
  return e;
}

/** Create or edit a tax item. Only the intent and its context are entered here; the proposed amount is the backend's. */
export function TaxItemForm({
  initial,
  years,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: ItemDraft;
  years: string[];
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (draft: ItemDraft) => void;
  onCancel?: () => void;
}) {
  const [d, setD] = useState(initial);
  const [errors, setErrors] = useState<Errors>({});
  const categories = useTaxCategories();
  const set = <K extends keyof ItemDraft>(key: K, value: ItemDraft[K]) => setD((x) => ({ ...x, [key]: value }));
  const suggestions = categories.data?.suggested ?? [];

  return (
    <Form
      label={submitLabel}
      onSubmit={() => {
        const found = validate(d);
        setErrors(found);
        if (Object.keys(found).length === 0) onSubmit(d);
      }}
    >
      <Stack gap={3}>
        <TextField label="What is it?" value={d.description} onChange={(e) => set('description', e.target.value)} error={errors.description} placeholder="AI Engineering Conference ticket" maxLength={500} />
        <Row gap={3} align="start">
          <SelectField label="Financial year" value={d.taxYear} onChange={(e) => set('taxYear', e.target.value)} hint="1 July to 30 June">
            {years.map((y) => <option key={y} value={y}>FY {y}</option>)}
          </SelectField>
          <TextField label="Date (optional)" type="date" value={d.date} onChange={(e) => set('date', e.target.value)} hint="When it was paid or incurred" />
        </Row>
        <Row gap={3} align="start">
          <SelectField label="Kind" value={d.kind} onChange={(e) => set('kind', e.target.value as ItemDraft['kind'])}>
            {Object.entries(KIND_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </SelectField>
          <TextField label="Category" value={d.category} onChange={(e) => set('category', e.target.value)} list="tax-categories" hint="Pick a suggestion or type your own" />
          <datalist id="tax-categories">
            {suggestions.map((s) => <option key={s.category} value={s.category}>{s.label}</option>)}
          </datalist>
        </Row>
        <Row gap={3} align="start">
          <DecimalField label="Amount" value={d.amount} onChange={(e) => set('amount', e.target.value)} error={errors.amount} hint="Leave empty to use the linked transaction's amount" />
          <TextField label="Currency" value={d.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} error={errors.currency} maxLength={3} />
          <DecimalField label="Claim %" value={d.claimPercent} onChange={(e) => set('claimPercent', e.target.value)} error={errors.claimPercent} hint="Your intended share, e.g. 50 for half" />
        </Row>
        <TextAreaField label="Why you intend to claim it" rows={2} value={d.rationale} onChange={(e) => set('rationale', e.target.value)} placeholder="Relates directly to my current work" />
        <Row gap={3} align="start">
          <SelectField label="Review status" value={d.status} onChange={(e) => set('status', e.target.value as ItemDraft['status'])}>
            <option value="TO_REVIEW">To review</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="EXCLUDED">Excluded</option>
          </SelectField>
          <DecimalField label="Actually claimed (optional)" value={d.claimedAmount} onChange={(e) => set('claimedAmount', e.target.value)} error={errors.claimedAmount} hint="What went on the lodged return" />
        </Row>
        <TextAreaField label="Notes" rows={2} value={d.notes} onChange={(e) => set('notes', e.target.value)} />
        <ApiErrorCallout error={error} title="Not saved" />
        <Row justify="end" gap={2}>
          {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
          <Button type="submit" variant="primary" disabled={pending}>{pending ? 'Saving…' : submitLabel}</Button>
        </Row>
      </Stack>
    </Form>
  );
}
