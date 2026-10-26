import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { dec } from '../common/decimal';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { UnitOfWork } from '../database/unit-of-work';
import type { CurrentUser } from '../users/users.service';
import { defaultHorizon, depreciationSchedule, type DepreciationInput, type DepreciationSchedule, type ScheduleRow } from './depreciation-math';
import { taxYearLabel, taxYearOf, todayInAustralia } from './financial-year';
import { evidenceView, TaxLedgerService } from './tax-ledger.service';
import { assetPositions, HOME_CURRENCY, linkView, money, moneyOrNull, percentText, type EvidenceView, type GapCode, type LinkView, type PositionView } from './tax-views';
import { TaxAssetEntity, TaxAssetYearEntity, type TaxReturnFilingEntity } from './tax.entities';
import { TaxRepository } from './tax.repository';
import {
  assetYearSchema,
  createTaxAssetSchema,
  scheduleQuerySchema,
  taxYear as taxYearSchema,
  updateTaxAssetSchema,
  type AssetYearInput,
  type CreateTaxAssetInput,
  type ReviewStatus,
  type ScheduleQueryInput,
  type TaxReturnStatus,
  type UpdateTaxAssetInput,
} from './tax.schemas';

export const ASSET_NOTES = [
  'Depreciation figures are estimates from your own inputs (cost, dates, method, effective life or rate, use percentages). Money does not look up ATO effective lives, apply instant asset write-off or low-value pool rules, or decide eligibility; confirm your treatment with the ATO\'s guidance or a registered tax agent.',
  'Decline in value starts on the date first used or installed ready for use, and is apportioned by days held in the financial year (365, or 366 when it contains 29 February). Amounts are rounded to cents each year.',
  'PRIME_COST: cost × (100% ÷ effective life) × days held ÷ days in year. DIMINISHING_VALUE: opening value × (200% ÷ effective life) × days held ÷ days in year. IMMEDIATE: the full cost in the first year of use, only on your assertion that it qualifies. Each year is capped at the remaining value.',
  'The asset declines in full each year; the deduction is the decline × that year\'s work-use percentage, and the rest is private use. On disposal, the balancing adjustment is the termination value − adjustable value (positive: an estimated assessable amount; negative: an estimated deduction), scaled by work use.',
  'A transaction that pays for a registered asset cannot also be a tax item: the purchase is claimed through its depreciation, never as an expense as well.',
  'A filed year keeps its filed snapshot. If you later change an asset, the schedule shows the filed figure next to the recomputed one (driftFromFiled) instead of rewriting the past.',
];

export type AssetLifecycle = 'NOT_IN_USE' | 'IN_USE' | 'WRITTEN_OFF' | 'DISPOSED';

export type ScheduleRowView = ScheduleRow & {
  yearStatus: TaxReturnStatus;
  review: { status: ReviewStatus; claimedAmount: string | null; note: string | null; usePercentOverride: string | null };
  filed: { version: number; deduction: string | null } | null;
  /** The filed deduction differs from the one computed now */
  driftFromFiled: boolean;
};

export type AssetScheduleView = Omit<DepreciationSchedule, 'rows'> & { throughYear: string; rows: ScheduleRowView[]; notes: string[] };

/** The latest filing per year, by start year */
type LatestFilings = Map<number, TaxReturnFilingEntity>;

type Snapshot = { positions?: { id: string; proposedAmount: string | null; assetId: string | null }[] };

/** The depreciating asset register and its derived schedules. See docs/tax.md. */
@Injectable()
export class TaxAssetsService {
  constructor(
    private readonly repo: TaxRepository,
    private readonly ledger: TaxLedgerService,
    private readonly uow: UnitOfWork,
  ) {}

  async list(user: CurrentUser) {
    const assets = await this.repo.listAssets(user.id);
    const current = taxYearOf(todayInAustralia());
    const views = await this.views(user.id, assets, {});
    return {
      currentTaxYear: taxYearLabel(current),
      assets: views.map(({ schedule, ...v }) => {
        const row = schedule.rows.find((r) => r.startYear === current);
        return { ...v, currentYear: row ? { taxYear: row.taxYear, decline: row.decline, deduction: row.deduction, usePercent: row.usePercent, closingValue: row.closingValue } : null };
      }),
      notes: ASSET_NOTES,
    };
  }

  async get(user: CurrentUser, assetId: string, query: ScheduleQueryInput = {}) {
    const options = parseInput(scheduleQuerySchema, query);
    const asset = isUuid(assetId) ? await this.repo.findAsset(user.id, assetId) : null;
    if (!asset) throw new NotFoundError(`Asset ${assetId} not found`);
    const [view] = await this.views(user.id, [asset], { throughYear: options.throughYear });
    return view;
  }

