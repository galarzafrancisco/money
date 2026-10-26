import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { In, type EntityManager } from 'typeorm';
import { UnitOfWork } from '../database/unit-of-work';
import { JURISDICTION } from './financial-year';
import {
  TaxAssetEntity,
  TaxAssetYearEntity,
  TaxEvidenceLinkEntity,
  TaxItemEntity,
  TaxReturnEntity,
  TaxReturnFilingEntity,
  TaxSourceLinkEntity,
} from './tax.entities';

/** A link with the source transaction it points at, read in the same query (never copied) */
export type LinkRow = {
  id: string;
  itemId: string | null;
  assetId: string | null;
  transactionId: string | null;
  upTransactionId: string | null;
  note: string | null;
  createdAt: Date;
  source: {
    kind: 'manual' | 'up';
    accountId: string;
    accountName: string;
    /** Money transaction type; null for Up */
    type: string | null;
    date: string | Date;
    currency: string;
    /** Signed as recorded: Up amounts are negative for money out */
    amount: string | null;
    description: string | null;
    status: 'HELD' | 'SETTLED' | null;
    deleted: boolean;
  };
};

type RawLink = {
  id: string;
  item_id: string | null;
  asset_id: string | null;
  transaction_id: string | null;
  up_transaction_id: string | null;
  note: string | null;
  created_at: Date | string;
  tx_type: string | null;
  tx_date: string | null;
  tx_currency: string | null;
  tx_amount: string | null;
  tx_description: string | null;
  tx_account_id: string | null;
  tx_account_name: string | null;
  up_description: string | null;
  up_created_at: Date | string | null;
  up_currency: string | null;
  up_amount: string | null;
  up_status: 'HELD' | 'SETTLED' | null;
  up_deleted_at: Date | string | null;
  up_account_id: string | null;
  up_account_name: string | null;
};

const LINK_SELECT = `
  SELECT l.id, l.item_id, l.asset_id, l.transaction_id, l.up_transaction_id, l.note, l.created_at,
         t.type AS tx_type, to_char(t.date, 'YYYY-MM-DD') AS tx_date, t.currency AS tx_currency,
         coalesce(t.amount, t.total, t.net_amount, t.to_amount)::text AS tx_amount, t.description AS tx_description,
         t.account_id AS tx_account_id, a.name AS tx_account_name,
         u.description AS up_description, u.up_created_at, u.currency AS up_currency, u.amount::text AS up_amount,
         u.status AS up_status, u.deleted_at AS up_deleted_at, u.up_account_id, ua.display_name AS up_account_name
    FROM tax_source_links l
    LEFT JOIN transactions t ON t.id = l.transaction_id AND t.user_id = l.user_id
    LEFT JOIN accounts a ON a.id = t.account_id AND a.user_id = l.user_id
    LEFT JOIN up_transactions u ON u.id = l.up_transaction_id AND u.user_id = l.user_id
    LEFT JOIN up_accounts ua ON ua.id = u.up_account_id AND ua.user_id = l.user_id`;

function toLink(r: RawLink): LinkRow {
  const up = r.up_transaction_id !== null;
  return {
    id: r.id,
    itemId: r.item_id,
    assetId: r.asset_id,
    transactionId: r.transaction_id,
    upTransactionId: r.up_transaction_id,
    note: r.note,
    createdAt: new Date(r.created_at),
    source: up
      ? {
          kind: 'up',
          accountId: r.up_account_id as string,
          accountName: r.up_account_name ?? 'Up account',
          type: null,
          date: new Date(r.up_created_at as string),
          currency: r.up_currency as string,
          amount: r.up_amount,
          description: r.up_description,
          status: r.up_status,
          deleted: r.up_deleted_at !== null,
        }
      : {
          kind: 'manual',
          accountId: r.tx_account_id as string,
          accountName: r.tx_account_name ?? 'Account',
          type: r.tx_type,
          date: r.tx_date as string,
          currency: r.tx_currency as string,
          amount: r.tx_amount,
          description: r.tx_description,
          status: null,
          deleted: false,
        },
  };
}

