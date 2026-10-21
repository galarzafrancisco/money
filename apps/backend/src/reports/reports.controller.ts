import { Controller, Get, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import type { CurrentUser } from '../users/users.service';
import { ReportsService } from './reports.service';

/** Query: ?valuation=market|cost&baseCurrency=AUD&fxRates=USD:1.52,EUR:1.65&rootAccountId=… */
@Controller('api/reports')
@Protected()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('accounts')
  accounts(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, unknown>) {
    return this.reports.accountsReport(user, query as never);
  }

  @Get('categories')
  categories(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, unknown>) {
    return this.reports.categoriesReport(user, query as never);
  }
}
