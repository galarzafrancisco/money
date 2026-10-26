import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { ConflictError, NotFoundError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { UnitOfWork } from '../database/unit-of-work';
import type { CurrentUser } from '../users/users.service';
import { taxYearLabel, taxYearOf, todayInAustralia } from './financial-year';
import { itemView, linkView, type EvidenceView, type LinkView, type TaxItemView } from './tax-views';
import { TaxItemEntity, type TaxEvidenceLinkEntity, type TaxReturnEntity } from './tax.entities';
import { TaxRepository, type ItemFilter, type LinkRow } from './tax.repository';
import {
  createEvidenceSchema,
  createLinkSchema,
  createTaxItemSchema,
  listTaxItemsSchema,
  SUGGESTED_TAX_CATEGORIES,
  updateTaxItemSchema,
  type CreateEvidenceInput,
  type CreateLinkInput,
  type CreateTaxItemInput,
  type EvidenceKind,
  type ListTaxItemsInput,
  type TaxReturnStatus,
  type UpdateTaxItemInput,
} from './tax.schemas';

export const TAX_NOTES = [
  'Tracking aid only, not tax advice: Money records what you intend to claim and why. It does not decide whether anything is deductible or assessable; confirm with the ATO\'s guidance or a registered tax agent.',
  'Australian financial years run 1 July to 30 June; "2026-27" is 1 July 2026 to 30 June 2027.',
  'proposedAmount = amount × claimPercent. claimedAmount is what you record as actually claimed, kept apart from the proposal.',
  'Evidence is stored as links only; Money keeps no files.',
];

type SourceRef = { transactionId?: string; upTransactionId?: string };

export function evidenceView(e: TaxEvidenceLinkEntity): EvidenceView {
  return { id: e.id, label: e.label, url: e.url, kind: e.kind, createdAt: e.createdAt.toISOString() };
}

/**
 * The tax ledger: tax items (proposed positions), their links to source
 * transactions and their evidence URLs. A filed year is read-only until it
 * is reopened for amendment (TaxYearsService). See docs/tax.md.
 */
@Injectable()
export class TaxLedgerService {
  constructor(
    private readonly repo: TaxRepository,
    private readonly uow: UnitOfWork,
  ) {}

  categories() {
    return { suggested: SUGGESTED_TAX_CATEGORIES, notes: ['Suggestions only: any lower-case slug works, e.g. "rental-property-repairs". Categories group positions in the year summary.'] };
  }

  async list(user: CurrentUser, input: ListTaxItemsInput = {}) {
    const filter = parseInput(listTaxItemsSchema, input);
    const repoFilter: ItemFilter = { startYear: filter.taxYear, kind: filter.kind, category: filter.category, status: filter.status, q: filter.q };
    let items = await this.itemViews(user.id, repoFilter);
    if (filter.source) items = items.filter((i) => (filter.source === 'linked' ? i.links.length > 0 : i.links.length === 0));
    if (filter.evidence) items = items.filter((i) => (filter.evidence === 'present' ? i.evidence.length > 0 : i.evidence.length === 0));
    return { items, notes: TAX_NOTES };
  }

  async get(user: CurrentUser, itemId: string, manager?: EntityManager): Promise<TaxItemView> {
    const item = isUuid(itemId) ? await this.repo.findItem(user.id, itemId, manager) : null;
    if (!item) throw new NotFoundError(`Tax item ${itemId} not found`);
    const [view] = await this.viewsOf(user.id, [item], manager);
    return view;
  }

  async create(user: CurrentUser, input: CreateTaxItemInput): Promise<TaxItemView> {
    const data = parseInput(createTaxItemSchema, input);
    const startYear = data.taxYear ?? taxYearOf(data.date ?? todayInAustralia());
    const id = await this.uow.run(async (manager) => {
      await this.lockWritableYear(user.id, startYear, manager);
      const item = Object.assign(new TaxItemEntity(), {
        id: randomUUID(),
        userId: user.id,
        startYear,
        kind: data.kind ?? 'DEDUCTION',
        category: data.category ?? 'other',
        description: data.description,
        incurredOn: data.date ?? null,
        currency: data.currency ?? 'AUD',
        amount: data.amount ?? null,
        claimPercent: data.claimPercent ?? '100',
        status: data.status ?? 'TO_REVIEW',
        rationale: data.rationale || null,
        notes: data.notes || null,
        claimedAmount: data.claimedAmount ?? null,
      });
      await this.repo.saveItem(item, manager);
      for (const ref of data.links ?? []) await this.addLinkTo(user.id, { itemId: item.id }, ref, { allowShared: data.allowShared ?? false, note: null }, manager);
      for (const e of data.evidence ?? []) await this.repo.addEvidence({ userId: user.id, itemId: item.id, assetId: null, label: e.label, url: e.url, kind: e.kind ?? 'OTHER' }, manager);
      return item.id;
    });
    return this.get(user, id);
  }

  async update(user: CurrentUser, itemId: string, input: UpdateTaxItemInput): Promise<TaxItemView> {
    const data = parseInput(updateTaxItemSchema, input);
    await this.uow.run(async (manager) => {
      const current = isUuid(itemId) ? await this.repo.findItem(user.id, itemId, manager) : null;
      if (!current) throw new NotFoundError(`Tax item ${itemId} not found`);
      const target = data.taxYear ?? current.startYear;
      // Lock both years in ascending order: the item leaves one and joins the other
      for (const year of [...new Set([current.startYear, target])].sort((a, b) => a - b)) await this.lockWritableYear(user.id, year, manager);
      const item = await this.repo.findItemForUpdate(user.id, itemId, manager);
      if (!item) throw new NotFoundError(`Tax item ${itemId} not found`);
      item.startYear = target;
      if (data.kind !== undefined) item.kind = data.kind;
      if (data.category !== undefined) item.category = data.category;
      if (data.description !== undefined) item.description = data.description;
      if (data.date !== undefined) item.incurredOn = data.date ?? null;
      if (data.currency !== undefined) item.currency = data.currency;
      if (data.amount !== undefined) item.amount = data.amount ?? null;
      if (data.claimPercent !== undefined) item.claimPercent = data.claimPercent;
      if (data.status !== undefined) item.status = data.status;
      if (data.rationale !== undefined) item.rationale = data.rationale || null;
      if (data.notes !== undefined) item.notes = data.notes || null;
      if (data.claimedAmount !== undefined) item.claimedAmount = data.claimedAmount ?? null;
      await this.repo.saveItem(item, manager);
    });
    return this.get(user, itemId);
  }

  async delete(user: CurrentUser, itemId: string): Promise<{ deleted: true; linksRemoved: number; evidenceRemoved: number }> {
    return this.uow.run(async (manager) => {
      const item = isUuid(itemId) ? await this.repo.findItem(user.id, itemId, manager) : null;
      if (!item) throw new NotFoundError(`Tax item ${itemId} not found`);
      await this.lockWritableYear(user.id, item.startYear, manager);
      const links = await this.repo.listLinks(user.id, { itemIds: [item.id] }, manager);
      const evidence = await this.repo.listEvidence(user.id, { itemIds: [item.id] }, manager);
      await this.repo.deleteItem(user.id, item.id, manager);
      return { deleted: true as const, linksRemoved: links.length, evidenceRemoved: evidence.length };
    });
  }

  // ---- links ----

  /** Links an item or asset to a source transaction. Linking the same pair again is a no-op. */
  async link(user: CurrentUser, input: CreateLinkInput) {
    const data = parseInput(createLinkSchema, input);
    const owner = { itemId: data.itemId, assetId: data.assetId };
    const linkId = await this.uow.run(async (manager) => {
      await this.lockOwner(user.id, owner, manager);
      return this.addLinkTo(user.id, owner, { transactionId: data.transactionId, upTransactionId: data.upTransactionId }, { allowShared: data.allowShared ?? false, note: data.note || null }, manager);
    });
    return this.linkResult(user.id, linkId);
  }

  async unlink(user: CurrentUser, linkId: string): Promise<{ deleted: true; itemId: string | null; assetId: string | null }> {
    return this.uow.run(async (manager) => {
      const link = isUuid(linkId) ? await this.repo.findLink(user.id, linkId, manager) : null;
      if (!link) throw new NotFoundError(`Tax link ${linkId} not found`);
      await this.lockOwner(user.id, { itemId: link.itemId ?? undefined, assetId: link.assetId ?? undefined }, manager);
      await this.repo.deleteLink(user.id, link.id, manager);
      return { deleted: true as const, itemId: link.itemId, assetId: link.assetId };
    });
  }

  // ---- evidence ----

  async addEvidence(user: CurrentUser, input: CreateEvidenceInput) {
    const data = parseInput(createEvidenceSchema, input);
    const owner = { itemId: data.itemId, assetId: data.assetId };
    const id = await this.uow.run(async (manager) => {
      await this.lockOwner(user.id, owner, manager);
      return this.repo.addEvidence({ userId: user.id, itemId: owner.itemId ?? null, assetId: owner.assetId ?? null, label: data.label, url: data.url, kind: (data.kind ?? 'OTHER') as EvidenceKind }, manager);
    });
    const evidence = (await this.repo.findEvidence(user.id, id)) as TaxEvidenceLinkEntity;
    return { ...evidenceView(evidence), itemId: evidence.itemId, assetId: evidence.assetId };
  }

  async removeEvidence(user: CurrentUser, evidenceId: string): Promise<{ deleted: true; itemId: string | null; assetId: string | null }> {
    return this.uow.run(async (manager) => {
      const evidence = isUuid(evidenceId) ? await this.repo.findEvidence(user.id, evidenceId, manager) : null;
      if (!evidence) throw new NotFoundError(`Evidence link ${evidenceId} not found`);
      await this.lockOwner(user.id, { itemId: evidence.itemId ?? undefined, assetId: evidence.assetId ?? undefined }, manager);
      await this.repo.deleteEvidence(user.id, evidence.id, manager);
      return { deleted: true as const, itemId: evidence.itemId, assetId: evidence.assetId };
    });
  }

  // ---- shared with the asset and year services ----

  /** Item views for a filter, with links, evidence and year status. Inside a transaction, pass its manager. */
  async itemViews(userId: string, filter: ItemFilter, manager?: EntityManager): Promise<TaxItemView[]> {
    return this.viewsOf(userId, await this.repo.listItems(userId, filter, manager), manager);
  }

  /** Year status by start year (PREPARING when the year has no return row yet) */
  async yearStatuses(userId: string, manager?: EntityManager): Promise<Map<number, TaxReturnEntity>> {
    return new Map((await this.repo.listReturns(userId, manager)).map((r) => [r.startYear, r]));
  }

  /**
   * Takes the year's lock and refuses writes to a filed year. Every write
   * that changes a year's positions goes through here first.
   */
  async lockWritableYear(userId: string, startYear: number, manager: EntityManager): Promise<TaxReturnEntity> {
    const row = await this.repo.lockReturn(userId, startYear, manager);
    if (row.status === 'FILED') {
      throw new ConflictError(`Tax year ${taxYearLabel(startYear)} is filed. Reopen it for amendment before changing its positions.`, { taxYear: taxYearLabel(startYear), status: row.status });
    }
    return row;
  }

  /** Adds a link inside the caller's transaction, after the double-counting checks */
  async addLinkTo(userId: string, owner: { itemId?: string; assetId?: string }, ref: SourceRef, options: { allowShared: boolean; note: string | null }, manager: EntityManager): Promise<string> {
    const exists = ref.transactionId
      ? isUuid(ref.transactionId) && (await this.repo.transactionExists(userId, ref.transactionId, manager))
      : isUuid(ref.upTransactionId as string) && (await this.repo.upTransactionExists(userId, ref.upTransactionId as string, manager));
    if (!exists) throw new NotFoundError(ref.transactionId ? `Transaction ${ref.transactionId} not found` : `Up transaction ${ref.upTransactionId} not found`);

    const existing = await this.repo.linksToSource(userId, ref, manager);
    const same = existing.find((l) => (owner.itemId ? l.itemId === owner.itemId : l.assetId === owner.assetId));
    if (same) return same.id;
    const others = existing.map((l) => ({ itemId: l.itemId, assetId: l.assetId }));
    const toAsset = existing.filter((l) => l.assetId);
    const toItem = existing.filter((l) => l.itemId);
    if (owner.itemId && toAsset.length > 0) {
      throw new ConflictError('That transaction pays for a registered depreciating asset. Claiming it as a tax item as well would count the purchase twice; its deduction comes from the asset\'s depreciation schedule.', { linkedTo: others });
    }
    if (owner.assetId && toItem.length > 0) {
      throw new ConflictError('That transaction is already linked to a tax item. Linking it to an asset as well would count the purchase twice (an expense and depreciation). Remove the item\'s link, or delete the item, first.', { linkedTo: others });
    }
    if (!options.allowShared && existing.length > 0) {
      throw new ConflictError(`That transaction is already linked to another ${owner.itemId ? 'tax item' : 'asset'}. Pass allowShared: true if it really covers both (e.g. one invoice split over two claims).`, { linkedTo: others });
    }
    try {
      return await this.repo.addLink({ userId, itemId: owner.itemId ?? null, assetId: owner.assetId ?? null, transactionId: ref.transactionId ?? null, upTransactionId: ref.upTransactionId ?? null, note: options.note }, manager);
    } catch (error) {
      if (String((error as { code?: string }).code) === '23505') throw new ConflictError('That transaction was just linked by another request. Try again.');
      throw error;
    }
  }

  private async lockOwner(userId: string, owner: { itemId?: string; assetId?: string }, manager: EntityManager): Promise<void> {
    if (owner.itemId) {
      const item = isUuid(owner.itemId) ? await this.repo.findItem(userId, owner.itemId, manager) : null;
      if (!item) throw new NotFoundError(`Tax item ${owner.itemId} not found`);
      await this.lockWritableYear(userId, item.startYear, manager);
      await this.repo.findItemForUpdate(userId, item.id, manager);
      return;
    }
    const asset = isUuid(owner.assetId as string) ? await this.repo.findAssetForUpdate(userId, owner.assetId as string, manager) : null;
    if (!asset) throw new NotFoundError(`Asset ${owner.assetId} not found`);
  }

  private async linkResult(userId: string, linkId: string) {
    const link = (await this.repo.findLink(userId, linkId)) as LinkRow;
    const all = await this.repo.linksToSource(userId, { transactionId: link.transactionId ?? undefined, upTransactionId: link.upTransactionId ?? undefined });
    return { ...linkView(link, all), itemId: link.itemId, assetId: link.assetId };
  }

  private async viewsOf(userId: string, items: TaxItemEntity[], manager?: EntityManager): Promise<TaxItemView[]> {
    if (items.length === 0) return [];
    const ids = items.map((i) => i.id);
    const [links, evidence, years, allLinks] = [
      await this.repo.listLinks(userId, { itemIds: ids }, manager),
      await this.repo.listEvidence(userId, { itemIds: ids }, manager),
      await this.yearStatuses(userId, manager),
      await this.repo.listLinks(userId, {}, manager),
    ];
    return items.map((item) => {
      const own: LinkView[] = links.filter((l) => l.itemId === item.id).map((l) => linkView(l, allLinks));
      const ev = evidence.filter((e) => e.itemId === item.id).map(evidenceView);
      const status: TaxReturnStatus = years.get(item.startYear)?.status ?? 'PREPARING';
      return itemView(item, own, ev, status);
    });
  }
}