export type ItemFilter = { startYear?: number; kind?: string; category?: string; status?: string; q?: string };

/**
 * The tax ledger's tables. Every method is scoped to one user. Linked
 * transactions are read with a user-scoped join, so a link can never show
 * another user's transaction.
 */
@Injectable()
export class TaxRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // ---- items ----

  listItems(userId: string, filter: ItemFilter = {}, manager: EntityManager = this.uow.manager): Promise<TaxItemEntity[]> {
    const query = manager.getRepository(TaxItemEntity).createQueryBuilder('i').where('i.user_id = :userId', { userId });
    if (filter.startYear !== undefined) query.andWhere('i.start_year = :year', { year: filter.startYear });
    if (filter.kind) query.andWhere('i.kind = :kind', { kind: filter.kind });
    if (filter.category) query.andWhere('i.category = :category', { category: filter.category });
    if (filter.status) query.andWhere('i.status = :status', { status: filter.status });
    if (filter.q) {
      query.andWhere(`(strpos(lower(i.description), lower(:q)) > 0 OR strpos(lower(coalesce(i.rationale, '')), lower(:q)) > 0 OR strpos(lower(coalesce(i.notes, '')), lower(:q)) > 0)`, { q: filter.q });
    }
    return query.orderBy('i.start_year', 'DESC').addOrderBy('i.incurred_on', 'ASC', 'NULLS LAST').addOrderBy('i.created_at', 'ASC').addOrderBy('i.id', 'ASC').getMany();
  }

  findItem(userId: string, id: string, manager: EntityManager = this.uow.manager): Promise<TaxItemEntity | null> {
    return manager.findOne(TaxItemEntity, { where: { id, userId } });
  }

  findItemForUpdate(userId: string, id: string, manager: EntityManager): Promise<TaxItemEntity | null> {
    return manager.getRepository(TaxItemEntity).createQueryBuilder('i').setLock('pessimistic_write').where('i.id = :id AND i.user_id = :userId', { id, userId }).getOne();
  }

  saveItem(item: TaxItemEntity, manager: EntityManager): Promise<TaxItemEntity> {
    return manager.save(TaxItemEntity, item);
  }

  async deleteItem(userId: string, id: string, manager: EntityManager): Promise<void> {
    await manager.delete(TaxItemEntity, { id, userId });
  }

  // ---- assets ----

  listAssets(userId: string, manager: EntityManager = this.uow.manager): Promise<TaxAssetEntity[]> {
    return manager.find(TaxAssetEntity, { where: { userId }, order: { acquiredOn: 'ASC', name: 'ASC', id: 'ASC' } });
  }

  findAsset(userId: string, id: string, manager: EntityManager = this.uow.manager): Promise<TaxAssetEntity | null> {
    return manager.findOne(TaxAssetEntity, { where: { id, userId } });
  }

  findAssetForUpdate(userId: string, id: string, manager: EntityManager): Promise<TaxAssetEntity | null> {
    return manager.getRepository(TaxAssetEntity).createQueryBuilder('a').setLock('pessimistic_write').where('a.id = :id AND a.user_id = :userId', { id, userId }).getOne();
  }

  saveAsset(asset: TaxAssetEntity, manager: EntityManager): Promise<TaxAssetEntity> {
    return manager.save(TaxAssetEntity, asset);
  }

  async deleteAsset(userId: string, id: string, manager: EntityManager): Promise<void> {
    await manager.delete(TaxAssetEntity, { id, userId });
  }

  listAssetYears(userId: string, assetIds?: readonly string[], manager: EntityManager = this.uow.manager): Promise<TaxAssetYearEntity[]> {
    if (assetIds && assetIds.length === 0) return Promise.resolve([]);
    return manager.find(TaxAssetYearEntity, { where: assetIds ? { userId, assetId: In([...assetIds]) } : { userId }, order: { startYear: 'ASC' } });
  }

  findAssetYear(userId: string, assetId: string, startYear: number, manager: EntityManager): Promise<TaxAssetYearEntity | null> {
    return manager.findOne(TaxAssetYearEntity, { where: { userId, assetId, startYear } });
  }

  saveAssetYear(row: TaxAssetYearEntity, manager: EntityManager): Promise<TaxAssetYearEntity> {
    return manager.save(TaxAssetYearEntity, row);
  }

  // ---- source links ----

  async listLinks(userId: string, owners: { itemIds?: readonly string[]; assetIds?: readonly string[] } = {}, manager: EntityManager = this.uow.manager): Promise<LinkRow[]> {
    const params: unknown[] = [userId];
    const where = ['l.user_id = $1'];
    const ors: string[] = [];
    if (owners.itemIds) {
      params.push(owners.itemIds);
      ors.push(`l.item_id = ANY($${params.length}::uuid[])`);
    }
    if (owners.assetIds) {
      params.push(owners.assetIds);
      ors.push(`l.asset_id = ANY($${params.length}::uuid[])`);
    }
    if (ors.length > 0) where.push(`(${ors.join(' OR ')})`);
    const rows: RawLink[] = await manager.query(`${LINK_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.created_at, l.id`, params);
    return rows.map(toLink);
  }

  /** Every link to one source transaction (Money or Up), with its owner */
  async linksToSource(userId: string, source: { transactionId?: string; upTransactionId?: string }, manager: EntityManager = this.uow.manager): Promise<LinkRow[]> {
    const column = source.transactionId ? 'l.transaction_id' : 'l.up_transaction_id';
    const rows: RawLink[] = await manager.query(`${LINK_SELECT} WHERE l.user_id = $1 AND ${column} = $2 ORDER BY l.created_at, l.id`, [userId, source.transactionId ?? source.upTransactionId]);
    return rows.map(toLink);
  }

  async findLink(userId: string, id: string, manager: EntityManager = this.uow.manager): Promise<LinkRow | null> {
    const [row]: RawLink[] = await manager.query(`${LINK_SELECT} WHERE l.user_id = $1 AND l.id = $2`, [userId, id]);
    return row ? toLink(row) : null;
  }

  async addLink(link: Omit<TaxSourceLinkEntity, 'id' | 'createdAt'>, manager: EntityManager): Promise<string> {
    const id = randomUUID();
    await manager.save(TaxSourceLinkEntity, Object.assign(new TaxSourceLinkEntity(), { ...link, id }));
    return id;
  }

  async deleteLink(userId: string, id: string, manager: EntityManager): Promise<void> {
    await manager.delete(TaxSourceLinkEntity, { id, userId });
  }

  /** True when the Money transaction exists and is this user's */
  async transactionExists(userId: string, transactionId: string, manager: EntityManager = this.uow.manager): Promise<boolean> {
    const rows: unknown[] = await manager.query(`SELECT 1 FROM transactions WHERE id = $1 AND user_id = $2`, [transactionId, userId]);
    return rows.length > 0;
  }

  /** True when the imported Up transaction exists and is this user's */
  async upTransactionExists(userId: string, upTransactionId: string, manager: EntityManager = this.uow.manager): Promise<boolean> {
    const rows: unknown[] = await manager.query(`SELECT 1 FROM up_transactions WHERE id = $1 AND user_id = $2`, [upTransactionId, userId]);
    return rows.length > 0;
  }

  // ---- evidence ----

  listEvidence(userId: string, owners: { itemIds?: readonly string[]; assetIds?: readonly string[] } = {}, manager: EntityManager = this.uow.manager): Promise<TaxEvidenceLinkEntity[]> {
    const query = manager.getRepository(TaxEvidenceLinkEntity).createQueryBuilder('e').where('e.user_id = :userId', { userId });
    const ors: string[] = [];
    if (owners.itemIds) ors.push(owners.itemIds.length > 0 ? 'e.item_id IN (:...itemIds)' : 'false');
    if (owners.assetIds) ors.push(owners.assetIds.length > 0 ? 'e.asset_id IN (:...assetIds)' : 'false');
    if (ors.length > 0) query.andWhere(`(${ors.join(' OR ')})`, { itemIds: owners.itemIds, assetIds: owners.assetIds });
    return query.orderBy('e.created_at', 'ASC').addOrderBy('e.id', 'ASC').getMany();
  }

  findEvidence(userId: string, id: string, manager: EntityManager = this.uow.manager): Promise<TaxEvidenceLinkEntity | null> {
    return manager.findOne(TaxEvidenceLinkEntity, { where: { id, userId } });
  }

  async addEvidence(evidence: Omit<TaxEvidenceLinkEntity, 'id' | 'createdAt'>, manager: EntityManager): Promise<string> {
    const id = randomUUID();
    await manager.save(TaxEvidenceLinkEntity, Object.assign(new TaxEvidenceLinkEntity(), { ...evidence, id }));
    return id;
  }

  async deleteEvidence(userId: string, id: string, manager: EntityManager): Promise<void> {
    await manager.delete(TaxEvidenceLinkEntity, { id, userId });
  }

  // ---- returns and filings ----

  listReturns(userId: string, manager: EntityManager = this.uow.manager): Promise<TaxReturnEntity[]> {
    return manager.find(TaxReturnEntity, { where: { userId, jurisdiction: JURISDICTION }, order: { startYear: 'DESC' } });
  }

  findReturn(userId: string, startYear: number, manager: EntityManager = this.uow.manager): Promise<TaxReturnEntity | null> {
    return manager.findOne(TaxReturnEntity, { where: { userId, jurisdiction: JURISDICTION, startYear } });
  }

  /**
   * The year's return row, created if needed, locked until the transaction
   * ends. Every write in a year takes this lock first, so filing and edits in
   * the same year are serialized.
   */
  async lockReturn(userId: string, startYear: number, manager: EntityManager): Promise<TaxReturnEntity> {
    await manager.query(
      `INSERT INTO tax_returns (id, user_id, jurisdiction, start_year, status) VALUES ($1, $2, $3, $4, 'PREPARING')
       ON CONFLICT (user_id, jurisdiction, start_year) DO NOTHING`,
      [randomUUID(), userId, JURISDICTION, startYear],
    );
    return manager
      .getRepository(TaxReturnEntity)
      .createQueryBuilder('r')
      .setLock('pessimistic_write')
      .where('r.user_id = :userId AND r.jurisdiction = :jurisdiction AND r.start_year = :startYear', { userId, jurisdiction: JURISDICTION, startYear })
      .getOneOrFail();
  }

  saveReturn(row: TaxReturnEntity, manager: EntityManager): Promise<TaxReturnEntity> {
    return manager.save(TaxReturnEntity, row);
  }

  listFilings(userId: string, returnIds?: readonly string[], manager: EntityManager = this.uow.manager): Promise<TaxReturnFilingEntity[]> {
    if (returnIds && returnIds.length === 0) return Promise.resolve([]);
    return manager.find(TaxReturnFilingEntity, { where: returnIds ? { userId, returnId: In([...returnIds]) } : { userId }, order: { version: 'ASC' } });
  }

  addFiling(filing: Omit<TaxReturnFilingEntity, 'id' | 'createdAt'>, manager: EntityManager): Promise<TaxReturnFilingEntity> {
    return manager.save(TaxReturnFilingEntity, Object.assign(new TaxReturnFilingEntity(), { ...filing, id: randomUUID() }));
  }
}
