import { Inject, Injectable } from '@nestjs/common';
import { AccountsRepository } from '../accounts/accounts.repository';
import { childrenIndex, descendantsOf } from '../accounts/hierarchy';
import { MoneyDecimal, ZERO, dec, fmt } from '../common/decimal';
import { NotFoundError, ValidationError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { addDays, daysBetween } from '../market-prices/market-calendar';
import { assertRatesCover, type FxPolicy, type ValuationItem } from '../reports/aggregation';
import type { CurrentUser } from '../users/users.service';
import { PriceHistoryService } from './price-history.service';
import { settledThrough } from './valuation-job.service';
import { FINAL_STATUSES, type PriceStatus } from './valuation-math';
import { recomputeSchema, valuationHistorySchema, type RecomputeInput, type ValuationHistoryInput } from './valuations.schemas';
import { ValuationsRepository, type LotSnapshot, type ValuationHoldingRow } from './valuations.repository';

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
  lots: LotSnapshot[];
};

export type ValuationDayView = {
  date: string;
  /** Every in-scope holding is valued at its close (or the last close on a non-trading day) */
  complete: boolean;
  includesMockPrices: boolean;
  priceProvider: string;
  computedAt: string;
  totals: {
    byCurrency: CurrencyTotals[];
    converted: { baseCurrency: string; marketValue: string; costBase: string } | null;
  };
  holdings?: HoldingSnapshotView[];
};

export type ValuationHistory = {
  fromDate: string;
  toDate: string;
  accountId: string | null;
  includeSubaccounts: boolean;
  symbol: string | null;
  fx: (FxPolicy & { policy: string }) | null;
  days: ValuationDayView[];
  notes: string[];
};

const NOTES = [
  'Each valuation date values what was held at the end of that date (historical quantities and lots, matched by each sale\'s own lot allocations or FIFO) at the closing price of that trading date on the holding\'s own exchange, in its local time zone.',
  'price.status: CLOSE = that day\'s close; NON_TRADING_DAY = weekend or holiday, valued at the last close (price.tradingDate); PRICE_PENDING = no close yet, provisionally valued at the last close and re-tried; MISSING / CURRENCY_MISMATCH = not valued (marketValue null, excluded from totals.marketValue).',
  'Totals are per currency; currencies are never added together unless you pass baseCurrency and fxRates, which are applied as constant rates to every day (not historical exchange rates).',
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
    private readonly prices: PriceHistoryService,
  ) {}

  async history(user: CurrentUser, input: ValuationHistoryInput = {}): Promise<ValuationHistory> {
    const options = parseInput(valuationHistorySchema, input);
    const accountIds = options.accountId ? await this.scope(user, options.accountId, options.includeSubaccounts) : undefined;
    const summary = await this.repo.daysSummary(user.id);
    const toDate = options.toDate ?? summary.latest ?? settledThrough(new Date(), this.config.valuations.settleHourUtc);
    const fromDate = options.fromDate ?? addDays(toDate, -(DEFAULT_RANGE_DAYS - 1));
    if (fromDate > toDate) throw new ValidationError('fromDate must not be after toDate');
    const span = daysBetween(fromDate, toDate) + 1;
    if (span > MAX_RANGE_DAYS) throw new ValidationError(`At most ${MAX_RANGE_DAYS} days per request`);
    if (options.include === 'holdings' && span > MAX_HOLDINGS_RANGE_DAYS) {
      throw new ValidationError(`include=holdings allows at most ${MAX_HOLDINGS_RANGE_DAYS} days per request; narrow the range or use include=totals`);
    }

    const [days, holdings] = await Promise.all([
      this.repo.listDays(user.id, fromDate, toDate),
      this.repo.listHoldings(user.id, fromDate, toDate, { accountIds, symbol: options.symbol }),
    ]);
    const fx = options.baseCurrency ? { baseCurrency: options.baseCurrency, rates: options.fxRates ?? {} } : null;
    assertRatesCover([...new Set(holdings.map((h) => h.currency))].map((currency) => ({ currency }) as ValuationItem), fx);

    const byDate = new Map<string, ValuationHoldingRow[]>();
    for (const h of holdings) byDate.set(h.date, [...(byDate.get(h.date) ?? []), h]);

    return {
      fromDate,
      toDate,
      accountId: options.accountId ?? null,
      includeSubaccounts: options.includeSubaccounts,
      symbol: options.symbol ?? null,
      fx: fx ? { ...fx, policy: 'Constant caller-supplied rates (units of baseCurrency per unit), applied to every date. Not historical FX.' } : null,
      days: days.map((day) => {
        const rows = byDate.get(day.date) ?? [];
        const view: ValuationDayView = {
          date: day.date,
          complete: rows.every((h) => FINAL_STATUSES.includes(h.priceStatus)),
          includesMockPrices: rows.some((h) => h.priceIsMock === true),
          priceProvider: day.priceProvider,
          computedAt: day.computedAt.toISOString(),
          totals: totalsOf(rows, fx),
        };
        if (options.include === 'holdings') view.holdings = rows.map(holdingView);
        return view;
      }),
      notes: NOTES,
    };
  }

  async status(user: CurrentUser) {
    const [summary, requests, job] = await Promise.all([this.repo.daysSummary(user.id), this.repo.recomputeRequests(user.id), this.repo.jobState()]);
    const cfg = this.config.valuations;
    return {
      priceProvider: this.prices.providerName,
      priceProviderIsMock: this.prices.providerName === 'mock',
      jobEnabled: cfg.jobEnabled,
      intervalMinutes: cfg.intervalMinutes,
      settledThrough: settledThrough(new Date(), cfg.settleHourUtc),
      earliestValuationDate: summary.earliest,
      latestValuationDate: summary.latest,
      materialisedDays: summary.days,
      partialDays: summary.partialDays,
      pendingRecomputeFrom: requests[0]?.fromDate ?? null,
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
    return { requested: true as const, fromDate: options.fromDate, accounts: accountIds.length, note: 'Dates from fromDate are re-valued on the next job run.' };
  }

  private async scope(user: CurrentUser, accountId: string, includeSubaccounts: boolean): Promise<string[]> {
    const all = await this.accounts.list(user.id);
    if (!isUuid(accountId) || !all.some((a) => a.id === accountId)) throw new NotFoundError(`Account ${accountId} not found`);
    if (!includeSubaccounts) return [accountId];
    return [accountId, ...descendantsOf(accountId, childrenIndex(all)).map((a) => a.id)];
  }
}

function totalsOf(rows: readonly ValuationHoldingRow[], fx: FxPolicy | null): ValuationDayView['totals'] {
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
  let converted: ValuationDayView['totals']['converted'] = null;
  if (fx) {
    let marketValue = ZERO;
    let costBase = ZERO;
    for (const [currency, t] of by) {
      const rate = currency === fx.baseCurrency ? dec(1) : dec(fx.rates[currency]);
      marketValue = marketValue.plus(t.marketValue.times(rate));
      costBase = costBase.plus(t.costBase.times(rate));
    }
    converted = { baseCurrency: fx.baseCurrency, marketValue: fmt(marketValue), costBase: fmt(costBase) };
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
  };
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
    lots: h.lots,
  };
}
