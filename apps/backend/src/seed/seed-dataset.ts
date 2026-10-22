import type { AccountType } from '../accounts/account.entity';
import type { RecordTransactionInput } from '../transactions/transactions.schemas';
import type { CreateTransferInput } from '../transfers/transfers.schemas';

/**
 * SYNTHETIC seed data for development and tests. Every person, account and
 * amount here is made up. Nothing comes from a real portfolio, and nothing in
 * this file may ever be replaced by real figures.
 *
 * Dates are given as days before an anchor date (`--anchor`, default today),
 * so the history always falls inside the valuation backfill window. Amounts,
 * quantities and prices are fixed, so the expected balances below do not
 * depend on the anchor.
 *
 * Trade prices are the MOCK provider's base price of each symbol (or within
 * its ±5% daily swing), so cost bases, mock closes and value-over-time stay
 * coherent. With another provider they would not be; the seed CLI refuses it.
 *
 * See apps/backend/docs/seed-data.md for the expected results of each user.
 */

/** Prefix of every seeded account and category description: marks a record as synthetic and safe to reset */
export const SEED_MARKER = '[synthetic seed]';

/** Every synthetic identity's subject starts with this, so it can never be a Taico user's */
export const SEED_SUBJECT_PREFIX = 'money-seed-';

export type SeedCategory = { key: string; name: string; description: string; color: string };

export type SeedAccount = {
  key: string;
  name: string;
  type: AccountType;
  reportingCurrency: string;
  description: string;
  parent?: string;
  category?: string;
};

type Dated = { daysAgo: number };

/** A lot named by the key of its BUY, instead of the ID the database will give it */
export type SeedAllocation = { lot: string; quantity: string };

type WithoutDate<T> = T extends unknown ? Omit<T, 'date' | 'allocations'> : never;
/** A transaction as recorded, minus its date (from daysAgo); a SELL names its lots by key */
export type SeedTransactionInput =
  | WithoutDate<Exclude<RecordTransactionInput, { type: 'SELL' }>>
  | (WithoutDate<Extract<RecordTransactionInput, { type: 'SELL' }>> & { allocations?: SeedAllocation[] });

export type SeedActivity =
  | (Dated & {
      kind: 'transaction';
      /** Lets a later SELL name this BUY as a lot */
      key?: string;
      account: string;
      input: SeedTransactionInput;
    })
  | (Dated & {
      kind: 'transfer';
      from: string;
      to: string;
      input: Omit<CreateTransferInput, 'fromAccountId' | 'toAccountId' | 'date'>;
    });

export type SeedUser = {
  key: string;
  subject: string;
  displayName: string;
  email: string;
  /** default: coherent, realistic data. edge-case: intentional oddities, kept apart from the default users */
  purpose: 'default' | 'edge-case';
  summary: string;
  categories: SeedCategory[];
  accounts: SeedAccount[];
  holdingCategories: { account: string; symbol: string; category: string }[];
  activity: SeedActivity[];
};

const tx = (daysAgo: number, account: string, input: Extract<SeedActivity, { kind: 'transaction' }>['input'], key?: string): SeedActivity => ({
  kind: 'transaction',
  daysAgo,
  account,
  input,
  key,
});
const transfer = (daysAgo: number, from: string, to: string, input: Extract<SeedActivity, { kind: 'transfer' }>['input']): SeedActivity => ({
  kind: 'transfer',
  daysAgo,
  from,
  to,
  input,
});

/**
 * Alex: the main coherent dataset. A bank account with two buckets, an ASX
 * broker, a US broker funded through an AUD→USD transfer and an FX conversion,
 * and a super fund. Concentrated in NVDA on the US side.
 */
