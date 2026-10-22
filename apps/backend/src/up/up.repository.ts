import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { UnitOfWork } from '../database/unit-of-work';
import { UpAccountEntity, UpIntegrationEntity, UpSyncRunEntity, UpTransactionEntity, UpWebhookEventEntity, type UpSyncTrigger } from './up.entities';

export type UpTransactionFilter = {
  upAccountIds?: string[];
  status?: 'HELD' | 'SETTLED';
  fromDate?: string;
  toDate?: string;
  includeDeleted?: boolean;
  reconciliation?: 'matched' | 'unmatched';
  limit: number;
  offset: number;
};

export type UpAccountValues = {
  upId: string;
  displayName: string;
  accountType: string;
  ownershipType: string;
  currency: string;
  balance: string;
  upCreatedAt: Date;
};

export type UpTransactionValues = Omit<UpTransactionEntity, 'id' | 'userId' | 'integrationId' | 'upAccountId' | 'matchedTransactionId' | 'firstImportedAt' | 'updatedAt' | 'deletedAt'>;

/**
 * Every method is scoped to one user, except findIntegrationByWebhookId, which
 * exists only so an inbound provider event can be matched to its integration
 * before the event's signature is verified (see up-webhook.service.ts).
 */
@Injectable()
export class UpRepository {
  constructor(private readonly uow: UnitOfWork) {}

  findIntegration(userId: string, manager: EntityManager = this.uow.manager): Promise<UpIntegrationEntity | null> {
    return manager.findOne(UpIntegrationEntity, { where: { userId } });
  }

  findIntegrationByWebhookId(webhookId: string, manager: EntityManager = this.uow.manager): Promise<UpIntegrationEntity | null> {
    return manager.findOne(UpIntegrationEntity, { where: { webhookId } });
  }

  /** Whether another user's live integration has already imported one of these Up accounts */
  async upAccountsClaimedByOthers(userId: string, upIds: string[], manager: EntityManager = this.uow.manager): Promise<boolean> {
    if (upIds.length === 0) return false;
    const rows = await manager.query(
      `SELECT 1 FROM up_accounts a JOIN up_integrations i ON i.id = a.integration_id
       WHERE a.up_id = ANY($1) AND a.user_id <> $2 AND i.status <> 'disconnected' LIMIT 1`,
      [upIds, userId],
    );
    return rows.length > 0;
  }

  async saveIntegration(entity: UpIntegrationEntity, manager: EntityManager = this.uow.manager): Promise<UpIntegrationEntity> {
    entity.updatedAt = new Date();
    return manager.save(UpIntegrationEntity, entity);
  }

  listAccounts(userId: string, integrationId: string | null, manager: EntityManager = this.uow.manager): Promise<UpAccountEntity[]> {
    const query = manager.getRepository(UpAccountEntity).createQueryBuilder('a').where('a.user_id = :userId', { userId });
    if (integrationId) query.andWhere('a.integration_id = :integrationId', { integrationId });
    return query.orderBy('a.display_name', 'ASC').addOrderBy('a.id', 'ASC').getMany();
  }

  findAccount(userId: string, id: string, manager: EntityManager = this.uow.manager): Promise<UpAccountEntity | null> {
    return manager.findOne(UpAccountEntity, { where: { id, userId } });
  }

  findAccountByUpId(userId: string, integrationId: string, upId: string, manager: EntityManager = this.uow.manager): Promise<UpAccountEntity | null> {
    return manager.findOne(UpAccountEntity, { where: { userId, integrationId, upId } });
  }

  saveAccount(entity: UpAccountEntity, manager: EntityManager = this.uow.manager): Promise<UpAccountEntity> {
    entity.updatedAt = new Date();
    return manager.save(UpAccountEntity, entity);
  }

  /** Inserts a new account (hidden by default) or refreshes an existing one, keeping the user's visibility and link */
  async upsertAccount(userId: string, integrationId: string, values: UpAccountValues, manager: EntityManager): Promise<{ created: boolean }> {
    const rows = await manager.query(
      `INSERT INTO up_accounts (id, user_id, integration_id, up_id, display_name, account_type, ownership_type, currency, balance, up_created_at, visible)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false)
       ON CONFLICT (integration_id, up_id) DO UPDATE SET
         display_name = EXCLUDED.display_name, account_type = EXCLUDED.account_type, ownership_type = EXCLUDED.ownership_type,
         currency = EXCLUDED.currency, balance = EXCLUDED.balance, removed_at = NULL, updated_at = now()
       RETURNING (xmax = 0) AS created`,
      [randomUUID(), userId, integrationId, values.upId, values.displayName, values.accountType, values.ownershipType, values.currency, values.balance, values.upCreatedAt],
    );
    return { created: Boolean(rows[0]?.created) };
  }

