import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { ApiRoute } from '../openapi/api-route.decorator';
import { apiSchema } from '../openapi/api-schemas';
import type { CurrentUser } from '../users/users.service';
import { deleteTransferResultSchema, transferListSchema, transferSchema } from './transfers.responses';
import { createTransferSchema, listTransfersSchema, updateTransferSchema } from './transfers.schemas';
import { TransfersService } from './transfers.service';

@Controller('api/transfers')
@Protected()
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  /** Query: accountId (either side), fromDate, toDate */
  @Get()
  @ApiRoute({ tag: 'transfers', operationId: 'listTransfers', summary: 'List transfers between your accounts', query: listTransfersSchema, response: transferListSchema })
  list(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, string>) {
    return this.transfers.list(user, query);
  }

  /** Body: { fromAccountId, toAccountId, date, fromCurrency, toCurrency?, fromAmount?, toAmount?, rate?, fees?, description? } */
  @Post()
  @ApiRoute({
    tag: 'transfers',
    operationId: 'recordTransfer',
    summary: 'Record a transfer between two of your accounts that already happened',
    body: apiSchema('RecordTransferRequest', createTransferSchema),
    response: transferSchema,
  })
  record(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.transfers.record(user, body as never);
  }

  @Get(':transferId')
  @ApiRoute({ tag: 'transfers', operationId: 'getTransfer', summary: 'Get one transfer', response: transferSchema })
  get(@AuthenticatedUser() user: CurrentUser, @Param('transferId') transferId: string) {
    return this.transfers.get(user, transferId);
  }

  @Patch(':transferId')
  @ApiRoute({ tag: 'transfers', operationId: 'updateTransfer', summary: 'Edit a transfer', body: apiSchema('UpdateTransferRequest', updateTransferSchema), response: transferSchema })
  update(@AuthenticatedUser() user: CurrentUser, @Param('transferId') transferId: string, @Body() body: unknown) {
    return this.transfers.update(user, transferId, body as never);
  }

  @Delete(':transferId')
  @HttpCode(200)
  @ApiRoute({ tag: 'transfers', operationId: 'deleteTransfer', summary: 'Delete a transfer and both of its legs', response: deleteTransferResultSchema })
  delete(@AuthenticatedUser() user: CurrentUser, @Param('transferId') transferId: string) {
    return this.transfers.delete(user, transferId);
  }
}
