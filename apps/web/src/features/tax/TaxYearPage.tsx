import type { TaxCategoryTotal, TaxDriftLine, TaxFiling, TaxPosition } from '@money/client';
import { useState } from 'react';
import { useParams } from 'react-router';
import { Amount, Button, ButtonLink, Callout, Card, Checkbox, Form, Loading, Row, Stack, Table, Text, TextAreaField, TextField, type Column } from '../../ui';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { PageHeader } from '../shared/PageHeader';
import { useFileYear, useReopenYear, useTaxReport, useTaxYear, useUpdateYearNotes } from './data';
import { DISCLAIMER, GapBadges, KIND_LABELS, PositionLink, ReviewBadge, TaxNav, YearStatusBadge } from './parts';

const positionColumns: Column<TaxPosition>[] = [
  {
    key: 'description',
    header: 'Position',
    render: (p) => (
      <Stack gap={1}>
        <PositionLink itemId={p.itemId} assetId={p.assetId}>{p.description}</PositionLink>
        <Text size="xs" tone="muted" as="span">{KIND_LABELS[p.kind]} · {p.category}{p.date ? ` · ${p.date}` : ''}</Text>
        <GapBadges gaps={p.gaps} />
      </Stack>
    ),
  },
  { key: 'amount', header: 'Amount', numeric: true, render: (p) => <Amount value={p.amount} currency={p.currency} /> },
  { key: 'percent', header: 'Claim / use', numeric: true, render: (p) => <Amount value={p.percent} kind="percent" /> },
  { key: 'proposed', header: 'Proposed', numeric: true, render: (p) => <Amount value={p.proposedAmount} currency={p.currency} /> },
  { key: 'claimed', header: 'Claimed', numeric: true, render: (p) => <Amount value={p.claimedAmount} currency={p.currency} /> },
  { key: 'status', header: 'Status', render: (p) => <ReviewBadge status={p.status} /> },
];

const CHANGE_LABELS: Record<TaxDriftLine['change'], string> = { added: 'New since filing', removed: 'No longer computed', changed: 'Changed' };

const driftColumns: Column<TaxDriftLine>[] = [
  {
    key: 'description',
    header: 'Position',
    render: (d) => (
      <Stack gap={1}>
        <span>{d.description}</span>
        <Text size="xs" tone="muted" as="span">{CHANGE_LABELS[d.change]}{d.fields.length > 0 ? `: ${d.fields.join(', ')}` : ''}</Text>
      </Stack>
    ),
  },
  { key: 'filed', header: 'Filed proposed', numeric: true, render: (d) => <Amount value={d.filedProposed} /> },
  { key: 'live', header: 'Live proposed', numeric: true, render: (d) => <Amount value={d.liveProposed} /> },
];

const categoryColumns: Column<TaxCategoryTotal>[] = [
  { key: 'category', header: 'Category', render: (c) => <span>{c.category} <Text size="xs" tone="muted" as="span">({KIND_LABELS[c.kind]})</Text></span> },
  { key: 'count', header: 'Positions', numeric: true, render: (c) => c.count },
  { key: 'proposed', header: 'Proposed', numeric: true, render: (c) => <Amount value={c.proposed} currency={c.currency} /> },
  { key: 'confirmed', header: 'Confirmed', numeric: true, render: (c) => <Amount value={c.confirmed} currency={c.currency} /> },
  { key: 'claimed', header: 'Claimed', numeric: true, render: (c) => <Amount value={c.claimed} currency={c.currency} /> },
];

const filingColumns: Column<TaxFiling>[] = [
  { key: 'version', header: 'Version', render: (f) => `${f.version} (${f.kind === 'ORIGINAL' ? 'original' : 'amendment'})` },
  { key: 'filed', header: 'Lodged', nowrap: true, render: (f) => f.filedOn },
  { key: 'reference', header: 'Reference', render: (f) => f.reference ?? '—' },
  { key: 'reason', header: 'Amendment reason', render: (f) => f.amendmentReason ?? '—' },
  { key: 'totals', header: 'Proposed then', numeric: true, render: (f) => <Stack gap={1}>{f.totals.byKind.map((t) => <span key={t.kind + t.currency}>{KIND_LABELS[t.kind]}: <Amount value={t.proposed} currency={t.currency} /></span>)}</Stack> },
];

