import { loadConfig } from '../config/env.config';
import { TokenCipher } from './secrets';
import { TaicoAuthError, TaicoWebClient } from './taico-web-client';

const key = Buffer.alloc(32, 7).toString('base64');

describe('web auth configuration', () => {
  it('on https uses the client metadata document as client_id and __Host- Secure cookies', () => {
    const config = loadConfig({ PUBLIC_BASE_URL: 'https://money.example', TAICO_ISSUER: 'https://taico.app', SESSION_ENCRYPTION_KEY: key } as NodeJS.ProcessEnv);
    expect(config.webAuth).toMatchObject({
      clientId: 'https://money.example/auth/client-metadata.json',
      authorizationServer: 'https://taico.app/mcp/money-api/0.0.0',
      redirectUri: 'https://money.example/auth/callback',
      appUrl: 'https://money.example',
      secureCookies: true,
      sessionCookieName: '__Host-money_session',
      encryptionKeyEphemeral: false,
    });
  });

  it('on plain http has no client_id unless TAICO_WEB_CLIENT_ID is set, and uses an ephemeral key in development', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.webAuth.clientId).toBeNull();
    expect(config.webAuth.secureCookies).toBe(false);
    expect(config.webAuth.encryptionKeyEphemeral).toBe(true);
    expect(loadConfig({ TAICO_WEB_CLIENT_ID: 'abc' } as NodeJS.ProcessEnv).webAuth.clientId).toBe('abc');
  });

  it('requires a 32-byte SESSION_ENCRYPTION_KEY in production', () => {
    const production = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', TAICO_ISSUER: 'https://taico.app' };
    expect(() => loadConfig(production as NodeJS.ProcessEnv)).toThrow(/SESSION_ENCRYPTION_KEY is required/);
    expect(() => loadConfig({ ...production, SESSION_ENCRYPTION_KEY: 'c2hvcnQ=' } as NodeJS.ProcessEnv)).toThrow(/32 bytes/);
    expect(loadConfig({ ...production, SESSION_ENCRYPTION_KEY: key } as NodeJS.ProcessEnv).webAuth.encryptionKeyEphemeral).toBe(false);
  });
});

describe('TokenCipher', () => {
  const cipher = new TokenCipher(Buffer.alloc(32, 1));

  it('round-trips and binds ciphertext to its row', () => {
    const encrypted = cipher.encrypt('secret-token', 'row-1');
    expect(encrypted).not.toContain('secret-token');
    expect(cipher.decrypt(encrypted, 'row-1')).toBe('secret-token');
    expect(() => cipher.decrypt(encrypted, 'row-2')).toThrow();
    expect(() => new TokenCipher(Buffer.alloc(32, 2)).decrypt(encrypted, 'row-1')).toThrow();
  });
});

describe('TaicoWebClient', () => {
  const config = loadConfig({ TAICO_ISSUER: 'https://taico.test', TAICO_WEB_CLIENT_ID: 'cid' } as NodeJS.ProcessEnv);
  const metadata = (overrides: Record<string, unknown>) =>
    (async () =>
      new Response(
        JSON.stringify({
          issuer: 'https://taico.test/mcp/money-api/0.0.0',
          authorization_endpoint: 'https://taico.test/authorize',
          token_endpoint: 'https://taico.test/token',
          code_challenge_methods_supported: ['S256'],
          ...overrides,
        }),
        { status: 200 },
      )) as typeof fetch;

  it('refuses metadata naming another issuer', async () => {
    const client = new TaicoWebClient(config, metadata({ issuer: 'https://evil.test' }));
    await expect(client.authorizationRequest()).rejects.toMatchObject({ kind: 'unavailable', message: expect.stringMatching(/does not match/) });
  });

  it('refuses a server without PKCE S256', async () => {
    const client = new TaicoWebClient(config, metadata({ code_challenge_methods_supported: ['plain'] }));
    await expect(client.authorizationRequest()).rejects.toBeInstanceOf(TaicoAuthError);
  });

  it('reports a missing client_id as not configured', async () => {
    const client = new TaicoWebClient(loadConfig({} as NodeJS.ProcessEnv), metadata({}));
    await expect(client.authorizationRequest()).rejects.toMatchObject({ kind: 'not_configured' });
  });
});
