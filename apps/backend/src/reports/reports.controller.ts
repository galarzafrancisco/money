import { Controller, Get, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { ApiRoute } from '../openapi/api-route.decorator';
import type { CurrentUser } from '../users/users.service';
import { accountsReportSchema, categoriesReportSchema } from './reports.responses';
import { reportOptionsSchema } from './reports.schemas';
import { ReportsService } from './reports.service';

/** Query: ?valuation=market|cost&baseCurrency=AUD&fxRates=USD:1.52,EUR:1.65&rootAccountId=… */
@Controller('api/reports')
@Protected()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('accounts')
  @ApiRoute({ tag: 'reports', operationId: 'getAccountsReport', summary: 'Account tree with own and rolled-up totals per currency', query: reportOptionsSchema, response: accountsReportSchema })
  accounts(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, unknown>) {
    return this.reports.accountsReport(user, query as never);
  }

  @Get('categories')
  @ApiRoute({ tag: 'reports', operationId: 'getCategoriesReport', summary: 'Totals per effective category', query: reportOptionsSchema, response: categoriesReportSchema })
  categories(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, unknown>) {
    return this.reports.categoriesReport(user, query as never);
  }
}
