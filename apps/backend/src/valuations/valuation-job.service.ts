import { Inject, Injectable, Logger } from '@nestjs/common';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AccountsRepository } from '../accounts/accounts.repository';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { addDays } from '../market-prices/market-calendar';
import { sameSplits } from '../splits/split-math';
import { SplitsService } from '../splits/splits.service';
import type { TransactionEntity } from '../transactions/transaction.entity';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { requestProgress, selectDueDates } from './due-dates';
import { PriceHistoryService } from './price-history.service';
import { FINAL_STATUSES, holdingsOn, positionsByDate, priceWindows } from './valuation-math';
import { ValuationsRepository } from './valuations.repository';

export type UserRunSummary = {
  userId: string;
  datesComputed: number;
  partialDays: number;
  /** More dates were due than VALUATION_MAX_DAYS_PER_RUN; the rest are left for the next run */
  truncated: boolean;
  /** Due dates left for the next run (a backfill in progress) */
  remaining: number;
  error?: string;
};

export type RunSummary = {
  skipped: boolean;
  reason?: string;
  now: string;
  /** The latest valuation date that was due at `now` */
  settledThrough: string;
  priceProvider: string;
  users: UserRunSummary[];
  /** Some user still has due dates: run again soon (catch-up) rather than at the next interval */
  moreDue: boolean;
};

const LEASE_MINUTES = 30;

/**
 * Valuation date D is due once the closes of D are final everywhere Money
 * looks: D+1 at settleHourUtc (06:00 UTC by default: after the US close of D,
 * 20:00/21:00 UTC, and long after the ASX close).
 */
export function settledThrough(now: Date, settleHourUtc: number): string {
  return addDays(new Date(now.getTime() - settleHourUtc * 3_600_000).toISOString().slice(0, 10), -1);
}

/**
 * The first date a user's history has to cover: the first purchase, or with
 * VALUATION_BACKFILL_DAYS set, no further back than that many days.
 */
export function historyFloor(firstBuy: string, today: string, backfillDays: number | null): string {
  if (backfillDays === null) return firstBuy;
  const cap = addDays(today, -backfillDays);
  return firstBuy > cap ? firstBuy : cap;
}

/**
 * Materialises each user's holdings, valued at the market close, for every
 * due date: backfilling missing dates, re-trying recent days whose prices
 * were pending or missing, and re-doing dates affected by backdated trades.
 * Each date is replaced atomically, so the job is idempotent and safe to
 * re-run or retry at any time. See docs/valuations.md.
 */
