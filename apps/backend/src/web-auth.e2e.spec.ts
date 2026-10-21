import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { createTestApp, ISSUER, type TestApp, type TokenOptions } from './test-support/test-app';

/*
 * Browser sign-in (docs/web-auth.md) against a FAKE Taico authorization
 * server: an in-process stand-in for discovery and the token endpoint, which
 * mints tokens with the test signing key. This exercises Money's side of the
 * flow end to end; it is not a live Taico integration test.
 */

const AS_ISSUER = `${ISSUER}/mcp/money-api/0.0.0`;
const AUTHORIZE = `${ISSUER}/api/v1/auth/authorize/mcp/money-api/0.0.0`;
const TOKEN = `${ISSUER}/api/v1/auth/token/mcp/money-api/0.0.0`;

type PendingAuthorization = { clientId: string; redirectUri: string; challenge: string; resource: string | null; subject: string };

class FakeTaico {
  sign!: (options: TokenOptions) => Promise<string>;
  /** Authorization codes waiting to be redeemed */
  codes = new Map<string, PendingAuthorization>();
  /** Live refresh tokens (rotated on use) */
  refreshTokens = new Map<string, { subject: string }>();
  tokenRequests: URLSearchParams[] = [];
  /** What the next tokens look like */
  accessTokenLifetime = 3600;
  tokenOverrides: TokenOptions = {};
  down = false;
  refreshDelayMs = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (this.down) throw new TypeError('fetch failed');
    if (url === `${ISSUER}/.well-known/oauth-authorization-server/mcp/money-api/0.0.0`) {
      return json(200, {
        issuer: AS_ISSUER,
        authorization_endpoint: AUTHORIZE,
        token_endpoint: TOKEN,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url === TOKEN && init?.method === 'POST') {
      const body = new URLSearchParams(String(init.body));
      this.tokenRequests.push(body);
      return this.token(body);
    }
    return json(404, { error: 'not_found' });
  };

  /** What Taico does when the user approves: issue a code for the authorization request URL */
  approve(authorizeUrl: string, subject = 'user-a'): { code: string; state: string } {
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE);
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('code_challenge_method')).toBe('S256');
    const code = randomUUID();
    this.codes.set(code, { clientId: p.get('client_id')!, redirectUri: p.get('redirect_uri')!, challenge: p.get('code_challenge')!, resource: p.get('resource'), subject });
    return { code, state: p.get('state')! };
  }

  private async token(body: URLSearchParams): Promise<Response> {
    if (body.get('grant_type') === 'authorization_code') {
      const pending = this.codes.get(body.get('code') ?? '');
      this.codes.delete(body.get('code') ?? '');
      if (!pending) return json(400, { error: 'invalid_grant' });
      const challenge = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== pending.challenge || body.get('redirect_uri') !== pending.redirectUri || body.get('client_id') !== pending.clientId) {
        return json(400, { error: 'invalid_grant' });
      }
      return this.issue(pending.subject);
    }
    if (body.get('grant_type') === 'refresh_token') {
      if (this.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, this.refreshDelayMs));
      const grant = this.refreshTokens.get(body.get('refresh_token') ?? '');
      if (!grant) return json(400, { error: 'invalid_grant' });
      this.refreshTokens.delete(body.get('refresh_token')!);
      return this.issue(grant.subject);
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  private async issue(subject: string): Promise<Response> {
    const refreshToken = randomUUID();
    this.refreshTokens.set(refreshToken, { subject });
    const accessToken = await this.sign({ subject, expiresInSeconds: this.accessTokenLifetime, ...this.tokenOverrides });
    return json(200, { access_token: accessToken, token_type: 'Bearer', expires_in: this.accessTokenLifetime, refresh_token: refreshToken, scope: '' });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** name=value pairs from Set-Cookie headers */
function cookiesFrom(setCookie: string[] | string | undefined): Record<string, { value: string; raw: string }> {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return Object.fromEntries(
    list.map((raw) => {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      return [pair.slice(0, index), { value: decodeURIComponent(pair.slice(index + 1)), raw }];
    }),
  );
}

describe('browser sign-in (fake Taico)', () => {
  let t: TestApp;
  const taico = new FakeTaico();

  beforeAll(async () => {
    t = await createTestApp({ webAuthFetch: taico.fetch, env: { WEB_APP_URL: 'http://app.test/money' } });
    taico.sign = (options) => t.token(options);
  });
  afterAll(() => t.close());
  beforeEach(() => {
    taico.accessTokenLifetime = 3600;
    taico.tokenOverrides = {};
    taico.down = false;
    taico.refreshDelayMs = 0;
  });

  /** Starts a sign-in; returns the Taico URL and the login cookie */
  async function startLogin(returnTo?: string) {
    const response = await t.http.get('/auth/login').query(returnTo === undefined ? {} : { returnTo }).expect(302);
    const login = cookiesFrom(response.headers['set-cookie'])['money_login'];
    return { location: response.headers.location as string, login, response };
  }

  /** A full sign-in; returns the session cookie value */
  async function signIn(subject = 'user-a', returnTo = '/accounts'): Promise<string> {
    const { location, login } = await startLogin(returnTo);
    const { code, state } = taico.approve(location, subject);
    const callback = await t.http.get('/auth/callback').query({ code, state }).set('Cookie', `money_login=${login.value}`).expect(302);
    expect(callback.headers.location).toBe(`http://app.test/money${returnTo}`);
    const session = cookiesFrom(callback.headers['set-cookie'])['money_session'];
    expect(session).toBeDefined();
    return session.value;
  }

  const withSession = (cookie: string) => ({
    get: (url: string) => t.http.get(url).set('Cookie', `money_session=${cookie}`),
    post: (url: string, body: object, csrf?: string) => {
      const request = t.http.post(url).set('Cookie', `money_session=${cookie}`);
      return (csrf ? request.set('X-CSRF-Token', csrf) : request).send(body);
    },
  });

  async function csrfOf(cookie: string): Promise<string> {
    const response = await withSession(cookie).get('/auth/session').expect(200);
    return response.body.csrfToken;
  }

  describe('starting sign-in', () => {
    it('redirects to Taico with PKCE S256, state, Money client_id, callback and the REST API resource', async () => {
      const { location, login, response } = await startLogin('/accounts');
      const url = new URL(location);
      expect(url.searchParams.get('client_id')).toBe('money-web-test');
      expect(url.searchParams.get('redirect_uri')).toBe('http://money.test/auth/callback');
      expect(url.searchParams.get('resource')).toBe('http://money.test/api');
      expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.has('scope')).toBe(false);
      expect(login.raw).toMatch(/HttpOnly/);
      expect(login.raw).toMatch(/SameSite=Lax/);
      expect(login.raw).toMatch(/Path=\//);
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('serves a client ID metadata document for Taico', async () => {
      const response = await t.http.get('/auth/client-metadata.json').expect(200);
      expect(response.body).toEqual({
        client_id: 'http://money.test/auth/client-metadata.json',
        client_name: 'Money',
        client_uri: 'http://app.test/money',
        redirect_uris: ['http://money.test/auth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    });
  });

  describe('callback', () => {
    it('opens a session and the cookie works on the REST API, as the token user', async () => {
      const cookie = await signIn('user-a');
      const session = await withSession(cookie).get('/auth/session').expect(200);
      expect(session.body).toMatchObject({ authenticated: true, user: { id: expect.any(String) }, csrfToken: expect.any(String), expiresAt: expect.any(String) });
      const me = await withSession(cookie).get('/api/me').expect(200);
      expect(me.body).toMatchObject({ issuer: ISSUER, subject: 'user-a', id: session.body.user.id });
      // The code was redeemed with the verifier, at the resource Money asked for
      const exchange = taico.tokenRequests.at(-1)!;
      expect(exchange.get('grant_type')).toBe('authorization_code');
      expect(exchange.get('resource')).toBe('http://money.test/api');
    });

    it('keeps tokens out of the browser and encrypts them at rest', async () => {
      const cookie = await signIn('user-a');
      const session = await withSession(cookie).get('/auth/session').expect(200);
      expect(JSON.stringify(session.body)).not.toMatch(/eyJ/);
      const rows = await t.app.get(DataSource).query(`SELECT "id", "access_token", "refresh_token" FROM "web_sessions"`);
      for (const row of rows) {
        expect(row.id).not.toBe(cookie);
        expect(row.access_token).toMatch(/^v1\./);
        expect(row.access_token).not.toMatch(/eyJ/);
        expect(row.refresh_token).toMatch(/^v1\./);
      }
    });

    it('sets a HttpOnly, SameSite=Lax session cookie and clears the login cookie', async () => {
      const { location, login } = await startLogin('/');
      const { code, state } = taico.approve(location);
      const callback = await t.http.get('/auth/callback').query({ code, state }).set('Cookie', `money_login=${login.value}`).expect(302);
      const cookies = cookiesFrom(callback.headers['set-cookie']);
      expect(cookies['money_session'].raw).toMatch(/HttpOnly/);
      expect(cookies['money_session'].raw).toMatch(/SameSite=Lax/);
      expect(cookies['money_login'].value).toBe('');
    });

    it('refuses a state that does not match, and the attempt cannot be retried', async () => {
      const { location, login } = await startLogin('/accounts');
      const { code, state } = taico.approve(location);
      const wrong = await t.http.get('/auth/callback').query({ code, state: 'forged' }).set('Cookie', `money_login=${login.value}`).expect(302);
      expect(wrong.headers.location).toBe('http://app.test/money/accounts?authError=invalid_request');
      expect(cookiesFrom(wrong.headers['set-cookie'])['money_session']).toBeUndefined();
      const replay = await t.http.get('/auth/callback').query({ code, state }).set('Cookie', `money_login=${login.value}`).expect(302);
      expect(replay.headers.location).toBe('http://app.test/money/?authError=login_expired');
    });

    it('refuses a callback from a browser that did not start the sign-in (no login cookie)', async () => {
      const { location } = await startLogin();
      const { code, state } = taico.approve(location);
      const response = await t.http.get('/auth/callback').query({ code, state }).expect(302);
      expect(response.headers.location).toBe('http://app.test/money/?authError=login_expired');
    });

    it('reports a denied consent', async () => {
      const { location, login } = await startLogin('/x');
      const state = new URL(location).searchParams.get('state')!;
      const response = await t.http.get('/auth/callback').query({ error: 'access_denied', state }).set('Cookie', `money_login=${login.value}`).expect(302);
      expect(response.headers.location).toBe('http://app.test/money/x?authError=access_denied');
    });

    it('refuses a code Taico does not redeem (wrong verifier / replayed code)', async () => {
      const { location, login } = await startLogin();
      const { state } = taico.approve(location);
      const response = await t.http.get('/auth/callback').query({ code: 'not-a-code', state }).set('Cookie', `money_login=${login.value}`).expect(302);
      expect(response.headers.location).toBe('http://app.test/money/?authError=sign_in_failed');
    });

    it.each([
      ['a token for the MCP audience', { audience: 'http://money.test/mcp' }],
      ['a token from another issuer', { issuer: 'https://evil.test' }],
      ['a token signed by an untrusted key', { foreignKey: true }],
      ['an expired token', { expiresInSeconds: -120 }],
    ])('refuses %s, without opening a session', async (_label, overrides) => {
      taico.tokenOverrides = overrides;
      const { location, login } = await startLogin();
      const { code, state } = taico.approve(location);
      const response = await t.http.get('/auth/callback').query({ code, state }).set('Cookie', `money_login=${login.value}`).expect(302);
      expect(response.headers.location).toBe('http://app.test/money/?authError=sign_in_failed');
      expect(cookiesFrom(response.headers['set-cookie'])['money_session']).toBeUndefined();
    });

    it.each(['//evil.test/x', 'https://evil.test', '/\\evil.test', 'accounts', '/%0d%0aSet-Cookie:x', '/a\tb'])('does not redirect off the app for returnTo %p', async (returnTo) => {
      const { location, login } = await startLogin(returnTo);
      const { code, state } = taico.approve(location);
      const response = await t.http.get('/auth/callback').query({ code, state }).set('Cookie', `money_login=${login.value}`).expect(302);
      expect(response.headers.location.startsWith('http://app.test/money/')).toBe(true);
      expect(new URL(response.headers.location).origin).toBe('http://app.test');
    });

    it('starts a fresh session on sign-in: the cookie the browser had before stops working', async () => {
      const before = await signIn('user-a');
      const { location, login } = await startLogin('/');
      const { code, state } = taico.approve(location);
      const callback = await t.http
        .get('/auth/callback')
        .query({ code, state })
        .set('Cookie', `money_login=${login.value}; money_session=${before}`)
        .expect(302);
      const after = cookiesFrom(callback.headers['set-cookie'])['money_session'].value;
      expect(after).not.toBe(before);
      await withSession(before).get('/api/me').expect(401);
      await withSession(after).get('/api/me').expect(200);
    });
  });

  describe('API calls with the session cookie', () => {
    it('requires the CSRF token on unsafe methods', async () => {
      const cookie = await signIn('user-a');
      const refused = await withSession(cookie).post('/api/accounts', { name: 'No CSRF' }).expect(403);
      expect(refused.body.error.code).toBe('csrf_failed');
      await withSession(cookie).post('/api/accounts', { name: 'Wrong CSRF' }, 'nope').expect(403);
      await withSession(cookie).post('/api/accounts', { name: 'With CSRF' }, await csrfOf(cookie)).expect(201);
    });

    it("keeps users apart: one session cannot see another user's account", async () => {
      const a = await signIn('iso-a');
      const b = await signIn('iso-b');
      const created = await withSession(a).post('/api/accounts', { name: 'Private' }, await csrfOf(a)).expect(201);
      await withSession(b).get(`/api/accounts/${created.body.id}`).expect(404);
      const list = await withSession(b).get('/api/accounts').expect(200);
      expect(list.body.map((x: { id: string }) => x.id)).not.toContain(created.body.id);
    });

    it('lets an explicit bearer token win over the cookie', async () => {
      const cookie = await signIn('user-a');
      const bearer = await t.token({ subject: 'bearer-user' });
      const me = await t.http.get('/api/me').set('Cookie', `money_session=${cookie}`).set('Authorization', `Bearer ${bearer}`).expect(200);
      expect(me.body.subject).toBe('bearer-user');
    });

    it('does not accept the cookie on /mcp', async () => {
      const cookie = await signIn('user-a');
      await t.http
        .post('/mcp')
        .set('Cookie', `money_session=${cookie}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(401);
    });

    it('answers 401 session_expired for an unknown cookie and clears it', async () => {
      const response = await withSession('made-up').get('/api/me').expect(401);
      expect(response.body.error.code).toBe('session_expired');
      expect(cookiesFrom(response.headers['set-cookie'])['money_session'].value).toBe('');
    });

    it('ends sessions past their expiry', async () => {
      const cookie = await signIn('user-a');
      await t.app.get(DataSource).query(`UPDATE "web_sessions" SET "idle_expires_at" = now() - interval '1 minute'`);
      await withSession(cookie).get('/api/me').expect(401);
      const session = await withSession(cookie).get('/auth/session').expect(200);
      expect(session.body).toEqual({ authenticated: false, loginUrl: '/auth/login' });
    });
  });

  describe('token renewal', () => {
    it('refreshes an expiring access token once, even for concurrent requests, and keeps the rotated refresh token', async () => {
      taico.accessTokenLifetime = 30; // inside the 60 s refresh window
      const cookie = await signIn('refresh-user');
      taico.accessTokenLifetime = 3600;
      taico.refreshDelayMs = 50;
      const before = taico.tokenRequests.length;
      const results = await Promise.all([withSession(cookie).get('/api/me'), withSession(cookie).get('/api/me'), withSession(cookie).get('/api/accounts')]);
      for (const result of results) expect(result.status).toBe(200);
      const refreshes = taico.tokenRequests.slice(before).filter((body) => body.get('grant_type') === 'refresh_token');
      expect(refreshes).toHaveLength(1);
      // The rotated refresh token is the one kept: the next renewal uses it successfully
      await t.app.get(DataSource).query(`UPDATE "web_sessions" SET "access_token_expires_at" = now()`);
      await withSession(cookie).get('/api/me').expect(200);
    });

    it('ends the session when Taico refuses the refresh token', async () => {
      const cookie = await signIn('revoked-user');
      taico.refreshTokens.clear();
      await t.app.get(DataSource).query(`UPDATE "web_sessions" SET "access_token_expires_at" = now()`);
      const response = await withSession(cookie).get('/api/me').expect(401);
      expect(response.body.error.code).toBe('session_expired');
      expect((await withSession(cookie).get('/auth/session')).body.authenticated).toBe(false);
    });

    it('keeps the session and answers 503 while Taico is unreachable', async () => {
      const cookie = await signIn('offline-user');
      await t.app.get(DataSource).query(`UPDATE "web_sessions" SET "access_token_expires_at" = now()`);
      taico.down = true;
      const response = await withSession(cookie).get('/api/me').expect(503);
      expect(response.body.error.code).toBe('auth_unavailable');
      taico.down = false;
      await withSession(cookie).get('/api/me').expect(200);
    });

    it('ends the session when a refreshed token names another user', async () => {
      const cookie = await signIn('switch-user');
      await t.app.get(DataSource).query(`UPDATE "web_sessions" SET "access_token_expires_at" = now()`);
      taico.tokenOverrides = { subject: 'someone-else' };
      await withSession(cookie).get('/api/me').expect(401);
    });
  });

  describe('sign-out', () => {
    it('needs the CSRF token, then ends the session and clears the cookie', async () => {
      const cookie = await signIn('user-a');
      await t.http.post('/auth/logout').set('Cookie', `money_session=${cookie}`).expect(403);
      const csrf = await csrfOf(cookie);
      const response = await t.http.post('/auth/logout').set('Cookie', `money_session=${cookie}`).set('X-CSRF-Token', csrf).expect(204);
      expect(cookiesFrom(response.headers['set-cookie'])['money_session'].value).toBe('');
      await withSession(cookie).get('/api/me').expect(401);
    });

    it('is harmless without a session', async () => {
      await t.http.post('/auth/logout').expect(204);
    });
  });

  it('reports an unreachable Taico when starting sign-in', async () => {
    taico.down = true;
    const fresh = await createTestApp({ webAuthFetch: taico.fetch });
    try {
      const response = await fresh.http.get('/auth/login').expect(502);
      expect(response.body.error.code).toBe('auth_unavailable');
    } finally {
      await fresh.close();
    }
  });
});
