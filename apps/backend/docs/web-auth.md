# Browser sign-in (web app authentication)

How the Money web app signs users in through Taico. The browser never holds a Taico token.
The Money backend is the OAuth client (a **backend-for-frontend**, BFF). The browser gets an
opaque, HttpOnly session cookie, and the backend keeps the tokens.

Bearer clients (MCP clients, scripts, automation) are unchanged. They still send
`Authorization: Bearer <Taico token>` to `/api` or `/mcp` with the same audience rules.

## What Taico supports (verified)

Checked against ai-monorepo `origin/main` (`00be0a8e`, 2026-10-21) and live discovery at
`https://taico.app`:

| Capability | Taico |
|---|---|
| Authorization servers | One per **registry entry** ("MCP server"): issuer `{TAICO_ISSUER}/mcp/{id}/0.0.0`, metadata at `{TAICO_ISSUER}/.well-known/oauth-authorization-server/mcp/{id}/0.0.0` |
| Grant | Authorization Code with **PKCE, S256 only**. `state` is echoed back. |
| Audience | `aud` = the registry entry's URL. It is never taken from the client. An RFC 8707 `resource` is optional, but if sent it must equal that URL. |
| Refresh | Yes. Refresh tokens are **rotated on every use**: the old one stops working. |
| Client authentication | `none` (public client) or `private_key_jwt`. Client ID metadata documents (CIMD) are supported over https from public addresses. Dynamic registration is supported. |
| Lifetimes (defaults) | Access token 1 h. Unfinished client registrations are pruned after 45 min (`MCP_CLIENT_PRUNE_RETENTION_HOURS`). |
| **Not supported** | OpenID Connect (no ID token, nonce or userinfo), token revocation, end-session / global logout |

Consequences for Money:

- **A separate Taico registry entry for the REST API is required.** The existing `money` entry's
  tokens carry `aud = …/mcp`. Money refuses those on `/api`, and that separation must stay. The
  browser flow uses an entry (default id `money-api`) whose URL is `$PUBLIC_BASE_URL/api`, so its
  tokens pass the existing `/api` audience check unchanged.
- There is no ID token. The identity is the validated **access token's** `(iss, sub)`, the same as for
  every other Money client. No nonce is used, because no OIDC flow is involved.
