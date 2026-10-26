import type { TaxItem } from '@money/client';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Amount, Badge, Button, ButtonLink, Callout, Card, DescriptionList, Loading, Row, SelectField, Stack, Table, Text, TextField, type Column } from '../../ui';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { PageHeader } from '../shared/PageHeader';
import { useCreateTaxItem, useDeleteTaxItem, useTaxItem, useTaxItems, useTaxYears, useUpdateTaxItem, type ItemFilter } from './data';
import { DISCLAIMER, EvidenceCard, GapBadges, GAP_LABELS, KIND_LABELS, LinksCard, PositionLink, ReviewBadge, TaxNav, YearStatusBadge, yearOptions } from './parts';
import { draftOf, TaxItemForm, type ItemDraft } from './TaxItemForm';

const blankOr = (v: string) => (v.trim() ? v.trim() : undefined);
const blankNull = (v: string) => (v.trim() ? v.trim() : null);

function createBody(d: ItemDraft) {
  return {
    taxYear: d.taxYear,
    kind: d.kind,
    category: d.category.trim() || 'other',
    description: d.description.trim(),
    date: blankOr(d.date),
    currency: d.currency.trim(),
    amount: blankOr(d.amount),
    claimPercent: d.claimPercent.trim(),
    status: d.status,
    rationale: blankOr(d.rationale),
    notes: blankOr(d.notes),
    claimedAmount: blankOr(d.claimedAmount),
  };
}

function updateBody(d: ItemDraft) {
  return { ...createBody(d), category: d.category.trim() || 'other', date: blankNull(d.date), amount: blankNull(d.amount), rationale: blankNull(d.rationale), notes: blankNull(d.notes), claimedAmount: blankNull(d.claimedAmount) };
}

function useYearChoices(extra: string[] = []) {
  const years = useTaxYears();
  const current = years.data?.currentTaxYear;
  return { current, choices: current ? yearOptions(current, [...(years.data?.years.map((y) => y.taxYear) ?? []), ...extra]) : [] };
}

const itemColumns: Column<TaxItem>[] = [
  {
    key: 'description',
    header: 'Item',
    render: (i) => (
      <Stack gap={1}>
        <PositionLink itemId={i.id} assetId={null}>{i.description}</PositionLink>
        <Text size="xs" tone="muted" as="span">FY {i.taxYear} · {KIND_LABELS[i.kind]} · {i.category}{i.date ? ` · ${i.date}` : ''}</Text>
        <GapBadges gaps={i.gaps} />
      </Stack>
    ),
  },
  { key: 'amount', header: 'Amount', numeric: true, render: (i) => <Amount value={i.effectiveAmount} currency={i.currency} /> },
  { key: 'percent', header: 'Claim', numeric: true, render: (i) => <Amount value={i.claimPercent} kind="percent" /> },
  { key: 'proposed', header: 'Proposed', numeric: true, render: (i) => <Amount value={i.proposedAmount} currency={i.currency} /> },
  { key: 'status', header: 'Status', render: (i) => <ReviewBadge status={i.status} /> },
];

/** Every tax item, filterable: the "what have I remembered" list */
export function TaxItemsPage() {
  const [params, setParams] = useSearchParams();
  const filter: ItemFilter = {
    taxYear: params.get('taxYear') || undefined,
    status: (params.get('status') as ItemFilter['status']) || undefined,
    category: params.get('category') || undefined,
    source: (params.get('source') as ItemFilter['source']) || undefined,
    evidence: (params.get('evidence') as ItemFilter['evidence']) || undefined,
    q: params.get('q') || undefined,
  };
  const items = useTaxItems(filter);
  const { choices } = useYearChoices();
  const [q, setQ] = useState(filter.q ?? '');
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader title="Tax items" subtitle="Everything you have remembered for a tax return, across years." actions={<ButtonLink to="/tax/items/new" variant="primary">Remember an item</ButtonLink>} />
      <TaxNav />
      <Card>
        <Row gap={3} align="start">
          <SelectField label="Year" value={filter.taxYear ?? ''} onChange={(e) => setFilter('taxYear', e.target.value)}>
            <option value="">All years</option>
            {choices.map((y) => <option key={y} value={y}>FY {y}</option>)}
          </SelectField>
          <SelectField label="Status" value={filter.status ?? ''} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">Any</option>
            <option value="TO_REVIEW">To review</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="EXCLUDED">Excluded</option>
          </SelectField>
          <SelectField label="Transaction" value={filter.source ?? ''} onChange={(e) => setFilter('source', e.target.value)}>
            <option value="">Any</option>
            <option value="linked">Linked</option>
            <option value="unlinked">Unmatched</option>
          </SelectField>
          <SelectField label="Evidence" value={filter.evidence ?? ''} onChange={(e) => setFilter('evidence', e.target.value)}>
            <option value="">Any</option>
            <option value="present">Has evidence</option>
            <option value="missing">Missing</option>
          </SelectField>
          <TextField label="Category" value={filter.category ?? ''} onChange={(e) => setFilter('category', e.target.value)} placeholder="self-education" />
          <TextField label="Search" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setFilter('q', q.trim())} onKeyDown={(e) => e.key === 'Enter' && setFilter('q', q.trim())} placeholder="conference" />
        </Row>
      </Card>
      {items.isPending && <Loading label="Loading items…" />}
      {items.isError && <ApiErrorCallout error={items.error} title="Could not load tax items" />}
      {items.data && (
        <Card flush>
          {items.data.items.length > 0 ? (
            <Table<TaxItem> label="Tax items" columns={itemColumns} rows={items.data.items} rowKey={(i) => i.id} />
          ) : (
            <Stack gap={2}><Text tone="muted" size="sm">No items match.</Text></Stack>
          )}
        </Card>
      )}
      <Text size="sm" tone="muted">{DISCLAIMER}</Text>
    </>
  );
}

