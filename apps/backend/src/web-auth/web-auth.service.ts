import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ResourceServer, TaicoClaims } from '@taico/auth';
import type { TokenSet } from '@taico/auth/client';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { UnitOfWork } from '../database/unit-of-work';
import { UsersService, type CurrentUser } from '../users/users.service';
import { UsersRepository } from '../users/users.repository';
import { randomSecret, safeEqual, sha256, TokenCipher } from './secrets';
import { TaicoAuthError, TaicoWebClient } from './taico-web-client';
import { WebSessionsRepository, type WebSessionRow } from './web-sessions.repository';

export const MONEY_RESOURCE_SERVER = Symbol('MONEY_RESOURCE_SERVER');

/** Refresh an access token this long before it expires */
const REFRESH_SKEW_MS = 60_000;
/** Write last-seen at most this often per session */
const TOUCH_INTERVAL_MS = 5 * 60_000;

/** Why a sign-in callback failed; sent to the web app as `?authError=` */
export type LoginErrorCode = 'access_denied' | 'invalid_request' | 'login_expired' | 'sign_in_failed' | 'auth_unavailable';

export class LoginError extends Error {
  constructor(
    readonly code: LoginErrorCode,
    message: string,
    readonly returnTo = '/',
  ) {
    super(message);
  }
}

/** Outcome of resolving a session cookie for an API request */
export type SessionAccess =
  | { status: 'ok'; session: WebSessionRow; accessToken: string }
  | { status: 'none' }
  | { status: 'unavailable' };

/**
 * Browser sign-in through Taico (backend-for-frontend). See docs/web-auth.md.
 *
 * Money is the OAuth client; the browser never sees a Taico token. A session
 * cookie maps to a server-side row holding encrypted tokens. Every API call
 * made with the cookie still goes through the same JWT validation as a bearer
 * client (the middleware hands the access token to AccessTokenGuard).
 */
