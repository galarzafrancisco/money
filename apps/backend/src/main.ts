import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadConfig } from './config/env.config';
import { startDatabase } from './database/in-memory-database';
import { serveWebApp, webDistDir } from './web-app/serve-web-app';

async function bootstrap(): Promise<void> {
  const loaded = loadConfig();
  const logger = new Logger('Money');
  const inMemory = loaded.database.driver === 'memory';
  const running = await startDatabase(loaded.database);
  const config = { ...loaded, database: running.database };
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot({ config }));
  app.enableShutdownHooks();
  const webDir = webDistDir();
  const servingWeb = serveWebApp(app, webDir);
  await app.listen(config.port);
  logger.log(`Listening on ${config.publicBaseUrl} (REST /api, MCP /mcp)`);
  logger.log(servingWeb ? `Web app: serving ${webDir} at /` : `Web app: no build at ${webDir} (run npm run build, or the Vite dev server)`);
  if (inMemory) {
    logger.warn('Database: IN-MEMORY PGlite (DATABASE_MODE=memory). NOT DURABLE: all accounts, transactions and sessions are lost on every restart or redeploy.');
  } else {
    logger.log(`Database: ${config.database.driver === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : `embedded PGlite at ${config.database.dataDir}`}`);
  }
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