  async schedule(user: CurrentUser, assetId: string, query: ScheduleQueryInput = {}): Promise<AssetScheduleView & { assetId: string; name: string }> {
    const view = await this.get(user, assetId, query);
    return { assetId: view.id, name: view.name, ...view.schedule };
  }

  async create(user: CurrentUser, input: CreateTaxAssetInput) {
    const data = parseInput(createTaxAssetSchema, input);
    const asset = Object.assign(new TaxAssetEntity(), {
      id: randomUUID(),
      userId: user.id,
      name: data.name,
      description: data.description || null,
      category: data.category ?? 'depreciating-assets',
      currency: data.currency ?? HOME_CURRENCY,
      cost: data.cost,
      acquiredOn: data.acquiredOn,
      firstUsedOn: data.firstUsedOn ?? null,
      method: data.method,
      effectiveLifeYears: data.effectiveLifeYears ?? null,
      ratePercent: data.ratePercent ?? null,
      defaultUsePercent: data.defaultUsePercent ?? '100',
      ownership: data.ownership || null,
      disposedOn: data.disposedOn ?? null,
      disposalProceeds: data.disposalProceeds ?? null,
      notes: data.notes || null,
    });
    assertConsistent(asset);
    await this.uow.run(async (manager) => {
      await this.repo.saveAsset(asset, manager);
      for (const ref of data.links ?? []) await this.ledger.addLinkTo(user.id, { assetId: asset.id }, ref, { allowShared: false, note: null }, manager);
      for (const e of data.evidence ?? []) await this.repo.addEvidence({ userId: user.id, itemId: null, assetId: asset.id, label: e.label, url: e.url, kind: e.kind ?? 'OTHER' }, manager);
    });
    return this.get(user, asset.id);
  }

  async update(user: CurrentUser, assetId: string, input: UpdateTaxAssetInput) {
    const data = parseInput(updateTaxAssetSchema, input);
    await this.uow.run(async (manager) => {
      const asset = isUuid(assetId) ? await this.repo.findAssetForUpdate(user.id, assetId, manager) : null;
      if (!asset) throw new NotFoundError(`Asset ${assetId} not found`);
      if (data.name !== undefined) asset.name = data.name;
      if (data.description !== undefined) asset.description = data.description || null;
      if (data.category !== undefined) asset.category = data.category;
      if (data.currency !== undefined) asset.currency = data.currency;
      if (data.cost !== undefined) asset.cost = data.cost;
      if (data.acquiredOn !== undefined) asset.acquiredOn = data.acquiredOn;
      if (data.firstUsedOn !== undefined) asset.firstUsedOn = data.firstUsedOn ?? null;
      if (data.method !== undefined) asset.method = data.method;
      if (data.effectiveLifeYears !== undefined) asset.effectiveLifeYears = data.effectiveLifeYears ?? null;
      if (data.ratePercent !== undefined) asset.ratePercent = data.ratePercent ?? null;
      if (data.defaultUsePercent !== undefined) asset.defaultUsePercent = data.defaultUsePercent;
      if (data.ownership !== undefined) asset.ownership = data.ownership || null;
      if (data.disposedOn !== undefined) asset.disposedOn = data.disposedOn ?? null;
      if (data.disposalProceeds !== undefined) asset.disposalProceeds = data.disposalProceeds ?? null;
      if (data.notes !== undefined) asset.notes = data.notes || null;
      assertConsistent(asset);
      await this.repo.saveAsset(asset, manager);
    });
    return this.get(user, assetId);
  }

  /** Refused once the asset appears in a filed return: record its disposal instead, so the history stays */
  async delete(user: CurrentUser, assetId: string): Promise<{ deleted: true; linksRemoved: number; evidenceRemoved: number }> {
    return this.uow.run(async (manager) => {
      const asset = isUuid(assetId) ? await this.repo.findAssetForUpdate(user.id, assetId, manager) : null;
      if (!asset) throw new NotFoundError(`Asset ${assetId} not found`);
      const returns = await this.repo.listReturns(user.id, manager);
      const filings = await this.repo.listFilings(user.id, returns.map((r) => r.id), manager);
      const filedIn = [...new Set(filings.filter((f) => ((f.snapshot as Snapshot).positions ?? []).some((p) => p.assetId === asset.id)).map((f) => returns.find((r) => r.id === f.returnId)?.startYear))]
        .filter((y): y is number => y !== undefined)
        .sort();
      if (filedIn.length > 0) {
        throw new ConflictError(`${asset.name} is part of filed return(s) for ${filedIn.map(taxYearLabel).join(', ')}. Record its disposal (disposedOn, disposalProceeds) instead of deleting it.`, { filedTaxYears: filedIn.map(taxYearLabel) });
      }
      const links = await this.repo.listLinks(user.id, { assetIds: [asset.id] }, manager);
      const evidence = await this.repo.listEvidence(user.id, { assetIds: [asset.id] }, manager);
      await this.repo.deleteAsset(user.id, asset.id, manager);
      return { deleted: true as const, linksRemoved: links.length, evidenceRemoved: evidence.length };
    });
  }

