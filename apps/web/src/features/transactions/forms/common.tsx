import type { ReactNode } from 'react';
import { Badge, Button, Callout, Row, Text } from '../../../ui';
import { isDecimal } from '../../../lib/decimal';

/** Today's date in the user's time zone, as YYYY-MM-DD */
export function todayIso(now = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export type FieldErrors = Record<string, string>;

export const checks = {
  date(value: string): string | null {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : 'Use a date like 2024-07-01.';
  },
  currency(value: string): string | null {
    return /^[A-Za-z]{3}$/.test(value.trim()) ? null : 'Use a 3-letter code, e.g. AUD.';
  },
  symbol(value: string): string | null {
    return /^[A-Za-z0-9][A-Za-z0-9.\-^=]{0,31}$/.test(value.trim()) ? null : 'Use a ticker such as VOO or VAS.AX.';
  },
  /** Blank is allowed (the backend may calculate it); otherwise a non-negative decimal with at most 10 places */
  optionalAmount(value: string): string | null {
    const v = value.trim();
    if (!v) return null;
    if (!isDecimal(v) || v.startsWith('-')) return 'Use a number like 1234.56, without currency symbols or commas.';
    if ((v.split('.')[1]?.length ?? 0) > 10) return 'Use at most 10 decimal places.';
    return null;
  },
  requiredAmount(value: string): string | null {
    if (!value.trim()) return 'Required.';
    return checks.optionalAmount(value);
  },
};

/** Drops blank strings so the backend sees only what the user entered */
export function compact<T extends Record<string, unknown>>(body: T): T {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== '' && v !== undefined && v !== null)) as T;
}

/**
 * "Fill in any N of these" guidance for figures Money can calculate (three of
 * four for trades, two of three for dividends and conversions). The UI only
 * counts what was filled in; the backend does the arithmetic.
 */
export function anyOfStatus(values: Record<string, string>, need: number): { filled: string[]; missing: string[]; enough: boolean; calculated: string | null } {
  const filled = Object.keys(values).filter((k) => values[k].trim() !== '');
  const missing = Object.keys(values).filter((k) => values[k].trim() === '');
  return { filled, missing, enough: filled.length >= need, calculated: filled.length === need && missing.length === 1 ? missing[0] : null };
}

export function CalculatedBadge({ show }: { show: boolean }) {
  return show ? <Badge tone="accent">Money calculates this</Badge> : null;
}

export function AnyOfHint({ labels, need, status }: { labels: Record<string, string>; need: number; status: ReturnType<typeof anyOfStatus> }) {
  const total = Object.keys(labels).length;
  let message: ReactNode;
  if (!status.enough) message = `Enter any ${need} of the ${total} figures below; Money works out the other from them.`;
  else if (status.calculated) message = `Money will calculate ${labels[status.calculated].toLowerCase()} from the others.`;
  else message = `All ${total} given: Money checks they agree (within 0.01) and stores them as entered.`;
  return (
    <Text size="sm" tone={status.enough ? 'muted' : 'default'}>
      {message}
    </Text>
  );
}

export function FormActions({ pending, label, onCancel }: { pending: boolean; label: string; onCancel?: () => void }) {
  return (
    <Row justify="between">
      {onCancel ? <Button variant="ghost" onClick={onCancel}>Cancel</Button> : <span />}
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? 'Recording…' : label}
      </Button>
    </Row>
  );
}

export function RecordingNote() {
  return (
    <Callout tone="info">
      You are recording something that already happened. Money keeps the record; it does not contact your bank or broker.
    </Callout>
  );
}