function ReportCard({ taxYear }: { taxYear: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const report = useTaxReport(taxYear, open);
  return (
    <Card title="Copyable summary" actions={<Button size="sm" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show summary'}</Button>}>
      {!open && <Text size="sm" tone="muted">A Markdown summary for your notes or your tax agent, and a CSV of every position.</Text>}
      {open && report.isPending && <Loading label="Preparing summary…" />}
      {open && report.isError && <ApiErrorCallout error={report.error} />}
      {open && report.data && (
        <Stack gap={2}>
          <TextAreaField label="Markdown" readOnly rows={14} value={report.data.markdown} />
          <Row gap={2}>
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(report.data.markdown).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copied' : 'Copy Markdown'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(report.data.csv)}>Copy CSV</Button>
          </Row>
        </Stack>
      )}
    </Card>
  );
}

function FilingCard({ taxYear, status, toReview }: { taxYear: string; status: string; toReview: number }) {
  const file = useFileYear();
  const reopen = useReopenYear();
  const [filedOn, setFiledOn] = useState('');
  const [reference, setReference] = useState('');
  const [allowUnreviewed, setAllowUnreviewed] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();

  if (status === 'FILED') {
    return (
      <Card title="Filed">
        <Form
          label="Reopen for amendment"
          onSubmit={() => {
            if (!reason.trim()) return setError('Say why you are amending it.');
            setError(undefined);
            reopen.mutate({ taxYear, reason: reason.trim() }, { onSuccess: () => setReason('') });
          }}
        >
          <Stack gap={2}>
            <Text size="sm" tone="muted">This year is read-only, so what you filed stays as it was. To correct it, reopen it for amendment, change it, and record the amendment as a new version.</Text>
            <TextField label="Reason for amending" value={reason} onChange={(e) => setReason(e.target.value)} error={error} />
            <ApiErrorCallout error={reopen.error} title="Not reopened" />
            <Row justify="end"><Button type="submit" disabled={reopen.isPending}>Reopen for amendment</Button></Row>
          </Stack>
        </Form>
      </Card>
    );
  }
  return (
    <Card title={status === 'AMENDING' ? 'Record the amendment' : 'Record lodgment'}>
      <Form
        label="Record lodgment"
        onSubmit={() => {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(filedOn)) return setError('Enter the date you lodged it.');
          setError(undefined);
          file.mutate({ taxYear, body: { filedOn, reference: reference.trim() || undefined, allowUnreviewed } });
        }}
      >
        <Stack gap={2}>
          <Text size="sm" tone="muted">
            Once you have lodged your return (Money does not lodge anything), record it here. Money keeps a snapshot of every position as filed and makes the year read-only. Record what you actually claimed on each position first.
          </Text>
          <Row gap={2} align="start">
            <TextField label="Lodged on" type="date" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} error={error} />
            <TextField label="Reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} />
          </Row>
          {toReview > 0 && (
            <Checkbox label={`File anyway with ${toReview} position(s) still to review`} checked={allowUnreviewed} onChange={(e) => setAllowUnreviewed(e.target.checked)} />
          )}
          <ApiErrorCallout error={file.error} title="Not recorded" />
          <Row justify="end"><Button type="submit" variant="primary" disabled={file.isPending}>{status === 'AMENDING' ? 'Record amendment' : 'Record as filed'}</Button></Row>
        </Stack>
      </Form>
    </Card>
  );
}

function NotesCard({ taxYear, notes }: { taxYear: string; notes: string | null }) {
  const save = useUpdateYearNotes();
  const [draft, setDraft] = useState(notes ?? '');
  return (
    <Card title="Preparation notes">
      <Form label="Preparation notes" onSubmit={() => save.mutate({ taxYear, notes: draft.trim() || null })}>
        <Stack gap={2}>
          <TextAreaField label="Notes" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Questions for your tax agent, what is still missing…" />
          <ApiErrorCallout error={save.error} title="Not saved" />
          <Row justify="end"><Button type="submit" size="sm" disabled={save.isPending}>Save notes</Button></Row>
        </Stack>
      </Form>
    </Card>
  );
}