  /** Sets one year's work-use percentage, review state or claimed figure. Refused while that year is filed. */
  async setYear(user: CurrentUser, assetId: string, taxYear: string, input: AssetYearInput) {
    const data = parseInput(assetYearSchema, input);
    const year = parseInput(taxYearSchema, taxYear);
    await this.uow.run(async (manager) => {
      // Lock order (data-model.md): the year's return row, then the asset row
      if (!isUuid(assetId) || !(await this.repo.findAsset(user.id, assetId, manager))) throw new NotFoundError(`Asset ${assetId} not found`);
      await this.ledger.lockWritableYear(user.id, year, manager);
      const asset = await this.repo.findAssetForUpdate(user.id, assetId, manager);
      if (!asset) throw new NotFoundError(`Asset ${assetId} not found`);
      if (year < taxYearOf(asset.acquiredOn)) throw new ValidationError(`${asset.name} was acquired on ${asset.acquiredOn}, after ${taxYearLabel(year)}`);
      const row =
        (await this.repo.findAssetYear(user.id, asset.id, year, manager)) ??
        Object.assign(new TaxAssetYearEntity(), { id: randomUUID(), userId: user.id, assetId: asset.id, startYear: year, usePercent: null, status: 'TO_REVIEW', claimedAmount: null, note: null });
      if (data.usePercent !== undefined) row.usePercent = data.usePercent ?? null;
      if (data.status !== undefined) row.status = data.status;
      if (data.claimedAmount !== undefined) row.claimedAmount = data.claimedAmount ?? null;
      if (data.note !== undefined) row.note = data.note || null;
      await this.repo.saveAssetYear(row, manager);
    });
    return this.get(user, assetId);
  }

  // ---- shared with TaxYearsService ----

  /** Every asset's positions for one year (depreciation and any balancing adjustment). Inside a transaction, pass its manager. */
  async positionsFor(userId: string, startYear: number, manager?: EntityManager): Promise<PositionView[]> {
    const assets = await this.repo.listAssets(userId, manager);
    const views = await this.views(userId, assets, { throughYear: startYear }, manager);
    return views.flatMap((v) => {
      const row = v.schedule.rows.find((r) => r.startYear === startYear);
      if (!row) return [];
      return assetPositions({ id: v.id, name: v.name, category: v.category, currency: v.currency, linkCount: v.links.length, evidenceCount: v.evidence.length }, row, { status: row.review.status, claimedAmount: row.review.claimedAmount });
    });
  }

  /** The years (start years) in which some asset has a schedule row, up to `through` */
  async yearsWithDepreciation(userId: string, through: number, manager?: EntityManager): Promise<Set<number>> {
    const years = new Set<number>();
    for (const asset of await this.repo.listAssets(userId, manager)) {
      for (const row of depreciationSchedule(inputOf(asset, new Map()), through).rows) years.add(row.startYear);
    }
    return years;
  }

