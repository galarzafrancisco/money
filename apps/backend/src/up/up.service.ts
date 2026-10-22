import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, CredentialRejectedError, NotConfiguredError, NotFoundError, UpstreamError, ValidationError } from '../common/errors';
import { fmt, fmtOrNull, dec } from '../common/decimal';
import { isUuid, parseInput } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { UnitOfWork } from '../database/unit-of-work';
import { AccountsService } from '../accounts/accounts.service';
import { CategoriesService } from '../categories/categories.service';
import type { CurrentUser } from '../users/users.service';
import { UpAuthRejectedError, UpUnavailableError, type UpApiClient } from './up-api.client';
import { UpVault } from './up-vault';
import { UP_API_CLIENT, UpSyncService, type SyncStats } from './up-sync.service';
import { UpIntegrationEntity, type UpAccountEntity, type UpSyncRunEntity, type UpTransactionEntity } from './up.entities';
import { UpRepository } from './up.repository';
import {
  connectUpSchema,
  disconnectUpSchema,
  listUpAccountsSchema,
  listUpTransactionsSchema,
  matchUpTransactionSchema,
  setUpVisibilitySchema,
  updateUpAccountSchema,
  type ConnectUpInput,
  type SetUpVisibilityInput,
} from './up.schemas';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export type UpStatusView = {
  configured: boolean;
  status: 'none' | 'active' | 'rejected' | 'disconnected';
  webhookStatus: 'none' | 'registered' | 'failed';
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: { code: string; at: string } | null;
  accounts: { total: number; visible: number; hidden: number };
  hint: string | null;
};

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);
const WEBHOOK_DESCRIPTION = 'Money (read-only tracking)';

/**
 * The Up! integration for one user: connect, status, sync, account
 * visibility, imported transactions, reconciliation and disconnect. REST and
 * MCP both call this. Imported data is a separate, read-only record of what
 * Up reports. It is never written into the manual ledger.
 */
