import { OAuthClient, OAuthClientError, type ServerMetadata, type TokenSet } from '@taico/auth/client';
import type { AppConfig } from '../config/env.config';

export const WEB_AUTH_FETCH = Symbol('WEB_AUTH_FETCH');

/** Why a call to Taico failed, in terms the session layer acts on */
export class TaicoAuthError extends Error {
  constructor(
    message: string,
    /** `rejected`: Taico refused the grant (sign in again). `unavailable`: Taico could not be reached or misbehaved (retry later). `not_configured`: Money lacks a client_id. */
    readonly kind: 'rejected' | 'unavailable' | 'not_configured',
  ) {
    super(message);
    this.name = 'TaicoAuthError';
  }
}

type TaicoMetadata = ServerMetadata & { code_challenge_methods_supported?: string[] };

/**
 * Money's OAuth client for browser sign-in at Taico: Authorization Code with
 * PKCE (S256) against the authorization server of the `money-api` registry
 * entry, asking for tokens for Money's REST API (RFC 8707 `resource`).
 *
 * Taico rotates refresh tokens on every use; callers serialize refreshes.
 * Nothing here logs tokens, codes, verifiers or state.
 */
export class TaicoWebClient {
  private client: Promise<OAuthClient> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return this.config.webAuth.clientId !== null;
  }

  async authorizationRequest(): Promise<{ url: string; state: string; codeVerifier: string }> {
    const client = await this.oauthClient();
    return client.createAuthorizationRequest({
      redirectUri: this.config.webAuth.redirectUri,
      resource: this.config.auth.apiResourceUrl,
    });
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
    const client = await this.oauthClient();
    return this.call(() =>
      client.exchangeCode({ code, codeVerifier, redirectUri: this.config.webAuth.redirectUri, resource: this.config.auth.apiResourceUrl }),
    );
  }

  async refresh(refreshToken: string, scope: string): Promise<TokenSet> {
    const client = await this.oauthClient();
    return this.call(() => client.refresh({ refreshToken, scope }));
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof OAuthClientError) {
        // 400/401/403 from the token endpoint: the code or refresh token is no good
        throw new TaicoAuthError(`Taico token endpoint answered HTTP ${error.status}${error.error ? ` (${error.error})` : ''}`, error.isAuthFailure ? 'rejected' : 'unavailable');
      }
      throw new TaicoAuthError(`Taico token endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`, 'unavailable');
    }
  }

  /** Discovers and checks the authorization server once; retried after a failure */
  private oauthClient(): Promise<OAuthClient> {
    const clientId = this.config.webAuth.clientId;
    if (!clientId) {
      return Promise.reject(
        new TaicoAuthError('Browser sign-in is not configured: set TAICO_WEB_CLIENT_ID, or serve Money over https so Taico can read its client metadata document', 'not_configured'),
      );
    }
    this.client ??= this.discover().then((metadata) => new OAuthClient({ issuer: metadata.issuer, metadata, clientId, fetch: this.fetchImpl }));
    this.client.catch(() => {
      this.client = null;
    });
    return this.client;
  }

  private async discover(): Promise<TaicoMetadata> {
    const issuer = new URL(this.config.webAuth.authorizationServer);
    const path = issuer.pathname === '/' ? '' : issuer.pathname.replace(/\/$/, '');
    const url = `${issuer.origin}/.well-known/oauth-authorization-server${path}`;
    let metadata: TaicoMetadata;
    try {
      const response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      metadata = (await response.json()) as TaicoMetadata;
    } catch (error) {
      throw new TaicoAuthError(`Taico discovery failed at ${url}: ${error instanceof Error ? error.message : String(error)}`, 'unavailable');
    }
    // RFC 8414 section 3.3: the metadata must name the issuer it was fetched for
    if (metadata.issuer !== this.config.webAuth.authorizationServer) {
      throw new TaicoAuthError(`Taico metadata issuer ${metadata.issuer} does not match ${this.config.webAuth.authorizationServer}`, 'unavailable');
    }
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
      throw new TaicoAuthError('Taico metadata lacks authorization or token endpoint', 'unavailable');
    }
    if (!metadata.code_challenge_methods_supported?.includes('S256')) {
      throw new TaicoAuthError('Taico does not advertise PKCE S256', 'unavailable');
    }
    return metadata;
  }
}
