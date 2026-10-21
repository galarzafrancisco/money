import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config/env.config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger('Money');
  const app = await NestFactory.create(AppModule.forRoot({ config }));
  app.enableShutdownHooks();
  await app.listen(config.port);
  logger.log(`Listening on ${config.publicBaseUrl} (REST /api, MCP /mcp)`);
  logger.log(`Database: ${config.database.driver === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : `embedded PGlite at ${config.database.dataDir}`}`);
  logger.log(`Taico issuer: ${config.auth.issuer} (JWKS ${config.auth.jwksUrl})`);
  const web = config.webAuth;
  logger.log(
    web.clientId
      ? `Browser sign-in: ${web.authorizationServer} (client ${web.clientId}, callback ${web.redirectUri})`
      : 'Browser sign-in: not configured (set TAICO_WEB_CLIENT_ID, see docs/web-auth.md)',
  );
  if (web.encryptionKeyEphemeral) logger.warn('SESSION_ENCRYPTION_KEY unset: using a per-process key, browser sessions end on restart');
  logger.log(`Market prices: ${config.marketPrices.provider}${config.marketPrices.provider === 'mock' ? ' (MOCK prices, not real)' : ''}`);
}

void bootstrap();
