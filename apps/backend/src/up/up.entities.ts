import { Column, Entity, PrimaryColumn } from 'typeorm';

const numeric = (name: string, nullable = false) => ({ name, type: 'numeric' as const, precision: 30, scale: 10, nullable });

export type UpIntegrationStatus = 'active' | 'rejected' | 'disconnected';
export type UpWebhookStatus = 'none' | 'registered' | 'failed';

/** A user's connection to Up. At most one per user. Secrets are AES-256-GCM ciphertext, bound to this row's ID */
@Entity('up_integrations')
export class UpIntegrationEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ type: 'varchar', length: 20 }) status: UpIntegrationStatus;
  /** Null once disconnected */
  @Column({ name: 'token_ciphertext', type: 'text', nullable: true }) tokenCiphertext: string | null;
  /** Up's webhook ID: the opaque identity an inbound event is matched on */
  @Column({ name: 'webhook_id', type: 'varchar', length: 64, nullable: true }) webhookId: string | null;
  @Column({ name: 'webhook_secret_ciphertext', type: 'text', nullable: true }) webhookSecretCiphertext: string | null;
  @Column({ name: 'webhook_status', type: 'varchar', length: 20 }) webhookStatus: UpWebhookStatus;
  @Column({ name: 'last_error_code', type: 'varchar', length: 40, nullable: true }) lastErrorCode: string | null;
  @Column({ name: 'last_error_at', type: 'timestamptz', nullable: true }) lastErrorAt: Date | null;
  @Column({ name: 'connected_at', type: 'timestamptz' }) connectedAt: Date;
  @Column({ name: 'disconnected_at', type: 'timestamptz', nullable: true }) disconnectedAt: Date | null;
  @Column({ name: 'last_sync_at', type: 'timestamptz', nullable: true }) lastSyncAt: Date | null;
  @Column({ name: 'created_at', type: 'timestamptz', update: false, default: () => 'now()' }) createdAt: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
}

@Entity('up_accounts')
export class UpAccountEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ name: 'integration_id', type: 'uuid' }) integrationId: string;
  @Column({ name: 'up_id', type: 'varchar', length: 64 }) upId: string;
  @Column({ name: 'display_name', type: 'varchar', length: 255 }) displayName: string;
  @Column({ name: 'account_type', type: 'varchar', length: 30 }) accountType: string;
  @Column({ name: 'ownership_type', type: 'varchar', length: 30 }) ownershipType: string;
  @Column({ type: 'varchar', length: 3 }) currency: string;
  @Column(numeric('balance')) balance: string;
  @Column({ name: 'up_created_at', type: 'timestamptz' }) upCreatedAt: Date;
  /** false = imported and tracked but hidden from default views */
  @Column({ type: 'boolean', default: false }) visible: boolean;
  @Column({ name: 'linked_account_id', type: 'uuid', nullable: true }) linkedAccountId: string | null;
  /** Newest Up createdAt fully imported for this account */
  @Column({ name: 'tx_cursor', type: 'timestamptz', nullable: true }) txCursor: Date | null;
  @Column({ name: 'first_imported_at', type: 'timestamptz', default: () => 'now()', update: false }) firstImportedAt: Date;
  @Column({ name: 'last_synced_at', type: 'timestamptz', nullable: true }) lastSyncedAt: Date | null;
  /** Set when Up no longer lists the account; data is kept */
  @Column({ name: 'removed_at', type: 'timestamptz', nullable: true }) removedAt: Date | null;
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
}

@Entity('up_transactions')
export class UpTransactionEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ name: 'integration_id', type: 'uuid' }) integrationId: string;
  @Column({ name: 'up_account_id', type: 'uuid' }) upAccountId: string;
  @Column({ name: 'up_id', type: 'varchar', length: 64 }) upId: string;
  @Column({ type: 'varchar', length: 10 }) status: 'HELD' | 'SETTLED';
  @Column({ type: 'text' }) description: string;
  @Column({ name: 'raw_text', type: 'text', nullable: true }) rawText: string | null;
  @Column({ type: 'text', nullable: true }) message: string | null;
  @Column({ name: 'transaction_type', type: 'varchar', length: 100, nullable: true }) transactionType: string | null;
  @Column({ type: 'varchar', length: 3 }) currency: string;
  /** Signed: negative = money out of the Up account */
  @Column(numeric('amount')) amount: string;
  @Column({ name: 'foreign_currency', type: 'varchar', length: 3, nullable: true }) foreignCurrency: string | null;
  @Column(numeric('foreign_amount', true)) foreignAmount: string | null;
  @Column({ name: 'category_id', type: 'varchar', length: 100, nullable: true }) categoryId: string | null;
  @Column({ name: 'transfer_up_account_id', type: 'varchar', length: 64, nullable: true }) transferUpAccountId: string | null;
  @Column({ name: 'up_created_at', type: 'timestamptz' }) upCreatedAt: Date;
  @Column({ name: 'settled_at', type: 'timestamptz', nullable: true }) settledAt: Date | null;
  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt: Date | null;
  /** The manual Money transaction this is the same real-world event as */
  @Column({ name: 'matched_transaction_id', type: 'uuid', nullable: true }) matchedTransactionId: string | null;
  @Column({ name: 'first_imported_at', type: 'timestamptz', default: () => 'now()', update: false }) firstImportedAt: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
}

export type UpWebhookOutcome = 'applied' | 'deleted' | 'ignored' | 'ping';

@Entity('up_webhook_events')
export class UpWebhookEventEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ name: 'integration_id', type: 'uuid' }) integrationId: string;
  @Column({ name: 'event_id', type: 'varchar', length: 64 }) eventId: string;
  @Column({ name: 'event_type', type: 'varchar', length: 40 }) eventType: string;
  @Column({ name: 'up_transaction_id', type: 'varchar', length: 64, nullable: true }) upTransactionId: string | null;
  /** Null until the event has been fully processed */
  @Column({ type: 'varchar', length: 20, nullable: true }) outcome: UpWebhookOutcome | null;
  @Column({ type: 'integer', default: 1 }) attempts: number;
  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'now()', update: false }) receivedAt: Date;
  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true }) processedAt: Date | null;
}

export type UpSyncTrigger = 'connect' | 'manual' | 'webhook' | 'reconnect';

@Entity('up_sync_runs')
export class UpSyncRunEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ name: 'integration_id', type: 'uuid' }) integrationId: string;
  @Column({ type: 'varchar', length: 20 }) trigger: UpSyncTrigger;
  @Column({ type: 'varchar', length: 20 }) status: 'running' | 'succeeded' | 'failed';
  @Column({ name: 'accounts_seen', type: 'integer', default: 0 }) accountsSeen: number;
  @Column({ name: 'transactions_created', type: 'integer', default: 0 }) transactionsCreated: number;
  @Column({ name: 'transactions_updated', type: 'integer', default: 0 }) transactionsUpdated: number;
  @Column({ name: 'transactions_deleted', type: 'integer', default: 0 }) transactionsDeleted: number;
  @Column({ name: 'error_code', type: 'varchar', length: 40, nullable: true }) errorCode: string | null;
  @Column({ name: 'started_at', type: 'timestamptz' }) startedAt: Date;
  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true }) finishedAt: Date | null;
}

export const UP_ENTITIES = [UpIntegrationEntity, UpAccountEntity, UpTransactionEntity, UpWebhookEventEntity, UpSyncRunEntity];
