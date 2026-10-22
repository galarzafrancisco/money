import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CredentialRejectedError, NotConfiguredError, UpstreamError } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { UnitOfWork } from '../database/unit-of-work';
import { UpAuthRejectedError, UpUnavailableError, type UpApiClient } from './up-api.client';
import { accountValues, transactionValues } from './up-mapping';
import type { UpIntegrationEntity, UpSyncRunEntity, UpSyncTrigger } from './up.entities';
import { UpRepository } from './up.repository';
import { UpVault } from './up-vault';

export const UP_API_CLIENT = Symbol('UP_API_CLIENT');

export type SyncStats = { accounts: number; created: number; updated: number; deleted: number };

/**
 * Imports Up data into the up_* tables. Provider access goes through
 * UpApiClient, persistence through UpRepository: this class holds the rules
 * (what a first and an incremental sync read, how updates and deletions are
 * detected) and nothing HTTP-shaped, so a different transport (a scheduled
 * job, a CLI) can call it too.
 *
 * Idempotent: every write is an upsert keyed by (integration, Up ID), so
 * overlapping syncs, repeated webhooks and retries converge on the same rows.
 */
@Injectable()
export class UpSyncService {
  /** Syncs in flight per integration, so concurrent triggers share one run. Pure coalescing, no business state */
  private readonly running = new Map<string, Promise<SyncStats>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(UP_API_CLIENT) private readonly client: UpApiClient,
    private readonly repo: UpRepository,
    private readonly vault: UpVault,
    private readonly uow: UnitOfWork,
  ) {}

  /** The decrypted token, or null when it cannot be read (disconnected, or the key changed) */
  tokenOf(integration: UpIntegrationEntity): string | null {
    if (!integration.tokenCiphertext) return null;
    return this.vault.tryDecrypt(integration.tokenCiphertext, integration.id);
  }

  sync(integration: UpIntegrationEntity, trigger: UpSyncTrigger): Promise<SyncStats> {
    const existing = this.running.get(integration.id);
    if (existing) return existing;
    const run = this.syncOnce(integration, trigger).finally(() => this.running.delete(integration.id));
    this.running.set(integration.id, run);
    return run;
  }

  private async syncOnce(integration: UpIntegrationEntity, trigger: UpSyncTrigger): Promise<SyncStats> {
    if (integration.status === 'disconnected') throw new NotConfiguredError('The Up integration is disconnected');
    const token = this.tokenOf(integration);
    if (!token) {
      await this.recordFailure(integration, 'token_unreadable');
      throw new CredentialRejectedError('The stored Up token cannot be read; reconnect Up with a new token');
    }
    const userId = integration.userId;
    const run = await this.repo.startRun(userId, integration.id, trigger);
    const stats: SyncStats = { accounts: 0, created: 0, updated: 0, deleted: 0 };
    try {
      const upAccounts = await this.client.listAccounts(token);
      await this.uow.run(async (manager) => {
        for (const account of upAccounts) await this.repo.upsertAccount(userId, integration.id, accountValues(account), manager);
        await this.repo.markAccountsRemovedExcept(userId, integration.id, upAccounts.map((a) => a.id), manager);
      });
      stats.accounts = upAccounts.length;

      for (const upAccount of upAccounts) {
        const local = await this.repo.findAccountByUpId(userId, integration.id, upAccount.id);
        if (!local) continue;
        // Re-read a window before the cursor: statuses change (HELD -> SETTLED) and Up may delete or replace transactions
        const since = local.txCursor ? new Date(local.txCursor.getTime() - this.config.up.overlapDays * 86_400_000) : null;
        const fetched = await this.client.listTransactions(token, upAccount.id, since ? since.toISOString() : null);
        await this.uow.run(async (manager) => {
          const seen = new Set<string>();
          let newest = local.txCursor;
          for (const transaction of fetched) {
            seen.add(transaction.id);
            const result = await this.repo.upsertTransaction(userId, integration.id, local.id, transactionValues(transaction), manager);
            if (result.created) stats.created++;
            else stats.updated++;
            const createdAt = new Date(transaction.attributes.createdAt);
            if (!newest || createdAt > newest) newest = createdAt;
          }
          // Anything we hold inside the window that Up no longer returns was deleted or replaced there
          for (const upId of await this.repo.liveUpIdsSince(userId, local.id, since, manager)) {
            if (!seen.has(upId) && (await this.repo.markTransactionDeleted(userId, integration.id, upId, manager))) stats.deleted++;
          }
          // Targeted update: a full save would overwrite a visibility change made while the sync ran
          await this.repo.setAccountCursor(userId, local.id, newest, manager);
        });
      }

      integration.lastSyncAt = new Date();
      integration.lastErrorCode = null;
      integration.lastErrorAt = null;
      await this.repo.saveIntegration(integration);
      await this.finish(run, 'succeeded', stats, null);
      return stats;
    } catch (error) {
      const failure = await this.classify(integration, error);
      await this.finish(run, 'failed', stats, failure.code);
      throw failure.error;
    }
  }

  /**
   * Applies one transaction fetched from Up (a webhook event). Returns false when Up
   * no longer has it or the account is unknown to us.
   */
  async refreshTransaction(integration: UpIntegrationEntity, token: string, upTransactionId: string): Promise<'applied' | 'deleted' | 'ignored'> {
    const userId = integration.userId;
    const transaction = await this.client.getTransaction(token, upTransactionId);
    if (!transaction) {
      const deleted = await this.uow.run((manager) => this.repo.markTransactionDeleted(userId, integration.id, upTransactionId, manager));
      return deleted ? 'deleted' : 'ignored';
    }
    const upAccountId = transaction.relationships?.account?.data?.id;
    if (!upAccountId) return 'ignored';
    const upAccount = await this.client.getAccount(token, upAccountId);
    if (!upAccount) return 'ignored';
    await this.uow.run(async (manager) => {
      // An account opened after the last sync arrives hidden, like any new import
      await this.repo.upsertAccount(userId, integration.id, accountValues(upAccount), manager);
      const account = await this.repo.findAccountByUpId(userId, integration.id, upAccountId, manager);
      await this.repo.upsertTransaction(userId, integration.id, account!.id, transactionValues(transaction), manager);
    });
    return 'applied';
  }

  async markDeleted(integration: UpIntegrationEntity, upTransactionId: string): Promise<'deleted' | 'ignored'> {
    const deleted = await this.uow.run((manager) => this.repo.markTransactionDeleted(integration.userId, integration.id, upTransactionId, manager));
    return deleted ? 'deleted' : 'ignored';
  }

  /** Records an auth failure or upstream problem on the integration and maps it to a domain error */
  async classify(integration: UpIntegrationEntity, error: unknown): Promise<{ code: string; error: Error }> {
    if (error instanceof UpAuthRejectedError) {
      integration.status = 'rejected';
      await this.recordFailure(integration, 'token_rejected');
      return { code: 'token_rejected', error: new CredentialRejectedError('Up rejected the stored token (revoked or expired). Reconnect Up with a new personal access token.') };
    }
    if (error instanceof UpUnavailableError || error instanceof z.ZodError) {
      await this.recordFailure(integration, 'upstream_unavailable');
      return { code: 'upstream_unavailable', error: new UpstreamError('Up could not be reached or answered unexpectedly; try again later') };
    }
    await this.recordFailure(integration, 'internal_error');
    return { code: 'internal_error', error: error instanceof Error ? error : new Error('Sync failed') };
  }

  private async recordFailure(integration: UpIntegrationEntity, code: string): Promise<void> {
    integration.lastErrorCode = code;
    integration.lastErrorAt = new Date();
    await this.repo.saveIntegration(integration);
  }

  private async finish(run: UpSyncRunEntity, status: 'succeeded' | 'failed', stats: SyncStats, errorCode: string | null): Promise<void> {
    run.status = status;
    run.accountsSeen = stats.accounts;
    run.transactionsCreated = stats.created;
    run.transactionsUpdated = stats.updated;
    run.transactionsDeleted = stats.deleted;
    run.errorCode = errorCode;
    await this.repo.finishRun(run);
  }
}

