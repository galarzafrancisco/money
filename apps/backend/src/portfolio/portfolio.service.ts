import { Injectable } from '@nestjs/common';
import { MoneyDecimal, ZERO, dec, fmt } from '../common/decimal';
import { AccountsService, type AccountView } from '../accounts/accounts.service';
import { heldOverTwelveMonths, replayLedger } from '../ledger/ledger-engine';
import { MarketPricesService } from '../market-prices/market-prices.service';
import type { Quote } from '../market-prices/market-price.port';
import { toLedgerEntry } from '../transactions/transaction.mapper';
import { TransactionsRepository } from '../transactions/transactions.repository';
import type { CurrentUser } from '../users/users.service';

/**
 * Stated with every summary so that no client presents these numbers as tax
 * advice. See apps/backend/docs/accounting-assumptions.md.
 */
export const ACCOUNTING_NOTES = [
  'Personal tracking only, not tax advice. Check figures with the ATO or a registered tax agent.',
  'A sale with lot allocations uses specific identification (the parcels it names); a sale without uses first-in, first-out (FIFO). Each disposal says which (selection).',
  'A sale\'s fees and net proceeds are shared between its parcels pro-rata by quantity (10 dp, last parcel takes the remainder), so disposals add up exactly to the sale.',
  'Cost base includes brokerage. Sale proceeds are net of brokerage.',
  'Cost bases, proceeds and gains are in the currency of the trade. They are not converted to AUD at transaction-date rates, which the ATO requires for foreign-currency CGT.',
  'heldOverTwelveMonths flags parcels that pass the 12-month test for the CGT discount. No discount is applied.',
  'Realized gain = net proceeds − cost base of the parcels sold. Unrealized gain = market value − remaining cost base.',
];

type PriceInfo = { price: string; currency: string; asOf: string; source: string; isMock: boolean };

export type PortfolioView = {
  account: AccountView;
  asOf: string;
  priceProvider: string;
  cash: { currency: string; balance: string }[];
  holdings: HoldingView[];
  realized: {
    totals: { currency: string; proceeds: string; costBase: string; gain: string }[];
    disposals: {
      sellTransactionId: string;
      lotId: string;
      symbol: string;
      currency: string;
      acquiredOn: string;
      disposedOn: string;
      selection: 'FIFO' | 'SPECIFIC';
      quantity: string;
      costBase: string;
      grossProceeds: string;
      fees: string;
      proceeds: string;
      gain: string;
      daysHeld: number;
      heldOverTwelveMonths: boolean;
    }[];
  };
  dividends: {
    totals: DividendView[];
    bySymbol: (DividendView & { symbol: string })[];
  };
  notes: string[];
};

type DividendView = { currency: string; grossAmount: string; withholdingTax: string; netAmount: string; frankingCredits: string };

export type HoldingView = {
  symbol: string;
  currency: string;
  quantity: string;
  costBase: string;
  averageUnitCost: string;
  price: PriceInfo | null;
  priceError: string | null;
  marketValue: string | null;
  unrealizedGain: string | null;
  unrealizedGainPercent: string | null;
  lots: {
    lotId: string;
    acquiredOn: string;
    originalQuantity: string;
    remainingQuantity: string;
    costBase: string;
    unitCostBase: string;
    marketValue: string | null;
    unrealizedGain: string | null;
    /** Whether a sale today would pass the 12-month CGT-discount test */
    heldOverTwelveMonths: boolean;
  }[];
};