export const ALEX: SeedUser = {
  key: 'alex',
  subject: `${SEED_SUBJECT_PREFIX}alex`,
  displayName: 'Alex Example (synthetic)',
  email: 'alex@example.invalid',
  purpose: 'default',
  summary: 'Main coherent dataset: buckets, categories, AUD/USD, transfers, FX, buys, FIFO and specific-lot sells, dividends with withholding and franking, super',
  categories: [
    { key: 'emergency', name: 'emergency-fund', description: 'Cash kept for emergencies', color: '#2e7d32' },
    { key: 'term', name: 'term-deposits', description: 'Fixed-term deposits', color: '#1565c0' },
    { key: 'alpha', name: 'alpha-high-risk', description: 'Single stocks bought for growth; high risk', color: '#c62828' },
    { key: 'etf', name: 'broad-market-etf', description: 'Diversified index ETFs', color: '#6a1b9a' },
  ],
  accounts: [
    { key: 'bank', name: 'Everyday Bank', type: 'CASH', reportingCurrency: 'AUD', description: 'Fictional transaction account' },
    { key: 'emergency', name: 'Emergency Fund', type: 'CASH', reportingCurrency: 'AUD', parent: 'bank', category: 'emergency', description: 'Bucket of Everyday Bank' },
    { key: 'term', name: 'Term Deposit 1', type: 'CASH', reportingCurrency: 'AUD', parent: 'bank', category: 'term', description: '6-month term deposit bucket' },
    { key: 'asx', name: 'ASX Broker', type: 'INVESTMENT', reportingCurrency: 'AUD', description: 'Fictional ASX brokerage account' },
    { key: 'us', name: 'US Broker', type: 'INVESTMENT', reportingCurrency: 'USD', description: 'Fictional US brokerage account' },
    { key: 'super', name: 'Super Fund', type: 'SUPERANNUATION', reportingCurrency: 'AUD', description: 'Fictional superannuation account' },
  ],
  holdingCategories: [
    { account: 'asx', symbol: 'VAS.AX', category: 'etf' },
    { account: 'asx', symbol: 'VGS.AX', category: 'etf' },
    { account: 'us', symbol: 'IVV', category: 'etf' },
    { account: 'us', symbol: 'NVDA', category: 'alpha' },
    { account: 'us', symbol: 'PLTR', category: 'alpha' },
  ],
  activity: [
    // Everyday Bank: savings come in, money goes out to the buckets and brokers
    tx(360, 'bank', { type: 'DEPOSIT', currency: 'AUD', amount: '80000.00', description: 'Opening balance (synthetic)' }),
    tx(300, 'bank', { type: 'DEPOSIT', currency: 'AUD', amount: '9000.00', description: 'Savings (synthetic)' }),
    tx(200, 'bank', { type: 'DEPOSIT', currency: 'AUD', amount: '9000.00', description: 'Savings (synthetic)' }),
    tx(100, 'bank', { type: 'DEPOSIT', currency: 'AUD', amount: '9000.00', description: 'Savings (synthetic)' }),
    tx(30, 'bank', { type: 'WITHDRAWAL', currency: 'AUD', amount: '2500.00', description: 'Holiday (synthetic)' }),
    transfer(355, 'bank', 'emergency', { fromCurrency: 'AUD', fromAmount: '15000.00', description: 'Fund the emergency bucket' }),
    transfer(355, 'bank', 'term', { fromCurrency: 'AUD', fromAmount: '10000.00', description: 'Open the term deposit' }),
    tx(175, 'term', { type: 'DEPOSIT', currency: 'AUD', amount: '350.00', description: 'Term deposit interest (synthetic)' }),
    transfer(350, 'bank', 'asx', { fromCurrency: 'AUD', fromAmount: '25000.00' }),
    // A transfer between currencies, with a fee: 20000 AUD × 0.65 = 13000 USD
    transfer(345, 'bank', 'us', { fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: '20000.00', rate: '0.65', fees: '10.00', description: 'Fund the US broker' }),
    transfer(150, 'bank', 'asx', { fromCurrency: 'AUD', fromAmount: '10000.00' }),

    // ASX Broker (AUD)
    tx(340, 'asx', { type: 'BUY', symbol: 'VAS.AX', currency: 'AUD', quantity: '30', unitPrice: '452.60', fees: '9.50' }, 'asx-vas-1'),
    tx(330, 'asx', { type: 'BUY', symbol: 'BHP.AX', currency: 'AUD', quantity: '15', unitPrice: '371.73', fees: '9.50' }),
    tx(320, 'asx', { type: 'BUY', symbol: 'CBA.AX', currency: 'AUD', quantity: '50', unitPrice: '55.52', fees: '9.50' }),
    tx(250, 'asx', { type: 'DIVIDEND', symbol: 'VAS.AX', currency: 'AUD', grossAmount: '180.00', withholdingTax: '0', frankingCredits: '45.00' }),
    tx(240, 'asx', { type: 'DIVIDEND', symbol: 'BHP.AX', currency: 'AUD', grossAmount: '52.50', withholdingTax: '0', frankingCredits: '22.50' }),
    tx(140, 'asx', { type: 'BUY', symbol: 'VGS.AX', currency: 'AUD', quantity: '15', unitPrice: '454.83', fees: '9.50' }),
    tx(120, 'asx', { type: 'BUY', symbol: 'VAS.AX', currency: 'AUD', quantity: '10', unitPrice: '452.60', fees: '9.50' }, 'asx-vas-2'),
    tx(60, 'asx', { type: 'SELL', symbol: 'CBA.AX', currency: 'AUD', quantity: '20', unitPrice: '57.00', fees: '9.50', description: 'FIFO sale' }),
    // Specific identification: the 5 shares come from the second VAS.AX lot, not the oldest
    tx(40, 'asx', {
      type: 'SELL',
      symbol: 'VAS.AX',
      currency: 'AUD',
      quantity: '5',
      unitPrice: '460.00',
      fees: '9.50',
      description: 'Specific-lot sale',
      allocations: [{ lot: 'asx-vas-2', quantity: '5' }],
    }),
    tx(20, 'asx', { type: 'DIVIDEND', symbol: 'VAS.AX', currency: 'AUD', grossAmount: '160.00', withholdingTax: '0', frankingCredits: '40.00' }),

    // US Broker (USD), plus AUD deposited and converted on the same day
    tx(340, 'us', { type: 'BUY', symbol: 'IVV', currency: 'USD', quantity: '25', unitPrice: '204.42', fees: '1.00' }),
    tx(335, 'us', { type: 'BUY', symbol: 'NVDA', currency: 'USD', quantity: '20', unitPrice: '259.26', fees: '1.00' }),
    tx(200, 'us', { type: 'BUY', symbol: 'PLTR', currency: 'USD', quantity: '40', unitPrice: '42.43', fees: '1.00' }),
    tx(180, 'us', { type: 'DIVIDEND', symbol: 'IVV', currency: 'USD', grossAmount: '20.00', withholdingTax: '3.00' }),
    tx(150, 'us', { type: 'DEPOSIT', currency: 'AUD', amount: '3005.00', description: 'AUD top-up (synthetic)' }),
    tx(150, 'us', { type: 'FX_CONVERSION', fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: '3000.00', rate: '0.65', fees: '5.00' }),
    tx(145, 'us', { type: 'BUY', symbol: 'NVDA', currency: 'USD', quantity: '5', unitPrice: '259.26', fees: '1.00' }),
    tx(90, 'us', { type: 'SELL', symbol: 'PLTR', currency: 'USD', quantity: '10', unitPrice: '44.00', fees: '1.00' }),
    tx(85, 'us', { type: 'DIVIDEND', symbol: 'NVDA', currency: 'USD', grossAmount: '0.80', withholdingTax: '0.12' }),
    tx(10, 'us', { type: 'DIVIDEND', symbol: 'IVV', currency: 'USD', grossAmount: '22.00', withholdingTax: '3.30' }),

    // Super Fund: quarterly employer contributions invested in a diversified ETF
    tx(350, 'super', { type: 'DEPOSIT', currency: 'AUD', amount: '2500.00', description: 'Employer contribution (synthetic)' }),
    tx(345, 'super', { type: 'BUY', symbol: 'VDHG.AX', currency: 'AUD', quantity: '6', unitPrice: '301.12', fees: '0' }),
    tx(260, 'super', { type: 'DEPOSIT', currency: 'AUD', amount: '2500.00', description: 'Employer contribution (synthetic)' }),
    tx(255, 'super', { type: 'BUY', symbol: 'VDHG.AX', currency: 'AUD', quantity: '8', unitPrice: '301.12', fees: '0' }),
    tx(170, 'super', { type: 'DEPOSIT', currency: 'AUD', amount: '2500.00', description: 'Employer contribution (synthetic)' }),
    tx(165, 'super', { type: 'BUY', symbol: 'VDHG.AX', currency: 'AUD', quantity: '8', unitPrice: '301.12', fees: '0' }),
    tx(80, 'super', { type: 'DEPOSIT', currency: 'AUD', amount: '2500.00', description: 'Employer contribution (synthetic)' }),
    tx(75, 'super', { type: 'BUY', symbol: 'VDHG.AX', currency: 'AUD', quantity: '8', unitPrice: '301.12', fees: '0' }),
  ],
};

