import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import type { CurrentUser } from '../users/users.service';
import { ValuationsService } from './valuations.service';

@Controller('api/valuations')
@Protected()
export class ValuationsController {
  constructor(private readonly valuations: ValuationsService) {}

  /** Query: fromDate, toDate, accountId, includeSubaccounts, symbol, include=totals|holdings, baseCurrency, fxRates=USD:1.5,… */
  @Get()
  history(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, unknown>) {
    return this.valuations.history(user, query as never);
  }

  @Get('status')
  status(@AuthenticatedUser() user: CurrentUser) {
    return this.valuations.status(user);
  }

  /** Body: { fromDate, accountId? } */
  @Post('recompute')
  @HttpCode(202)
  recompute(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.valuations.requestRecompute(user, body as never);
  }
}