@Injectable()
export class ValuationJobService {
  private readonly logger = new Logger('ValuationJob');
  private readonly owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly repo: ValuationsRepository,
    private readonly accounts: AccountsRepository,
    private readonly transactions: TransactionsRepository,
    private readonly prices: PriceHistoryService,
    private readonly splits: SplitsService,
  ) {}

  async runOnce(now: Date = new Date(), options: { userId?: string } = {}): Promise<RunSummary> {
    const base = {
      now: now.toISOString(),
      settledThrough: settledThrough(now, this.config.valuations.settleHourUtc),
      priceProvider: this.prices.providerName,
    };
    if (!(await this.repo.acquireLease(this.owner, LEASE_MINUTES))) {
      return { ...base, skipped: true, reason: 'Another run holds the lease', users: [], moreDue: false };
    }
    const users: UserRunSummary[] = [];
    let failure: string | null = null;
    try {
      const ids = options.userId ? [options.userId] : await this.repo.usersToProcess();
      for (const userId of ids) {
        try {
          users.push(await this.processUser(userId, now, base.settledThrough));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Valuing user ${userId} failed: ${message}`);
          users.push({ userId, datesComputed: 0, partialDays: 0, truncated: false, remaining: 0, error: message });
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      this.logger.error(`Valuation run failed: ${failure}`);
    }
    const summary: RunSummary = { ...base, skipped: false, users, moreDue: !failure && users.some((u) => u.truncated) };
    const status = failure ? 'failed' : users.some((u) => u.error || u.truncated || u.partialDays > 0) ? 'partial' : 'ok';
    await this.repo.releaseLease(this.owner, {
      status,
      error: failure ?? (users.filter((u) => u.error).map((u) => `${u.userId}: ${u.error}`).join('; ') || null),
      summary: { ...base, users: users.map(({ userId, ...rest }) => ({ userId, ...rest })) },
    });
    const computed = users.reduce((n, u) => n + u.datesComputed, 0);
    if (computed > 0 || failure) this.logger.log(`Valuation run ${status}: ${computed} user-days computed for ${users.length} users`);
    return summary;
  }

  private async processUser(userId: string, now: Date, settled: string): Promise<UserRunSummary> {
    const cfg = this.config.valuations;
    const summary: UserRunSummary = { userId, datesComputed: 0, partialDays: 0, truncated: false, remaining: 0 };
    const requests = await this.repo.recomputeRequests(userId);
    if (!(await this.repo.userExists(userId))) {
      await this.repo.clearRequests(userId, requests);
      return summary;
    }
    const dbNow = await this.repo.now();
    // Requests are read before the ledger, so the ledger read includes every change they stand for
    const rows = await this.transactions.list(userId, {});
    const firstBuy = rows.find((r) => r.type === 'BUY')?.date ?? null;
    await this.repo.deleteDaysBefore(userId, firstBuy);
    if (!firstBuy) {
      await this.repo.clearRequests(userId, requests);
      return summary;
    }

    const today = now.toISOString().slice(0, 10);
    const floor = historyFloor(firstBuy, today, cfg.backfillDays);
    const existing = new Map((await this.repo.listDays(userId, floor, settled)).map((d) => [d.date, d]));
    const { due, remaining } = selectDueDates({
      floor,
      settled,
      existing,
      priceProvider: this.prices.providerName,
      requests,
      recheckFrom: addDays(settled, -cfg.recheckDays),
      partialRetryBefore: new Date(dbNow.getTime() - cfg.partialRetryDays * 86_400_000),
      maxDays: cfg.maxDaysPerRun,
    });
    summary.remaining = remaining;
    summary.truncated = remaining > 0;
    if (due.length === 0) {
      await this.repo.clearRequests(userId, requests);
      return summary;
    }

    const accounts = await this.accounts.list(userId);
    const rowsByAccount = new Map<string, TransactionEntity[]>();
    for (const row of rows) rowsByAccount.set(row.accountId, [...(rowsByAccount.get(row.accountId) ?? []), row]);
    // Replayed in the present share basis; holdingsOn converts each date to its own basis
    const symbols = rows.filter((r) => r.symbol).map((r) => r.symbol!);
    let splits = await this.splits.index(symbols);
    const replay = () =>
      accounts.map((account) => ({
        accountId: account.id,
        byDate: positionsByDate(this.splits.presentEntriesWith(rowsByAccount.get(account.id) ?? [], splits, now), due),
      }));
    let positions = replay();
    // Each symbol only over the due dates it is held, so closed positions are not looked up past their sale
    const series = await this.prices.getSeriesByRange(priceWindows(positions, due, cfg.maxCarryDays, today), now);
    // The lookup may have recorded a split the provider reported: replay with it (which dates are held does not change)
    const latest = await this.splits.index(symbols);
    if (!sameSplits(splits, latest)) {
      splits = latest;
      positions = replay();
    }

    for (const date of due) {
      const holdings = holdingsOn(positions, date, series, cfg.maxCarryDays, splits);
      const complete = holdings.every((h) => FINAL_STATUSES.includes(h.priceStatus));
      await this.repo.replaceDay(userId, { date, status: complete ? 'COMPLETE' : 'PARTIAL', priceProvider: this.prices.providerName }, holdings);
      summary.datesComputed++;
      if (!complete) summary.partialDays++;
    }
    // Checkpoint each request, or clear it once everything it covers is re-valued
    const computed = new Set(due);
    for (const request of requests) {
      const progress = requestProgress(request, floor, settled, computed);
      if (progress.done) await this.repo.clearRequests(userId, [request]);
      else await this.repo.checkpointRequest(userId, request, progress.recomputedFrom);
    }
    return summary;
  }
}
