import type { TaxEvidence, TaxLink } from '@money/client';
import { useState } from 'react';
import { Link } from 'react-router';
import { InAppNav } from '../../app/InAppNav';
import { compareDecimals, isDecimal } from '../../lib/decimal';
import { Amount, Badge, Button, Card, Form, Row, SelectField, Stack, Table, Text, TextField, type BadgeTone, type Column } from '../../ui';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { useAddEvidence, useLinkCandidates, useLinkTransaction, useRemoveEvidence, useUnlinkTransaction } from './data';

/** The tax section's in-app navigation */
export function TaxNav() {
  return (
    <InAppNav
      label="Tax sections"
      items={[
        { to: '/tax', label: 'Years', end: true },
        { to: '/tax/items', label: 'Items' },
        { to: '/tax/assets', label: 'Assets' },
      ]}
    />
  );
}

export const DISCLAIMER = 'Tracking aid only, not tax advice. Money records what you intend to claim and why, and estimates depreciation from your own inputs; it does not decide what is deductible.';

const REVIEW: Record<string, { label: string; tone: BadgeTone }> = {
  TO_REVIEW: { label: 'To review', tone: 'warning' },
  CONFIRMED: { label: 'Confirmed', tone: 'success' },
  EXCLUDED: { label: 'Excluded', tone: 'neutral' },
};

