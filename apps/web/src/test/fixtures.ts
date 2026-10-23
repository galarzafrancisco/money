import type { Account, AccountReportNode, AccountsReport, Category, Lot, LotList, Portfolio, SaleAllocations, Transaction, Transfer } from '@money/client';

const now = '2026-10-21T00:00:00.000Z';

export function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    name: 'Broker',
    type: 'INVESTMENT',
    reportingCurrency: 'AUD',
    description: null,
    parentAccountId: null,
    categoryId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function category(overrides: Partial<Category> = {}): Category {
  return { id: 'cat-1', name: 'Core', description: null, color: '#336699', createdAt: now, updatedAt: now, ...overrides };
}

const totals = (byCurrency: { currency: string; total: string }[]) => ({
  byCurrency: byCurrency.map((t) => ({ currency: t.currency, cash: t.total, holdings: '0', total: t.total })),
  converted: null,
});

export function reportNode(a: Account, own: { currency: string; total: string }[], rolledUp = own, children: AccountReportNode[] = []): AccountReportNode {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    source: 'manual',
    parentAccountId: a.parentAccountId,
    level: 0,
    categoryId: a.categoryId,
    effectiveCategory: null,
    own: totals(own),
    rolledUp: totals(rolledUp),
    items: [],
    children,
  };
}

export function accountsReport(accounts: AccountReportNode[], warnings: string[] = []): AccountsReport {
  return { asOf: now, valuation: 'market', fx: null, priceProvider: 'mock', rootAccountId: null, totals: totals([]), warnings, notes: [], accounts };
}

export function portfolio(a: Account, overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    account: a,
    asOf: now,
    priceProvider: 'mock',
    cash: [{ currency: 'AUD', balance: '1234.5' }],
    holdings: [
      {
        symbol: 'VAS.AX',
        currency: 'AUD',
        quantity: '300',
        costBase: '27000',
        averageUnitCost: '90',
        price: { price: '100', currency: 'AUD', asOf: now, source: 'mock', isMock: true, isStale: false },
        priceError: null,
        marketValue: '30000',
        unrealizedGain: '3000',
        unrealizedGainPercent: '11.1111',
        lots: [],
      },
    ],
    realized: { totals: [], disposals: [] },
    dividends: { totals: [], bySymbol: [] },
    notes: ['Personal tracking only, not tax advice.'],
    ...overrides,
  };
}

export function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    accountId: 'acc-1',
    type: 'DEPOSIT',
    date: '2024-01-02',
    sequence: 1,
    description: null,
    calculatedField: null,
    createdAt: now,
    updatedAt: now,
    currency: 'AUD',
    amount: '5000',
    externalCurrency: null,
    externalAmount: null,
    ...overrides,
  };
}

export function lot(overrides: Partial<Lot> = {}): Lot {
  return {
    lotId: 'lot-1',
    buyTransactionId: 'lot-1',
    accountId: 'acc-1',
    symbol: 'VAS.AX',
    currency: 'AUD',
    acquiredOn: '2023-01-10',
    sequence: 2,
    status: 'OPEN',
    originalQuantity: '100',
    originalCostBase: '9000',
    unitCostBase: '90',
    remainingQuantity: '100',
    remainingCostBase: '9000',
    daysHeld: 500,
    heldOverTwelveMonths: true,
    disposals: [],
    ...overrides,
  };
}

export function lotList(lots: Lot[]): LotList {
  return { accountId: 'acc-1', asOf: null, symbol: null, excludedTransactionId: null, lots, notes: ['Not tax advice.'] };
}

export function saleAllocations(overrides: Partial<SaleAllocations> = {}): SaleAllocations {
  return {
    saleTransactionId: 'sale-1',
    accountId: 'acc-1',
    symbol: 'VAS.AX',
    currency: 'AUD',
    date: '2024-03-01',
    lotSelection: 'SPECIFIC',
    quantity: '40',
    unitPrice: '100',
    fees: '10',
    total: '3990',
    allocations: [
      { lotId: 'lot-1', acquiredOn: '2023-01-10', quantity: '15', unitCostBase: '90', costBase: '1350', grossProceeds: '1500', fees: '3.75', proceeds: '1496.25', gain: '146.25', daysHeld: 416, heldOverTwelveMonths: true },
      { lotId: 'lot-2', acquiredOn: '2023-06-01', quantity: '25', unitCostBase: '95', costBase: '2375', grossProceeds: '2500', fees: '6.25', proceeds: '2493.75', gain: '118.75', daysHeld: 274, heldOverTwelveMonths: false },
    ],
    totals: { quantity: '40', costBase: '3725', grossProceeds: '4000', fees: '10', proceeds: '3990', gain: '265' },
    notes: ['Personal tracking only, not tax advice.'],
    ...overrides,
  };
}

export function transfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tr-1',
    fromAccountId: 'acc-1',
    toAccountId: 'acc-2',
    date: '2024-04-01',
    description: null,
    fromCurrency: 'AUD',
    fromAmount: '100',
    toCurrency: 'AUD',
    toAmount: '100',
    rate: '1',
    fees: '0',
    isFx: false,
    calculatedField: null,
    outTransactionId: 'tx-out',
    inTransactionId: 'tx-in',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