- Sign-out can only be **local**: see [Sign-out](#sign-out).

## Design

```
Browser ──(cookie)──► Money /auth/*  ──(PKCE code flow, refresh)──► Taico money-api AS
   │                     │
   └──(cookie + CSRF)──► Money /api ── SessionAuthMiddleware: session → access token → Authorization header
                                         └► AccessTokenGuard (JWT: signature, iss, exp, aud=/api) → MoneyUserGuard (iss, sub) → services
```

1. `GET /auth/login?returnTo=/accounts` creates a PKCE verifier and a `state`, stores the
   attempt server-side (`state` hashed, verifier encrypted), sets a short-lived `money_login`
   cookie that binds the attempt to this browser, and redirects to Taico's authorize endpoint
   with `client_id`, `redirect_uri`, `resource=$PUBLIC_BASE_URL/api` and S256 `code_challenge`.
   No `scope` is requested (see [Scopes](#scopes)).
2. The user signs in to Taico and approves. Taico redirects to `GET /auth/callback?code&state`.
3. The callback **consumes** the attempt named by the login cookie (single use). It checks
   `state` in constant time and checks the 10-minute deadline. It redeems the code with the
   verifier, then validates the access token with **the same `ResourceServer` the API uses**
   (signature, `iss`, `exp`, `aud` = `/api`). It provisions or loads the user from `(iss, sub)`,
   then opens a **new** session. Any session the browser already had is deleted (fixation
   protection). Finally it redirects to `WEB_APP_URL + returnTo`.
4. On each `/api` request carrying the session cookie and no `Authorization` header,
   `SessionAuthMiddleware`:
   - loads the session and enforces idle and absolute expiry;
   - requires `X-CSRF-Token` on unsafe methods;
   - refreshes the access token if it expires within 60 s;
   - sets `Authorization: Bearer <access token>`.

   The normal guards then run, so **JWT validation and user isolation are the same code path as
   for bearer clients**. The middleware never decides who the user is.

### Sessions and cookies

| | |
|---|---|
| Session cookie | `__Host-money_session` on https (`money_session` on plain-http dev). HttpOnly, SameSite=Lax, Path=/, host-only, Secure on https. Max-Age = absolute lifetime. |
| Login cookie | `__Host-money_login` / `money_login`, same flags, 10 min |
| Cookie value | 32 random bytes. The database stores only its SHA-256, so a leaked database does not yield usable cookies. |
| Tokens at rest | AES-256-GCM with `SESSION_ENCRYPTION_KEY`, with the row ID as associated data |
| Expiry | Idle `WEB_SESSION_IDLE_MINUTES` (default 12 h, extended at most every 5 min) and absolute `WEB_SESSION_MAX_HOURS` (default 7 days). A refused refresh also ends the session. |
| Renewal | Serialized per session: an in-process single flight plus `SELECT … FOR UPDATE` on the session row, because Taico rotates refresh tokens and a second concurrent refresh would kill the session. The refreshed token must validate for `/api` and carry the same `(iss, sub)`, otherwise the session ends. |
| Housekeeping | Expired attempts and sessions are deleted whenever a sign-in starts |
| Logging | Tokens, codes, verifiers, `state` and cookies are never logged. Auth responses send `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. |

### CSRF

- SameSite=Lax keeps the cookie off cross-site subresource requests and cross-site POSTs.
- A synchronizer token is also required. `GET /auth/session` returns `csrfToken`. Every
  non-GET/HEAD/OPTIONS `/api` request made with the cookie, and `POST /auth/logout`, must send it
  as `X-CSRF-Token`. Otherwise Money answers `403 csrf_failed`.
- Bearer requests don't need it, because the browser never attaches their credential on its own.
- The login callback is protected by `state` plus the browser-bound login cookie, so an attacker
  cannot sign a victim in with the attacker's code.

### Safe redirects

`returnTo` must be a relative path in the web app (`/accounts?tab=x`). Absolute URLs,
protocol-relative `//host`, backslashes and control characters fall back to `/`. The final
URL is `WEB_APP_URL + returnTo` and must keep `WEB_APP_URL`'s origin.

### Scopes

Money defines **no OAuth scopes** and enforces none. The web flow requests none. Taico grants
none for an entry without scopes. The live `money` MCP entry currently lists `notes:read` /
`notes:write`, which were borrowed from another app. Money does not use them, and the
`money-api` entry should not copy them. Authorization inside Money is per user (every query is
scoped to the token's user). If Money ever needs scopes (for example read-only automation), define
them in Money first, then register them on the Taico entries.

### Sign-out

`POST /auth/logout` deletes the Money session and clears the cookie (**local sign-out**).
Taico has no revocation or end-session endpoint, so:

- the user stays signed in to Taico. The next "Sign in" may complete without a password prompt,
  depending on Taico's own session;
- the discarded refresh token stays valid at Taico until it expires, but no copy remains in
  Money. It existed only encrypted in the deleted row.

A "sign out of Taico everywhere" option is not offered. Add it once Taico has an end-session
endpoint.

### Alternatives considered

| Option | Why not |
|---|---|
| SPA as a public OAuth client, tokens in browser memory or storage | Any XSS exfiltrates tokens. Refresh tokens in the browser are worse. The UI guidelines forbid tokens in web storage. |
| Reuse the `money` (MCP) entry's tokens on `/api` | Breaks the REST/MCP audience separation that the backend tests enforce |
| Make `/api` accept a Money-minted session JWT | Adds a second token issuer and validation path. The BFF reuses the existing JWT validation instead. |
| Stateless encrypted-cookie session (no table) | Can't be revoked on sign-out. Rotated refresh tokens would need cookie rewrites on concurrent requests (races). |
| Confidential client with `private_key_jwt` | Supported by Taico for CIMD clients only. PKCE plus server-side token storage already protect the code. Noted as possible hardening. |

## Contract for the web app

The UI must be served from the **same site** as the backend (the same origin, or behind a reverse
proxy that forwards `/api` and `/auth`). Cookies are host-only and there is no CORS.

| Request | Behaviour |
|---|---|
| `GET /auth/session` | Always 200. `{ "authenticated": false, "loginUrl": "/auth/login" }` or `{ "authenticated": true, "user": { "id", "displayName", "email" }, "csrfToken": "…", "expiresAt": "ISO" }`. Call it on app start. |
| Navigate to `/auth/login?returnTo=<path>` | Full-page navigation, not fetch. Ends back at `WEB_APP_URL + returnTo`. |
| `?authError=<code>` on return | `access_denied` (user declined), `login_expired` (no or expired attempt, or a reused callback), `invalid_request` (state mismatch, missing code), `sign_in_failed` (Taico refused the code, or the token failed validation), `auth_unavailable` (Taico unreachable). Show a message and offer "Sign in" again. Strip the parameter from the URL. |
| `/api/*` | Send with `credentials: 'same-origin'` (the default) and **no** Authorization header. Add `X-CSRF-Token: <csrfToken>` on POST/PUT/PATCH/DELETE. |
| `401 { error: { code: "session_expired" } }` | The session ended (expired, signed out or refresh refused). Send the user to `/auth/login?returnTo=<current path>`. |
| `403 { error: { code: "csrf_failed" } }` | Missing or stale CSRF token. Refetch `/auth/session` and retry once. |
| `503 { error: { code: "auth_unavailable" } }` | Taico unreachable while renewing. The session is kept, so retry later. |
| `POST /auth/logout` with `X-CSRF-Token` | 204, cookie cleared. Then show the signed-out state. |

Other `/api` errors keep the usual envelope (`docs/api.md`). With the generated client
(`docs/architecture/api-clients.md`), omit `getAccessToken` and add the CSRF header in the
app-level session module, never in feature code.

The `/auth/*` endpoints are part of the browser flow, not the REST resource. They are not in
the generated API client, and the session module calls them directly (navigation for login,
one small call each for session and logout).

## Configuration and setup

| Variable | Default | Meaning |
|---|---|---|
| `TAICO_WEB_SERVER_ID` | `money-api` | Taico registry entry for the REST API |
| `TAICO_WEB_AUTHORIZATION_SERVER` | `$TAICO_ISSUER/mcp/$TAICO_WEB_SERVER_ID/0.0.0` | Its issuer identifier. Metadata is read from the RFC 8414 well-known URL and must name this exact issuer and support S256. |
| `TAICO_WEB_CLIENT_ID` | `$PUBLIC_BASE_URL/auth/client-metadata.json` when `PUBLIC_BASE_URL` is https, else unset | Money's client_id at Taico |
| `WEB_APP_URL` | `$PUBLIC_BASE_URL` | Where the web app lives. Post-login redirects stay under it. |
| `SESSION_ENCRYPTION_KEY` | random per process outside production | 32 bytes, base64 (`openssl rand -base64 32`). **Required in production.** Rotating it ends all sessions. |
| `WEB_SESSION_IDLE_MINUTES` / `WEB_SESSION_MAX_HOURS` | `720` / `168` | Session expiry |

Redirect URI: `$PUBLIC_BASE_URL/auth/callback`.

### Taico-side prerequisites (one-time)

1. **Registry entry `money-api`**: an HTTP server whose URL is exactly `$PUBLIC_BASE_URL/api`
   (e.g. `https://money.example.com/api`), with no scopes and no downstream connections.
   Check it with `curl $TAICO_ISSUER/.well-known/oauth-authorization-server/mcp/money-api/0.0.0`.
   As of 2026-10-21 it **does not exist** on `https://taico.app` (404).
2. **Client identity**, either:
   - **Production (https, publicly reachable)**: nothing to register. Money serves its client ID
     metadata document at `$PUBLIC_BASE_URL/auth/client-metadata.json` and uses that URL as
     `client_id`. Taico fetches and caches it.
   - **Local development or non-public hosts**: register once with dynamic client registration:
     `npm -w @money/backend run auth:register-web-client` (uses the backend's environment), then
     set the printed `TAICO_WEB_CLIENT_ID`. **Complete one sign-in within 45 minutes**, otherwise
     Taico prunes the unused client and you need to register again.
3. `SESSION_ENCRYPTION_KEY` as a deployment secret.

### Local development

- Against a **local Taico** (`TAICO_ISSUER=http://localhost:3000`): create the `money-api` entry
  with URL `http://localhost:4180/api`, then register a client as above.
- Against **taico.app** from `http://localhost:4180`: the `money-api` entry's URL must be the URL
  Money calls itself (`PUBLIC_BASE_URL/api`). A production entry pointing at the production URL
  won't match a localhost backend, because Taico rejects the `resource` and tokens would have the
  wrong audience. Use a separate dev entry (for example `money-api-dev`, URL
  `http://localhost:4180/api`, `TAICO_WEB_SERVER_ID=money-api-dev`).
- A UI dev server on another port (for example Vite on 5173) should proxy `/api` and `/auth` to
  4180 and set `WEB_APP_URL=http://localhost:5173`. Cookies are per host, not per port, so the
  session works through the proxy.
- Without `SESSION_ENCRYPTION_KEY`, sessions end whenever the backend restarts.

## Tests

`src/web-auth.e2e.spec.ts` runs the real app against a **fake Taico authorization server**: an
in-process stand-in for discovery and the token endpoint that checks PKCE and mints tokens with
the test key. It covers:

- the authorize request parameters, the callback and cookie flags;
- invalid or forged `state`, a missing login cookie, a replayed callback, denied consent, a
  refused code;
- tokens with the wrong audience (MCP), wrong issuer, untrusted key or expiry being refused;
- open-redirect attempts;
- fixation (a new session ID), CSRF on unsafe methods and logout;
- cross-user isolation, bearer precedence, the cookie being refused on `/mcp`;
- idle expiry, a single refresh under concurrency with rotation, a refused refresh ending the
  session, an unreachable Taico keeping it (503), a refreshed token naming another user;
- tokens encrypted at rest.

`src/web-auth/web-auth.config.spec.ts` covers configuration, the cipher and discovery checks.
These are **mocked** tests. A live sign-in against Taico needs the prerequisites above and has not
been run yet.
