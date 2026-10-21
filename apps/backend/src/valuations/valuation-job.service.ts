import { Inject, Injectable, Logger } from '@nestjs/common';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AccountsRepository } from '../accounts/accounts.repository';
import { dec, fmt } from '../common/decimal';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { addDays, dateRange } from '../market-prices/market-calendar';
import { toLedgerEntry } from '../transactions/transaction.mapper';
import type { TransactionEntity } from '../transactions/transaction.entity';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { PriceHistoryService } from './price-history.service';
import { FINAL_STATUSES, positionsByDate, priceHolding } from './valuation-math';
import { ValuationsRepository, type ValuationHoldingRow } from './valuations.repository';

export type UserRunSummary = {
  userId: string;
  datesComputed: number;
  partialDays: number;
  /** More dates were due than VALUATION_MAX_DAYS_PER_RUN; the rest are left for the next run */
  truncated: boolean;
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
  ) {}

  async runOnce(now: Date = new Date(), options: { userId?: string } = {}): Promise<RunSummary> {
    const base = {
      now: now.toISOString(),
      settledThrough: settledThrough(now, this.config.valuations.settleHourUtc),
      priceProvider: this.prices.providerName,
    };
    if (!(await this.repo.acquireLease(this.owner, LEASE_MINUTES))) {
      return { ...base, skipped: true, reason: 'Another run holds the lease', users: [] };
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
          users.push({ userId, datesComputed: 0, partialDays: 0, truncated: false, error: message });
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      this.logger.error(`Valuation run failed: ${failure}`);
    }
    const summary: RunSummary = { ...base, skipped: false, users };
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
    const summary: UserRunSummary = { userId, datesComputed: 0, partialDays: 0, truncated: false };
    const requests = await this.repo.recomputeRequests(userId);
    if (!(await this.repo.userExists(userId))) {
      await this.repo.clearRequests(userId, requests);
      return summary;
    }
    const rows = await this.transactions.list(userId, {});
    const firstBuy = rows.find((r) => r.type === 'BUY')?.date ?? null;
    await this.repo.deleteDaysBefore(userId, firstBuy);
    if (!firstBuy) {
      await this.repo.clearRequests(userId, requests);
      return summary;
    }

    const today = now.toISOString().slice(0, 10);
    const floor = [firstBuy, addDays(today, -cfg.backfillDays)].sort()[1];
    if (floor > settled) {
      await this.repo.clearRequests(userId, requests);
      return summary;
    }
    const existing = new Map((await this.repo.listDays(userId, floor, settled)).map((d) => [d.date, d]));
    const requestedFrom = requests.length > 0 ? requests[0].fromDate : null;
    const recheckFrom = addDays(settled, -cfg.recheckDays);
    let due = dateRange(floor, settled).filter((date) => {
      const day = existing.get(date);
      return (
        !day ||
        day.priceProvider !== this.prices.providerName ||
        (day.status === 'PARTIAL' && date >= recheckFrom) ||
        (requestedFrom !== null && date >= requestedFrom)
      );
    });
    if (due.length > cfg.maxDaysPerRun) {
      due = due.slice(0, cfg.maxDaysPerRun);
      summary.truncated = true;
    }
    if (due.length === 0) {
      await this.repo.clearRequests(userId, requests);
      return summary;
    }

    const accounts = await this.accounts.list(userId);
    const rowsByAccount = new Map<string, TransactionEntity[]>();
    for (const row of rows) rowsByAccount.set(row.accountId, [...(rowsByAccount.get(row.accountId) ?? []), row]);
    const positions = accounts.map((account) => ({
      accountId: account.id,
      byDate: positionsByDate((rowsByAccount.get(account.id) ?? []).map(toLedgerEntry), due),
    }));
    const symbols = new Set<string>();
    for (const { byDate } of positions) for (const list of byDate.values()) for (const p of list) symbols.add(p.symbol);
    // Up to today, so a later session reveals a holiday; back far enough to carry a previous close
    const series = await this.prices.getSeries([...symbols], { from: addDays(due[0], -cfg.maxCarryDays), to: today }, now);

    for (const date of due) {
      const holdings: Omit<ValuationHoldingRow, 'date'>[] = [];
      for (const { accountId, byDate } of positions) {
        for (const position of byDate.get(date) ?? []) {
          const priced = priceHolding(position, date, series.get(position.symbol), cfg.maxCarryDays);
          const unit = priced.close ? fmt(dec(priced.close.close)) : null;
          holdings.push({
            accountId,
            symbol: position.symbol,
            currency: position.currency,
            quantity: fmt(position.quantity),
            costBase: fmt(position.costBase),
            priceStatus: priced.status,
            closePrice: unit,
            priceCurrency: priced.close ? priced.series!.currency : null,
            priceDate: priced.close?.tradingDate ?? null,
            priceCloseTime: priced.close?.closeTime ?? null,
            priceSource: priced.series?.source ?? null,
            priceIsMock: priced.series ? priced.series.isMock : null,
            exchangeTimezone: priced.series?.exchangeTimezone ?? null,
            marketValue: priced.marketValue ? fmt(priced.marketValue) : null,
            priceNote: priced.note,
            lots: position.lots.map((lot) => ({
              lotId: lot.lotId,
              acquiredOn: lot.acquiredOn,
              quantity: fmt(lot.remainingQuantity),
              costBase: fmt(lot.remainingCostBase),
              marketValue: priced.marketValue && unit ? fmt(lot.remainingQuantity.times(unit)) : null,
            })),
          });
        }
      }
      const complete = holdings.every((h) => FINAL_STATUSES.includes(h.priceStatus));
      await this.repo.replaceDay(userId, { date, status: complete ? 'COMPLETE' : 'PARTIAL', priceProvider: this.prices.providerName }, holdings);
      summary.datesComputed++;
      if (!complete) summary.partialDays++;
    }
    if (!summary.truncated) await this.repo.clearRequests(userId, requests);
    return summary;
  }
}