@Injectable()
export class UpService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(UP_API_CLIENT) private readonly client: UpApiClient,
    private readonly repo: UpRepository,
    private readonly sync: UpSyncService,
    private readonly vault: UpVault,
    private readonly uow: UnitOfWork,
    private readonly accounts: AccountsService,
    private readonly categories: CategoriesService,
  ) {}

  async status(user: CurrentUser): Promise<UpStatusView> {
    const integration = await this.repo.findIntegration(user.id);
    return this.statusOf(user.id, integration);
  }

  /**
   * Connects Up with a personal access token, or reconnects with a new one
   * (token rotation), then imports every accessible account and its
   * transactions. New accounts start hidden: choose what to show with
   * setVisibility.
   */
  async connect(user: CurrentUser, input: ConnectUpInput): Promise<UpStatusView> {
    const { token } = parseInput(connectUpSchema, input);
    if (!this.vault.available) throw new NotConfiguredError('The Up integration is not configured on this server (UP_ENCRYPTION_KEY is not set)');

    // 1. The token must work, and must belong to the same Up customer as any earlier import
    let upAccounts;
    try {
      upAccounts = await this.client.listAccounts(token);
    } catch (error) {
      throw this.providerError(error, 'Up rejected this token. Check that it is a current personal access token.');
    }
    const upIds = upAccounts.map((account) => account.id);
    if (await this.repo.upAccountsClaimedByOthers(user.id, upIds)) {
      throw new ConflictError('These Up accounts are already connected to another Money user');
    }
    let integration = await this.repo.findIntegration(user.id);
    const trigger = integration ? 'reconnect' : 'connect';
    if (integration) {
      const known = (await this.repo.listAccounts(user.id, integration.id)).map((account) => account.upId);
      if (known.length > 0 && !known.some((id) => upIds.includes(id))) {
        throw new ConflictError('This token belongs to a different Up customer than the data already imported. Disconnect with purge: true first to start over.');
      }
    }

    // 2. Store the token encrypted; replace the webhook (a new token cannot reuse the old secret)
    const previousWebhook = integration?.webhookId && integration.tokenCiphertext ? { id: integration.webhookId, token: this.sync.tokenOf(integration) } : null;
    const now = new Date();
    integration ??= Object.assign(new UpIntegrationEntity(), {
      id: randomUUID(), userId: user.id, connectedAt: now, disconnectedAt: null, lastSyncAt: null,
    });
    integration.status = 'active';
    integration.tokenCiphertext = this.vault.encrypt(token, integration.id);
    integration.connectedAt = now;
    integration.disconnectedAt = null;
    integration.lastErrorCode = null;
    integration.lastErrorAt = null;
    integration.webhookId = null;
    integration.webhookSecretCiphertext = null;
    integration.webhookStatus = 'none';
    await this.repo.saveIntegration(integration);
    if (previousWebhook?.token) await this.removeOurWebhooks(previousWebhook.token).catch(() => undefined); // the old token may be revoked or rotated already
    await this.registerWebhook(integration, token);

    // 3. Import
    await this.sync.sync(integration, trigger);
    return this.statusOf(user.id, integration);
  }

  async syncNow(user: CurrentUser): Promise<SyncStats & { status: UpStatusView }> {
    const integration = await this.requireIntegration(user);
    if (integration.status === 'disconnected') throw new ConflictError('Up is disconnected; connect it again first');
    const stats = await this.sync.sync(integration, 'manual');
    return { ...stats, status: await this.statusOf(user.id, integration) };
  }

  /**
   * Disconnects: removes Money's webhook at Up (best effort), erases the stored
   * token and webhook secret, and stops syncing. Imported data stays unless
   * `purge` is set. Money cannot revoke the token itself: revoke it at Up too.
   */
  async disconnect(user: CurrentUser, input: unknown) {
    const { purge } = parseInput(disconnectUpSchema, input);
    const integration = await this.requireIntegration(user);
    let webhookRemoved = false;
    const token = this.sync.tokenOf(integration);
    if (token && integration.webhookId) {
      try {
        await this.removeOurWebhooks(token);
        webhookRemoved = true;
      } catch {
        // The token may already be revoked; the webhook secret is erased below either way
      }
    }
    return this.uow.run(async (manager) => {
      integration.status = 'disconnected';
      integration.tokenCiphertext = null;
      integration.webhookId = null;
      integration.webhookSecretCiphertext = null;
      integration.webhookStatus = 'none';
      integration.disconnectedAt = new Date();
      await this.repo.saveIntegration(integration, manager);
      const counts = purge ? await this.repo.purge(user.id, integration.id, manager) : { accounts: 0, transactions: 0 };
      return { disconnected: true, purged: Boolean(purge), accountsDeleted: counts.accounts, transactionsDeleted: counts.transactions, webhookRemoved };
    });
  }

  async listAccounts(user: CurrentUser, input: unknown) {
    const { visibility } = parseInput(listUpAccountsSchema, input);
    const all = await this.repo.listAccounts(user.id, null);
    return all.filter((account) => matchesVisibility(account, visibility ?? 'visible')).map(accountView);
  }

  async updateAccount(user: CurrentUser, id: string, input: unknown) {
    const changes = parseInput(updateUpAccountSchema, input);
    const account = isUuid(id) ? await this.repo.findAccount(user.id, id) : null;
    if (!account) throw new NotFoundError(`Up account ${id} not found`);
    if (changes.visible !== undefined) account.visible = changes.visible;
    if (changes.linkedAccountId !== undefined) {
      if (changes.linkedAccountId === null) account.linkedAccountId = null;
      else account.linkedAccountId = (await this.accounts.require(user, changes.linkedAccountId)).id;
    }
    if (changes.categoryId !== undefined) {
      if (changes.categoryId === null) account.categoryId = null;
      else account.categoryId = (await this.categories.get(user, changes.categoryId)).id;
    }
    return accountView(await this.repo.saveAccount(account));
  }

  /** Makes exactly these accounts visible and hides the rest. Hidden accounts keep syncing */
  async setVisibility(user: CurrentUser, input: SetUpVisibilityInput) {
    const { visibleAccountIds } = parseInput(setUpVisibilitySchema, input);
    return this.uow.run(async (manager) => {
      const all = await this.repo.listAccounts(user.id, null, manager);
      const byId = new Map(all.map((account) => [account.id, account]));
      for (const id of visibleAccountIds) if (!byId.has(id)) throw new NotFoundError(`Up account ${id} not found`);
      const wanted = new Set(visibleAccountIds);
      for (const account of all) {
        const visible = wanted.has(account.id);
        if (account.visible !== visible) {
          account.visible = visible;
          await this.repo.saveAccount(account, manager);
        }
      }
      return all.map(accountView);
    });
  }

  async listTransactions(user: CurrentUser, input: unknown) {
    const query = parseInput(listUpTransactionsSchema, input);
    const accounts = await this.repo.listAccounts(user.id, null);
    let scope: UpAccountEntity[];
    if (query.accountId) {
      const one = isUuid(query.accountId) ? accounts.find((account) => account.id === query.accountId) : undefined;
      if (!one) throw new NotFoundError(`Up account ${query.accountId} not found`);
      scope = [one]; // asking for one account by ID is the per-account "show all"
    } else {
      scope = accounts.filter((account) => matchesVisibility(account, query.visibility ?? 'visible'));
    }
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const rows = await this.repo.listTransactions(user.id, {
      upAccountIds: scope.map((account) => account.id),
      status: query.status,
      fromDate: query.fromDate,
      toDate: query.toDate,
      includeDeleted: query.includeDeleted,
      reconciliation: query.reconciliation,
      limit: limit + 1,
      offset,
    });
    return { items: rows.slice(0, limit).map(transactionView), nextOffset: rows.length > limit ? offset + limit : null };
  }

  /** Marks an imported transaction as the same event as a manual Money transaction, so the two are not counted twice */
  async match(user: CurrentUser, id: string, input: unknown) {
    const { transactionId } = parseInput(matchUpTransactionSchema, input);
    const transaction = await this.requireTransaction(user, id);
    if (!isUuid(transactionId) || !(await this.repo.moneyTransactionExists(user.id, transactionId))) {
      throw new NotFoundError(`Transaction ${transactionId} not found`);
    }
    try {
      transaction.matchedTransactionId = transactionId;
      return transactionView(await this.repo.saveTransaction(transaction));
    } catch (error) {
      if (/UQ_up_transactions_matched/.test(String((error as Error).message))) throw new ConflictError('That Money transaction is already matched to another Up transaction');
      throw error;
    }
  }

  async unmatch(user: CurrentUser, id: string) {
    const transaction = await this.requireTransaction(user, id);
    transaction.matchedTransactionId = null;
    return transactionView(await this.repo.saveTransaction(transaction));
  }

  async runs(user: CurrentUser): Promise<ReturnType<typeof runView>[]> {
    const integration = await this.repo.findIntegration(user.id);
    if (!integration) return [];
    return (await this.repo.listRuns(user.id, integration.id, 20)).map(runView);
  }

  // ---------- internals ----------

  private async requireIntegration(user: CurrentUser): Promise<UpIntegrationEntity> {
    const integration = await this.repo.findIntegration(user.id);
    if (!integration) throw new NotFoundError('Up is not connected');
    return integration;
  }

  private async requireTransaction(user: CurrentUser, id: string): Promise<UpTransactionEntity> {
    const transaction = isUuid(id) ? await this.repo.findTransaction(user.id, id) : null;
    if (!transaction) throw new NotFoundError(`Up transaction ${id} not found`);
    return transaction;
  }

  private providerError(error: unknown, rejectedMessage: string): Error {
    if (error instanceof UpAuthRejectedError) return new CredentialRejectedError(rejectedMessage);
    if (error instanceof UpUnavailableError || error instanceof z.ZodError) return new UpstreamError('Up could not be reached or answered unexpectedly; try again later');
    return error instanceof Error ? error : new Error('Up request failed');
  }

  /** Removes webhooks at Up that point at Money's callback URL. Webhooks are per Up customer, so these are all Money's */
  private async removeOurWebhooks(token: string): Promise<void> {
    for (const webhook of await this.client.listWebhooks(token)) {
      if (webhook.url === this.config.up.webhookUrl) await this.client.deleteWebhook(token, webhook.id);
    }
  }

  private async registerWebhook(integration: UpIntegrationEntity, token: string): Promise<void> {
    if (!this.config.up.registerWebhook) return;
    try {
      await this.removeOurWebhooks(token); // leftovers of an earlier connection would exhaust Up's webhook limit
      const webhook = await this.client.createWebhook(token, this.config.up.webhookUrl, WEBHOOK_DESCRIPTION);
      integration.webhookId = webhook.id;
      integration.webhookSecretCiphertext = this.vault.encrypt(webhook.secretKey, integration.id);
      integration.webhookStatus = 'registered';
    } catch {
      // Not fatal: syncs still import everything, only push updates are missing
      integration.webhookStatus = 'failed';
    }
    await this.repo.saveIntegration(integration);
  }

  private async statusOf(userId: string, integration: UpIntegrationEntity | null): Promise<UpStatusView> {
    const configured = this.vault.available;
    if (!integration) {
      return { configured, status: 'none', webhookStatus: 'none', connectedAt: null, lastSyncAt: null, lastError: null, accounts: { total: 0, visible: 0, hidden: 0 }, hint: configured ? null : 'Up is not configured on this server.' };
    }
    const accounts = await this.repo.listAccounts(userId, integration.id);
    const visible = accounts.filter((account) => account.visible).length;
    let hint: string | null = null;
    if (integration.status === 'rejected') hint = 'Up rejected the stored token. Reconnect with a new personal access token.';
    else if (integration.status === 'active' && accounts.length > 0 && visible === 0) hint = 'Imported Up accounts are hidden by default. Choose which to show.';
    return {
      configured,
      status: integration.status,
      webhookStatus: integration.webhookStatus,
      connectedAt: iso(integration.connectedAt),
      lastSyncAt: iso(integration.lastSyncAt),
      lastError: integration.lastErrorCode && integration.lastErrorAt ? { code: integration.lastErrorCode, at: integration.lastErrorAt.toISOString() } : null,
      accounts: { total: accounts.length, visible, hidden: accounts.length - visible },
      hint,
    };
  }
}

