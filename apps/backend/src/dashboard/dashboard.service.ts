import { Injectable } from '@nestjs/common';
import type { AccountType } from '../accounts/account.entity';
import { dec, fmt } from '../common/decimal';
import { parseInput } from '../common/validation';
import { addDays } from '../market-prices/market-calendar';
import { MarketPricesService } from '../market-prices/market-prices.service';
import { buildAccountTree, effectiveItemCategory, totalsOf, type FxPolicy, type TotalsView, type ValuationItem } from '../reports/aggregation';
import { ReportsService, type ItemView } from '../reports/reports.service';
import type { CurrentUser } from '../users/users.service';
import { PriceHistoryService } from '../valuations/price-history.service';
import {
  ASSET_CLASSES,
  STALE_PRICE_DAYS,
  assetClassOf,
  byAmountDesc,
  groupBy,
  holdingChange,
  previousClose,
  percentOf,
  priceStatusOf,
  sum,
  worstStatus,
  type AssetClass,
  type PriceStatus,
} from './dashboard-math';
import { dashboardOptionsSchema, type DashboardOptionsInput } from './dashboard.schemas';

type CategoryRef = { id: string; name: string; color: string | null } | null;

export type FxRateView = {
  /** Converts this currency into the display currency */
  currency: string;
  /** Units of the display currency per 1 unit of `currency` */
  rate: string;
  /** manual: you supplied it. market: looked up from the price provider. */
  source: 'manual' | 'market';
  provider: string | null;
  asOf: string | null;
  isMock: boolean;
  /** The provider could not be reached; the last known rate */
  isStale: boolean;
};

export type DailyChangeView = {
  /** Change per holding currency, before conversion */
  byCurrency: { currency: string; change: string }[];
  /** In the display currency; null when a rate is missing or nothing could be compared */
  converted: { baseCurrency: string; change: string } | null;
  /** Converted change as a percentage of the same holdings' value at the previous close; null when unknown */
  percent: string | null;
  /** Holdings compared against a previous close */
  holdingsIncluded: number;
  /** Holdings left out: no market price, no previous close, or a split since */
  holdingsExcluded: number;
  /** True when every holding was compared and every currency converted */
  complete: boolean;
};

export type DashboardItemView = ItemView & { assetClass: AssetClass; priceStatus: PriceStatus | null };

export type DashboardView = {
  asOf: string;
  displayCurrency: string;
  priceProvider: string;
  fx: {
    displayCurrency: string;
    /** True when every currency held has a rate, so converted figures are given */
    complete: boolean;
    rates: FxRateView[];
    /** Currencies with no rate: converted figures and percentages are null */
    missing: { currency: string; reason: string }[];
  };
  valuation: {
    /** COMPLETE: every holding at a recent price and every currency converted. PARTIAL otherwise. */
    status: 'COMPLETE' | 'PARTIAL';
    usesMockPrices: boolean;
    holdings: number;
    marketPriced: number;
    stalePriced: number;
    mockPriced: number;
    costFallback: number;
    oldestPriceAsOf: string | null;
    stalePriceDays: number;
  };
  /** Every cash balance and holding, counted once */
  total: TotalsView;
  /** Change in total tracked assets since the previous close: holdings' price movement only */
  dailyChange: DailyChangeView;
  assetClasses: {
    assetClass: AssetClass;
    totals: TotalsView;
    percentOfTotal: string | null;
    accounts: { accountId: string; accountPath: string[]; totals: TotalsView; percentOfClass: string | null }[];
  }[];
  categories: {
    category: CategoryRef;
    totals: TotalsView;
    percentOfTotal: string | null;
    items: DashboardItemView[];
  }[];
  accounts: {
    id: string;
    name: string;
    type: AccountType;
    source: 'manual' | 'up';
    subaccounts: number;
    /** The account plus all its subaccounts */
    totals: TotalsView;
    percentOfTotal: string | null;
  }[];
  shares: {
    /** The share portfolio: holdings outside super accounts */
    totals: TotalsView;
    percentOfTotal: string | null;
    tickers: {
      symbol: string;
      currency: string;
      quantity: string;
      value: string;
      /** In the display currency; null without a complete FX policy */
      convertedValue: string | null;
      /** Denominator: the share portfolio (shares.totals) */
      percentOfShares: string | null;
      /** Denominator: total tracked assets (total) */
      percentOfTotal: string | null;
      priceStatus: PriceStatus;
      price: { price: string; asOf: string; source: string; isMock: boolean; isStale: boolean } | null;
      positions: { accountId: string; accountPath: string[]; quantity: string; value: string; basis: 'cash' | 'market' | 'cost' }[];
    }[];
  };
  warnings: string[];
  notes: string[];
};

