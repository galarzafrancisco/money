import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ConflictError, NotFoundError } from '../common/errors';
import { parseInput } from '../common/validation';
import { UnitOfWork } from '../database/unit-of-work';
import type { CurrentUser } from '../users/users.service';
import { DEPRECIATION_RULES_VERSION } from './depreciation-math';
import { JURISDICTION, taxYearLabel, taxYearOf, todayInAustralia } from './financial-year';
import { renderCsv, renderMarkdown } from './tax-report';
import { TaxAssetsService } from './tax-assets.service';
import { TAX_NOTES, TaxLedgerService } from './tax-ledger.service';
import { driftOf, gapSummary, GAP_DESCRIPTIONS, itemPosition, periodOf, totalsOf, withoutDetail, type CategoryTotalLine, type DetailedPosition, type DriftLine, type GapSummary, type TotalLine } from './tax-views';
import type { TaxReturnFilingEntity } from './tax.entities';
import { TaxRepository } from './tax.repository';
import {
  amendYearSchema,
  fileYearSchema,
  reportQuerySchema,
  taxYear as taxYearSchema,
  updateYearSchema,
  type AmendYearInput,
  type FileYearInput,
  type ReportQueryInput,
  type TaxReturnStatus,
  type UpdateYearInput,
} from './tax.schemas';

/**
 * What a filing stores: the year's positions and totals exactly as they were
 * filed, with each position's supporting detail (rationale, notes, source
 * transactions, evidence URLs, asset inputs), so the filing stays complete
 * when the live records later change or are deleted.
 */
export type FilingSnapshot = {
  taxYear: string;
  jurisdiction: string;
  period: { start: string; end: string };
  version: number;
  kind: 'ORIGINAL' | 'AMENDMENT';
  filedOn: string;
  reference: string | null;
  note: string | null;
  amendmentReason: string | null;
  rulesVersion: string;
  positions: DetailedPosition[];
  totals: { byKind: TotalLine[]; byCategory: CategoryTotalLine[] };
  gaps: GapSummary;
};

export type FilingView = {
  id: string;
  version: number;
  kind: 'ORIGINAL' | 'AMENDMENT';
  filedOn: string;
  reference: string | null;
  note: string | null;
  amendmentReason: string | null;
  rulesVersion: string;
  positionCount: number;
  totals: { byKind: TotalLine[] };
  createdAt: string;
};

const YEAR_NOTES = [
  ...TAX_NOTES,
  'Positions are your tax items for the year plus each registered asset\'s estimated decline in value (and any balancing adjustment on disposal). An asset\'s purchase is never also an item, so it is not counted twice.',
  'proposed excludes EXCLUDED positions; confirmed counts CONFIRMED ones only; claimed is what you recorded as actually claimed.',
  'Filing stores an immutable snapshot. A filed year is read-only; reopen it for amendment to change it, then file again to store the amendment as a new version.',
  'For a filed year, positions and totals are the latest filed snapshot (basis FILED). If the live records behind it have changed since (an asset, a linked transaction, evidence), the live recomputation is shown separately under live, and drift lists every difference.',
];

function driftWarning(version: number, count: number): string {
  return `The live records have changed since filed version ${version}: ${count} position(s) differ (see drift). The figures shown are as filed; reopen the year for amendment to correct them.`;
}

function filingView(f: TaxReturnFilingEntity): FilingView {
  const s = f.snapshot as FilingSnapshot;
  return {
    id: f.id,
    version: f.version,
    kind: f.kind,
    filedOn: f.filedOn,
    reference: f.reference,
    note: f.note,
    amendmentReason: s.amendmentReason ?? null,
    rulesVersion: s.rulesVersion,
    positionCount: s.positions.length,
    totals: { byKind: s.totals.byKind },
    createdAt: f.createdAt.toISOString(),
  };
}

/** Financial years as returns: annual summaries, reports, filing snapshots and amendments. See docs/tax.md. */
@Injectable()
export class TaxYearsService {
  constructor(
    private readonly repo: TaxRepository,
    private readonly ledger: TaxLedgerService,
    private readonly assets: TaxAssetsService,
    private readonly uow: UnitOfWork,
  ) {}