/** One financial year: every position (items and asset depreciation), totals, open questions and filing */
export function TaxYearPage() {
  const { taxYear = '' } = useParams();
  const year = useTaxYear(taxYear);
  const header = (s?: { status: string; period: { start: string; end: string } }) => (
    <>
      <PageHeader
        title={<>FY {taxYear} {s && <YearStatusBadge status={s.status} />}</>}
        subtitle={s ? `${s.period.start} to ${s.period.end}` : undefined}
        actions={s && s.status !== 'FILED' ? <ButtonLink to={`/tax/items/new?taxYear=${taxYear}`} variant="primary">Add item</ButtonLink> : undefined}
      />
      <TaxNav />
    </>
  );
  if (year.isPending) return <>{header()}<Loading label="Loading the year…" /></>;
  if (year.isError) return <>{header()}<ApiErrorCallout error={year.error} title="Could not load this year" /></>;
  const s = year.data;
  const toReview = s.positions.filter((p) => p.status === 'TO_REVIEW').length;
  const gapCounts = Object.entries(s.gaps.counts).filter(([code]) => code !== 'needs-review');

  return (
    <>
      {header(s)}
      {s.basis === 'FILED' && (
        <Text size="sm" tone="muted">
          Showing the figures as filed (version {s.filedVersion}). Changes to the records since then are listed under “Changes since filing”, not applied here.
        </Text>
      )}
      <Card title={s.basis === 'FILED' ? `Totals as filed (version ${s.filedVersion})` : 'Totals'}>
        {s.totals.byKind.length === 0 ? (
          <Text tone="muted" size="sm">Nothing recorded for this year.</Text>
        ) : (
          <Stack gap={2}>
            {s.totals.byKind.map((t) => (
              <Row key={t.kind + t.currency} justify="between" gap={3}>
                <Text as="span" strong>{KIND_LABELS[t.kind]}</Text>
                <Row gap={4}>
                  <Text size="sm" as="span">Proposed <Amount value={t.proposed} currency={t.currency} /></Text>
                  <Text size="sm" tone="muted" as="span">Confirmed <Amount value={t.confirmed} currency={t.currency} /></Text>
                  <Text size="sm" tone="muted" as="span">Claimed <Amount value={t.claimed} currency={t.currency} /></Text>
                </Row>
              </Row>
            ))}
          </Stack>
        )}
      </Card>
      {(toReview > 0 || gapCounts.length > 0 || s.warnings.length > 0) && (
        <Callout tone="warning" title="Open questions">
          <ul>
            {toReview > 0 && <li>{toReview} position(s) still to review.</li>}
            {gapCounts.map(([code, n]) => <li key={code}>{n} × {s.gapDescriptions[code] ?? code}</li>)}
            {s.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </Callout>
      )}
      <Card title={s.basis === 'FILED' ? 'Positions as filed' : 'Positions'} flush>
        {s.positions.length > 0 ? (
          <Table<TaxPosition> label={`Positions for ${taxYear}`} columns={positionColumns} rows={s.positions} rowKey={(p) => p.id} />
        ) : (
          <Text tone="muted" size="sm">No positions.</Text>
        )}
      </Card>
      {s.totals.byCategory.length > 0 && (
        <Card title="By category" flush>
          <Table<TaxCategoryTotal> label="Totals by category" columns={categoryColumns} rows={s.totals.byCategory} rowKey={(c) => `${c.kind}|${c.category}|${c.currency}`} />
        </Card>
      )}
      {s.drift.length > 0 && (
        <Card title={s.basis === 'FILED' ? 'Changes since filing' : 'Changes since the last filing'} flush>
          <Table<TaxDriftLine> label="Differences from the latest filing" columns={driftColumns} rows={s.drift} rowKey={(d) => `${d.change}|${d.positionId}`} />
        </Card>
      )}
      <FilingCard taxYear={s.taxYear} status={s.status} toReview={toReview} />
      {s.filings.length > 0 && (
        <Card title="Filing history" flush>
          <Table<TaxFiling> label="Filing history" columns={filingColumns} rows={s.filings} rowKey={(f) => f.id} />
        </Card>
      )}
      <ReportCard taxYear={s.taxYear} />
      <NotesCard key={s.notes ?? ''} taxYear={s.taxYear} notes={s.notes} />
      <Text size="sm" tone="muted">{DISCLAIMER}</Text>
    </>
  );
}