const NOTES = [
  'dailyChange is the price movement of every holding priced at market: quantity × (latest price − previous session close), converted at the same rates as the totals. Cash is not included (deposits, withdrawals and bank balances are not market moves), and holdings without a market price or previous close are left out and counted in holdingsExcluded.',
  'Total, asset classes, categories and top-level accounts each split the same cash balances and holdings, so each adds up to the total and nothing is counted twice.',
  'Asset class: everything in a SUPERANNUATION account or any subaccount of one is super (its balance recorded as cash, and any shares held in it). Other holdings are shares; other cash is cash.',
  'Ticker concentration covers the share portfolio only (not shares held inside super). percentOfShares divides by the share portfolio; percentOfTotal divides by all tracked assets.',
  'Converted figures use one rate per currency at the time of the request (shown in fx.rates); recorded transactions keep their own currency. If any rate is missing, converted figures and percentages are null rather than leaving money out.',
  'Holdings without a usable price are valued at cost base and flagged COST_FALLBACK. Mock prices are made up.',
  'Categories are current labels, not history. Personal tracking only, not financial or tax advice.',
];

/**
 * The portfolio dashboard: total tracked assets in a display currency, split
 * by asset class, category, top-level account and ticker. Built on the same
 * valuation items as the accounts and categories reports.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly reports: ReportsService,
    private readonly prices: MarketPricesService,
    private readonly history: PriceHistoryService,
  ) {}

  async dashboard(user: CurrentUser, input: DashboardOptionsInput = {}, now = new Date()): Promise<DashboardView> {
    const options = parseInput(dashboardOptionsSchema, input);
    const display = options.displayCurrency;
    const ctx = await this.reports.valuationContext(user, { valuation: 'market', visibility: 'visible' });
    const { items } = ctx;

    // ── FX: manual rates first, then the provider; any gap disables conversion
    const currencies = [...new Set(items.map((i) => i.currency))].filter((c) => c !== display).sort();
    const rates: FxRateView[] = [];
    const missing: { currency: string; reason: string }[] = [];
    await Promise.all(
      currencies.map(async (currency) => {
        const manual = options.fxRates?.[currency];
        if (manual !== undefined) {
          rates.push({ currency, rate: manual, source: 'manual', provider: null, asOf: null, isMock: false, isStale: false });
          return;
        }
        const result = await this.prices.getFxRate(currency, display);
        if ('rate' in result) {
          rates.push({ currency, rate: result.rate.rate, source: 'market', provider: result.rate.source, asOf: result.rate.asOf, isMock: result.rate.isMock, isStale: result.rate.isStale });
        } else {
          missing.push({ currency, reason: result.error });
        }
      }),
    );
    rates.sort((a, b) => a.currency.localeCompare(b.currency));
    missing.sort((a, b) => a.currency.localeCompare(b.currency));
    const fx: FxPolicy | null = missing.length === 0 ? { baseCurrency: display, rates: Object.fromEntries(rates.map((r) => [r.currency, r.rate])) } : null;
    const totals = (subset: readonly ValuationItem[]) => totalsOf(subset, fx);

    const total = totals(items);
    const grand = total.converted?.total ?? null;
    const { pathOf } = ctx;

    const dailyChange = await this.dailyChange(items, fx, display, now);

    // ── Asset classes
    const classOf = new Map(items.map((item) => [item, assetClassOf(item, ctx.byId)]));
    const assetClasses = ASSET_CLASSES.map((assetClass) => {
      const classItems = items.filter((i) => classOf.get(i) === assetClass);
      const classTotals = totals(classItems);
      const accounts = [...groupBy(classItems, (i) => i.accountId)].map(([accountId, accountItems]) => {
        const accountTotals = totals(accountItems);
        return { accountId, accountPath: pathOf(accountId), totals: accountTotals, percentOfClass: percentOf(accountTotals.converted?.total, classTotals.converted?.total) };
      });
      accounts.sort(byAmountDesc((a) => a.totals.converted?.total ?? null, (a) => a.accountPath.join('/')));
      return { assetClass, totals: classTotals, percentOfTotal: percentOf(classTotals.converted?.total, grand), accounts };
    });

    // ── Holdings' price quality
    const statusOf = new Map(items.filter((i) => i.kind === 'holding').map((item) => [item, priceStatusOf(item, now)]));
    const itemView = (item: ValuationItem): DashboardItemView => ({ ...ctx.itemView(item), assetClass: classOf.get(item)!, priceStatus: statusOf.get(item) ?? null });

    // ── Categories (every custom category, empty or not, then Uncategorized)
    const groups = groupBy(items, (i) => effectiveItemCategory(i, ctx.byId, ctx.holdingCategories).categoryId);
    const categories = [...ctx.categoryList.map((c) => c.id), null].map((id) => {
      const categoryItems = groups.get(id) ?? [];
      const categoryTotals = totals(categoryItems);
      return { category: ctx.categoryRef(id), totals: categoryTotals, percentOfTotal: percentOf(categoryTotals.converted?.total, grand), items: categoryItems.map(itemView) };
    });

    // ── Top-level accounts (each includes its subaccounts)
    const accounts = buildAccountTree(ctx.allAccounts, items).map((node) => {
      const accountTotals = totals(node.rolledUpItems);
      return {
        id: node.account.id,
        name: node.account.name,
        type: node.account.type,
        source: ctx.sourceOf(node.account.id),
        subaccounts: node.children.length,
        totals: accountTotals,
        percentOfTotal: percentOf(accountTotals.converted?.total, grand),
      };
    });

    // ── Share portfolio and ticker concentration
    const shareItems = items.filter((i) => classOf.get(i) === 'shares');
    const sharesTotals = totals(shareItems);
    const sharesConverted = sharesTotals.converted?.total ?? null;
    const tickers = [...groupBy(shareItems, (i) => `${i.symbol}|${i.currency}`).values()].map((positions) => {
      const first = positions[0];
      const tickerTotals = totals(positions);
      const convertedValue = tickerTotals.converted?.holdings ?? null;
      return {
        symbol: first.symbol!,
        currency: first.currency,
        quantity: fmt(sum(positions.map((p) => p.quantity!))),
        value: fmt(sum(positions.map((p) => p.value))),
        convertedValue,
        percentOfShares: percentOf(convertedValue, sharesConverted),
        percentOfTotal: percentOf(convertedValue, grand),
        priceStatus: worstStatus(positions.map((p) => statusOf.get(p)!)),
        price: positions.find((p) => p.price)?.price ?? null,
        positions: positions
          .map((p) => ({ accountId: p.accountId, accountPath: pathOf(p.accountId), quantity: fmt(p.quantity!), value: fmt(p.value), basis: p.basis }))
          .sort(byAmountDesc((p) => p.value, (p) => p.accountPath.join('/'))),
      };
    });
    tickers.sort(byAmountDesc((t) => t.convertedValue, (t) => t.symbol));

    // ── Valuation quality
    const statuses = [...statusOf.values()];
    const count = (s: PriceStatus) => statuses.filter((x) => x === s).length;
    const priced = [...statusOf.keys()].filter((i) => i.price && i.basis === 'market').map((i) => i.price!.asOf);
    const stale = count('STALE');
    const costFallback = count('COST_FALLBACK');
    const mock = count('MOCK');

    const warnings = [...ctx.envelope.warnings];
    for (const m of missing) warnings.push(`No ${m.currency}→${display} rate (${m.reason}). Converted totals and percentages are left out; supply fxRates to set one.`);
    if (stale > 0) warnings.push(`${stale} holding(s) use a price older than ${STALE_PRICE_DAYS} days.`);
    for (const r of rates.filter((r) => r.isStale)) warnings.push(`The ${r.currency}→${display} rate is the last known one, from ${r.asOf}: the provider could not be reached.`);
    if (rates.some((r) => r.isMock)) warnings.push('Some exchange rates are mock (made-up development data). Do not rely on the converted figures.');

    return {
      asOf: now.toISOString(),
      displayCurrency: display,
      priceProvider: this.prices.providerName,
      fx: { displayCurrency: display, complete: fx !== null, rates, missing },
      valuation: {
        status: stale === 0 && costFallback === 0 && fx !== null ? 'COMPLETE' : 'PARTIAL',
        usesMockPrices: mock > 0 || rates.some((r) => r.isMock),
        holdings: statuses.length,
        marketPriced: count('MARKET'),
        stalePriced: stale,
        mockPriced: mock,
        costFallback,
        oldestPriceAsOf: priced.length > 0 ? priced.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null,
        stalePriceDays: STALE_PRICE_DAYS,
      },
      total,
      dailyChange,
      assetClasses,
      categories,
      accounts,
      shares: { totals: sharesTotals, percentOfTotal: percentOf(sharesConverted, grand), tickers },
      warnings,
      notes: NOTES,
    };
  }

  /** Price movement since the previous close across every market-priced holding */
  private async dailyChange(items: readonly ValuationItem[], fx: FxPolicy | null, display: string, now: Date): Promise<DailyChangeView> {
    const holdings = items.filter((i) => i.kind === 'holding');
    const marketHeld = holdings.filter((i) => i.basis === 'market' && i.price);
    const symbols = [...new Set(marketHeld.map((i) => i.symbol!))];
    const today = now.toISOString().slice(0, 10);
    const series = symbols.length > 0 ? await this.history.getSeries(symbols, { from: addDays(today, -10), to: today }, now) : new Map();

    const change = new Map<string, ReturnType<typeof dec>>();
    const before = new Map<string, ReturnType<typeof dec>>();
    let included = 0;
    for (const item of marketHeld) {
      const found = series.get(item.symbol!)?.series;
      const prev = found ? previousClose(found, item.price!.asOf.slice(0, 10), item.currency) : null;
      if (!prev) continue;
      included += 1;
      const delta = holdingChange(item.quantity!, item.price!.price, prev.close);
      change.set(item.currency, (change.get(item.currency) ?? dec(0)).plus(delta));
      before.set(item.currency, (before.get(item.currency) ?? dec(0)).plus(item.quantity!.times(dec(prev.close))));
    }

    const byCurrency = [...change].map(([currency, c]) => ({ currency, change: fmt(c) })).sort((a, b) => a.currency.localeCompare(b.currency));
    const rateOf = (currency: string) => (currency === display ? dec(1) : fx ? dec(fx.rates[currency]) : null);
    const convert = (m: Map<string, ReturnType<typeof dec>>) => {
      let acc = dec(0);
      for (const [currency, v] of m) {
        const rate = rateOf(currency);
        if (!rate) return null;
        acc = acc.plus(v.times(rate));
      }
      return acc;
    };
    const converted = included > 0 ? convert(change) : null;
    const convertedBefore = included > 0 ? convert(before) : null;
    return {
      byCurrency,
      converted: converted ? { baseCurrency: display, change: fmt(converted) } : null,
      percent: converted && convertedBefore ? percentOf(fmt(converted), fmt(convertedBefore)) : null,
      holdingsIncluded: included,
      holdingsExcluded: holdings.length - included,
      complete: holdings.length === included && (included === 0 || converted !== null),
    };
  }
}
