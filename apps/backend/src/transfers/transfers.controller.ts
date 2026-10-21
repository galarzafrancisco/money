import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import type { CurrentUser } from '../users/users.service';
import { TransfersService } from './transfers.service';

@Controller('api/transfers')
@Protected()
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  /** Query: accountId (either side), fromDate, toDate */
  @Get()
  list(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, string>) {
    return this.transfers.list(user, query);
  }

  /** Body: { fromAccountId, toAccountId, date, fromCurrency, toCurrency?, fromAmount?, toAmount?, rate?, fees?, description? } */
  @Post()
  record(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.transfers.record(user, body as never);
  }

  @Get(':transferId')
  get(@AuthenticatedUser() user: CurrentUser, @Param('transferId') transferId: string) {
    return this.transfers.get(user, transferId);
  }

  @Patch(':transferId')
  update(@AuthenticatedUser() user: CurrentUser, @Param('transferId') transferId: string, @Body() body: unknown) {
    return this.transfers.update(user, transferId, body as never);
  }

  @Delete(':transferId')
  @HttpCode(200)
  delete(@AuthenticatedUser() user: CurrentUser, @Param('transferId') transferId: string) {
    return this.transfers.delete(user, transferId);
  }
}