  private async views(userId: string, assets: TaxAssetEntity[], options: { throughYear?: number }, manager?: EntityManager) {
    if (assets.length === 0) return [];
    const ids = assets.map((a) => a.id);
    const records = await this.repo.listAssetYears(userId, ids, manager);
    const links = await this.repo.listLinks(userId, { assetIds: ids }, manager);
    const allLinks = await this.repo.listLinks(userId, {}, manager);
    const evidence = await this.repo.listEvidence(userId, { assetIds: ids }, manager);
    const returns = await this.repo.listReturns(userId, manager);
    const filings = await this.repo.listFilings(userId, returns.map((r) => r.id), manager);
    const yearStatus = new Map(returns.map((r) => [r.startYear, r.status]));
    const latest: LatestFilings = new Map();
    for (const f of filings) {
      const year = returns.find((r) => r.id === f.returnId)?.startYear;
      if (year !== undefined && (latest.get(year)?.version ?? 0) < f.version) latest.set(year, f);
    }
    const current = taxYearOf(todayInAustralia());

    return assets.map((asset) => {
      const own = records.filter((r) => r.assetId === asset.id);
      const input = inputOf(asset, new Map(own.filter((r) => r.usePercent !== null).map((r) => [r.startYear, r.usePercent as string])));
      const through = options.throughYear ?? defaultHorizon(input, current);
      const schedule = depreciationSchedule(input, through);
      const rows: ScheduleRowView[] = schedule.rows.map((row) => {
        const record = own.find((r) => r.startYear === row.startYear);
        const filing = latest.get(row.startYear);
        const filedPosition = filing ? ((filing.snapshot as Snapshot).positions ?? []).find((p) => p.id === `asset:${asset.id}:${row.taxYear}`) : undefined;
        const filed = filing && filedPosition ? { version: filing.version, deduction: filedPosition.proposedAmount } : null;
        return {
          ...row,
          yearStatus: yearStatus.get(row.startYear) ?? 'PREPARING',
          review: { status: record?.status ?? 'TO_REVIEW', claimedAmount: moneyOrNull(record?.claimedAmount), note: record?.note ?? null, usePercentOverride: record?.usePercent ? percentText(record.usePercent) : null },
          filed,
          driftFromFiled: filed !== null && filed.deduction !== row.deduction,
        };
      });
      const assetLinks: LinkView[] = links.filter((l) => l.assetId === asset.id).map((l) => linkView(l, allLinks));
      const assetEvidence: EvidenceView[] = evidence.filter((e) => e.assetId === asset.id).map(evidenceView);
      const gaps: GapCode[] = [];
      if (!asset.firstUsedOn) gaps.push('not-in-use');
      if (assetEvidence.length === 0) gaps.push('no-evidence');
      if (assetLinks.length === 0) gaps.push('no-transaction');
      if (asset.currency !== HOME_CURRENCY) gaps.push('not-aud');
      if (assetLinks.some((l) => l.alsoLinkedTo.length > 0)) gaps.push('shared-transaction');
      const lifecycle: AssetLifecycle = asset.disposedOn ? 'DISPOSED' : !asset.firstUsedOn ? 'NOT_IN_USE' : schedule.endReason === 'WRITTEN_OFF' ? 'WRITTEN_OFF' : 'IN_USE';
      const last = rows.at(-1);
      return {
        id: asset.id,
        name: asset.name,
        description: asset.description,
        category: asset.category,
        currency: asset.currency,
        cost: money(asset.cost),
        acquiredOn: asset.acquiredOn,
        firstUsedOn: asset.firstUsedOn,
        method: asset.method,
        effectiveLifeYears: asset.effectiveLifeYears === null ? null : percentText(asset.effectiveLifeYears),
        ratePercent: asset.ratePercent === null ? null : percentText(asset.ratePercent),
        defaultUsePercent: percentText(asset.defaultUsePercent),
        ownership: asset.ownership,
        disposedOn: asset.disposedOn,
        disposalProceeds: moneyOrNull(asset.disposalProceeds),
        notes: asset.notes,
        lifecycle,
        adjustableValue: last ? last.closingValue : money(asset.cost),
        links: assetLinks,
        evidence: assetEvidence,
        gaps,
        schedule: { ...schedule, throughYear: taxYearLabel(through), rows, notes: ASSET_NOTES },
        createdAt: asset.createdAt.toISOString(),
        updatedAt: asset.updatedAt.toISOString(),
      };
    });
  }
}

function inputOf(asset: TaxAssetEntity, usePercentByYear: ReadonlyMap<number, string>): DepreciationInput {
  return {
    cost: asset.cost,
    startDate: asset.firstUsedOn,
    method: asset.method,
    effectiveLifeYears: asset.effectiveLifeYears,
    ratePercent: asset.ratePercent,
    defaultUsePercent: asset.defaultUsePercent,
    usePercentByYear,
    disposedOn: asset.disposedOn,
    disposalProceeds: asset.disposalProceeds,
  };
}

/** The rules the CHECK constraints enforce, as readable validation errors (also after a partial update) */
function assertConsistent(asset: TaxAssetEntity): void {
  if (asset.method !== 'IMMEDIATE' && asset.effectiveLifeYears === null && asset.ratePercent === null) {
    throw new ValidationError(`${asset.method} needs effectiveLifeYears or ratePercent: Money does not assume an effective life`);
  }
  if (asset.firstUsedOn && asset.firstUsedOn < asset.acquiredOn) throw new ValidationError('firstUsedOn must not be before acquiredOn');
  if (asset.disposedOn && asset.disposedOn < (asset.firstUsedOn ?? asset.acquiredOn)) throw new ValidationError('disposedOn must not be before the asset was acquired or first used');
  if (asset.disposalProceeds !== null && !asset.disposedOn) throw new ValidationError('disposalProceeds needs disposedOn');
  if (asset.effectiveLifeYears !== null && dec(asset.effectiveLifeYears).gt(100)) throw new ValidationError('effectiveLifeYears must be at most 100');
}
