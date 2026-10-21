import type { Lot } from '@money/client';
import { Amount, Badge, Callout, DecimalField, Loading, Stack, Table, Text, type Column } from '../../../ui';
import { compareDecimals, isDecimal, sumDecimals } from '../../../lib/decimal';
import { ApiErrorCallout } from '../../shared/ApiErrorCallout';

export type LotChoice = Record<string, string>;

/**
 * Checks typed lot quantities: each between 0 and the lot's remaining
 * quantity, and together equal to the sale quantity. Exact decimal
 * comparison on strings; no accounting is done here.
 */
export function checkLotChoice(lots: Lot[], choice: LotChoice, saleQuantity: string): { total: string; errors: Record<string, string>; matches: boolean } {
  const errors: Record<string, string> = {};
  const entered: string[] = [];
  for (const lot of lots) {
    const value = (choice[lot.lotId] ?? '').trim();
    if (!value) continue;
    if (!isDecimal(value) || value.startsWith('-')) {
      errors[lot.lotId] = 'Use a number.';
      continue;
    }
    if (compareDecimals(value, lot.remainingQuantity) > 0) errors[lot.lotId] = 'More than this lot has left.';
    entered.push(value);
  }
  const total = sumDecimals(entered);
  const matches = Object.keys(errors).length === 0 && isDecimal(saleQuantity.trim()) && compareDecimals(total, saleQuantity.trim()) === 0 && compareDecimals(total, '0') > 0;
  return { total, errors, matches };
}

/** Allocations to send, in display order, skipping lots left at zero */
export function allocationsFrom(lots: Lot[], choice: LotChoice): { lotId: string; quantity: string }[] {
  return lots
    .map((lot) => ({ lotId: lot.lotId, quantity: (choice[lot.lotId] ?? '').trim() }))
    .filter((a) => a.quantity !== '' && isDecimal(a.quantity) && compareDecimals(a.quantity, '0') > 0);
}

/** One quantity input per open lot, with a running total against the sale quantity */
export function LotPicker({
  lots,
  loading,
  error,
  choice,
  onChange,
  saleQuantity,
  symbol,
}: {
  lots: Lot[] | undefined;
  loading: boolean;
  error: unknown;
  choice: LotChoice;
  onChange: (choice: LotChoice) => void;
  saleQuantity: string;
  symbol: string;
}) {
  if (loading) return <Loading label="Loading lots…" />;
  if (error) return <ApiErrorCallout error={error} title="Could not load lots" />;
  if (!lots || lots.length === 0) return <Callout tone="warning">No open lots of {symbol || 'this symbol'} on that date.</Callout>;

  const { total, errors, matches } = checkLotChoice(lots, choice, saleQuantity);
  const columns: Column<Lot>[] = [
    { key: 'acquired', nowrap: true, header: 'Bought on', render: (l) => <span>{l.acquiredOn} <Text tone="muted" size="xs" as="span">#{l.sequence}</Text></span> },
    { key: 'remaining', header: 'Available', numeric: true, render: (l) => <Amount value={l.remainingQuantity} kind="quantity" /> },
    { key: 'unit', header: 'Unit cost', numeric: true, render: (l) => <Amount value={l.unitCostBase} currency={l.currency} kind="rate" /> },
    { key: 'cost', header: 'Cost base left', numeric: true, render: (l) => <Amount value={l.remainingCostBase} currency={l.currency} /> },
    { key: 'held', header: 'Held', render: (l) => <span>{l.daysHeld} days {l.heldOverTwelveMonths && <Badge tone="accent">&gt; 12 months</Badge>}</span> },
    {
      key: 'take',
      header: 'Sell from this lot',
      render: (l) => (
        <DecimalField
          label={<span className="visually-hidden">Shares from the lot bought {l.acquiredOn} (#{l.sequence})</span>}
          value={choice[l.lotId] ?? ''}
          placeholder="0"
          error={errors[l.lotId]}
          onChange={(e) => onChange({ ...choice, [l.lotId]: e.target.value })}
        />
      ),
    },
  ];

  return (
    <Stack gap={3}>
      <Table label="Lots to sell from" columns={columns} rows={lots} rowKey={(l) => l.lotId} />
      <Text size="sm" tone={matches ? 'success' : 'warning'} strong>
        <span aria-live="polite">
          Chosen {total || '0'} of {saleQuantity.trim() || '?'} shares{matches ? ' ✓' : ''}
        </span>
      </Text>
    </Stack>
  );
}
