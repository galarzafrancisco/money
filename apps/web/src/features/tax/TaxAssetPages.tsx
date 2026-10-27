import type { DepreciationRow, TaxAsset, TaxAssetList } from '@money/client';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Amount, Badge, Button, ButtonLink, Callout, Card, DecimalField, DescriptionList, EmptyState, Form, Loading, Row, SelectField, Stack, Table, Text, TextAreaField, TextField, type BadgeTone, type Column } from '../../ui';
import { isDecimal, isPositiveDecimal } from '../../lib/decimal';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { PageHeader } from '../shared/PageHeader';
import { useDeleteAsset, useRegisterAsset, useSetAssetYear, useTaxAsset, useTaxAssets, useUpdateAsset } from './data';
import { DISCLAIMER, EvidenceCard, GapBadges, isPercent, LinksCard, ReviewBadge, shiftYear, TaxNav, YearStatusBadge } from './parts';

const METHOD_LABELS: Record<string, string> = { PRIME_COST: 'Prime cost', DIMINISHING_VALUE: 'Diminishing value', IMMEDIATE: 'Immediate deduction' };
const LIFECYCLE: Record<string, { label: string; tone: BadgeTone }> = {
  NOT_IN_USE: { label: 'Not in use yet', tone: 'warning' },
  IN_USE: { label: 'In use', tone: 'success' },
  WRITTEN_OFF: { label: 'Written off', tone: 'neutral' },
  DISPOSED: { label: 'Disposed of', tone: 'neutral' },
};

function LifecycleBadge({ lifecycle }: { lifecycle: string }) {
  const l = LIFECYCLE[lifecycle] ?? { label: lifecycle, tone: 'neutral' as const };
  return <Badge tone={l.tone}>{l.label}</Badge>;
}

type ListedAsset = TaxAssetList['assets'][number];

/** The depreciating asset register */
export function TaxAssetsPage() {
  const assets = useTaxAssets();
  const header = (
    <>
      <PageHeader title="Depreciating assets" subtitle="Equipment you use for work, with an estimated decline in value per financial year from your own inputs." actions={<ButtonLink to="/tax/assets/new" variant="primary">Register asset</ButtonLink>} />
      <TaxNav />
    </>
  );
  if (assets.isPending) return <>{header}<Loading label="Loading assets…" /></>;
  if (assets.isError) return <>{header}<ApiErrorCallout error={assets.error} title="Could not load your assets" /></>;
  const columns: Column<ListedAsset>[] = [
    {
      key: 'name',
      header: 'Asset',
      render: (a) => (
        <Stack gap={1}>
          <Link to={`/tax/assets/${a.id}`}>{a.name}</Link>
          <Text size="xs" tone="muted" as="span">{METHOD_LABELS[a.method]} · acquired {a.acquiredOn}</Text>
          <GapBadges gaps={a.gaps} />
        </Stack>
      ),
    },
    { key: 'cost', header: 'Cost', numeric: true, render: (a) => <Amount value={a.cost} currency={a.currency} /> },
    { key: 'value', header: 'Adjustable value', numeric: true, render: (a) => <Amount value={a.adjustableValue} currency={a.currency} /> },
    { key: 'year', header: `FY ${assets.data.currentTaxYear} estimate`, numeric: true, render: (a) => (a.currentYear ? <Amount value={a.currentYear.deduction} currency={a.currency} /> : '—') },
    { key: 'status', header: 'Status', render: (a) => <LifecycleBadge lifecycle={a.lifecycle} /> },
  ];
  return (
    <>
      {header}
      {assets.data.assets.length === 0 ? (
        <EmptyState title="No assets yet" action={<ButtonLink to="/tax/assets/new" variant="primary">Register an asset</ButtonLink>}>
          Register a computer or other equipment once, with its cost, when you started using it and your chosen method and effective life. Money estimates each year's decline in value.
        </EmptyState>
      ) : (
        <Card flush>
          <Table<ListedAsset> label="Depreciating assets" columns={columns} rows={assets.data.assets} rowKey={(a) => a.id} />
        </Card>
      )}
      <Text size="sm" tone="muted">{DISCLAIMER}</Text>
    </>
  );
}

