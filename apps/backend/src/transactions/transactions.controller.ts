import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import type { CurrentUser } from '../users/users.service';
import { TransactionsService } from './transactions.service';

@Controller('api')
@Protected()
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get('accounts/:accountId/transactions')
  list(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Query() query: Record<string, string>) {
    return this.transactions.list(user, accountId, query);
  }

  /** Body: { type: DEPOSIT | WITHDRAWAL | FX_CONVERSION | BUY | SELL | DIVIDEND, date, ...fields for that type } */
  @Post('accounts/:accountId/transactions')
  record(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Body() body: unknown) {
    return this.transactions.record(user, accountId, body as never);
  }

  @Get('transactions/:transactionId')
  get(@AuthenticatedUser() user: CurrentUser, @Param('transactionId') transactionId: string) {
    return this.transactions.get(user, transactionId);
  }

  @Patch('transactions/:transactionId')
  update(@AuthenticatedUser() user: CurrentUser, @Param('transactionId') transactionId: string, @Body() body: unknown) {
    return this.transactions.update(user, transactionId, body as never);
  }

  @Delete('transactions/:transactionId')
  @HttpCode(200)
  delete(@AuthenticatedUser() user: CurrentUser, @Param('transactionId') transactionId: string) {
    return this.transactions.delete(user, transactionId);
  }
}
