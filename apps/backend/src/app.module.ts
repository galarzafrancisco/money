import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { remoteJwks, type JwksSource } from '@taico/auth';
import { AuthExceptionFilter, AuthModule } from '@taico/auth/nest';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsRepository } from './accounts/accounts.repository';
import { AccountsService } from './accounts/accounts.service';
import { createMoneyResourceServer, protectedResources } from './auth/auth.setup';
import { MoneyUserGuard } from './auth/user.guard';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesRepository } from './categories/categories.repository';
import { CategoriesService } from './categories/categories.service';
import { DomainErrorFilter } from './common/domain-error.filter';
import { APP_CONFIG, type AppConfig } from './config/env.config';
import { dataSourceOptions } from './database/data-source-options';
import { UnitOfWork } from './database/unit-of-work';
import { HealthController } from './health/health.controller';
import { MARKET_PRICE_PROVIDER, type MarketPriceProvider } from './market-prices/market-price.port';
import { MarketPricesService } from './market-prices/market-prices.service';
import { MockPriceProvider } from './market-prices/mock-price.provider';
import { YahooPriceProvider } from './market-prices/yahoo-price.provider';
import { LotsController } from './lots/lots.controller';
import { LotsService } from './lots/lots.service';
import { McpController } from './mcp/mcp.controller';
import { MoneyMcpServerFactory } from './mcp/money-mcp.server';
import { PortfolioController } from './portfolio/portfolio.controller';
import { PortfolioService } from './portfolio/portfolio.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { TransactionsController } from './transactions/transactions.controller';
import { TransactionsRepository } from './transactions/transactions.repository';
import { TransactionsService } from './transactions/transactions.service';
import { TransfersController } from './transfers/transfers.controller';
import { TransfersRepository } from './transfers/transfers.repository';
import { TransfersService } from './transfers/transfers.service';
import { UsersRepository } from './users/users.repository';
import { PriceHistoryService } from './valuations/price-history.service';
import { ValuationJobService } from './valuations/valuation-job.service';
import { ValuationScheduler } from './valuations/valuation.scheduler';
import { ValuationsController } from './valuations/valuations.controller';
import { ValuationsRepository } from './valuations/valuations.repository';
import { ValuationsService } from './valuations/valuations.service';
import { UsersService } from './users/users.service';

export type AppModuleOptions = {
  config: AppConfig;
  /** Overrides Taico's remote JWKS (tests sign their own tokens) */
  jwks?: JwksSource;
  /** Overrides the provider chosen by MARKET_PRICE_PROVIDER */
  priceProvider?: MarketPriceProvider;
};

export function priceProviderFor(config: AppConfig): MarketPriceProvider {
  return config.marketPrices.provider === 'yahoo' ? new YahooPriceProvider() : new MockPriceProvider();
}

@Global()
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config } = options;
    return {
      module: AppModule,
      imports: [
        TypeOrmModule.forRoot({ ...dataSourceOptions(config.database), retryAttempts: config.nodeEnv === 'test' ? 0 : 5 }),
        AuthModule.forRoot({
          resourceServer: createMoneyResourceServer(config, options.jwks ?? remoteJwks(config.auth.jwksUrl)),
          metadata: { resources: protectedResources(config), authorizationServers: config.auth.authorizationServers },
        }),
      ],
      controllers: [HealthController, AccountsController, TransactionsController, LotsController, PortfolioController, CategoriesController, ReportsController, TransfersController, ValuationsController, McpController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: MARKET_PRICE_PROVIDER, useValue: options.priceProvider ?? priceProviderFor(config) },
        { provide: APP_FILTER, useClass: AuthExceptionFilter },
        { provide: APP_FILTER, useClass: DomainErrorFilter },
        UnitOfWork,
        UsersRepository,
        UsersService,
        MoneyUserGuard,
        AccountsRepository,
        AccountsService,
        CategoriesRepository,
        CategoriesService,
        ReportsService,
        TransactionsRepository,
        TransactionsService,
        LotsService,
        TransfersRepository,
        TransfersService,
        PortfolioService,
        MarketPricesService,
        PriceHistoryService,
        ValuationsRepository,
        ValuationJobService,
        ValuationsService,
        ValuationScheduler,
        MoneyMcpServerFactory,
      ],
      exports: [MARKET_PRICE_PROVIDER, MarketPricesService, ValuationJobService],
    };
  }
}
