import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { ApiRoute } from '../openapi/api-route.decorator';
import { apiSchema } from '../openapi/api-schemas';
import type { CurrentUser } from '../users/users.service';
import { recomputeResultSchema, valuationAsOfResultSchema, valuationHistoryResultSchema, valuationStatusSchema } from './valuations.responses';
import { recomputeSchema, valuationAsOfSchema, valuationHistorySchema } from './valuations.schemas';
import { ValuationsService } from './valuations.service';

@Controller('api/valuations')
@Protected()
export class ValuationsController {
  constructor(private readonly valuations: ValuationsService) {}

  /** Query: fromDate, toDate, accountId, includeSubaccounts, symbol, include=totals|holdings, baseCurrency, fxRates=USD:1.5,… */
  @Get()
  @ApiRoute({ tag: 'valuations', operationId: 'getValuationHistory', summary: 'Daily closing-price valuations of share holdings (not cash)', query: valuationHistorySchema, response: valuationHistoryResultSchema })
  history(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, unknown>) {
    return this.valuations.history(user, query as never);
  }

  /** Query: date, accountId, includeSubaccounts, symbol, baseCurrency, fxRates */
  @Get('as-of')
  @ApiRoute({
    tag: 'valuations',
    operationId: 'getValuationAsOf',
    summary: 'Holdings and their value at the close of one date: the snapshot, or reconstructed on demand',
    query: valuationAsOfSchema,
    response: valuationAsOfResultSchema,
  })
  asOf(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, unknown>) {
    return this.valuations.asOf(user, query as never);
  }

  @Get('status')
  @ApiRoute({ tag: 'valuations', operationId: 'getValuationStatus', summary: 'State of the daily valuation job for you', response: valuationStatusSchema })
  status(@AuthenticatedUser() user: CurrentUser) {
    return this.valuations.status(user);
  }

  /** Body: { fromDate, accountId?, refreshPrices? } */
  @Post('recompute')
  @HttpCode(202)
  @ApiRoute({ tag: 'valuations', operationId: 'requestValuationRecompute', summary: 'Re-value dates from fromDate on the next job run', body: apiSchema('ValuationRecomputeRequest', recomputeSchema), response: recomputeResultSchema })
  recompute(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.valuations.requestRecompute(user, body as never);
  }
}