export function ReviewBadge({ status }: { status: string }) {
  const r = REVIEW[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={r.tone}>{r.label}</Badge>;
}

const YEAR: Record<string, { label: string; tone: BadgeTone }> = {
  PREPARING: { label: 'Preparing', tone: 'accent' },
  FILED: { label: 'Filed', tone: 'success' },
  AMENDING: { label: 'Amending', tone: 'warning' },
};

export function YearStatusBadge({ status }: { status: string }) {
  const y = YEAR[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={y.tone}>{y.label}</Badge>;
}

export const KIND_LABELS: Record<string, string> = { DEDUCTION: 'Deduction', INCOME: 'Income', OFFSET: 'Offset', OTHER: 'Other' };

export const GAP_LABELS: Record<string, string> = {
  'needs-review': 'needs review',
  'no-evidence': 'no evidence',
  'no-transaction': 'unmatched',
  'no-amount': 'no amount',
  'not-aud': 'not AUD',
  'currency-mismatch': 'currency mismatch',
  'shared-transaction': 'shared transaction',
  'outside-year': 'date outside year',
  'not-in-use': 'not in use yet',
  'removed-transaction': 'transaction removed',
};

/** Open questions, minus "needs review" (shown by the status badge) */
export function GapBadges({ gaps }: { gaps: readonly string[] }) {
  const shown = gaps.filter((g) => g !== 'needs-review');
  if (shown.length === 0) return null;
  return (
    <Row gap={1}>
      {shown.map((g) => (
        <Badge key={g} tone={g === 'shared-transaction' || g === 'currency-mismatch' ? 'danger' : 'neutral'}>
          {GAP_LABELS[g] ?? g}
        </Badge>
      ))}
    </Row>
  );
}

/** A percentage from 0 to 100, checked exactly */
export function isPercent(value: string): boolean {
  const v = value.trim();
  return isDecimal(v) && compareDecimals(v, '0') >= 0 && compareDecimals(v, '100') <= 0;
}

/** "2026-27" shifted by n years, for year pickers (labels only, no money maths) */
export function shiftYear(label: string, n: number): string {
  const start = Number(label.slice(0, 4)) + n;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function yearOptions(current: string, extra: readonly string[] = []): string[] {
  return [...new Set([shiftYear(current, 1), current, shiftYear(current, -1), shiftYear(current, -2), shiftYear(current, -3), ...extra])].sort().reverse();
}

type Owner = { itemId: string } | { assetId: string };

const linkColumns = (onUnlink: ((l: TaxLink) => void) | null): Column<TaxLink>[] => [
  { key: 'date', header: 'Date', nowrap: true, render: (l) => l.date },
  {
    key: 'what',
    header: 'Transaction',
    render: (l) => (
      <Stack gap={1}>
        <span>{l.description ?? (l.type ?? 'Transaction')}</span>
        <Text size="xs" tone="muted" as="span">
          {l.accountName} · {l.source === 'up' ? 'Up (imported)' : 'Money'}
          {l.deleted ? ' · deleted at Up' : ''}
          {l.alsoLinkedTo.length > 0 ? ` · also linked to ${l.alsoLinkedTo.length} other record(s)` : ''}
        </Text>
      </Stack>
    ),
  },
  { key: 'amount', header: 'Amount', numeric: true, render: (l) => <Amount value={l.amount} currency={l.currency} /> },
  ...(onUnlink ? [{ key: 'actions', header: '', render: (l: TaxLink) => <Button size="sm" variant="ghost" onClick={() => onUnlink(l)}>Unlink</Button> }] : []),
];

/** Source transactions of an item or asset, with a search to link another */
export function LinksCard({ owner, links, locked, hint }: { owner: Owner; links: TaxLink[]; locked: boolean; hint: string }) {
  const unlink = useUnlinkTransaction();
  const link = useLinkTransaction();
  const [text, setText] = useState('');
  const candidates = useLinkCandidates(text);
  const linked = new Set(links.map((l) => l.transactionId ?? l.upTransactionId));

  return (
    <Card title="Source transactions">
      <Stack gap={3}>
        <Text size="sm" tone="muted">{hint}</Text>
        {links.length > 0 ? (
          <Table<TaxLink> label="Linked transactions" columns={linkColumns(locked ? null : (l) => unlink.mutate(l.id))} rows={links} rowKey={(l) => l.id} />
        ) : (
          <Text size="sm" tone="muted">Not linked to a transaction yet. That is fine for something paid elsewhere or not cleared yet.</Text>
        )}
        <ApiErrorCallout error={unlink.error} title="Not unlinked" />
        {!locked && (
          <Stack gap={2}>
            <TextField label="Find a transaction to link" value={text} onChange={(e) => setText(e.target.value)} placeholder="Description or merchant, e.g. conference" hint="Searches money out of your Money and Up accounts." />
            {candidates.data && candidates.data.items.length === 0 && <Text size="sm" tone="muted">No matching transactions.</Text>}
            {candidates.data && candidates.data.items.length > 0 && (
              <Table
                label="Matching transactions"
                rows={candidates.data.items}
                rowKey={(c) => c.id}
                columns={[
                  { key: 'date', header: 'Date', nowrap: true, render: (c) => c.date.slice(0, 10) },
                  { key: 'what', header: 'Transaction', render: (c) => <span>{c.merchant ?? c.note ?? c.type ?? 'Transaction'} <Badge>{c.source === 'up' ? 'Up' : 'Money'}</Badge></span> },
                  { key: 'amount', header: 'Amount', numeric: true, render: (c) => <Amount value={c.amount} currency={c.currency} signed /> },
                  {
                    key: 'link',
                    header: '',
                    render: (c) =>
                      linked.has(c.id) ? (
                        <Text size="xs" tone="muted" as="span">Linked</Text>
                      ) : (
                        <Button size="sm" disabled={link.isPending} onClick={() => link.mutate({ ...owner, ...(c.source === 'up' ? { upTransactionId: c.id } : { transactionId: c.id }) })}>
                          Link
                        </Button>
                      ),
                  },
                ]}
              />
            )}
            <ApiErrorCallout error={link.error} title="Not linked" />
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

const EVIDENCE_KINDS = ['RECEIPT', 'INVOICE', 'CALCULATION', 'STATEMENT', 'OTHER'] as const;

/** Labelled evidence URLs. Money stores links only, never files. */
export function EvidenceCard({ owner, evidence, locked }: { owner: Owner; evidence: TaxEvidence[]; locked: boolean }) {
  const add = useAddEvidence();
  const remove = useRemoveEvidence();
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<(typeof EVIDENCE_KINDS)[number]>('RECEIPT');
  const [error, setError] = useState<string>();

  return (
    <Card title="Evidence links">
      <Stack gap={3}>
        {evidence.length === 0 && <Text size="sm" tone="muted">No evidence yet. Add a link to the receipt, invoice or your calculation, wherever you keep it.</Text>}
        {evidence.length > 0 && (
          <Stack gap={2}>
            {evidence.map((e) => (
              <Row key={e.id} justify="between" gap={2}>
                <span>
                  <a href={e.url} target="_blank" rel="noreferrer noopener">{e.label}</a> <Badge>{e.kind.toLowerCase()}</Badge>
                </span>
                {!locked && <Button size="sm" variant="ghost" onClick={() => remove.mutate(e.id)}>Remove</Button>}
              </Row>
            ))}
          </Stack>
        )}
        <ApiErrorCallout error={remove.error} title="Not removed" />
        {!locked && (
          <Form
            label="Add evidence"
            onSubmit={() => {
              if (!label.trim()) return setError('Give the link a label, e.g. "Receipt".');
              if (!/^https?:\/\//i.test(url.trim())) return setError('Use a web address starting with https://');
              setError(undefined);
              add.mutate({ ...owner, label: label.trim(), url: url.trim(), kind }, { onSuccess: () => { setLabel(''); setUrl(''); } });
            }}
          >
            <Stack gap={2}>
              <Row gap={2} align="start">
                <TextField label="Label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Receipt" />
                <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  {EVIDENCE_KINDS.map((k) => <option key={k} value={k}>{k.charAt(0) + k.slice(1).toLowerCase()}</option>)}
                </SelectField>
              </Row>
              <TextField label="URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://drive.example.com/receipt.pdf" error={error} inputMode="url" />
              <ApiErrorCallout error={add.error} title="Not added" />
              <Row justify="end"><Button type="submit" disabled={add.isPending}>Add link</Button></Row>
            </Stack>
          </Form>
        )}
      </Stack>
    </Card>
  );
}

export function PositionLink({ itemId, assetId, children }: { itemId: string | null; assetId: string | null; children: string }) {
  if (itemId) return <Link to={`/tax/items/${itemId}`}>{children}</Link>;
  if (assetId) return <Link to={`/tax/assets/${assetId}`}>{children}</Link>;
  return <>{children}</>;
}