/**
 * Blair: a second, smaller user for isolation tests. Some account and
 * category names and one ticker match Alex's on purpose, with different
 * amounts, so a leak between users is easy to spot.
 */
export const BLAIR: SeedUser = {
  key: 'blair',
  subject: `${SEED_SUBJECT_PREFIX}blair`,
  displayName: 'Blair Sample (synthetic)',
  email: 'blair@example.invalid',
  purpose: 'default',
  summary: 'Second user with overlapping names and tickers, for isolation checks',
  categories: [{ key: 'etf', name: 'broad-market-etf', description: 'Same name as one of Alex\'s categories', color: '#00838f' }],
  accounts: [
    { key: 'bank', name: 'Everyday Bank', type: 'CASH', reportingCurrency: 'AUD', description: 'Same name as Alex\'s bank account' },
    { key: 'asx', name: 'ASX Broker', type: 'INVESTMENT', reportingCurrency: 'AUD', category: 'etf', description: 'ETF-only brokerage account' },
  ],
  holdingCategories: [],
  activity: [
    tx(200, 'bank', { type: 'DEPOSIT', currency: 'AUD', amount: '12000.00', description: 'Opening balance (synthetic)' }),
    transfer(190, 'bank', 'asx', { fromCurrency: 'AUD', fromAmount: '8000.00' }),
    tx(185, 'asx', { type: 'BUY', symbol: 'VAS.AX', currency: 'AUD', quantity: '12', unitPrice: '452.60', fees: '5.00' }),
    tx(100, 'asx', { type: 'BUY', symbol: 'A200.AX', currency: 'AUD', quantity: '4', unitPrice: '494.29', fees: '5.00' }),
    tx(30, 'asx', { type: 'DIVIDEND', symbol: 'A200.AX', currency: 'AUD', grossAmount: '30.00', withholdingTax: '0', frankingCredits: '12.00' }),
  ],
};