function matchesVisibility(account: UpAccountEntity, visibility: 'visible' | 'hidden' | 'all'): boolean {
  return visibility === 'all' || (visibility === 'visible' ? account.visible : !account.visible);
}

function accountView(account: UpAccountEntity) {
  return {
    id: account.id,
    upId: account.upId,
    displayName: account.displayName,
    accountType: account.accountType,
    ownershipType: account.ownershipType,
    currency: account.currency,
    balance: fmt(dec(account.balance)),
    visible: account.visible,
    linkedAccountId: account.linkedAccountId,
    categoryId: account.categoryId,
    source: 'up' as const,
    lastSyncedAt: iso(account.lastSyncedAt),
    removedAt: iso(account.removedAt),
    upCreatedAt: account.upCreatedAt.toISOString(),
  };
}

function transactionView(t: UpTransactionEntity) {
  return {
    id: t.id,
    upId: t.upId,
    accountId: t.upAccountId,
    status: t.status,
    description: t.description,
    message: t.message,
    transactionType: t.transactionType,
    currency: t.currency,
    amount: fmt(dec(t.amount)),
    foreignCurrency: t.foreignCurrency,
    foreignAmount: t.foreignAmount === null ? null : fmt(dec(t.foreignAmount)),
    categoryId: t.categoryId,
    transferUpAccountId: t.transferUpAccountId,
    createdAt: t.upCreatedAt.toISOString(),
    settledAt: iso(t.settledAt),
    deletedAt: iso(t.deletedAt),
    matchedTransactionId: t.matchedTransactionId,
    reconciliation: t.matchedTransactionId ? ('matched' as const) : ('unmatched' as const),
    source: 'up' as const,
  };
}

function runView(run: UpSyncRunEntity) {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    accountsSeen: run.accountsSeen,
    transactionsCreated: run.transactionsCreated,
    transactionsUpdated: run.transactionsUpdated,
    transactionsDeleted: run.transactionsDeleted,
    errorCode: run.errorCode,
    startedAt: run.startedAt.toISOString(),
    finishedAt: iso(run.finishedAt),
  };
}