@Injectable()
export class PortfolioService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly transactions: TransactionsRepository,
    private readonly prices: MarketPricesService,
  ) {}

  /**
   * Derives an account's cash, holdings, lots, realized results and dividends
   * from its transactions, and values holdings at current market prices.
   */
  async accountPortfolio(user: CurrentUser, accountId: string, options: { withPrices?: boolean; today?: string } = {}): Promise<PortfolioView> {
    const account = await this.accounts.get(user, accountId);
    const rows = await this.transactions.listForAccount(user.id, account.id);
    const state = replayLedger(rows.map(toLedgerEntry));
    const today = options.today ?? new Date().toISOString().slice(0, 10);

    const symbols = [...state.positions.keys()];
    const quotes = options.withPrices === false ? new Map() : await this.prices.getQuotes(symbols);

    const holdings: HoldingView[] = [...state.positions.values()]
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .map((position) => {
        const result = quotes.get(position.symbol) as { quote: Quote } | { error: string } | undefined;
        let price: PriceInfo | null = null;
        let priceError: string | null = null;
        let unitPrice: MoneyDecimal | null = null;
        if (result && 'quote' in result) {
          const { quote } = result;
          price = { price: quote.price, currency: quote.currency, asOf: quote.asOf, source: quote.source, isMock: quote.isMock };
          if (quote.currency === position.currency) {
            unitPrice = dec(quote.price);
          } else {
            priceError = `Price is quoted in ${quote.currency} but the holding is in ${position.currency}; not valued`;
          }
        } else if (result && 'error' in result) {
          priceError = result.error;
        }
        const marketValue = unitPrice ? unitPrice.times(position.quantity) : null;
        const unrealized = marketValue ? marketValue.minus(position.costBase) : null;
        return {
          symbol: position.symbol,
          currency: position.currency,
          quantity: fmt(position.quantity),
          costBase: fmt(position.costBase),
          averageUnitCost: fmt(position.costBase.dividedBy(position.quantity)),
          price,
          priceError,
          marketValue: marketValue ? fmt(marketValue) : null,
          unrealizedGain: unrealized ? fmt(unrealized) : null,
          unrealizedGainPercent:
            unrealized && position.costBase.gt(0) ? fmt(unrealized.dividedBy(position.costBase).times(100).toDecimalPlaces(4)) : null,
          lots: position.lots.map((lot) => {
            const lotValue = unitPrice ? unitPrice.times(lot.remainingQuantity) : null;
            return {
              lotId: lot.lotId,
              acquiredOn: lot.acquiredOn,
              originalQuantity: fmt(lot.originalQuantity),
              remainingQuantity: fmt(lot.remainingQuantity),
              costBase: fmt(lot.remainingCostBase),
              unitCostBase: fmt(lot.originalCostBase.dividedBy(lot.originalQuantity)),
              marketValue: lotValue ? fmt(lotValue) : null,
              unrealizedGain: lotValue ? fmt(lotValue.minus(lot.remainingCostBase)) : null,
              heldOverTwelveMonths: heldOverTwelveMonths(lot.acquiredOn, today),
            };
          }),
        };
      });

    const realizedTotals = new Map<string, { proceeds: MoneyDecimal; costBase: MoneyDecimal; gain: MoneyDecimal }>();
    for (const disposal of state.disposals) {
      const totals = realizedTotals.get(disposal.currency) ?? { proceeds: ZERO, costBase: ZERO, gain: ZERO };
      realizedTotals.set(disposal.currency, {
        proceeds: totals.proceeds.plus(disposal.proceeds),
        costBase: totals.costBase.plus(disposal.costBase),
        gain: totals.gain.plus(disposal.gain),
      });
    }

    const dividendView = (d: { currency: string; grossAmount: MoneyDecimal; withholdingTax: MoneyDecimal; netAmount: MoneyDecimal; frankingCredits: MoneyDecimal }): DividendView => ({
      currency: d.currency,
      grossAmount: fmt(d.grossAmount),
      withholdingTax: fmt(d.withholdingTax),
      netAmount: fmt(d.netAmount),
      frankingCredits: fmt(d.frankingCredits),
    });

    return {
      account,
      asOf: new Date().toISOString(),
      priceProvider: this.prices.providerName,
      cash: [...state.cash.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, balance]) => ({ currency, balance: fmt(balance) })),
      holdings,
      realized: {
        totals: [...realizedTotals.entries()].map(([currency, t]) => ({
          currency,
          proceeds: fmt(t.proceeds),
          costBase: fmt(t.costBase),
          gain: fmt(t.gain),
        })),
        disposals: state.disposals.map((disposal) => ({
          sellTransactionId: disposal.sellTransactionId,
          lotId: disposal.lotId,
          symbol: disposal.symbol,
          currency: disposal.currency,
          acquiredOn: disposal.acquiredOn,
          disposedOn: disposal.disposedOn,
          selection: disposal.selection,
          quantity: fmt(disposal.quantity),
          costBase: fmt(disposal.costBase),
          grossProceeds: fmt(disposal.grossProceeds),
          fees: fmt(disposal.fees),
          proceeds: fmt(disposal.proceeds),
          gain: fmt(disposal.gain),
          daysHeld: disposal.daysHeld,
          heldOverTwelveMonths: disposal.heldOverTwelveMonths,
        })),
      },
      dividends: {
        totals: [...state.dividends.values()].map(dividendView),
        bySymbol: [...state.dividendsBySymbol.values()].map((d) => ({ symbol: d.symbol, ...dividendView(d) })),
      },
      notes: ACCOUNTING_NOTES,
    };
  }
}