  async setAccountCursor(userId: string, id: string, cursor: Date | null, manager: EntityManager): Promise<void> {
    await manager.query(`UPDATE up_accounts SET tx_cursor = $3, last_synced_at = now(), updated_at = now() WHERE id = $2 AND user_id = $1`, [userId, id, cursor]);
  }

  async markAccountsRemovedExcept(userId: string, integrationId: string, keepUpIds: string[], manager: EntityManager): Promise<void> {
    await manager.query(
      `UPDATE up_accounts SET removed_at = now(), updated_at = now()
       WHERE user_id = $1 AND integration_id = $2 AND removed_at IS NULL AND NOT (up_id = ANY($3))`,
      [userId, integrationId, keepUpIds],
    );
  }

  /** Inserts or refreshes one Up transaction. Never touches matched_transaction_id. Returns whether it was new */
  async upsertTransaction(userId: string, integrationId: string, upAccountId: string, values: UpTransactionValues, manager: EntityManager): Promise<{ created: boolean }> {
    const rows = await manager.query(
      `INSERT INTO up_transactions (id, user_id, integration_id, up_account_id, up_id, status, description, raw_text, message, transaction_type,
         currency, amount, foreign_currency, foreign_amount, category_id, transfer_up_account_id, up_created_at, settled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (integration_id, up_id) DO UPDATE SET
         up_account_id = EXCLUDED.up_account_id, status = EXCLUDED.status, description = EXCLUDED.description, raw_text = EXCLUDED.raw_text,
         message = EXCLUDED.message, transaction_type = EXCLUDED.transaction_type, currency = EXCLUDED.currency, amount = EXCLUDED.amount,
         foreign_currency = EXCLUDED.foreign_currency, foreign_amount = EXCLUDED.foreign_amount, category_id = EXCLUDED.category_id,
         transfer_up_account_id = EXCLUDED.transfer_up_account_id, up_created_at = EXCLUDED.up_created_at, settled_at = EXCLUDED.settled_at,
         deleted_at = NULL, updated_at = now()
       RETURNING (xmax = 0) AS created`,
      [
        randomUUID(), userId, integrationId, upAccountId, values.upId, values.status, values.description, values.rawText, values.message,
        values.transactionType, values.currency, values.amount, values.foreignCurrency, values.foreignAmount, values.categoryId,
        values.transferUpAccountId, values.upCreatedAt, values.settledAt,
      ],
    );
    return { created: Boolean(rows[0]?.created) };
  }

  /** Marks one transaction as deleted by Up. Returns whether a live one was found */
  async markTransactionDeleted(userId: string, integrationId: string, upId: string, manager: EntityManager): Promise<boolean> {
    const rows = await manager.query(
      `UPDATE up_transactions SET deleted_at = now(), updated_at = now()
       WHERE user_id = $1 AND integration_id = $2 AND up_id = $3 AND deleted_at IS NULL RETURNING id`,
      [userId, integrationId, upId],
    );
    return rowCount(rows) > 0;
  }

  /** Live transactions of an account created at or after `since` (all when null): the set a sync window must account for */
  async liveUpIdsSince(userId: string, upAccountId: string, since: Date | null, manager: EntityManager): Promise<string[]> {
    const rows = await manager.query(
      `SELECT up_id FROM up_transactions WHERE user_id = $1 AND up_account_id = $2 AND deleted_at IS NULL AND ($3::timestamptz IS NULL OR up_created_at >= $3)`,
      [userId, upAccountId, since],
    );
    return rows.map((row: { up_id: string }) => row.up_id);
  }

  findTransaction(userId: string, id: string, manager: EntityManager = this.uow.manager): Promise<UpTransactionEntity | null> {
    return manager.findOne(UpTransactionEntity, { where: { id, userId } });
  }

  saveTransaction(entity: UpTransactionEntity, manager: EntityManager = this.uow.manager): Promise<UpTransactionEntity> {
    entity.updatedAt = new Date();
    return manager.save(UpTransactionEntity, entity);
  }

