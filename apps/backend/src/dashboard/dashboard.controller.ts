import { Controller, Get, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { ApiRoute } from '../openapi/api-route.decorator';
import type { CurrentUser } from '../users/users.service';
import { dashboardSchema } from './dashboard.responses';
import { dashboardOptionsSchema } from './dashboard.schemas';
import { DashboardService } from './dashboard.service';

/** Query: ?displayCurrency=AUD&fxRates=USD:1.52 */
@Controller('api/dashboard')
@Protected()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiRoute({
    tag: 'dashboard',
    operationId: 'getDashboard',
    summary: 'Total tracked assets in a display currency, split by asset class, category, account and ticker',
    query: dashboardOptionsSchema,
    response: dashboardSchema,
  })
  get(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, unknown>) {
    return this.dashboard.dashboard(user, query as never);
  }
}
