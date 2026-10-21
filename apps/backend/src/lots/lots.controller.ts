import { Controller, Get, Param, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { ApiRoute } from '../openapi/api-route.decorator';
import type { CurrentUser } from '../users/users.service';
import { lotsResultSchema, saleAllocationsSchema } from './lots.responses';
import { listLotsSchema } from './lots.schemas';
import { LotsService } from './lots.service';

@Controller('api')
@Protected()
export class LotsController {
  constructor(private readonly lots: LotsService) {}

  /** Query: symbol, asOf (YYYY-MM-DD), excludeTransactionId, includeClosed=true|false */
  @Get('accounts/:accountId/lots')
  @ApiRoute({ tag: 'lots', operationId: 'listLots', summary: "An account's purchase lots, as they stood at the end of asOf", query: listLotsSchema, response: lotsResultSchema })
  list(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Query() query: Record<string, unknown>) {
    return this.lots.listLots(user, accountId, query as never);
  }

  /** How one sale was split across purchase lots, with per-lot cost base, proceeds, fees, gain and holding period */
  @Get('transactions/:transactionId/allocations')
  @ApiRoute({ tag: 'lots', operationId: 'getSaleAllocations', summary: 'How one sale was split across purchase lots', response: saleAllocationsSchema })
  allocations(@AuthenticatedUser() user: CurrentUser, @Param('transactionId') transactionId: string) {
    return this.lots.saleAllocations(user, transactionId);
  }
}
