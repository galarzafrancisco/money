import type { MockAccount, MockTransaction } from './types';

/** Deterministic pseudo-random numbers (mulberry32): the same seed always yields the same fixtures */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS = ['Fictional Coffee Co', 'Example Grocer', 'Sample Transport', 'Demo Pharmacy', 'Placeholder Books', 'Test Takeaway'];

export type FixtureOptions = {
  seed?: number;
  /** Transactions generated for the Spending account (default 75: several pages at the default size) */
  spendingTransactions?: number;
  /** Timestamp of the oldest generated transaction */
  start?: string;
};

export type Fixtures = { accounts: Omit<MockAccount, 'id'>[]; transactions: (Omit<MockTransaction, 'id' | 'accountId'> & { accountIndex: number })[] };

/**
 * Three fictional accounts (Spending, Savings, a joint 2Up) and a repeatable
 * transaction history. Names are obviously made up; no real merchant data.
 */
export function buildFixtures(options: FixtureOptions = {}): Fixtures {
  const random = prng(options.seed ?? 1);
  const start = Date.parse(options.start ?? '2026-01-01T00:00:00Z');
  const accounts: Fixtures['accounts'] = [
    { displayName: 'Spending', accountType: 'TRANSACTIONAL', ownershipType: 'INDIVIDUAL', balanceInBaseUnits: 0, currencyCode: 'AUD', createdAt: new Date(start - 86400000).toISOString() },
    { displayName: 'Savings', accountType: 'SAVER', ownershipType: 'INDIVIDUAL', balanceInBaseUnits: 0, currencyCode: 'AUD', createdAt: new Date(start - 86400000).toISOString() },
    { displayName: '2Up Spending', accountType: 'TRANSACTIONAL', ownershipType: 'JOINT', balanceInBaseUnits: 0, currencyCode: 'AUD', createdAt: new Date(start - 86400000).toISOString() },
  ];
  const transactions: Fixtures['transactions'] = [];
  const count = options.spendingTransactions ?? 75;
  let minute = 0;
  const at = () => new Date(start + minute++ * 3_600_000).toISOString();
  const add = (accountIndex: number, description: string, amountInBaseUnits: number, extra: Partial<MockTransaction> = {}) => {
    const createdAt = at();
    accounts[accountIndex].balanceInBaseUnits += amountInBaseUnits;
    transactions.push({
      accountIndex,
      status: 'SETTLED',
      rawText: description.toUpperCase(),
      description,
      message: null,
      amountInBaseUnits,
      currencyCode: 'AUD',
      foreignAmount: null,
      transactionType: amountInBaseUnits < 0 ? 'Purchase' : 'Deposit',
      transferAccountId: null,
      categoryId: null,
      tags: [],
      createdAt,
      settledAt: createdAt,
      ...extra,
    });
  };
  add(0, 'Fictional Employer pay', 250_000, { transactionType: 'Salary' });
  for (let i = 0; i < count; i++) {
    const merchant = MERCHANTS[Math.floor(random() * MERCHANTS.length)];
    add(0, merchant, -(500 + Math.floor(random() * 9500)), { categoryId: i % 2 ? 'restaurants-and-cafes' : 'groceries' });
  }
  add(0, 'Example Overseas Shop', -4_000, { foreignAmount: { currencyCode: 'USD', valueInBaseUnits: -2_600 }, transactionType: 'Purchase' });
  add(1, 'Interest', 1_234, { transactionType: 'Interest' });
  add(1, 'Fictional Employer bonus', 50_000);
  add(2, 'Joint groceries', -8_800, { categoryId: 'groceries' });
  return { accounts, transactions };
}
