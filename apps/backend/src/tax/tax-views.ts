import { dec, MoneyDecimal, ZERO } from '../common/decimal';
import type { DepreciationSchedule, ScheduleRow } from './depreciation-math';
import { taxYearLabel, taxYearOf, taxYearPeriod } from './financial-year';
import type { LinkRow } from './tax.repository';
import type { EvidenceKind, ReviewStatus, TaxItemKind, TaxReturnStatus } from './tax.schemas';

/**
 * Pure mapping from stored rows to the views REST and MCP return: effective
 * amounts, proposed amounts, gaps and year totals. No I/O.
 */

export const HOME_CURRENCY = 'AUD';

const HUNDRED = new MoneyDecimal(100);
export const money = (value: MoneyDecimal | string) => dec(value).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toFixed(2);
export const moneyOrNull = (value: string | null | undefined) => (value === null || value === undefined ? null : money(value));
export const percentText = (value: string) => {
  const text = dec(value).toDecimalPlaces(6, MoneyDecimal.ROUND_HALF_UP).toFixed();
  return text === '-0' ? '0' : text;
};

/** Australia/Sydney calendar date of an instant */
export function australianDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export type LinkView = {
  id: string;
  source: 'manual' | 'up';
  transactionId: string | null;
  upTransactionId: string | null;
  accountId: string;
  accountName: string;
  type: string | null;
  date: string;
  currency: string;
  /** Absolute amount of the transaction */
  amount: string | null;
  direction: 'out' | 'in' | null;
  description: string | null;
  status: 'HELD' | 'SETTLED' | null;
  /** Up deleted the transaction after it was imported */
  deleted: boolean;
  note: string | null;
  /** Other tax items or assets linked to the same transaction */
  alsoLinkedTo: { itemId: string | null; assetId: string | null }[];
  createdAt: string;
};

export type EvidenceView = { id: string; label: string; url: string; kind: EvidenceKind; createdAt: string };

export const GAP_DESCRIPTIONS = {
  'needs-review': 'Still to review: confirm or exclude it',
  'no-evidence': 'No evidence link (receipt, invoice or calculation)',
  'no-transaction': 'Not linked to a transaction (manual or not yet matched)',
  'no-amount': 'No amount: enter one or link the transaction',
  'not-aud': 'Not in AUD: an Australian return needs AUD amounts',
  'currency-mismatch': 'A linked transaction is in another currency and is not counted in the amount',
  'shared-transaction': 'A linked transaction is also linked elsewhere: check it is not counted twice',
  'outside-year': 'Its date is outside this financial year: check the year',
  'not-in-use': 'Not used or installed ready yet: no decline in value until it is',
  'removed-transaction': 'A linked Up transaction was deleted at Up',
} as const;
export type GapCode = keyof typeof GAP_DESCRIPTIONS;

export function linkView(link: LinkRow, all: readonly LinkRow[]): LinkView {
  const s = link.source;
  const signed = s.amount === null ? null : dec(s.amount);
  const sameSource = all.filter((l) => l.id !== link.id && ((link.transactionId && l.transactionId === link.transactionId) || (link.upTransactionId && l.upTransactionId === link.upTransactionId)));
  const isUp = s.kind === 'up';
  const outflowTypes = new Set(['WITHDRAWAL', 'BUY', 'TRANSFER_OUT', 'FX_CONVERSION']);
  return {
    id: link.id,
    source: s.kind,
    transactionId: link.transactionId,
    upTransactionId: link.upTransactionId,
    accountId: s.accountId,
    accountName: s.accountName,
    type: s.type,
    date: typeof s.date === 'string' ? s.date : australianDate(s.date),
    currency: s.currency,
    amount: signed === null ? null : money(signed.abs()),
    direction: signed === null ? null : isUp ? (signed.lt(0) ? 'out' : 'in') : outflowTypes.has(s.type ?? '') ? 'out' : 'in',
    description: s.description,
    status: s.status,
    deleted: s.deleted,
    note: link.note,
    alsoLinkedTo: sameSource.map((l) => ({ itemId: l.itemId, assetId: l.assetId })),
    createdAt: link.createdAt.toISOString(),
  };
}

/** The amount a position is based on: the one entered, else the linked transactions in the same currency */
export function effectiveAmount(entered: string | null, currency: string, links: readonly LinkView[]): { amount: string | null; source: 'entered' | 'linked' | 'missing'; mismatched: boolean } {
  const usable = links.filter((l) => !l.deleted && l.amount !== null);
  const mismatched = usable.some((l) => l.currency !== currency);
  if (entered !== null) return { amount: money(entered), source: 'entered', mismatched };
  const same = usable.filter((l) => l.currency === currency);
  if (same.length === 0) return { amount: null, source: 'missing', mismatched };
  return { amount: money(same.reduce((t, l) => t.plus(l.amount as string), ZERO)), source: 'linked', mismatched };
}

