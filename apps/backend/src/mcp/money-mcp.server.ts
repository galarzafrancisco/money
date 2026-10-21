import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createAccountSchema, updateAccountSchema } from '../accounts/accounts.schemas';
import { AccountsService } from '../accounts/accounts.service';
import { DomainError } from '../common/errors';
import { tickerSymbol } from '../common/validation';
import { MarketPricesService } from '../market-prices/market-prices.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import {
  depositShape,
  dividendShape,
  fxShape,
  listTransactionsSchema,
  tradeShape,
  updateTransactionSchema,
  withdrawalShape,
} from '../transactions/transactions.schemas';
import { TransactionsService } from '../transactions/transactions.service';
import type { CurrentUser } from '../users/users.service';

const PERSONAL_TRACKING =
  'Money only records activity that happened elsewhere and updates its own tracking balances. It never moves money, contacts a bank or broker, or places trades.';

const accountId = z.string().describe('Account ID (from list_accounts)');
const transactionId = z.string().describe('Transaction ID (from list_transactions)');

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
  ) {}

  build(user: CurrentUser): McpServer {
    const server = new McpServer(
      { name: 'money', version: '0.0.1' },
      {
        instructions:
          `Personal investment tracking for the signed-in user: named accounts, multi-currency cash, FX conversions, share buys and sells, dividends with withholding tax, cost bases per parcel, and gains. ${PERSONAL_TRACKING} ` +
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

    tool('list_accounts', 'List your accounts', read, {}, () => this.accounts.list(user));
    tool('get_account', 'Get one account', read, { accountId }, ({ accountId }) => this.accounts.get(user, accountId));
    tool(
      'create_account',
      'Create a named account (a tracking record, not a real bank or brokerage account)',
      write,
      createAccountSchema.shape,
      (args) => this.accounts.create(user, args),
    );
    tool('update_account', 'Rename or edit an account', write, { accountId, ...updateAccountSchema.shape }, ({ accountId, ...changes }) =>
      this.accounts.update(user, accountId, changes),
    );
    tool(
      'delete_account',
      'Delete an account. An account with transactions needs deleteTransactions: true, which deletes them too.',
      destructive,
      { accountId, deleteTransactions: z.boolean().optional().describe('Also delete the account\'s transactions') },
      ({ accountId, deleteTransactions }) => this.accounts.delete(user, accountId, { deleteTransactions }),
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
      'Record a share sale. Give any three of quantity, unitPrice, fees and total (total = quantity × unitPrice − fees, the cash received); the fourth is calculated. Parcels are matched FIFO. Fails if fewer shares were held on that date.',
      write,
      { accountId, ...tradeShape },
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
      'Edit a transaction. Only fields valid for its type are accepted. Fields left out keep their values; set a calculable field to null to have it recalculated. The edit is rejected if the account\'s ledger would become inconsistent.',
      write,
      { transactionId, ...updateTransactionSchema.shape },
      ({ transactionId, ...changes }) => this.transactions.update(user, transactionId, changes),
    );
    tool(
      'delete_transaction',
      'Delete a transaction. Rejected if later transactions depend on it (e.g. a deposit that funded a buy).',
      destructive,
      { transactionId },
      ({ transactionId }) => this.transactions.delete(user, transactionId),
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
      'Latest market price for a ticker from the configured provider. Quotes with isMock: true are made-up development data.',
      read,
      { symbol: tickerSymbol },
      ({ symbol }) => this.prices.getQuote(symbol),
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
