import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createAccountSchema, updateAccountSchema } from '../accounts/accounts.schemas';
import { AccountsService } from '../accounts/accounts.service';
import { createCategorySchema, holdingCategorySchema, updateCategorySchema } from '../categories/categories.schemas';
import { CategoriesService } from '../categories/categories.service';
import { DomainError } from '../common/errors';
import { dashboardOptionsSchema } from '../dashboard/dashboard.schemas';
import { DashboardService } from '../dashboard/dashboard.service';
import { tickerSymbol } from '../common/validation';
import { listLotsSchema } from '../lots/lots.schemas';
import { LotsService } from '../lots/lots.service';
import { MarketPricesService } from '../market-prices/market-prices.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { reportOptionsSchema } from '../reports/reports.schemas';
import { ReportsService } from '../reports/reports.service';
import {
  depositShape,
  dividendShape,
  fxShape,
  listTransactionsSchema,
  sellShape,
  tradeShape,
  updateTransactionSchema,
  withdrawalShape,
} from '../transactions/transactions.schemas';
import { TransactionsService } from '../transactions/transactions.service';
import { createTransferShape, listTransfersShape, updateTransferShape } from '../transfers/transfers.schemas';
import { TransfersService } from '../transfers/transfers.service';
import type { CurrentUser } from '../users/users.service';
import { recomputeSchema, valuationAsOfSchema, valuationHistorySchema } from '../valuations/valuations.schemas';
import { ValuationsService } from '../valuations/valuations.service';

const PERSONAL_TRACKING =
  'Money only records activity that happened elsewhere and updates its own tracking balances. It never moves money, contacts a bank or broker, or places trades.';

const accountId = z.string().describe('Account ID (from list_accounts)');
const categoryId = z.string().describe('Category ID (from list_categories)');
const transactionId = z.string().describe('Transaction ID (from list_transactions)');
const transferId = z.string().describe('Transfer ID (from list_transfers)');

/**
 * The MCP adapter. Each tool parses nothing itself and holds no business
 * rules: it calls the same service method as the matching REST route, for
 * the user resolved from the request's access token. That user is bound when
 * the server is built and never comes from tool arguments.
 */
@Injectable()
export class MoneyMcpServerFactory {
  constructor(
    private readonly accounts: AccountsService,
    private readonly transactions: TransactionsService,
    private readonly portfolio: PortfolioService,
    private readonly prices: MarketPricesService,
    private readonly categories: CategoriesService,
    private readonly reports: ReportsService,
    private readonly transfers: TransfersService,
    private readonly valuations: ValuationsService,
    private readonly lots: LotsService,
    private readonly dashboard: DashboardService,
  ) {}

