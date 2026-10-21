import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { ApiRoute } from '../openapi/api-route.decorator';
import { apiSchema } from '../openapi/api-schemas';
import type { CurrentUser } from '../users/users.service';
import { deleteTransactionResultSchema, transactionListSchema, transactionSchema } from './transactions.responses';
import { listTransactionsSchema, recordTransactionSchema, updateTransactionSchema } from './transactions.schemas';
import { TransactionsService } from './transactions.service';

@Controller('api')
@Protected()
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get('accounts/:accountId/transactions')
  @ApiRoute({ tag: 'transactions', operationId: 'listTransactions', summary: "List an account's transactions in ledger order", query: listTransactionsSchema, response: transactionListSchema })
  list(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Query() query: Record<string, string>) {
    return this.transactions.list(user, accountId, query);
  }

  /** Body: { type: DEPOSIT | WITHDRAWAL | FX_CONVERSION | BUY | SELL | DIVIDEND, date, ...fields for that type } */
  @Post('accounts/:accountId/transactions')
  @ApiRoute({
    tag: 'transactions',
    operationId: 'recordTransaction',
    summary: 'Record a deposit, withdrawal, FX conversion, buy, sell or dividend that already happened',
    body: apiSchema('RecordTransactionRequest', recordTransactionSchema),
    response: transactionSchema,
  })
  record(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Body() body: unknown) {
    return this.transactions.record(user, accountId, body as never);
  }

  @Get('transactions/:transactionId')
  @ApiRoute({ tag: 'transactions', operationId: 'getTransaction', summary: 'Get one transaction', response: transactionSchema })
  get(@AuthenticatedUser() user: CurrentUser, @Param('transactionId') transactionId: string) {
    return this.transactions.get(user, transactionId);
  }

  @Patch('transactions/:transactionId')
  @ApiRoute({ tag: 'transactions', operationId: 'updateTransaction', summary: 'Edit a transaction', body: apiSchema('UpdateTransactionRequest', updateTransactionSchema), response: transactionSchema })
  update(@AuthenticatedUser() user: CurrentUser, @Param('transactionId') transactionId: string, @Body() body: unknown) {
    return this.transactions.update(user, transactionId, body as never);
  }

  @Delete('transactions/:transactionId')
  @HttpCode(200)
  @ApiRoute({ tag: 'transactions', operationId: 'deleteTransaction', summary: 'Delete a transaction', response: deleteTransactionResultSchema })
  delete(@AuthenticatedUser() user: CurrentUser, @Param('transactionId') transactionId: string) {
    return this.transactions.delete(user, transactionId);
  }
}
