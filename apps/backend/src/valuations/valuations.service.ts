import { Inject, Injectable } from '@nestjs/common';
import { AccountsRepository } from '../accounts/accounts.repository';
import { childrenIndex, descendantsOf } from '../accounts/hierarchy';
import { MoneyDecimal, ZERO, dec, fmt } from '../common/decimal';
import { NotFoundError, ValidationError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { addDays, daysBetween } from '../market-prices/market-calendar';
import { assertRatesCover, type FxPolicy, type ValuationItem } from '../reports/aggregation';
import { sameSplits } from '../splits/split-math';
import { SplitsService } from '../splits/splits.service';
import type { TransactionEntity } from '../transactions/transaction.entity';
import { TransactionsRepository } from '../transactions/transactions.repository';
import type { CurrentUser } from '../users/users.service';
import { PriceHistoryService } from './price-history.service';
import { requestCovers } from './due-dates';
import { historyFloor, settledThrough } from './valuation-job.service';
import { FINAL_STATUSES, holdingsOn, positionsByDate, type PriceStatus, type SeriesResult } from './valuation-math';
import {
  recomputeSchema,
  valuationAsOfSchema,
  valuationHistorySchema,
  type RecomputeInput,
  type ValuationAsOfInput,
  type ValuationHistoryInput,
} from './valuations.schemas';
import { ValuationsRepository, type LotSnapshot, type RecomputeRequest, type ValuationDayRow, type ValuationHoldingRow } from './valuations.repository';

const MAX_RANGE_DAYS = 3660;
const MAX_HOLDINGS_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 90;

export type CurrencyTotals = {
  currency: string;
  /** Sum over holdings that have a market value; see unvaluedHoldings */
  marketValue: string;
  /** Sum over all holdings */
  costBase: string;
  holdings: number;
  /** MISSING or CURRENCY_MISMATCH: no market value, left out of marketValue */
  unvaluedHoldings: number;
  /** PRICE_PENDING: valued at an earlier close, provisionally */
  provisionalHoldings: number;
};

export type HoldingSnapshotView = {
  accountId: string;
  symbol: string;
  currency: string;
  quantity: string;
  costBase: string;
  marketValue: string | null;
  price: {
    status: PriceStatus;
    close: string | null;
    currency: string | null;
    /** The trading date of the close used; differs from the valuation date on non-trading or pending days */
    tradingDate: string | null;
    closeTime: string | null;
    exchangeTimezone: string | null;
    source: string | null;
    isMock: boolean | null;
    note: string | null;
  };
  /**
   * The share basis: quantity, lots and price.close are as held and traded
   * on the valuation date. factor converts them to the present basis
   * (adjustedQuantity = quantity × factor, adjustedClose = close ÷ factor).
   * Null on snapshots written before splits were modelled.
   */
  split: { basis: 'VALUATION_DATE'; factor: string; adjustedQuantity: string; adjustedClose: string | null } | null;
  lots: LotSnapshot[];
};

/** A split of a symbol in scope, effective within the requested range: explains a step in quantity and close */
export type SplitInRange = { symbol: string; instrument: string; effectiveDate: string; numerator: string; denominator: string; ratio: string; provenance: string; source: string };

/** The rate one currency was converted at on one valuation date */
export type FxRateUsed = {
  currency: string;
  /** Units of baseCurrency per unit of currency */
  rate: string;
  /** HISTORICAL: the pair's daily close on or before the date. CONSTANT: your fxRates. */
  kind: 'HISTORICAL' | 'CONSTANT';
  /** The FX close's date (HISTORICAL); null for CONSTANT */
  tradingDate: string | null;
  source: string;
  isMock: boolean;
};

export type ConvertedTotals = {
  baseCurrency: string;
  marketValue: string;
  costBase: string;
  rates: FxRateUsed[];
} | null;

export type ValuationDayView = {
  date: string;
  /** Every in-scope holding is valued at its close (or the last close on a non-trading day) */
  complete: boolean;
  includesMockPrices: boolean;
  /** A backdated change or price correction is waiting to be re-valued on this date; figures may change */
  pendingRecompute: boolean;
  priceProvider: string;
  computedAt: string;
  totals: {
    byCurrency: CurrencyTotals[];
    /** Null without baseCurrency, or when a currency has no rate for this date (see conversionUnavailable) */
    converted: ConvertedTotals;
    /** Currencies that could not be converted on this date, and why; converted is then null */
    conversionUnavailable: { currency: string; reason: string }[];
  };
  holdings?: HoldingSnapshotView[];
};

export type FxView = {
  baseCurrency: string;
  policy: 'HISTORICAL' | 'CONSTANT';
  /** CONSTANT only: your rates */
  rates: Record<string, string> | null;
  description: string;
};

/**
 * How much of the requested range is materialised. Dates from the first
 * purchase to settledThrough without a snapshot are not shown in `days`: the
 * job has not valued them yet (a backfill in progress). They are not zero.
 */
export type HistoryCoverage = {
  /** The user's first purchase: the history starts here */
  firstHoldingDate: string | null;
  /** The first date the job materialises (firstHoldingDate, unless VALUATION_BACKFILL_DAYS caps it) */
  historyStartsOn: string | null;
  /** The latest date that can be valued (the previous day's closes are final) */
  settledThrough: string;
  /** Dates in the requested range that should have a snapshot but do not yet */
  missingDays: number;
  /** Days in the range with pending or missing prices (complete: false for the whole portfolio) */
  partialDays: number;
  /** True when every date in the range that can be valued is materialised and complete */
  complete: boolean;
};

export type ValuationHistory = {
  fromDate: string;
  toDate: string;
  coverage: HistoryCoverage;
  accountId: string | null;
  includeSubaccounts: boolean;
  symbol: string | null;
  fx: FxView | null;
  days: ValuationDayView[];
  /** Splits of the symbols in scope effective within the range: quantities step up and closes step down by the ratio, value does not */
  splits: SplitInRange[];
  notes: string[];
};

export type ValuationAsOfView = ValuationDayView & {
  /**
   * SNAPSHOT: the materialised valuation of that date. ON_DEMAND: worked out
   * now by replaying the ledger to that date and pricing at stored closes
   * (fetching missing ones), because no up-to-date complete snapshot exists.
   */
  basis: 'SNAPSHOT' | 'ON_DEMAND';
  basisReason: string;
  accountId: string | null;
  includeSubaccounts: boolean;
  symbol: string | null;
  fx: FxView | null;
  holdings: HoldingSnapshotView[];
  warnings: string[];
  notes: string[];
};

const NOTES = [
  'Each valuation date values what was held at the end of that date (historical quantities and lots, matched by each sale\'s own lot allocations or FIFO) at the closing price of that trading date on the holding\'s own exchange, in its local time zone.',
  'price.status: CLOSE = that day\'s close; NON_TRADING_DAY = weekend or holiday, valued at the last close (price.tradingDate); PRICE_PENDING = no close yet, provisionally valued at the last close and re-tried; MISSING / CURRENCY_MISMATCH = not valued (marketValue null, excluded from totals.marketValue).',
  'Totals are per currency; currencies are never added together unless you pass baseCurrency. Then each date is converted at that date\'s historical FX close (the latest within VALUATION_MAX_CARRY_DAYS on or before it, shown in converted.rates), or, if you also pass fxRates, at your constant rates for every date. A date with no usable rate has converted null and conversionUnavailable says why.',
  'Stock splits are modelled: quantities, lots and price.close are in each valuation date\'s own share basis (shares held and the as-traded close that day), so a split changes quantity and close by its ratio but not the value. holding.split gives the factor to today\'s basis and the split-adjusted quantity and close; splits lists the splits effective in the range (see list_stock_splits). Closes are not adjusted for dividends.',
  'Snapshots hold no categories: join with your current categories by accountId and symbol. Mock prices (isMock: true) are made up.',
  'Personal tracking only, not financial or tax advice.',
];

/** Read side of the daily valuations, shared by REST and MCP. Every query is scoped to the user. */
@Injectable()
export class ValuationsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly repo: ValuationsRepository,
    private readonly accounts: AccountsRepository,
    private readonly transactions: TransactionsRepository,
    private readonly prices: PriceHistoryService,
    private readonly splits: SplitsService,
  ) {}

  async history(user: CurrentUser, input: ValuationHistoryInput = {}, now: Date = new Date()): Promise<ValuationHistory> {
    const options = parseInput(valuationHistorySchema, input);
    const accountIds = options.accountId ? await this.scope(user, options.accountId, options.includeSubaccounts) : undefined;
    const summary = await this.repo.daysSummary(user.id);
    const toDate = options.toDate ?? summary.latest ?? settledThrough(now, this.config.valuations.settleHourUtc);
    const fromDate = options.fromDate ?? addDays(toDate, -(DEFAULT_RANGE_DAYS - 1));
    if (fromDate > toDate) throw new ValidationError('fromDate must not be after toDate');
    const span = daysBetween(fromDate, toDate) + 1;
    if (span > MAX_RANGE_DAYS) throw new ValidationError(`At most ${MAX_RANGE_DAYS} days per request`);
    if (options.include === 'holdings' && span > MAX_HOLDINGS_RANGE_DAYS) {
      throw new ValidationError(`include=holdings allows at most ${MAX_HOLDINGS_RANGE_DAYS} days per request; narrow the range or use include=totals`);
    }

    const [days, holdings, requests, firstBuy] = await Promise.all([
      this.repo.listDays(user.id, fromDate, toDate),
      this.repo.listHoldings(user.id, fromDate, toDate, { accountIds, symbol: options.symbol }),
      this.repo.recomputeRequests(user.id),
      this.repo.firstPurchaseDate(user.id),
    ]);
    const currencies = [...new Set(holdings.map((h) => h.currency))];
    const fx = await this.conversion(currencies, options, fromDate, toDate);
    const coverage = this.coverageOf(firstBuy, days, fromDate, toDate, now);

    const byDate = new Map<string, ValuationHoldingRow[]>();
    for (const h of holdings) byDate.set(h.date, [...(byDate.get(h.date) ?? []), h]);
    const splitIndex = await this.splits.index(holdings.map((h) => h.symbol));
    const splits: SplitInRange[] = [...splitIndex.entries()]
      .flatMap(([symbol, list]) => list.filter((x) => x.effectiveDate >= fromDate && x.effectiveDate <= toDate).map((x) => ({ symbol, ...x })))
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.symbol.localeCompare(b.symbol))
      .map((x) => ({
        symbol: x.symbol,
        instrument: x.instrument,
        effectiveDate: x.effectiveDate,
        numerator: x.numerator,
        denominator: x.denominator,
        ratio: fmt(dec(x.numerator).dividedBy(x.denominator)),
        provenance: x.provenance,
        source: x.source,
      }));

    return {
      fromDate,
      toDate,
      coverage,
      accountId: options.accountId ?? null,
      includeSubaccounts: options.includeSubaccounts,
      symbol: options.symbol ?? null,
      fx: fx?.view ?? null,
      days: days.map((day) => {
        const rows = byDate.get(day.date) ?? [];
        const view: ValuationDayView = {
          date: day.date,
          complete: rows.every((h) => FINAL_STATUSES.includes(h.priceStatus)),
          includesMockPrices: rows.some((h) => h.priceIsMock === true),
          pendingRecompute: isPendingRecompute(requests, accountIds, day.date),
          priceProvider: day.priceProvider,
          computedAt: day.computedAt.toISOString(),
          totals: totalsOf(rows, fx ? (currency) => fx.rateOn(currency, day.date) : null, fx?.view.baseCurrency ?? null),
        };
        if (options.include === 'holdings') view.holdings = rows.map(holdingView);
        return view;
      }),
      splits,
      notes: NOTES,
    };
  }

  /**
   * Holdings and value as of the end of one date. Uses the materialised
   * snapshot when it is complete and up to date; otherwise reconstructs it
   * on demand with the job's own code (ledger replay to that date, closes
   * from the shared store, missing ones fetched). Nothing is stored by this
   * read: the job materialises the date on its next run.
   */
  async asOf(user: CurrentUser, input: ValuationAsOfInput, now: Date = new Date()): Promise<ValuationAsOfView> {
    const options = parseInput(valuationAsOfSchema, input);
    const today = now.toISOString().slice(0, 10);
    if (options.date > today) throw new ValidationError(`date must not be after today (${today})`);
    const all = await this.accounts.list(user.id);
    const accountIds = options.accountId ? await this.scope(user, options.accountId, options.includeSubaccounts) : all.map((a) => a.id);
    const inScope = new Set(accountIds);
    const cfg = this.config.valuations;

    const [days, requests] = await Promise.all([this.repo.listDays(user.id, options.date, options.date), this.repo.recomputeRequests(user.id)]);
    const day = days[0];
    const pending = isPendingRecompute(requests, options.accountId ? accountIds : undefined, options.date);
    let reason: string | null = null;
    if (!day) reason = 'No snapshot is materialised for this date';
    else if (day.priceProvider !== this.prices.providerName) reason = `The snapshot was priced by ${day.priceProvider}, not ${this.prices.providerName}`;
    else if (pending) reason = 'A backdated change or price correction affects this date and has not been re-valued yet';
    else if (day.status !== 'COMPLETE') reason = 'The snapshot has pending or missing prices; re-checked now';

    let rows: ValuationHoldingRow[];
    let computedAt: string;
    const warnings: string[] = [];
    if (reason === null) {
      rows = await this.repo.listHoldings(user.id, options.date, options.date, { accountIds, symbol: options.symbol });
      computedAt = day!.computedAt.toISOString();
    } else {
      const entries = (await this.transactions.list(user.id, {})).filter((t) => inScope.has(t.accountId));
      const byAccount = new Map<string, TransactionEntity[]>();
      for (const row of entries) byAccount.set(row.accountId, [...(byAccount.get(row.accountId) ?? []), row]);
      const tradedSymbols = entries.filter((t) => t.symbol).map((t) => t.symbol!);
      let splits = await this.splits.index(tradedSymbols);
      const replay = () =>
        accountIds.map((accountId) => ({
          accountId,
          byDate: positionsByDate(this.splits.presentEntriesWith(byAccount.get(accountId) ?? [], splits, now), [options.date]),
        }));
      let positions = replay();
      const symbols = new Set<string>();
      for (const { byDate } of positions) for (const p of byDate.get(options.date) ?? []) if (!options.symbol || p.symbol === options.symbol) symbols.add(p.symbol);
      // Back far enough to carry a previous close; a little forward so a later session reveals a holiday
      const later = addDays(options.date, cfg.maxCarryDays);
      const series = await this.prices.getSeries([...symbols], { from: addDays(options.date, -cfg.maxCarryDays), to: later < today ? later : today }, now);
      warnings.push(...seriesWarnings(series));
      // The lookup may have recorded a split the provider reported
      const latest = await this.splits.index(tradedSymbols);
      if (!sameSplits(splits, latest)) {
        splits = latest;
        positions = replay();
      }
      rows = holdingsOn(positions, options.date, series, cfg.maxCarryDays, splits)
        .filter((h) => !options.symbol || h.symbol === options.symbol)
        .map((h) => ({ ...h, date: options.date }));
      computedAt = now.toISOString();
    }

    const fx = await this.conversion([...new Set(rows.map((h) => h.currency))], options, options.date, options.date, now);
    if (rows.some((h) => h.priceIsMock)) warnings.push('Some prices are mock (made-up development data). Do not rely on these values.');
    const totals = totalsOf(rows, fx ? (currency) => fx.rateOn(currency, options.date) : null, fx?.view.baseCurrency ?? null);
    for (const missing of totals.conversionUnavailable) warnings.push(`No ${missing.currency}→${fx!.view.baseCurrency} rate for ${options.date}: ${missing.reason}`);
    return {
      date: options.date,
      basis: reason === null ? 'SNAPSHOT' : 'ON_DEMAND',
      basisReason: reason ?? 'A complete, up-to-date snapshot of this date exists',
      accountId: options.accountId ?? null,
      includeSubaccounts: options.includeSubaccounts,
      symbol: options.symbol ?? null,
      complete: rows.every((h) => FINAL_STATUSES.includes(h.priceStatus)),
      includesMockPrices: rows.some((h) => h.priceIsMock === true),
      pendingRecompute: pending,
      priceProvider: reason === null ? day!.priceProvider : this.prices.providerName,
      computedAt,
      fx: fx?.view ?? null,
      totals,
      holdings: rows.map(holdingView),
      warnings,
      notes: NOTES,
    };
  }

  /**
   * How totals are converted to baseCurrency: your constant fxRates, or else
   * each date's historical FX close from the shared price store.
   */
  private async conversion(
    currencies: string[],
    options: { baseCurrency?: string; fxRates?: Record<string, string> },
    fromDate: string,
    toDate: string,
    now: Date = new Date(),
  ): Promise<{ view: FxView; rateOn: (currency: string, date: string) => FxRateUsed | { error: string } } | null> {
    const base = options.baseCurrency;
    if (!base) return null;
    if (options.fxRates) {
      const policy: FxPolicy = { baseCurrency: base, rates: options.fxRates };
      assertRatesCover(currencies.map((currency) => ({ currency }) as ValuationItem), policy);
      return {
        view: {
          baseCurrency: base,
          policy: 'CONSTANT',
          rates: options.fxRates,
          description: 'Constant caller-supplied rates (units of baseCurrency per unit), applied to every date. Not historical FX.',
        },
        rateOn: (currency) => ({ currency, rate: currency === base ? '1' : options.fxRates![currency], kind: 'CONSTANT', tradingDate: null, source: 'manual', isMock: false }),
      };
    }
    const maxCarry = this.config.valuations.maxCarryDays;
    const foreign = currencies.filter((c) => c !== base);
    const pairOf = (currency: string) => `${currency}${base}=X`;
    const series = foreign.length > 0 ? await this.prices.getSeries(foreign.map(pairOf), { from: addDays(fromDate, -maxCarry), to: toDate }, now) : new Map<string, SeriesResult>();
    return {
      view: {
        baseCurrency: base,
        policy: 'HISTORICAL',
        rates: null,
        description: `Each date is converted at the daily FX close of that date (or the latest one up to ${maxCarry} days before it) from ${this.prices.providerName}, shown per date in converted.rates.`,
      },
      rateOn: (currency, date) => {
        if (currency === base) return { currency, rate: '1', kind: 'HISTORICAL', tradingDate: date, source: 'identity', isMock: false };
        const result = series.get(pairOf(currency));
        if (!result) return { error: 'No FX history was looked up' };
        if (result.error !== undefined) return { error: result.error };
        if (!result.series) return { error: `${this.prices.providerName} has no ${currency}→${base} history` };
        if (result.series.currency !== base) return { error: `The ${pairOf(currency)} series is in ${result.series.currency}, not ${base}` };
        const close = [...result.series.closes].reverse().find((c) => c.tradingDate <= date);
        if (!close || daysBetween(close.tradingDate, date) > maxCarry) return { error: `No ${currency}→${base} close within ${maxCarry} days before ${date}` };
        return { currency, rate: fmt(dec(close.close)), kind: 'HISTORICAL', tradingDate: close.tradingDate, source: result.series.source, isMock: result.series.isMock };
      },
    };
  }

  private coverageOf(firstBuy: string | null, days: readonly ValuationDayRow[], fromDate: string, toDate: string, now: Date): HistoryCoverage {
    const cfg = this.config.valuations;
    const settled = settledThrough(now, cfg.settleHourUtc);
    const start = firstBuy ? historyFloor(firstBuy, now.toISOString().slice(0, 10), cfg.backfillDays) : null;
    const from = start && start > fromDate ? start : fromDate;
    const to = settled < toDate ? settled : toDate;
    const expected = start && from <= to ? daysBetween(from, to) + 1 : 0;
    const present = days.filter((d) => d.date >= from && d.date <= to).length;
    const partialDays = days.filter((d) => d.status === 'PARTIAL').length;
    const missingDays = Math.max(0, expected - present);
    return { firstHoldingDate: firstBuy, historyStartsOn: start, settledThrough: settled, missingDays, partialDays, complete: missingDays === 0 && partialDays === 0 };
  }

  async status(user: CurrentUser, now: Date = new Date()) {
    const cfg = this.config.valuations;
    const settled = settledThrough(now, cfg.settleHourUtc);
    const [summary, requests, job, firstBuy, missingPrices] = await Promise.all([
      this.repo.daysSummary(user.id),
      this.repo.recomputeRequests(user.id),
      this.repo.jobState(),
      this.repo.firstPurchaseDate(user.id),
      this.repo.missingPriceSymbols(user.id),
    ]);
    const start = firstBuy ? historyFloor(firstBuy, now.toISOString().slice(0, 10), cfg.backfillDays) : null;
    const requiredDays = start && start <= settled ? daysBetween(start, settled) + 1 : 0;
    const counts = requiredDays > 0 ? await this.repo.coverageCounts(user.id, start!, settled, this.prices.providerName) : { days: 0, partialDays: 0, otherProviderDays: 0 };
    const missingDays = requiredDays - counts.days;
    return {
      priceProvider: this.prices.providerName,
      priceProviderIsMock: this.prices.providerName === 'mock',
      jobEnabled: cfg.jobEnabled,
      intervalMinutes: cfg.intervalMinutes,
      settledThrough: settled,
      earliestValuationDate: summary.earliest,
      latestValuationDate: summary.latest,
      materialisedDays: summary.days,
      partialDays: summary.partialDays,
      pendingRecomputeFrom: requests[0]?.fromDate ?? null,
      coverage: {
        firstHoldingDate: firstBuy,
        historyStartsOn: start,
        historyLimitedByBackfillDays: start !== null && firstBuy !== null && start > firstBuy,
        requiredDays,
        materialisedDays: counts.days,
        missingDays,
        partialDays: counts.partialDays,
        repricingDays: counts.otherProviderDays,
        backfillComplete: missingDays === 0 && counts.otherProviderDays === 0 && requests.length === 0,
        percentComplete: requiredDays === 0 ? 100 : Math.floor(((counts.days - counts.otherProviderDays) / requiredDays) * 1000) / 10,
      },
      missingPrices,
      // Only the timing and outcome: the job's error text may mention other users
      lastRun: job ? { startedAt: job.lastStartedAt?.toISOString() ?? null, finishedAt: job.lastFinishedAt?.toISOString() ?? null, status: job.lastStatus } : null,
    };
  }

  /** Marks dates from fromDate for re-valuation on the next job run (e.g. after correcting a price source) */
  async requestRecompute(user: CurrentUser, input: RecomputeInput) {
    const options = parseInput(recomputeSchema, input);
    const accountIds = options.accountId
      ? await this.scope(user, options.accountId, true)
      : (await this.accounts.list(user.id)).map((a) => a.id);
    await this.repo.requestRecompute(user.id, accountIds, options.fromDate);
    let refreshedSymbols: string[] = [];
    if (options.refreshPrices) {
      const scope = new Set(accountIds);
      refreshedSymbols = [...new Set((await this.transactions.list(user.id, {})).filter((t) => scope.has(t.accountId) && t.symbol && (t.type === 'BUY' || t.type === 'SELL')).map((t) => t.symbol!))].sort();
      for (const symbol of refreshedSymbols) await this.prices.refresh(symbol, options.fromDate);
    }
    return {
      requested: true as const,
      fromDate: options.fromDate,
      accounts: accountIds.length,
      refreshedSymbols,
      note: options.refreshPrices
        ? 'Closes of these symbols from fromDate are fetched again on the next job run; corrected closes replace the stored ones, and dates from fromDate are re-valued.'
        : 'Dates from fromDate are re-valued on the next job run, from the stored closes.',
    };
  }

  private async scope(user: CurrentUser, accountId: string, includeSubaccounts: boolean): Promise<string[]> {
    const all = await this.accounts.list(user.id);
    if (!isUuid(accountId) || !all.some((a) => a.id === accountId)) throw new NotFoundError(`Account ${accountId} not found`);
    if (!includeSubaccounts) return [accountId];
    return [accountId, ...descendantsOf(accountId, childrenIndex(all)).map((a) => a.id)];
  }
}