@Injectable()
export class WebAuthService {
  private readonly logger = new Logger('WebAuth');
  private readonly cipher: TokenCipher;
  /** One refresh per session at a time in this process; the row lock covers other processes */
  private readonly refreshing = new Map<string, Promise<SessionAccess>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MONEY_RESOURCE_SERVER) private readonly resourceServer: ResourceServer,
    private readonly taico: TaicoWebClient,
    private readonly sessions: WebSessionsRepository,
    private readonly users: UsersService,
    private readonly usersRepository: UsersRepository,
    private readonly uow: UnitOfWork,
  ) {
    this.cipher = new TokenCipher(config.webAuth.encryptionKey);
  }

  /**
   * Starts a sign-in. Returns the Taico URL to redirect to and the value of
   * the login cookie that binds the callback to this browser.
   */
  async startLogin(returnTo: unknown): Promise<{ redirectUrl: string; loginCookie: string }> {
    const now = new Date();
    await this.sessions.deleteExpired(now);
    const request = await this.taico.authorizationRequest();
    const loginCookie = randomSecret();
    const id = sha256(loginCookie);
    await this.sessions.insertLoginAttempt({
      id,
      stateHash: sha256(request.state),
      codeVerifier: this.cipher.encrypt(request.codeVerifier, id),
      returnTo: this.safeReturnTo(returnTo),
      expiresAt: new Date(now.getTime() + this.config.webAuth.loginTimeoutSeconds * 1000),
    });
    return { redirectUrl: request.url, loginCookie };
  }

  /**
   * Completes a sign-in from Taico's redirect. Checks the login cookie and
   * `state`, redeems the code with the PKCE verifier, validates the access
   * token as Money's API would, and opens a new session.
   */
  async completeLogin(input: {
    loginCookie: string | undefined;
    previousSessionCookie: string | undefined;
    code: unknown;
    state: unknown;
    error: unknown;
  }): Promise<{ sessionCookie: string; returnTo: string; user: CurrentUser }> {
    if (!input.loginCookie) throw new LoginError('login_expired', 'No sign-in in progress in this browser');
    const attempt = await this.sessions.takeLoginAttempt(sha256(input.loginCookie));
    if (!attempt) throw new LoginError('login_expired', 'Sign-in not found or already used');
    const returnTo = attempt.returnTo;
    if (typeof input.state !== 'string' || !safeEqual(sha256(input.state), attempt.stateHash)) {
      throw new LoginError('invalid_request', 'State does not match the sign-in started in this browser', returnTo);
    }
    if (attempt.expiresAt.getTime() < Date.now()) throw new LoginError('login_expired', 'Sign-in took too long', returnTo);
    if (input.error !== undefined) {
      throw new LoginError(input.error === 'access_denied' ? 'access_denied' : 'sign_in_failed', `Taico returned an error: ${String(input.error).slice(0, 100)}`, returnTo);
    }
    if (typeof input.code !== 'string' || input.code.length === 0 || input.code.length > 2048) {
      throw new LoginError('invalid_request', 'Missing authorization code', returnTo);
    }

    let tokens: TokenSet;
    try {
      tokens = await this.taico.exchangeCode(input.code, this.cipher.decrypt(attempt.codeVerifier, attempt.id));
    } catch (error) {
      throw this.loginErrorFrom(error, returnTo);
    }
    const user = await this.userForToken(tokens.accessToken).catch((error: unknown) => {
      this.logger.warn(`Sign-in refused: Taico access token failed validation (${error instanceof Error ? error.message : String(error)})`);
      throw new LoginError('sign_in_failed', 'Taico issued a token Money does not accept', returnTo);
    });

    // A fresh session ID on every sign-in (no fixation); any session this browser had ends
    if (input.previousSessionCookie) await this.sessions.deleteSession(sha256(input.previousSessionCookie));
    const sessionCookie = randomSecret();
    const id = sha256(sessionCookie);
    const now = Date.now();
    await this.sessions.insertSession({
      id,
      userId: user.id,
      csrfToken: randomSecret(),
      ...this.encryptTokens(id, tokens),
      idleExpiresAt: new Date(now + this.config.webAuth.idleTimeoutMinutes * 60_000),
      expiresAt: new Date(now + this.config.webAuth.absoluteTimeoutHours * 3_600_000),
    });
    this.logger.log(`Signed in user ${user.id}`);
    return { sessionCookie, returnTo, user };
  }

  /** The session behind a cookie, if live. Extends its idle timeout. */
  async findSession(sessionCookie: string | undefined): Promise<WebSessionRow | null> {
    if (!sessionCookie) return null;
    const session = await this.sessions.findSession(sha256(sessionCookie));
    if (!session) return null;
    const now = Date.now();
    if (session.expiresAt.getTime() <= now || session.idleExpiresAt.getTime() <= now) {
      await this.sessions.deleteSession(session.id);
      return null;
    }
    if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const idleExpiresAt = new Date(Math.min(now + this.config.webAuth.idleTimeoutMinutes * 60_000, session.expiresAt.getTime()));
      await this.sessions.touch(session.id, new Date(now), idleExpiresAt);
      session.idleExpiresAt = idleExpiresAt;
    }
    return session;
  }

  /** The user a session belongs to, as shown by GET /auth/session */
  async sessionUser(session: WebSessionRow): Promise<{ id: string; displayName: string | null; email: string | null } | null> {
    const user = await this.usersRepository.findById(session.userId);
    return user ? { id: user.id, displayName: user.displayName, email: user.email } : null;
  }

  /**
   * A valid access token for an API call made with the session cookie,
   * refreshing it first when it is about to expire. A refused refresh ends
   * the session; an unreachable Taico leaves it for a retry.
   */
  async accessFor(session: WebSessionRow): Promise<SessionAccess> {
    if (session.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) {
      return { status: 'ok', session, accessToken: this.cipher.decrypt(session.accessToken, session.id) };
    }
    let pending = this.refreshing.get(session.id);
    if (!pending) {
      pending = this.refresh(session.id).finally(() => this.refreshing.delete(session.id));
      this.refreshing.set(session.id, pending);
    }
    return pending;
  }

  /** CSRF check for unsafe requests made with the session cookie */
  csrfMatches(session: WebSessionRow, header: unknown): boolean {
    return typeof header === 'string' && safeEqual(header, session.csrfToken);
  }

  /**
   * Ends a session (local sign-out). Taico offers no revocation or end-session
   * endpoint, so the Taico sign-in itself stays; the refresh token is dropped.
   */
  async logout(session: WebSessionRow): Promise<void> {
    await this.sessions.deleteSession(session.id);
    this.logger.log(`Signed out user ${session.userId}`);
  }

  /** Builds the absolute URL to send the browser to after sign-in */
  appRedirect(returnTo: string, error?: LoginErrorCode): string {
    const url = new URL(this.config.webAuth.appUrl + this.safeReturnTo(returnTo));
    if (error) url.searchParams.set('authError', error);
    return url.toString();
  }

  /**
   * Only same-app relative paths: "/accounts?x=1". Rejects absolute and
   * protocol-relative URLs, backslashes and control characters, so a sign-in
   * link cannot be used as an open redirect.
   */
  safeReturnTo(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return '/';
    if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
    const base = new URL(this.config.webAuth.appUrl + '/');
    const resolved = new URL(this.config.webAuth.appUrl + value);
    if (resolved.origin !== base.origin) return '/';
    return value;
  }

  private async refresh(sessionId: string): Promise<SessionAccess> {
    let rejected = false;
    const result = await this.uow.run(async (manager): Promise<SessionAccess> => {
      const session = await this.sessions.findSession(sessionId, manager, true);
      if (!session) return { status: 'none' };
      // Another request or process refreshed it while this one waited for the lock
      if (session.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) {
        return { status: 'ok', session, accessToken: this.cipher.decrypt(session.accessToken, session.id) };
      }
      if (!session.refreshToken) {
        rejected = true;
        return { status: 'none' };
      }
      let tokens: TokenSet;
      try {
        tokens = await this.taico.refresh(this.cipher.decrypt(session.refreshToken, session.id), session.scope);
      } catch (error) {
        if (error instanceof TaicoAuthError && error.kind === 'rejected') {
          this.logger.log(`Session of user ${session.userId} ended: Taico refused the refresh token`);
          rejected = true;
          return { status: 'none' };
        }
        this.logger.warn(`Token refresh failed, session kept: ${error instanceof Error ? error.message : String(error)}`);
        return { status: 'unavailable' };
      }
      // The refreshed token must still be for this API and this same user. Checked
      // without the users table: this transaction may hold the only connection.
      const auth = await this.resourceServer.authenticateToken(tokens.accessToken, this.config.auth.apiResourceUrl).catch(() => null);
      if (!auth || auth.claims.iss !== session.userIssuer || auth.subject !== session.userSubject) {
        this.logger.warn(`Session of user ${session.userId} ended: refreshed token failed validation or named another user`);
        rejected = true;
        return { status: 'none' };
      }
      const encrypted = this.encryptTokens(session.id, tokens);
      await this.sessions.updateTokens(manager, session.id, encrypted);
      return { status: 'ok', session: { ...session, ...encrypted }, accessToken: tokens.accessToken };
    });
    if (rejected) await this.sessions.deleteSession(sessionId);
    return result;
  }

  /** Validates a Taico access token exactly as the REST API does, and maps it to the Money user */
  private async userForToken(accessToken: string): Promise<CurrentUser> {
    const auth = await this.resourceServer.authenticateToken<Partial<TaicoClaims>>(accessToken, this.config.auth.apiResourceUrl);
    return this.users.resolve(auth);
  }

  private encryptTokens(id: string, tokens: TokenSet) {
    return {
      accessToken: this.cipher.encrypt(tokens.accessToken, id),
      refreshToken: tokens.refreshToken ? this.cipher.encrypt(tokens.refreshToken, id) : null,
      accessTokenExpiresAt: new Date(tokens.expiresAt),
      scope: tokens.scope,
    };
  }

  private loginErrorFrom(error: unknown, returnTo: string): LoginError {
    if (error instanceof TaicoAuthError) {
      this.logger.warn(`Sign-in failed: ${error.message}`);
      return new LoginError(error.kind === 'rejected' ? 'sign_in_failed' : 'auth_unavailable', error.message, returnTo);
    }
    this.logger.error(`Sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    return new LoginError('sign_in_failed', 'Sign-in failed', returnTo);
  }
}