  /** Every year with something in it (and the current year), newest first */
  async list(user: CurrentUser) {
    const current = taxYearOf(todayInAustralia());
    const [items, returns, depreciationYears] = [await this.repo.listItems(user.id), await this.repo.listReturns(user.id), await this.assets.yearsWithDepreciation(user.id, current)];
    const years = [...new Set([current, ...items.map((i) => i.startYear), ...returns.map((r) => r.startYear), ...depreciationYears])].sort((a, b) => b - a);
    const summaries = [];
    for (const year of years) {
      const s = await this.summary(user, taxYearLabel(year));
      summaries.push({
        taxYear: s.taxYear,
        period: s.period,
        status: s.status,
        current: year === current,
        positionCount: s.positions.length,
        itemCount: s.positions.filter((p) => p.source === 'ITEM').length,
        assetPositionCount: s.positions.filter((p) => p.source === 'ASSET').length,
        toReview: s.positions.filter((p) => p.status === 'TO_REVIEW').length,
        withGaps: s.gaps.positions.length,
        totals: s.totals.byKind,
        latestFiling: s.filings.at(-1) ?? null,
      });
    }
    return { currentTaxYear: taxYearLabel(current), years: summaries, notes: TAX_NOTES };
  }

  /**
   * The year's positions, totals, gaps, status and filing history. A filed
   * year answers with its latest filed snapshot (basis FILED); the figures
   * computed from the live records now are kept apart under `live`, and
   * `drift` lists every difference. While preparing or amending, the live
   * figures are the year's positions, and `drift` compares them with the
   * latest filing, if any.
   */
  async summary(user: CurrentUser, taxYear: string, manager?: EntityManager) {
    const year = parseInput(taxYearSchema, taxYear);
    const row = await this.repo.findReturn(user.id, year, manager);
    const filings = row ? await this.repo.listFilings(user.id, [row.id], manager) : [];
    const live = await this.livePositions(user.id, year, manager);
    const latest = filings.reduce<TaxReturnFilingEntity | undefined>((a, f) => (a && a.version > f.version ? a : f), undefined);
    const latestSnapshot = latest ? (latest.snapshot as FilingSnapshot) : undefined;
    const filed = row?.status === 'FILED' ? latestSnapshot : undefined;
    const primary = filed ? filed.positions : live;
    const positions = primary.map(withoutDetail);
    const livePositions = live.map(withoutDetail);
    const drift: DriftLine[] = latestSnapshot && row?.status !== 'PREPARING' ? driftOf(latestSnapshot.positions, live) : [];
    const shared = positions.filter((p) => p.gaps.includes('shared-transaction'));
    const warnings = [
      ...(filed && drift.length > 0 ? [driftWarning(filed.version, drift.length)] : []),
      ...(shared.length > 0 ? [`${shared.length} position(s) share a linked transaction with another position: check nothing is counted twice.`] : []),
      ...(positions.some((p) => p.gaps.includes('not-aud')) ? ['Some positions are not in AUD; totals are kept per currency and are not converted.'] : []),
      ...(row?.status === 'AMENDING' ? [`Reopened for amendment: ${row.amendingReason ?? 'no reason given'}. File again to store the amendment.`] : []),
    ];
    return {
      taxYear: taxYearLabel(year),
      jurisdiction: JURISDICTION,
      period: periodOf(year),
      status: (row?.status ?? 'PREPARING') as TaxReturnStatus,
      basis: (filed ? 'FILED' : 'LIVE') as 'FILED' | 'LIVE',
      filedVersion: filed ? filed.version : null,
      notes: row?.notes ?? null,
      amendingReason: row?.amendingReason ?? null,
      positions,
      totals: filed ? filed.totals : totalsOf(positions),
      gaps: filed ? filed.gaps : gapSummary(positions),
      gapDescriptions: GAP_DESCRIPTIONS,
      warnings,
      live: filed ? { positions: livePositions, totals: totalsOf(livePositions) } : null,
      drift,
      filings: filings.map(filingView),
      rulesVersion: filed ? filed.rulesVersion : DEPRECIATION_RULES_VERSION,
      disclaimers: YEAR_NOTES,
    };
  }

  /** A copyable Markdown summary and a CSV of the positions (a filed year's latest filing, the live year, or a given filed version) */
  async report(user: CurrentUser, taxYear: string, query: ReportQueryInput = {}) {
    const options = parseInput(reportQuerySchema, query);
    if (options.version !== undefined) {
      const filing = await this.filing(user, taxYear, options.version);
      const input = { taxYear: filing.taxYear, period: filing.period, status: filing.kind === 'ORIGINAL' ? 'FILED' : 'AMENDED', positions: filing.positions.map(withoutDetail), totals: filing.totals, filedVersion: filing.version };
      return { taxYear: filing.taxYear, version: filing.version, markdown: renderMarkdown(input), csv: renderCsv(input) };
    }
    const s = await this.summary(user, taxYear);
    const input = { taxYear: s.taxYear, period: s.period, status: s.status, positions: s.positions, totals: s.totals, filedVersion: s.filedVersion, warnings: s.filedVersion !== null && s.drift.length > 0 ? [driftWarning(s.filedVersion, s.drift.length)] : [] };
    return { taxYear: s.taxYear, version: s.filedVersion, markdown: renderMarkdown(input), csv: renderCsv(input) };
  }