function totalsOf(
  rows: readonly ValuationHoldingRow[],
  rateOf: ((currency: string) => FxRateUsed | { error: string }) | null,
  baseCurrency: string | null,
): ValuationDayView['totals'] {
  const by = new Map<string, { marketValue: MoneyDecimal; costBase: MoneyDecimal; holdings: number; unvalued: number; provisional: number }>();
  for (const h of rows) {
    const t = by.get(h.currency) ?? { marketValue: ZERO, costBase: ZERO, holdings: 0, unvalued: 0, provisional: 0 };
    t.costBase = t.costBase.plus(h.costBase);
    t.holdings++;
    if (h.marketValue === null) t.unvalued++;
    else t.marketValue = t.marketValue.plus(h.marketValue);
    if (h.priceStatus === 'PRICE_PENDING') t.provisional++;
    by.set(h.currency, t);
  }
  let converted: ConvertedTotals = null;
  const conversionUnavailable: { currency: string; reason: string }[] = [];
  if (rateOf && baseCurrency) {
    let marketValue = ZERO;
    let costBase = ZERO;
    const rates: FxRateUsed[] = [];
    for (const [currency, t] of [...by.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const rate = rateOf(currency);
      if ('error' in rate) {
        conversionUnavailable.push({ currency, reason: rate.error });
        continue;
      }
      if (currency !== baseCurrency) rates.push(rate);
      marketValue = marketValue.plus(t.marketValue.times(rate.rate));
      costBase = costBase.plus(t.costBase.times(rate.rate));
    }
    // Never a total that silently leaves a currency out
    if (conversionUnavailable.length === 0) converted = { baseCurrency, marketValue: fmt(marketValue), costBase: fmt(costBase), rates };
  }
  return {
    byCurrency: [...by.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, t]) => ({
        currency,
        marketValue: fmt(t.marketValue),
        costBase: fmt(t.costBase),
        holdings: t.holdings,
        unvaluedHoldings: t.unvalued,
        provisionalHoldings: t.provisional,
      })),
    converted,
    conversionUnavailable,
  };
}

