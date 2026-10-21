import { Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { clearCookie, noStore, readCookie, sendError, setCookie } from './cookies';
import { TaicoAuthError } from './taico-web-client';
import { LoginError, WebAuthService } from './web-auth.service';

/**
 * Browser sign-in endpoints (backend-for-frontend). Outside /api on purpose:
 * /api is the OAuth protected resource, these are the client side of the
 * flow. Contract: docs/web-auth.md.
 */
@Controller('auth')
export class WebAuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly webAuth: WebAuthService,
  ) {}

  /** Starts sign-in: redirects to Taico. `returnTo` is a path in the web app. */
  @Get('login')
  async login(@Query('returnTo') returnTo: unknown, @Res() res: Response): Promise<void> {
    noStore(res);
    try {
      const { redirectUrl, loginCookie } = await this.webAuth.startLogin(returnTo);
      setCookie(res, this.config.webAuth, this.config.webAuth.loginCookieName, loginCookie, this.config.webAuth.loginTimeoutSeconds * 1000);
      res.redirect(302, redirectUrl);
    } catch (error) {
      if (error instanceof TaicoAuthError) {
        sendError(res, error.kind === 'not_configured' ? 503 : 502, error.kind === 'not_configured' ? 'auth_not_configured' : 'auth_unavailable', error.message);
        return;
      }
      throw error;
    }
  }

  /** Taico's redirect back. Ends with a redirect into the web app, with `?authError=` on failure. */
  @Get('callback')
  async callback(@Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    noStore(res);
    const loginCookie = readCookie(req, this.config.webAuth.loginCookieName);
    clearCookie(res, this.config.webAuth, this.config.webAuth.loginCookieName);
    try {
      const result = await this.webAuth.completeLogin({
        loginCookie,
        previousSessionCookie: readCookie(req, this.config.webAuth.sessionCookieName),
        code: query.code,
        state: query.state,
        error: query.error,
      });
      setCookie(res, this.config.webAuth, this.config.webAuth.sessionCookieName, result.sessionCookie, this.config.webAuth.absoluteTimeoutHours * 3_600_000);
      res.redirect(302, this.webAuth.appRedirect(result.returnTo));
    } catch (error) {
      if (error instanceof LoginError) {
        res.redirect(302, this.webAuth.appRedirect(error.returnTo, error.code));
        return;
      }
      throw error;
    }
  }

  /**
   * Who is signed in. Always 200 so the app can bootstrap without an error:
   * `{ authenticated: false }` or the user, the session expiry and the CSRF
   * token to send as X-CSRF-Token on unsafe requests.
   */
  @Get('session')
  async session(@Req() req: Request, @Res() res: Response): Promise<void> {
    noStore(res);
    const session = await this.webAuth.findSession(readCookie(req, this.config.webAuth.sessionCookieName));
    const user = session ? await this.webAuth.sessionUser(session) : null;
    if (!session || !user) {
      if (readCookie(req, this.config.webAuth.sessionCookieName)) clearCookie(res, this.config.webAuth, this.config.webAuth.sessionCookieName);
      res.status(200).json({ authenticated: false, loginUrl: '/auth/login' });
      return;
    }
    res.status(200).json({
      authenticated: true,
      user,
      csrfToken: session.csrfToken,
      expiresAt: new Date(Math.min(session.expiresAt.getTime(), session.idleExpiresAt.getTime())).toISOString(),
    });
  }

  /** Local sign-out: ends the Money session. Needs X-CSRF-Token. Taico's own sign-in is unaffected. */
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    noStore(res);
    const session = await this.webAuth.findSession(readCookie(req, this.config.webAuth.sessionCookieName));
    if (session) {
      if (!this.webAuth.csrfMatches(session, req.headers['x-csrf-token'])) {
        sendError(res, 403, 'csrf_failed', 'Missing or wrong X-CSRF-Token');
        return;
      }
      await this.webAuth.logout(session);
    }
    clearCookie(res, this.config.webAuth, this.config.webAuth.sessionCookieName);
    res.status(204).end();
  }

  /**
   * Client ID metadata document (draft-ietf-oauth-client-id-metadata-document).
   * When Money is on public https, its client_id at Taico is this URL: Taico
   * fetches it, so there is nothing to register and no secret.
   */
  @Get('client-metadata.json')
  clientMetadata(@Res() res: Response): void {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      client_id: this.config.webAuth.clientMetadataUrl,
      client_name: 'Money',
      client_uri: this.config.webAuth.appUrl,
      redirect_uris: [this.config.webAuth.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  }
}