/** A user who exists but has recorded nothing: the empty states */
export const EMPTY: SeedUser = {
  key: 'empty',
  subject: `${SEED_SUBJECT_PREFIX}empty`,
  displayName: 'Empty Example (synthetic)',
  email: 'empty@example.invalid',
  purpose: 'default',
  summary: 'No accounts, categories or transactions (empty states)',
  categories: [],
  accounts: [],
  holdingCategories: [],
  activity: [],
};

/**
 * Intentional edge cases, kept in their own user so they never muddy the
 * coherent data. Uses the mock provider's reserved suffixes (see
 * market-prices/mock-price.provider.ts).
 */
export const EDGE: SeedUser = {
  key: 'edge',
  subject: `${SEED_SUBJECT_PREFIX}edge`,
  displayName: 'Edge Case (synthetic)',
  email: 'edge@example.invalid',
  purpose: 'edge-case',
  summary: 'Missing and stale prices, a currency with no FX rate, a sold-out holding with a later dividend, fractional shares, an empty account, 5-level nesting, an unused category',
  categories: [{ key: 'unused', name: 'unused-category', description: 'Assigned to nothing', color: '#9e9e9e' }],
  accounts: [
    { key: 'broker', name: 'Edge Broker', type: 'INVESTMENT', reportingCurrency: 'USD', description: 'Holdings with missing and stale prices' },
    { key: 'chf', name: 'Swiss Cash', type: 'CASH', reportingCurrency: 'CHF', description: 'CHF has no mock FX rate, so it cannot be converted' },
    { key: 'empty', name: 'Empty Account', type: 'CASH', reportingCurrency: 'AUD', description: 'No transactions' },
    { key: 'l1', name: 'Level 1', type: 'OTHER', reportingCurrency: 'AUD', description: 'Nesting level 1' },
    { key: 'l2', name: 'Level 2', type: 'OTHER', reportingCurrency: 'AUD', parent: 'l1', description: 'Nesting level 2' },
    { key: 'l3', name: 'Level 3', type: 'OTHER', reportingCurrency: 'AUD', parent: 'l2', description: 'Nesting level 3' },
    { key: 'l4', name: 'Level 4', type: 'OTHER', reportingCurrency: 'AUD', parent: 'l3', description: 'Nesting level 4' },
    { key: 'l5', name: 'Level 5', type: 'OTHER', reportingCurrency: 'AUD', parent: 'l4', description: 'Nesting level 5, the deepest allowed' },
  ],
  holdingCategories: [],
  activity: [
    tx(120, 'broker', { type: 'DEPOSIT', currency: 'USD', amount: '5000.00', description: 'Opening balance (synthetic)' }),
    // The mock provider does not know this symbol: no price, valued at cost
    tx(120, 'broker', { type: 'BUY', symbol: 'DELIST.MOCKMISSING', currency: 'USD', quantity: '10', unitPrice: '64.99', fees: '0' }),
    // Quotes always fail; the last stored close is served as stale
    tx(110, 'broker', { type: 'BUY', symbol: 'GRWTH.MOCKSTALE', currency: 'USD', quantity: '5', unitPrice: '427.23', fees: '0' }),
    // Bought and sold out completely; a dividend arrives after the sale
    tx(100, 'broker', { type: 'BUY', symbol: 'XYZ', currency: 'USD', quantity: '4', unitPrice: '282.17', fees: '0' }),
    tx(50, 'broker', { type: 'SELL', symbol: 'XYZ', currency: 'USD', quantity: '4', unitPrice: '290.00', fees: '0' }),
    tx(20, 'broker', { type: 'DIVIDEND', symbol: 'XYZ', currency: 'USD', grossAmount: '4.00', withholdingTax: '0.60', description: 'Dividend after selling out' }),
    // Fractional shares
    tx(45, 'broker', { type: 'BUY', symbol: 'VOO', currency: 'USD', quantity: '0.125', unitPrice: '276.92', fees: '0' }),
    tx(90, 'chf', { type: 'DEPOSIT', currency: 'CHF', amount: '1000.00' }),
    tx(60, 'l5', { type: 'DEPOSIT', currency: 'AUD', amount: '100.00', description: 'Cash five levels down' }),
  ],
};

/** The default users and the edge-case user, in seeding order */
export const SEED_USERS: readonly SeedUser[] = [ALEX, BLAIR, EMPTY, EDGE];