  async listTransactions(userId: string, filter: UpTransactionFilter, manager: EntityManager = this.uow.manager): Promise<UpTransactionEntity[]> {
    const query = manager.getRepository(UpTransactionEntity).createQueryBuilder('t').where('t.user_id = :userId', { userId });
    if (filter.upAccountIds) {
      if (filter.upAccountIds.length === 0) return [];
      query.andWhere('t.up_account_id IN (:...accountIds)', { accountIds: filter.upAccountIds });
    }
    if (filter.status) query.andWhere('t.status = :status', { status: filter.status });
    if (filter.fromDate) query.andWhere('t.up_created_at >= :from', { from: `${filter.fromDate}T00:00:00Z` });
    if (filter.toDate) query.andWhere('t.up_created_at < :to', { to: new Date(Date.parse(`${filter.toDate}T00:00:00Z`) + 86_400_000) });
    if (!filter.includeDeleted) query.andWhere('t.deleted_at IS NULL');
    if (filter.reconciliation === 'matched') query.andWhere('t.matched_transaction_id IS NOT NULL');
    if (filter.reconciliation === 'unmatched') query.andWhere('t.matched_transaction_id IS NULL');
    return query.orderBy('t.up_created_at', 'DESC').addOrderBy('t.id', 'DESC').take(filter.limit).skip(filter.offset).getMany();
  }

  async moneyTransactionExists(userId: string, transactionId: string, manager: EntityManager = this.uow.manager): Promise<boolean> {
    const rows = await manager.query(`SELECT 1 FROM transactions WHERE id = $1 AND user_id = $2`, [transactionId, userId]);
    return rows.length > 0;
  }

  /** Records an authentic event once. Returns the stored row and whether this call created it */
  async recordEvent(
    event: { userId: string; integrationId: string; eventId: string; eventType: string; upTransactionId: string | null },
    manager: EntityManager = this.uow.manager,
  ): Promise<{ row: UpWebhookEventEntity; created: boolean }> {
    const inserted = await manager.query(
      `INSERT INTO up_webhook_events (id, user_id, integration_id, event_id, event_type, up_transaction_id)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (integration_id, event_id) DO NOTHING RETURNING id`,
      [randomUUID(), event.userId, event.integrationId, event.eventId, event.eventType, event.upTransactionId],
    );
    const row = await manager.findOneOrFail(UpWebhookEventEntity, { where: { integrationId: event.integrationId, eventId: event.eventId } });
    if (inserted.length === 0) {
      await manager.query(`UPDATE up_webhook_events SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
      row.attempts += 1;
    }
    return { row, created: inserted.length > 0 };
  }

  async completeEvent(id: string, outcome: UpWebhookEventEntity['outcome'], manager: EntityManager = this.uow.manager): Promise<void> {
    await manager.query(`UPDATE up_webhook_events SET outcome = $2, processed_at = now() WHERE id = $1`, [id, outcome]);
  }

  async startRun(userId: string, integrationId: string, trigger: UpSyncTrigger, manager: EntityManager = this.uow.manager): Promise<UpSyncRunEntity> {
    return manager.save(UpSyncRunEntity, Object.assign(new UpSyncRunEntity(), {
      id: randomUUID(), userId, integrationId, trigger, status: 'running', accountsSeen: 0, transactionsCreated: 0,
      transactionsUpdated: 0, transactionsDeleted: 0, errorCode: null, startedAt: new Date(), finishedAt: null,
    }));
  }

  finishRun(run: UpSyncRunEntity, manager: EntityManager = this.uow.manager): Promise<UpSyncRunEntity> {
    run.finishedAt = new Date();
    return manager.save(UpSyncRunEntity, run);
  }

  listRuns(userId: string, integrationId: string, limit: number, manager: EntityManager = this.uow.manager): Promise<UpSyncRunEntity[]> {
    return manager.find(UpSyncRunEntity, { where: { userId, integrationId }, order: { startedAt: 'DESC', id: 'DESC' }, take: limit });
  }

  /** Deletes the imported accounts, transactions and webhook events of an integration. Sync run history stays as an audit trail */
  async purge(userId: string, integrationId: string, manager: EntityManager): Promise<{ accounts: number; transactions: number }> {
    const transactions = await manager.query(`DELETE FROM up_transactions WHERE user_id = $1 AND integration_id = $2 RETURNING id`, [userId, integrationId]);
    await manager.query(`DELETE FROM up_webhook_events WHERE user_id = $1 AND integration_id = $2`, [userId, integrationId]);
    const accounts = await manager.query(`DELETE FROM up_accounts WHERE user_id = $1 AND integration_id = $2 RETURNING id`, [userId, integrationId]);
    return { accounts: rowCount(accounts), transactions: rowCount(transactions) };
  }
}

/** TypeORM's Postgres driver answers UPDATE/DELETE ... RETURNING as [rows, count], but INSERT and SELECT as plain rows */
function rowCount(result: unknown): number {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0].length;
  return Array.isArray(result) ? result.length : 0;
}