type AssetDraft = {
  name: string;
  description: string;
  category: string;
  currency: string;
  cost: string;
  acquiredOn: string;
  firstUsedOn: string;
  method: TaxAsset['method'];
  effectiveLifeYears: string;
  ratePercent: string;
  defaultUsePercent: string;
  ownership: string;
  disposedOn: string;
  disposalProceeds: string;
  notes: string;
};

const blankAsset: AssetDraft = {
  name: '',
  description: '',
  category: 'depreciating-assets',
  currency: 'AUD',
  cost: '',
  acquiredOn: '',
  firstUsedOn: '',
  method: 'DIMINISHING_VALUE',
  effectiveLifeYears: '',
  ratePercent: '',
  defaultUsePercent: '100',
  ownership: '',
  disposedOn: '',
  disposalProceeds: '',
  notes: '',
};

function assetDraft(a: TaxAsset): AssetDraft {
  return {
    name: a.name,
    description: a.description ?? '',
    category: a.category,
    currency: a.currency,
    cost: a.cost,
    acquiredOn: a.acquiredOn,
    firstUsedOn: a.firstUsedOn ?? '',
    method: a.method,
    effectiveLifeYears: a.effectiveLifeYears ?? '',
    ratePercent: a.ratePercent ?? '',
    defaultUsePercent: a.defaultUsePercent,
    ownership: a.ownership ?? '',
    disposedOn: a.disposedOn ?? '',
    disposalProceeds: a.disposalProceeds ?? '',
    notes: a.notes ?? '',
  };
}

type AssetErrors = Partial<Record<keyof AssetDraft, string>>;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateAsset(d: AssetDraft): AssetErrors {
  const e: AssetErrors = {};
  if (!d.name.trim()) e.name = 'Name the asset.';
  if (!isPositiveDecimal(d.cost)) e.cost = 'Enter the cost, e.g. 6249.00.';
  if (!DATE.test(d.acquiredOn)) e.acquiredOn = 'Enter the purchase date.';
  if (d.method !== 'IMMEDIATE' && !d.effectiveLifeYears.trim() && !d.ratePercent.trim()) e.effectiveLifeYears = 'Enter the effective life you have chosen (or a rate). Money does not assume one.';
  if (d.effectiveLifeYears.trim() && !isPositiveDecimal(d.effectiveLifeYears)) e.effectiveLifeYears = 'Use a number of years, e.g. 4.';
  if (d.ratePercent.trim() && !isPercent(d.ratePercent)) e.ratePercent = 'Use a percentage up to 100.';
  if (!isPercent(d.defaultUsePercent)) e.defaultUsePercent = 'Use a percentage from 0 to 100.';
  if (d.disposalProceeds.trim() && !isDecimal(d.disposalProceeds)) e.disposalProceeds = 'Use a number, e.g. 1200.';
  if (d.disposalProceeds.trim() && !d.disposedOn) e.disposedOn = 'Enter when it was disposed of.';
  return e;
}