  async updateNotes(user: CurrentUser, taxYear: string, input: UpdateYearInput) {
    const year = parseInput(taxYearSchema, taxYear);
    const data = parseInput(updateYearSchema, input);
    await this.uow.run(async (manager) => {
      const row = await this.repo.lockReturn(user.id, year, manager);
      row.notes = data.notes || null;
      await this.repo.saveReturn(row, manager);
    });
    return this.summary(user, taxYear);
  }

  /**
   * Records that the year's return (or its amendment) was lodged: stores an
   * immutable snapshot of every position and total, and makes the year
   * read-only. Refused while positions are still TO_REVIEW unless
   * allowUnreviewed is set.
   */
  async file(user: CurrentUser, taxYear: string, input: FileYearInput) {
    const year = parseInput(taxYearSchema, taxYear);
    const data = parseInput(fileYearSchema, input);
    await this.uow.run(async (manager) => {
      const row = await this.repo.lockReturn(user.id, year, manager);
      if (row.status === 'FILED') throw new ConflictError(`Tax year ${taxYearLabel(year)} is already filed. Reopen it for amendment to file a correction.`, { status: row.status });
      const positions = await this.livePositions(user.id, year, manager);
      const unreviewed = positions.filter((p) => p.status === 'TO_REVIEW');
      if (unreviewed.length > 0 && !data.allowUnreviewed) {
        throw new ConflictError(`${unreviewed.length} position(s) are still TO_REVIEW. Confirm or exclude them, or pass allowUnreviewed: true.`, { positions: unreviewed.map((p) => ({ id: p.id, description: p.description })) });
      }
      const previous = await this.repo.listFilings(user.id, [row.id], manager);
      const version = previous.length + 1;
      const kind = version === 1 ? 'ORIGINAL' : 'AMENDMENT';
      const plain = positions.map(withoutDetail);
      const period = periodOf(year);
      const snapshot: FilingSnapshot = {
        taxYear: taxYearLabel(year),
        jurisdiction: JURISDICTION,
        period: { start: period.start, end: period.end },
        version,
        kind,
        filedOn: data.filedOn,
        reference: data.reference || null,
        note: data.note || null,
        amendmentReason: kind === 'AMENDMENT' ? row.amendingReason : null,
        rulesVersion: DEPRECIATION_RULES_VERSION,
        positions,
        totals: totalsOf(plain),
        gaps: gapSummary(plain),
      };
      await this.repo.addFiling({ userId: user.id, returnId: row.id, version, kind, filedOn: data.filedOn, reference: data.reference || null, note: data.note || null, snapshot }, manager);
      row.status = 'FILED';
      row.amendingReason = null;
      await this.repo.saveReturn(row, manager);
    });
    return this.summary(user, taxYear);
  }

  /** Reopens a filed year so it can be corrected. Earlier filings are kept unchanged. */
  async amend(user: CurrentUser, taxYear: string, input: AmendYearInput) {
    const year = parseInput(taxYearSchema, taxYear);
    const data = parseInput(amendYearSchema, input);
    await this.uow.run(async (manager) => {
      const row = await this.repo.lockReturn(user.id, year, manager);
      if (row.status !== 'FILED') throw new ConflictError(`Tax year ${taxYearLabel(year)} is ${row.status}, not filed: there is nothing to amend.`, { status: row.status });
      row.status = 'AMENDING';
      row.amendingReason = data.reason;
      await this.repo.saveReturn(row, manager);
    });
    return this.summary(user, taxYear);
  }

  /** The year's positions computed from the live records, with their supporting detail */
  private async livePositions(userId: string, year: number, manager?: EntityManager): Promise<DetailedPosition[]> {
    const items = await this.ledger.itemViews(userId, { startYear: year }, manager);
    const assetPositions = await this.assets.positionsFor(userId, year, manager);
    return [...items.map(itemPosition), ...assetPositions];
  }

  /** One filed version's full snapshot */
  async filing(user: CurrentUser, taxYear: string, version: string): Promise<FilingSnapshot & { id: string; createdAt: string }> {
    const year = parseInput(taxYearSchema, taxYear);
    const row = await this.repo.findReturn(user.id, year);
    const filing = row ? (await this.repo.listFilings(user.id, [row.id])).find((f) => String(f.version) === version) : undefined;
    if (!filing) throw new NotFoundError(`Filing version ${version} of ${taxYearLabel(year)} not found`);
    return { ...(filing.snapshot as FilingSnapshot), id: filing.id, createdAt: filing.createdAt.toISOString() };
  }
}