/** Remember something for a return: works before the payment clears; link it later */
export function NewTaxItemPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const create = useCreateTaxItem();
  const { current, choices } = useYearChoices();
  if (!current) return <Loading />;
  const initial: ItemDraft = {
    taxYear: params.get('taxYear') ?? current,
    kind: 'DEDUCTION',
    category: '',
    description: '',
    date: '',
    currency: 'AUD',
    amount: '',
    claimPercent: '100',
    status: 'TO_REVIEW',
    rationale: '',
    notes: '',
    claimedAmount: '',
  };
  return (
    <>
      <PageHeader title="Remember an item" subtitle="Note what you intend to claim (or declare) and why. You can link the transaction and add a receipt URL now or later." />
      <TaxNav />
      <Card>
        <TaxItemForm
          initial={initial}
          years={choices}
          submitLabel="Save item"
          pending={create.isPending}
          error={create.error}
          onCancel={() => navigate(-1)}
          onSubmit={(d) => create.mutate(createBody(d), { onSuccess: (item) => navigate(`/tax/items/${item.id}`) })}
        />
      </Card>
      <Text size="sm" tone="muted">{DISCLAIMER}</Text>
    </>
  );
}

/** One item: intent, proposed figure, source transactions, evidence and open questions */
export function TaxItemPage() {
  const { itemId = '' } = useParams();
  const navigate = useNavigate();
  const item = useTaxItem(itemId);
  const update = useUpdateTaxItem();
  const remove = useDeleteTaxItem();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { choices } = useYearChoices(item.data ? [item.data.taxYear] : []);

  if (item.isPending) return <><TaxNav /><Loading label="Loading item…" /></>;
  if (item.isError) return <><TaxNav /><ApiErrorCallout error={item.error} title="Could not load this item" /></>;
  const i = item.data;
  const owner = { itemId: i.id };

  return (
    <>
      <PageHeader
        title={i.description}
        eyebrow={<Text size="sm" tone="muted" as="span"><ButtonLink to={`/tax/years/${i.taxYear}`} variant="ghost" size="sm">FY {i.taxYear}</ButtonLink></Text>}
        subtitle={<>{KIND_LABELS[i.kind]} · {i.category} <ReviewBadge status={i.status} /></>}
        actions={!i.locked && !editing ? (
          <>
            <Button onClick={() => { update.reset(); setEditing(true); }}>Edit</Button>
            <Button variant="ghost" onClick={() => setDeleting(true)}>Delete</Button>
          </>
        ) : undefined}
      />
      <TaxNav />
      {i.locked && (
        <Callout tone="info" title={<>FY {i.taxYear} is filed <YearStatusBadge status={i.yearStatus} /></>}>
          This item is part of a filed return and is read-only. Reopen the year for amendment to change it.
        </Callout>
      )}
      {deleting && (
        <Callout tone="warning" title="Delete this item?">
          <Stack gap={2}>
            <Text size="sm">Its links and evidence URLs go too. The linked transactions are not touched.</Text>
            <ApiErrorCallout error={remove.error} title="Not deleted" />
            <Row gap={1}>
              <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(i.id, { onSuccess: () => navigate('/tax/items') })}>Delete item</Button>
              <Button size="sm" onClick={() => setDeleting(false)}>Cancel</Button>
            </Row>
          </Stack>
        </Callout>
      )}
      {editing ? (
        <Card title="Edit item">
          <TaxItemForm
            initial={draftOf(i)}
            years={choices}
            submitLabel="Save changes"
            pending={update.isPending}
            error={update.error}
            onCancel={() => setEditing(false)}
            onSubmit={(d) => update.mutate({ itemId: i.id, body: updateBody(d) }, { onSuccess: () => setEditing(false) })}
          />
        </Card>
      ) : (
        <Card title="Claim">
          <Stack gap={3}>
            <DescriptionList
              items={[
                { term: 'Amount', detail: <><Amount value={i.effectiveAmount} currency={i.currency} /> {i.amountSource === 'linked' && <Badge>from linked transactions</Badge>}{i.amountSource === 'missing' && <Badge tone="warning">missing</Badge>}</> },
                { term: 'Intended claim', detail: <Amount value={i.claimPercent} kind="percent" /> },
                { term: 'Proposed', detail: <Text strong as="span"><Amount value={i.proposedAmount} currency={i.currency} /></Text> },
                { term: 'Actually claimed', detail: i.claimedAmount ? <Amount value={i.claimedAmount} currency={i.currency} /> : <Text size="sm" tone="muted" as="span">Not recorded yet</Text> },
                { term: 'Date', detail: i.date ?? '—' },
                { term: 'Why', detail: i.rationale ?? '—' },
                { term: 'Notes', detail: i.notes ?? '—' },
              ]}
            />
            {i.gaps.length > 0 && (
              <Callout tone="warning" title="Open questions">
                <ul>{i.gaps.map((g) => <li key={g}>{g === 'needs-review' ? 'Still to review: confirm or exclude it' : GAP_LABELS[g] ?? g}</li>)}</ul>
              </Callout>
            )}
          </Stack>
        </Card>
      )}
      <LinksCard owner={owner} links={i.links} locked={i.locked} hint="The payment this comes from. Money refers to the transaction; it never copies it. A transaction that pays for a registered asset can't be linked here: its deduction comes from the asset's depreciation." />
      <EvidenceCard owner={owner} evidence={i.evidence} locked={i.locked} />
      <Text size="sm" tone="muted">{DISCLAIMER}</Text>
    </>
  );
}