function AssetForm({ initial, submitLabel, pending, error, onSubmit, onCancel, editing }: { initial: AssetDraft; submitLabel: string; pending: boolean; error: unknown; onSubmit: (d: AssetDraft) => void; onCancel?: () => void; editing: boolean }) {
  const [d, setD] = useState(initial);
  const [errors, setErrors] = useState<AssetErrors>({});
  const set = <K extends keyof AssetDraft>(key: K, value: AssetDraft[K]) => setD((x) => ({ ...x, [key]: value }));
  return (
    <Form
      label={submitLabel}
      onSubmit={() => {
        const found = validateAsset(d);
        setErrors(found);
        if (Object.keys(found).length === 0) onSubmit(d);
      }}
    >
      <Stack gap={3}>
        <TextField label="Name" value={d.name} onChange={(e) => set('name', e.target.value)} error={errors.name} placeholder="NVIDIA DGX Spark" />
        <Row gap={3} align="start">
          <DecimalField label="Cost" value={d.cost} onChange={(e) => set('cost', e.target.value)} error={errors.cost} hint="Purchase price plus costs to get it ready" />
          <TextField label="Currency" value={d.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={3} />
        </Row>
        <Row gap={3} align="start">
          <TextField label="Acquired on" type="date" value={d.acquiredOn} onChange={(e) => set('acquiredOn', e.target.value)} error={errors.acquiredOn} />
          <TextField label="First used / installed ready" type="date" value={d.firstUsedOn} onChange={(e) => set('firstUsedOn', e.target.value)} hint="Decline in value starts here. Leave empty if not in use yet." />
        </Row>
        <Row gap={3} align="start">
          <SelectField label="Method" value={d.method} onChange={(e) => set('method', e.target.value as AssetDraft['method'])}>
            {Object.entries(METHOD_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </SelectField>
          <DecimalField label="Effective life (years)" value={d.effectiveLifeYears} onChange={(e) => set('effectiveLifeYears', e.target.value)} error={errors.effectiveLifeYears} hint="Your choice, e.g. from the ATO's published determination" />
          <DecimalField label="Rate % (optional)" value={d.ratePercent} onChange={(e) => set('ratePercent', e.target.value)} error={errors.ratePercent} hint="Overrides the rate from effective life" />
        </Row>
        {d.method === 'IMMEDIATE' && (
          <Callout tone="warning">Immediate deduction writes off the full cost in the first year of use. Only use it if you have confirmed the asset qualifies; Money does not check.</Callout>
        )}
        <DecimalField label="Work use % (default for every year)" value={d.defaultUsePercent} onChange={(e) => set('defaultUsePercent', e.target.value)} error={errors.defaultUsePercent} hint="Change individual years later in the schedule" />
        <TextAreaField label="Ownership and use" rows={2} value={d.ownership} onChange={(e) => set('ownership', e.target.value)} placeholder="Owned by me; used for consulting and research at home" />
        {editing && (
          <Row gap={3} align="start">
            <TextField label="Disposed of on" type="date" value={d.disposedOn} onChange={(e) => set('disposedOn', e.target.value)} error={errors.disposedOn} hint="Sold, scrapped or no longer used" />
            <DecimalField label="Disposal proceeds" value={d.disposalProceeds} onChange={(e) => set('disposalProceeds', e.target.value)} error={errors.disposalProceeds} hint="Sale price or payout; empty counts as 0" />
          </Row>
        )}
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

const orUndefined = (v: string) => (v.trim() ? v.trim() : undefined);
const orNull = (v: string) => (v.trim() ? v.trim() : null);

export function NewTaxAssetPage() {
  const navigate = useNavigate();
  const register = useRegisterAsset();
  return (
    <>
      <PageHeader title="Register an asset" subtitle="Enter it once; Money estimates its decline in value for every financial year from these inputs. You can link the payment and invoice next." />
      <TaxNav />
      <Card>
        <AssetForm
          initial={blankAsset}
          editing={false}
          submitLabel="Register asset"
          pending={register.isPending}
          error={register.error}
          onCancel={() => navigate(-1)}
          onSubmit={(d) =>
            register.mutate(
              {
                name: d.name.trim(),
                category: orUndefined(d.category),
                currency: d.currency.trim(),
                cost: d.cost.trim(),
                acquiredOn: d.acquiredOn,
                firstUsedOn: orUndefined(d.firstUsedOn),
                method: d.method,
                effectiveLifeYears: orUndefined(d.effectiveLifeYears),
                ratePercent: orUndefined(d.ratePercent),
                defaultUsePercent: d.defaultUsePercent.trim(),
                ownership: orUndefined(d.ownership),
                notes: orUndefined(d.notes),
              },
              { onSuccess: (asset) => navigate(`/tax/assets/${asset.id}`) },
            )
          }
        />
      </Card>
      <Text size="sm" tone="muted">{DISCLAIMER}</Text>
    </>
  );
}

function YearEditor({ assetId, row, onDone }: { assetId: string; row: DepreciationRow; onDone: () => void }) {
  const save = useSetAssetYear();
  const [usePercent, setUsePercent] = useState(row.review.usePercentOverride ?? '');
  const [status, setStatus] = useState(row.review.status);
  const [claimed, setClaimed] = useState(row.review.claimedAmount ?? '');
  const [balancingClaimed, setBalancingClaimed] = useState(row.review.balancingClaimedAmount ?? '');
  const [error, setError] = useState<string>();
  const balancing = row.balancingAdjustment && Number(row.balancingAdjustment.amount) !== 0 ? row.balancingAdjustment : null;
  // A disposal year after a write-off has no decline left: only the balancing adjustment can be claimed
  const hasDecline = !(balancing && Number(row.openingValue) === 0 && Number(row.decline) === 0);
  return (
    <Form
      label={`Edit ${row.taxYear}`}
      onSubmit={() => {
        if (usePercent.trim() && !isPercent(usePercent)) return setError('Use a percentage from 0 to 100, or leave empty for the default.');
        if (claimed.trim() && !isDecimal(claimed)) return setError('Claimed amount must be a number.');
        if (balancingClaimed.trim() && !isDecimal(balancingClaimed)) return setError('Balancing adjustment claimed must be a positive number.');
        setError(undefined);
        const body = {
          usePercent: orNull(usePercent),
          status,
          ...(hasDecline ? { claimedAmount: orNull(claimed) } : {}),
          ...(balancing ? { balancingClaimedAmount: orNull(balancingClaimed) } : {}),
        };
        save.mutate({ assetId, taxYear: row.taxYear, body }, { onSuccess: onDone });
      }}
    >
      <Stack gap={2}>
        <Row gap={2} align="start">
          <DecimalField label={`Work use % in ${row.taxYear}`} value={usePercent} onChange={(e) => setUsePercent(e.target.value)} placeholder={`default ${row.usePercentSource === 'default' ? row.usePercent : ''}`} hint="Empty: the asset's default" />
          <SelectField label="Review" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="TO_REVIEW">To review</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="EXCLUDED">Excluded</option>
          </SelectField>
          {hasDecline && <DecimalField label="Depreciation claimed" value={claimed} onChange={(e) => setClaimed(e.target.value)} hint="Decline in value on the lodged return" />}
          {balancing && (
            <DecimalField
              label="Balancing adjustment claimed"
              value={balancingClaimed}
              onChange={(e) => setBalancingClaimed(e.target.value)}
              hint={Number(balancing.amount) > 0 ? 'Returned as assessable income' : 'Claimed as a deduction'}
            />
          )}
        </Row>
        <Row gap={2}>
          {error && <Text size="sm" tone="danger">{error}</Text>}
        </Row>
        <ApiErrorCallout error={save.error} title="Not saved" />
        <Row gap={2} justify="end">
          <Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
          <Button type="submit" size="sm" variant="primary" disabled={save.isPending}>Save year</Button>
        </Row>
      </Stack>
    </Form>
  );
}

/** One asset: inputs, the multi-year schedule with per-year use %, payment links and evidence */
export function TaxAssetPage() {
  const { assetId = '' } = useParams();
  const navigate = useNavigate();
  const [throughYear, setThroughYear] = useState<string>();
  const asset = useTaxAsset(assetId, throughYear);
  const update = useUpdateAsset();
  const remove = useDeleteAsset();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editingYear, setEditingYear] = useState<string | null>(null);

  if (asset.isPending) return <><TaxNav /><Loading label="Loading asset…" /></>;
  if (asset.isError) return <><TaxNav /><ApiErrorCallout error={asset.error} title="Could not load this asset" /></>;
  const a = asset.data;
  const s = a.schedule;
  const last = s.rows.at(-1);

  const columns: Column<DepreciationRow>[] = [
    {
      key: 'year',
      header: 'Year',
      render: (r) => (
        <Stack gap={1}>
          <Link to={`/tax/years/${r.taxYear}`}>FY {r.taxYear}</Link>
          <Text size="xs" tone="muted" as="span">{r.daysHeld}/{r.daysInYear} days</Text>
          {r.yearStatus !== 'PREPARING' && <YearStatusBadge status={r.yearStatus} />}
        </Stack>
      ),
    },
    { key: 'opening', header: 'Opening value', numeric: true, render: (r) => <Amount value={r.openingValue} currency={a.currency} /> },
    { key: 'decline', header: 'Decline', numeric: true, render: (r) => <Amount value={r.decline} currency={a.currency} /> },
    { key: 'use', header: 'Work use', numeric: true, render: (r) => <span><Amount value={r.usePercent} kind="percent" />{r.usePercentSource === 'year' && <Text size="xs" tone="muted" as="span"> (this year)</Text>}</span> },
    {
      key: 'deduction',
      header: 'Deduction (estimate)',
      numeric: true,
      render: (r) => (
        <Stack gap={1}>
          <Amount value={r.deduction} currency={a.currency} />
          {r.filed && <Text size="xs" tone={r.driftFromFiled ? 'danger' : 'muted'} as="span">filed {r.filed.deduction ?? '—'}{r.driftFromFiled ? ' (inputs changed since)' : ''}</Text>}
          {r.balancingAdjustment && <Text size="xs" tone="muted" as="span">balancing adj. {r.balancingAdjustment.taxableAmount}</Text>}
        </Stack>
      ),
    },
    { key: 'closing', header: 'Closing value', numeric: true, render: (r) => <Amount value={r.closingValue} currency={a.currency} /> },
    { key: 'review', header: 'Review', render: (r) => <Stack gap={1}><ReviewBadge status={r.review.status} />{r.review.claimedAmount && <Text size="xs" tone="muted" as="span">claimed {r.review.claimedAmount}</Text>}{r.review.balancingClaimedAmount && <Text size="xs" tone="muted" as="span">balancing claimed {r.review.balancingClaimedAmount}</Text>}</Stack> },
    { key: 'edit', header: '', render: (r) => (r.yearStatus === 'FILED' ? null : <Button size="sm" variant="ghost" onClick={() => setEditingYear(r.taxYear)}>Edit year</Button>) },
  ];
  const editingRow = s.rows.find((r) => r.taxYear === editingYear);

  return (
    <>
      <PageHeader
        title={a.name}
        subtitle={<>{METHOD_LABELS[a.method]} · <LifecycleBadge lifecycle={a.lifecycle} /></>}
        actions={!editing ? (
          <>
            <Button onClick={() => { update.reset(); setEditing(true); }}>Edit</Button>
            <Button variant="ghost" onClick={() => { remove.reset(); setDeleting(true); }}>Delete</Button>
          </>
        ) : undefined}
      />
      <TaxNav />
      {deleting && (
        <Callout tone="warning" title="Delete this asset?">
          <Stack gap={2}>
            <Text size="sm">Only for an asset entered by mistake. Once it is in a filed return, record its disposal instead.</Text>
            <ApiErrorCallout error={remove.error} title="Not deleted" />
            <Row gap={1}>
              <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(a.id, { onSuccess: () => navigate('/tax/assets') })}>Delete asset</Button>
              <Button size="sm" onClick={() => setDeleting(false)}>Cancel</Button>
            </Row>
          </Stack>
        </Callout>
      )}
      {editing ? (
        <Card title="Edit asset">
          <AssetForm
            initial={assetDraft(a)}
            editing
            submitLabel="Save changes"
            pending={update.isPending}
            error={update.error}
            onCancel={() => setEditing(false)}
            onSubmit={(d) =>
              update.mutate(
                {
                  assetId: a.id,
                  body: {
                    name: d.name.trim(),
                    currency: d.currency.trim(),
                    cost: d.cost.trim(),
                    acquiredOn: d.acquiredOn,
                    firstUsedOn: orNull(d.firstUsedOn),
                    method: d.method,
                    effectiveLifeYears: orNull(d.effectiveLifeYears),
                    ratePercent: orNull(d.ratePercent),
                    defaultUsePercent: d.defaultUsePercent.trim(),
                    ownership: orNull(d.ownership),
                    disposedOn: orNull(d.disposedOn),
                    disposalProceeds: orNull(d.disposalProceeds),
                    notes: orNull(d.notes),
                  },
                },
                { onSuccess: () => setEditing(false) },
              )
            }
          />
        </Card>
      ) : (
        <Card title="Inputs">
          <DescriptionList
            items={[
              { term: 'Cost', detail: <Amount value={a.cost} currency={a.currency} /> },
              { term: 'Acquired', detail: a.acquiredOn },
              { term: 'First used', detail: a.firstUsedOn ?? 'Not in use yet' },
              { term: 'Method and rate', detail: `${METHOD_LABELS[a.method]}${s.ratePercent ? `, ${s.ratePercent}% a year` : ''}${a.effectiveLifeYears ? ` (effective life ${a.effectiveLifeYears} years)` : ''}` },
              { term: 'Default work use', detail: <Amount value={a.defaultUsePercent} kind="percent" /> },
              { term: 'Ownership and use', detail: a.ownership ?? '—' },
              ...(a.disposedOn ? [{ term: 'Disposed of', detail: <>{a.disposedOn}, proceeds <Amount value={a.disposalProceeds ?? '0'} currency={a.currency} /></> }] : []),
              { term: 'Adjustable value', detail: <Amount value={a.adjustableValue} currency={a.currency} /> },
            ]}
          />
        </Card>
      )}
      <Card
        title="Depreciation schedule"
        actions={s.endReason === 'HORIZON' && last ? <Button size="sm" onClick={() => setThroughYear(shiftYear(last.taxYear, 3))}>Show 3 more years</Button> : undefined}
      >
        <Stack gap={3}>
          {s.rows.length === 0 ? (
            <Text size="sm" tone="muted">No schedule yet: set the date it was first used or installed ready for use.</Text>
          ) : (
            <Table<DepreciationRow>
              label="Depreciation schedule"
              columns={columns}
              rows={s.rows}
              rowKey={(r) => r.taxYear}
              footer={
                <tr>
                  <td>Total</td>
                  <td />
                  <td className="num"><Amount value={s.totals.decline} currency={a.currency} /></td>
                  <td />
                  <td className="num"><Amount value={s.totals.deduction} currency={a.currency} /></td>
                  <td colSpan={3} />
                </tr>
              }
            />
          )}
          {editingRow && <YearEditor key={editingRow.taxYear} assetId={a.id} row={editingRow} onDone={() => setEditingYear(null)} />}
          {s.rows.length > 0 && (
            <details>
              <summary>How these figures are worked out</summary>
              <Stack gap={2}>
                {s.rows.map((r) => <Text key={r.taxYear} size="sm"><strong>FY {r.taxYear}:</strong> {r.workings}</Text>)}
                <Text size="xs" tone="muted">Rules {s.rulesVersion}.</Text>
                {s.notes.map((n) => <Text key={n} size="xs" tone="muted">{n}</Text>)}
              </Stack>
            </details>
          )}
        </Stack>
      </Card>
      <LinksCard owner={{ assetId: a.id }} links={a.links} locked={false} hint="The payment(s) for the purchase. Linking them here means they can't also be claimed as an expense, so the purchase is never counted twice." />
      <EvidenceCard owner={{ assetId: a.id }} evidence={a.evidence} locked={false} />
      <Text size="sm" tone="muted">{DISCLAIMER}</Text>
    </>
  );
}
