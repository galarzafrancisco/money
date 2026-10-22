import type { Type } from '@nestjs/common';
import { AccountGroupsController } from '../account-groups/account-groups.controller';
import { AccountsController } from '../accounts/accounts.controller';
import { CategoriesController } from '../categories/categories.controller';
import { DashboardController } from '../dashboard/dashboard.controller';
import { LotsController } from '../lots/lots.controller';
import { PortfolioController } from '../portfolio/portfolio.controller';
import { ReportsController } from '../reports/reports.controller';
import { TransactionsController } from '../transactions/transactions.controller';
import { TransfersController } from '../transfers/transfers.controller';
import { UpController } from '../up/up.controller';
import { ValuationsController } from '../valuations/valuations.controller';

/**
 * The controllers that make up the REST API under /api. AppModule mounts
 * exactly these, so the OpenAPI spec (build-spec.ts) covers every REST route.
 */
export const REST_CONTROLLERS: readonly Type[] = [
  AccountsController,
  AccountGroupsController,
  TransactionsController,
  LotsController,
  PortfolioController,
  CategoriesController,
  ReportsController,
  DashboardController,
  TransfersController,
  ValuationsController,
  UpController,
];