  build(user: CurrentUser): McpServer {
    const server = new McpServer(
      { name: 'money', version: '0.0.1' },
      {
        instructions:
          `Personal investment tracking for the signed-in user: named accounts, multi-currency cash, FX conversions, transfers between accounts, share buys and sells, dividends with withholding tax, cost bases per parcel, and gains. ${PERSONAL_TRACKING} ` +
          'Amounts are decimal strings. Figures are not tax advice; see the notes returned by get_portfolio.',
      },
    );
    const read = { readOnlyHint: true };
    const write = { readOnlyHint: false, destructiveHint: false };
    const destructive = { readOnlyHint: false, destructiveHint: true };

    const tool = <Shape extends z.ZodRawShape>(
      name: string,
      description: string,
      annotations: Record<string, boolean>,
      shape: Shape,
      run: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
    ) => {
      server.registerTool(name, { description, annotations, inputSchema: shape }, (async (args: z.infer<z.ZodObject<Shape>>) =>
        toResult(() => run(args))) as never);
    };

    tool('whoami', 'The Money user the current access token maps to', read, {}, async () => user);

    tool('list_accounts', 'List your accounts and subaccounts (flat; parentAccountId links a subaccount to its parent). get_accounts_report gives the tree with balances.', read, {}, () => this.accounts.list(user));
    tool('get_account', 'Get one account', read, { accountId }, ({ accountId }) => this.accounts.get(user, accountId));
    tool(
      'create_account',
      'Create a named account (a tracking record, not a real bank or brokerage account). Give parentAccountId to make it a subaccount (bucket) of another account, e.g. "Term Deposit 1" under your bank account. Each subaccount has its own transactions.',
      write,
      createAccountSchema.shape,
      (args) => this.accounts.create(user, args),
    );
    tool('update_account', 'Rename or edit an account, move it under another account (parentAccountId; null for top-level), or set its category (categoryId; null to inherit its parent\'s)', write, { accountId, ...updateAccountSchema.shape }, ({ accountId, ...changes }) =>
      this.accounts.update(user, accountId, changes),
    );
    tool(
      'delete_account',
      'Delete an account. An account with subaccounts is refused; move or delete them first. So is one that takes part in transfers; delete those first. An account with transactions needs deleteTransactions: true, which deletes them too.',
      destructive,
      { accountId, deleteTransactions: z.boolean().optional().describe('Also delete the account\'s transactions') },
      ({ accountId, deleteTransactions }) => this.accounts.delete(user, accountId, { deleteTransactions }),
    );

    tool(
      'list_categories',
      'List your categories: your own labels for how you think about money (e.g. alpha-high-risk, boring-etf, emergency)',
      read,
      {},
      () => this.categories.list(user),
    );
    tool('get_category', 'Get one category and how many accounts and holdings have it as their own', read, { categoryId }, ({ categoryId }) =>
      this.categories.get(user, categoryId),
    );
    tool(
      'create_category',
      'Create a category. Assign it to an account or subaccount with update_account, or to one holding with set_holding_category.',
      write,
      createCategorySchema.shape,
      (args) => this.categories.create(user, args),
    );
    tool('update_category', 'Rename a category or change its description or colour', write, { categoryId, ...updateCategorySchema.shape }, ({ categoryId, ...changes }) =>
      this.categories.update(user, categoryId, changes),
    );
    tool(
      'delete_category',
      'Delete a category. If it is assigned, unassign: true is required; those accounts and holdings then inherit their category again.',
      destructive,
      { categoryId, unassign: z.boolean().optional().describe('Clear its assignments and delete it') },
      ({ categoryId, unassign }) => this.categories.delete(user, categoryId, { unassign }),
    );
    tool(
      'set_holding_category',
      'Give one holding (a symbol in one account, e.g. TSLA in your broker account) its own category, overriding the account\'s. categoryId null clears it. One category per holding.',
      write,
      { accountId, ...holdingCategorySchema.shape },
      ({ accountId, ...input }) => this.categories.setHoldingCategory(user, accountId, input),
    );
    tool(
      'list_holding_categories',
      'List the holdings that have their own category, optionally for one account',
      read,
      { accountId: accountId.optional() },
      ({ accountId }) => this.categories.listHoldingCategories(user, accountId),
    );

    tool(
      'get_accounts_report',
      'Balances and valuations as an account tree: per account "own" (its ledger) and "rolledUp" (plus all subaccounts), per currency. "totals" counts everything once; never add rolledUp figures across levels. Converted totals need baseCurrency and fxRates.',
      read,
      reportOptionsSchema.shape,
      (args) => this.reports.accountsReport(user, args),
    );
    tool(
      'get_categories_report',
      'Balances and valuations grouped by category. Every cash balance and holding is in exactly one category (holding\'s own, else account\'s, else nearest parent\'s, else Uncategorized), so category totals add up to the overall total. Converted totals need baseCurrency and fxRates.',
      read,
      reportOptionsSchema.shape,
      (args) => this.reports.categoriesReport(user, args),
    );

    tool(
      'get_dashboard',
      'Portfolio overview: total tracked assets in displayCurrency (default AUD), split by asset class (cash, shares, super), category, top-level account and ticker (concentration as percentOfShares and percentOfTotal). Rates come from fxRates or the price provider; if any is missing, converted figures and percentages are null. Check valuation.status and warnings before relying on figures.',
      read,
      dashboardOptionsSchema.shape,
      (args) => this.dashboard.dashboard(user, args),
    );

    tool(
      'list_transactions',
      'List an account\'s transactions in ledger order (date, then order recorded)',
      read,
      { accountId, ...listTransactionsSchema.shape },
      ({ accountId, ...filter }) => this.transactions.list(user, accountId, filter),
    );
    tool('get_transaction', 'Get one transaction', read, { transactionId }, ({ transactionId }) => this.transactions.get(user, transactionId));

    tool(
      'record_deposit',
      `Record cash that arrived in the account. For money converted on the way (e.g. AUD from the bank arriving as USD) give the credited currency and amount, and optionally externalCurrency/externalAmount for what left the bank. ${PERSONAL_TRACKING}`,
      write,
      { accountId, ...depositShape },
      ({ accountId, ...input }) => this.transactions.recordOfType(user, accountId, 'DEPOSIT', input),
    );
    tool(
      'record_withdrawal',
      `Record cash that left the account. Fails if the account did not hold enough of that currency on that date. ${PERSONAL_TRACKING}`,
      write,
      { accountId, ...withdrawalShape },
      ({ accountId, ...input }) => this.transactions.recordOfType(user, accountId, 'WITHDRAWAL', input),
    );
    tool(
      'record_fx_conversion',
      'Record a currency conversion inside the account. Give any two of fromAmount, toAmount and rate (toCurrency per fromCurrency); the third is calculated. Optional fees are charged in fromCurrency on top of fromAmount.',
      write,
      { accountId, ...fxShape },
      ({ accountId, ...input }) => this.transactions.recordOfType(user, accountId, 'FX_CONVERSION', input),
    );
    tool(
      'record_buy',
      'Record a share purchase. Give any three of quantity, unitPrice, fees and total (total = quantity × unitPrice + fees); the fourth is calculated. If all four are given they must agree within 0.01.',
      write,
      { accountId, ...tradeShape },
      ({ accountId, ...input }) => this.transactions.recordOfType(user, accountId, 'BUY', input),
    );
    tool(
      'record_sell',
      'Record a share sale. Give any three of quantity, unitPrice, fees and total (total = quantity × unitPrice − fees, the cash received); the fourth is calculated. To say which purchases the shares came from (specific identification), give allocations: [{lotId, quantity}, …] using lot IDs from list_lots, adding up to quantity; one sale may take part of several lots. Without allocations, lots are matched FIFO. Fails if the shares (or a named lot) were not held on that date.',
      write,
      { accountId, ...sellShape },
      ({ accountId, ...input }) => this.transactions.recordOfType(user, accountId, 'SELL', input),
    );
    tool(
      'record_dividend',
      'Record a dividend. Give any two of grossAmount, withholdingTax and netAmount (net = gross − withholding; use withholdingTax "0" if none). The net amount is credited as cash. Optional frankingCredits are recorded, not credited.',
      write,
      { accountId, ...dividendShape },
      ({ accountId, ...input }) => this.transactions.recordOfType(user, accountId, 'DIVIDEND', input),
    );
    tool(
      'update_transaction',
      'Edit a transaction. Transfer legs (TRANSFER_OUT/TRANSFER_IN) are refused; use update_transfer. Only fields valid for its type are accepted. Fields left out keep their values; set a calculable field to null to have it recalculated. On a SELL, allocations replaces its lot allocations and null switches it to FIFO. The edit is rejected if the account\'s ledger would become inconsistent (e.g. a purchase edited below what sales allocate from it).',
      write,
      { transactionId, ...updateTransactionSchema.shape },
      ({ transactionId, ...changes }) => this.transactions.update(user, transactionId, changes),
    );
    tool(
      'delete_transaction',
      'Delete a transaction. Transfer legs are refused; use delete_transfer. Rejected if later transactions depend on it (e.g. a deposit that funded a buy, or a purchase that sales allocate shares from).',
      destructive,
      { transactionId },
      ({ transactionId }) => this.transactions.delete(user, transactionId),
    );

    tool(
      'list_lots',
      'List an account\'s purchase lots (parcels): lotId (the BUY\'s transaction ID), purchase date, ticker, remaining quantity and cost base, holding period and the sales that took from each. asOf gives the lots a sale on that date can allocate from; excludeTransactionId leaves out a sale being edited.',
      read,
      { accountId, ...listLotsSchema.shape },
      ({ accountId, ...query }) => this.lots.listLots(user, accountId, query),
    );
    tool(
      'get_sale_allocations',
      'How one sale was split across purchase lots: per lot the quantity, cost base, gross and net proceeds, fees, gain and holding period (heldOverTwelveMonths), plus totals that add up to the sale. Works for FIFO and specific-identification sales.',
      read,
      { transactionId },
      ({ transactionId }) => this.lots.saleAllocations(user, transactionId),
    );

    tool(
      'record_transfer',
      `Record money moved between two of your accounts or subaccounts, e.g. from your bank account to a "Term Deposit 1" bucket. Both sides are recorded together: a TRANSFER_OUT on fromAccountId (amount plus any fees) and a TRANSFER_IN on toAccountId. In one currency give fromAmount. Between currencies give toCurrency and any two of fromAmount, toAmount and rate (toCurrency per fromCurrency). Fails if the source did not hold enough fromCurrency on that date. ${PERSONAL_TRACKING}`,
      write,
      createTransferShape,
      (args) => this.transfers.record(user, args),
    );
    tool(
      'list_transfers',
      'List transfers between your accounts, by date. Give accountId for the ones into or out of one account.',
      read,
      listTransfersShape,
      (args) => this.transfers.list(user, args),
    );
    tool('get_transfer', 'Get one transfer, including its FX details and the IDs of its two transactions', read, { transferId }, ({ transferId }) =>
      this.transfers.get(user, transferId),
    );
    tool(
      'update_transfer',
      'Edit a transfer; both sides change together. Accounts cannot be changed (delete and record again). Fields left out keep their values; set fromAmount, toAmount or rate to null to recalculate it. Rejected if either account\'s ledger would become inconsistent.',
      write,
      { transferId, ...updateTransferShape },
      ({ transferId, ...changes }) => this.transfers.update(user, transferId, changes),
    );
    tool(
      'delete_transfer',
      'Delete a transfer recorded by mistake, with both its transactions. Rejected if either account depends on it (e.g. the destination already spent the money). If money really came back, record a transfer in the opposite direction instead.',
      destructive,
      { transferId },
      ({ transferId }) => this.transfers.delete(user, transferId),
    );

    tool(
      'get_portfolio',
      'An account\'s cash per currency, holdings with per-parcel cost base, market value and unrealized gain, realized gains per sale and parcel, and dividend totals. Includes the accounting assumptions used.',
      read,
      { accountId, withPrices: z.boolean().optional().describe('Look up market prices (default true)') },
      ({ accountId, withPrices }) => this.portfolio.accountPortfolio(user, accountId, { withPrices }),
    );
    tool(
      'get_market_price',
      'Latest market price for a ticker from the configured provider, with source, currency and asOf. priceType LAST may be intraday and delayed; CLOSE is a finished session. isMock: true is made-up development data. isStale: true means the provider could not be reached and this is the last known price (staleReason, asOf).',
      read,
      { symbol: tickerSymbol },
      ({ symbol }) => this.prices.getQuote(symbol),
    );
    tool(
      'get_valuation_history',
      'Daily valuations of your holdings over a date range, for value-over-time charts: per date, what was held at the end of that day valued at that day\'s market close, with totals per currency. include: "holdings" adds each holding with quantity, close used (price.status, tradingDate, source, isMock) and lots. Check price.status and "complete": non-trading days use the last close, pending or missing prices are flagged, not hidden.',
      read,
      valuationHistorySchema.shape,
      (args) => this.valuations.history(user, args),
    );
    tool(
      'get_valuation_as_of',
      'Your holdings at the end of one past date (quantities and lots replayed from your transactions as of that date, never today\'s) valued at that date\'s closes. Uses the stored daily snapshot when complete and current (basis SNAPSHOT), else reconstructs it now (basis ON_DEMAND). baseCurrency converts at that date\'s historical FX close unless you pass fxRates. Check complete, price.status, warnings and conversionUnavailable.',
      read,
      valuationAsOfSchema.shape,
      (args) => this.valuations.asOf(user, args),
    );
    tool(
      'get_valuation_status',
      'How far daily valuations are materialised (earliest/latest date, partial days, pending recomputation) and when the job last ran',
      read,
      {},
      () => this.valuations.status(user),
    );
    tool(
      'request_valuation_recompute',
      'Ask the daily valuation job to re-value your holdings from a date on its next run. Backdated trades already trigger this automatically; use it to recover days whose prices were missing. refreshPrices: true also fetches the closes again from that date, to pick up provider corrections.',
      write,
      recomputeSchema.shape,
      (args) => this.valuations.requestRecompute(user, args),
    );

    return server;
  }
}

/** Results as JSON text; domain errors become tool errors with the same code and message as REST */
async function toResult(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await run();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    if (error instanceof DomainError) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }),
          },
        ],
      };
    }
    throw error;
  }
}