export function proposed(amount: string | null, percent: string): string | null {
  return amount === null ? null : money(dec(amount).times(percent).div(HUNDRED));
}

export type ItemFacts = {
  id: string;
  startYear: number;
  kind: TaxItemKind;
  category: string;
  description: string;
  incurredOn: string | null;
  currency: string;
  amount: string | null;
  claimPercent: string;
  status: ReviewStatus;
  rationale: string | null;
  notes: string | null;
  claimedAmount: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TaxItemView = {
  id: string;
  taxYear: string;
  kind: TaxItemKind;
  category: string;
  description: string;
  date: string | null;
  currency: string;
  amount: string | null;
  amountSource: 'entered' | 'linked' | 'missing';
  effectiveAmount: string | null;
  claimPercent: string;
  proposedAmount: string | null;
  claimedAmount: string | null;
  status: ReviewStatus;
  rationale: string | null;
  notes: string | null;
  links: LinkView[];
  evidence: EvidenceView[];
  gaps: GapCode[];
  yearStatus: TaxReturnStatus;
  /** true while the year is filed: edits are refused until it is reopened for amendment */
  locked: boolean;
  createdAt: string;
  updatedAt: string;
};

export function itemView(item: ItemFacts, links: LinkView[], evidence: EvidenceView[], yearStatus: TaxReturnStatus): TaxItemView {
  const effective = effectiveAmount(item.amount, item.currency, links);
  const gaps: GapCode[] = [];
  if (item.status === 'TO_REVIEW') gaps.push('needs-review');
  if (item.status !== 'EXCLUDED') {
    if (evidence.length === 0) gaps.push('no-evidence');
    if (links.length === 0) gaps.push('no-transaction');
    if (effective.amount === null) gaps.push('no-amount');
    if (item.currency !== HOME_CURRENCY) gaps.push('not-aud');
    if (effective.mismatched) gaps.push('currency-mismatch');
    if (links.some((l) => l.alsoLinkedTo.length > 0)) gaps.push('shared-transaction');
    if (links.some((l) => l.deleted)) gaps.push('removed-transaction');
    if (item.incurredOn && taxYearOf(item.incurredOn) !== item.startYear) gaps.push('outside-year');
  }
  return {
    id: item.id,
    taxYear: taxYearLabel(item.startYear),
    kind: item.kind,
    category: item.category,
    description: item.description,
    date: item.incurredOn,
    currency: item.currency,
    amount: moneyOrNull(item.amount),
    amountSource: effective.source,
    effectiveAmount: effective.amount,
    claimPercent: percentText(item.claimPercent),
    proposedAmount: proposed(effective.amount, item.claimPercent),
    claimedAmount: moneyOrNull(item.claimedAmount),
    status: item.status,
    rationale: item.rationale,
    notes: item.notes,
    links,
    evidence,
    gaps,
    yearStatus,
    locked: yearStatus === 'FILED',
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

/** One line of a year's return: a tax item, or an asset's depreciation (or balancing adjustment) for the year */
export type PositionView = {
  id: string;
  source: 'ITEM' | 'ASSET';
  itemId: string | null;
  assetId: string | null;
  kind: TaxItemKind;
  category: string;
  description: string;
  date: string | null;
  currency: string;
  /** Full amount before the claim or use percentage */
  amount: string | null;
  /** Claim percentage (items) or work-use percentage (assets) */
  percent: string;
  proposedAmount: string | null;
  claimedAmount: string | null;
  status: ReviewStatus;
  linkCount: number;
  evidenceCount: number;
  gaps: GapCode[];
  /** Assets: how the figure was worked out */
  workings: string | null;
};

export function itemPosition(item: TaxItemView): PositionView {
  return {
    id: item.id,
    source: 'ITEM',
    itemId: item.id,
    assetId: null,
    kind: item.kind,
    category: item.category,
    description: item.description,
    date: item.date,
    currency: item.currency,
    amount: item.effectiveAmount,
    percent: item.claimPercent,
    proposedAmount: item.proposedAmount,
    claimedAmount: item.claimedAmount,
    status: item.status,
    linkCount: item.links.length,
    evidenceCount: item.evidence.length,
    gaps: item.gaps,
    workings: null,
  };
}

export type AssetFacts = { id: string; name: string; category: string; currency: string; linkCount: number; evidenceCount: number };
export type AssetYearFacts = { status: ReviewStatus; claimedAmount: string | null } | null;

/** The depreciation (and any balancing adjustment) one schedule row contributes to its year */
export function assetPositions(asset: AssetFacts, row: ScheduleRow, record: AssetYearFacts): PositionView[] {
  const status = record?.status ?? 'TO_REVIEW';
  const gaps: GapCode[] = [];
  if (status === 'TO_REVIEW') gaps.push('needs-review');
  if (status !== 'EXCLUDED') {
    if (asset.evidenceCount === 0) gaps.push('no-evidence');
    if (asset.linkCount === 0) gaps.push('no-transaction');
    if (asset.currency !== HOME_CURRENCY) gaps.push('not-aud');
  }
  const base = {
    source: 'ASSET' as const,
    itemId: null,
    assetId: asset.id,
    category: asset.category,
    date: row.periodEnd,
    currency: asset.currency,
    status,
    linkCount: asset.linkCount,
    evidenceCount: asset.evidenceCount,
    gaps,
  };
  const positions: PositionView[] = [
    {
      ...base,
      id: `asset:${asset.id}:${row.taxYear}`,
      kind: 'DEDUCTION',
      description: `Decline in value: ${asset.name} (estimate)`,
      amount: row.decline,
      percent: row.usePercent,
      proposedAmount: row.deduction,
      claimedAmount: moneyOrNull(record?.claimedAmount),
      workings: row.workings,
    },
  ];
  const balancing = row.balancingAdjustment;
  if (balancing && !dec(balancing.amount).isZero()) {
    const assessable = dec(balancing.amount).gt(0);
    positions.push({
      ...base,
      id: `asset:${asset.id}:${row.taxYear}:balancing`,
      kind: assessable ? 'INCOME' : 'DEDUCTION',
      description: `Balancing adjustment on disposal: ${asset.name} (estimate, ${assessable ? 'assessable' : 'deductible'})`,
      amount: money(dec(balancing.amount).abs()),
      percent: row.usePercent,
      proposedAmount: money(dec(balancing.taxableAmount).abs()),
      claimedAmount: null,
      workings: `Termination value ${balancing.terminationValue} − adjustable value ${balancing.adjustableValue} = ${balancing.amount}; × ${row.usePercent}% work use = ${balancing.taxableAmount}.`,
    });
  }
  return positions;
}

export type TotalLine = { kind: TaxItemKind; currency: string; count: number; proposed: string; confirmed: string; claimed: string };
export type CategoryTotalLine = TotalLine & { category: string };

type Acc = { kind: TaxItemKind; currency: string; category: string; count: number; proposed: MoneyDecimal; confirmed: MoneyDecimal; claimed: MoneyDecimal };
const KIND_ORDER: readonly string[] = ['DEDUCTION', 'INCOME', 'OFFSET', 'OTHER'];

/** Totals per kind and per category, per currency. EXCLUDED positions are left out of proposed and confirmed. */
export function totalsOf(positions: readonly PositionView[]): { byKind: TotalLine[]; byCategory: CategoryTotalLine[] } {
  const byKind = new Map<string, Acc>();
  const byCategory = new Map<string, Acc>();
  const add = (map: Map<string, Acc>, key: string, p: PositionView, category: string) => {
    const line = map.get(key) ?? { kind: p.kind, currency: p.currency, category, count: 0, proposed: ZERO, confirmed: ZERO, claimed: ZERO };
    line.count += 1;
    if (p.status !== 'EXCLUDED' && p.proposedAmount !== null) line.proposed = line.proposed.plus(p.proposedAmount);
    if (p.status === 'CONFIRMED' && p.proposedAmount !== null) line.confirmed = line.confirmed.plus(p.proposedAmount);
    if (p.claimedAmount !== null) line.claimed = line.claimed.plus(p.claimedAmount);
    map.set(key, line);
  };
  for (const p of positions) {
    add(byKind, `${p.kind}|${p.currency}`, p, '');
    add(byCategory, `${p.kind}|${p.category}|${p.currency}`, p, p.category);
  }
  const order = (a: Acc, b: Acc) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.category.localeCompare(b.category) || a.currency.localeCompare(b.currency);
  const out = (l: Acc): TotalLine => ({ kind: l.kind, currency: l.currency, count: l.count, proposed: money(l.proposed), confirmed: money(l.confirmed), claimed: money(l.claimed) });
  return {
    byKind: [...byKind.values()].sort(order).map(out),
    byCategory: [...byCategory.values()].sort(order).map((l) => ({ ...out(l), category: l.category })),
  };
}

export type GapSummary = { counts: Partial<Record<GapCode, number>>; positions: { id: string; description: string; gaps: GapCode[] }[] };

export function gapSummary(positions: readonly PositionView[]): GapSummary {
  const counts: Partial<Record<GapCode, number>> = {};
  for (const p of positions) for (const g of p.gaps) counts[g] = (counts[g] ?? 0) + 1;
  return { counts, positions: positions.filter((p) => p.gaps.length > 0).map((p) => ({ id: p.id, description: p.description, gaps: p.gaps })) };
}

/** Schedule rows for one year (start year), if the asset has one */
export function rowFor(schedule: DepreciationSchedule, startYear: number): ScheduleRow | undefined {
  return schedule.rows.find((r) => r.startYear === startYear);
}

export function periodOf(startYear: number) {
  const p = taxYearPeriod(startYear);
  return { start: p.start, end: p.end, days: p.days };
}
