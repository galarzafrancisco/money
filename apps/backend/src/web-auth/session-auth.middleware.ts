import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { clearCookie, readCookie, sendError } from './cookies';
import { WebAuthService } from './web-auth.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Lets the web app call /api with its session cookie. Runs before the guards:
 * it looks up the session, checks CSRF on unsafe methods, refreshes the
 * access token if needed and puts it in the Authorization header. The route's
 * AccessTokenGuard then validates that JWT exactly as for any bearer client
 * (signature, iss, exp, aud = /api), and MoneyUserGuard maps (iss, sub) to
 * the user. Nothing here decides who the user is.
 *
 * A request that already has an Authorization header is left alone: explicit
 * bearer clients keep working and the cookie is ignored for them. /mcp is not
 * covered: MCP clients always use bearer tokens.
 */
@Injectable()
export class SessionAuthMiddleware implements NestMiddleware {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly webAuth: WebAuthService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (req.headers.authorization) return next();
      const cookie = readCookie(req, this.config.webAuth.sessionCookieName);
      if (!cookie) return next();

      const session = await this.webAuth.findSession(cookie);
      if (!session) return this.expired(res);
      if (!SAFE_METHODS.has(req.method) && !this.webAuth.csrfMatches(session, req.headers['x-csrf-token'])) {
        return sendError(res, 403, 'csrf_failed', 'Requests made with the session cookie need the X-CSRF-Token header from GET /auth/session');
      }
      const access = await this.webAuth.accessFor(session);
      if (access.status === 'none') return this.expired(res);
      if (access.status === 'unavailable') {
        return sendError(res, 503, 'auth_unavailable', 'Taico could not be reached to renew the session; try again shortly');
      }
      req.headers.authorization = `Bearer ${access.accessToken}`;
      next();
    } catch (error) {
      next(error);
    }
  }

  private expired(res: Response): void {
    clearCookie(res, this.config.webAuth, this.config.webAuth.sessionCookieName);
    sendError(res, 401, 'session_expired', 'The session has ended; sign in again at /auth/login');
  }
}
