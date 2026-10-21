import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Paths the backend owns; the web app never shadows them */
const BACKEND_PREFIXES = ['/api', '/auth', '/mcp', '/health', '/.well-known'];

export function isBackendPath(path: string): boolean {
  return BACKEND_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Where the built web app (apps/web/dist) is: WEB_DIST_DIR, else next to the backend in the repo or image */
export function webDistDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.WEB_DIST_DIR ?? join(__dirname, '..', '..', '..', 'web', 'dist'));
}

/**
 * Serves the web app from the same origin as /api and /auth, which the
 * cookie session requires (docs/web-auth.md). Hashed assets are cached for a
 * year; index.html is never cached, so a deploy takes effect on next load.
 * Any other GET that asks for HTML gets index.html (client-side routes such as
 * /accounts/123). Returns false when no build is present, e.g. in API-only
 * development, and serves nothing.
 */
export function serveWebApp(app: NestExpressApplication, dir: string): boolean {
  const index = join(dir, 'index.html');
  if (!existsSync(index)) return false;
  app.useStaticAssets(dir, {
    index: false,
    setHeaders: (res, path) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', path.includes(`${join(dir, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isBackendPath(req.path) || !req.accepts('html')) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.sendFile(index);
  });
  return true;
}