/** The earliest pending re-valuation date for the accounts in scope (all of the user's when undefined) */
/** A request in scope still covers the date: the job has not re-valued it yet */
function isPendingRecompute(requests: readonly RecomputeRequest[], accountIds: readonly string[] | undefined, date: string): boolean {
  return requests.some((r) => (!accountIds || accountIds.includes(r.accountId)) && requestCovers(r, date));
}

function seriesWarnings(series: Map<string, SeriesResult>): string[] {
  const warnings: string[] = [];
  for (const [symbol, result] of series) {
    if (result.error !== undefined) warnings.push(`No closes for ${symbol}: ${result.error}`);
    else if (result.warning) warnings.push(result.warning);
  }
  return warnings;
}

function holdingView(h: ValuationHoldingRow): HoldingSnapshotView {
  const n = (v: string | null) => (v === null ? null : fmt(dec(v)));
  return {
    accountId: h.accountId,
    symbol: h.symbol,
    currency: h.currency,
    quantity: fmt(dec(h.quantity)),
    costBase: fmt(dec(h.costBase)),
    marketValue: n(h.marketValue),
    price: {
      status: h.priceStatus,
      close: n(h.closePrice),
      currency: h.priceCurrency,
      tradingDate: h.priceDate,
      closeTime: h.priceCloseTime,
      exchangeTimezone: h.exchangeTimezone,
      source: h.priceSource,
      isMock: h.priceIsMock,
      note: h.priceNote,
    },
    split:
      h.splitFactor === null
        ? null
        : { basis: 'VALUATION_DATE', factor: fmt(dec(h.splitFactor)), adjustedQuantity: n(h.splitAdjustedQuantity) ?? fmt(dec(h.quantity).times(h.splitFactor)), adjustedClose: n(h.splitAdjustedClose) },
    lots: h.lots,
  };
}
