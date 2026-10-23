import { Controller, Get, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { ApiRoute } from '../openapi/api-route.decorator';
import { splitAdjustmentResultSchema, stockSplitListSchema } from './splits.responses';
import { listSplitsSchema, splitAdjustmentSchema } from './splits.schemas';
import { SplitsService } from './splits.service';

/** Stock splits are market data shared by every user; reading them still needs a signed-in user */
@Controller('api/stock-splits')
@Protected()
export class SplitsController {
  constructor(private readonly splits: SplitsService) {}

  /** Query: symbol, fromDate, toDate */
  @Get()
  @ApiRoute({ tag: 'stock-splits', operationId: 'listStockSplits', summary: 'Recorded stock splits, by symbol and effective-date range', query: listSplitsSchema, response: stockSplitListSchema })
  list(@Query() query: Record<string, unknown>) {
    return this.splits.list(query as never);
  }

  /** Query: symbol, date */
  @Get('adjustment')
  @ApiRoute({
    tag: 'stock-splits',
    operationId: 'getSplitAdjustment',
    summary: 'Cumulative split factor from a date\'s share basis to the present one',
    query: splitAdjustmentSchema,
    response: splitAdjustmentResultSchema,
  })
  adjustment(@Query() query: Record<string, unknown>) {
    return this.splits.adjustment(query as never);
  }
}
