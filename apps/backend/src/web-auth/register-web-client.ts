import { OAuthClient } from '@taico/auth/client';
import { loadConfig } from '../config/env.config';

/**
 * Registers Money's browser sign-in as a public OAuth client at Taico
 * (dynamic client registration) and prints the client_id to put in
 * TAICO_WEB_CLIENT_ID. For local development, where Taico cannot fetch
 * Money's client metadata document. See docs/web-auth.md.
 *
 *   npm -w @money/backend run auth:register-web-client
 *
 * Uses the same environment as the backend (TAICO_ISSUER, PUBLIC_BASE_URL,
 * PORT, TAICO_WEB_SERVER_ID). Taico prunes a registered client whose first
 * sign-in is not completed within MCP_CLIENT_PRUNE_RETENTION_HOURS (45 minutes
 * by default), so sign in once soon after registering.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const client = new OAuthClient({ issuer: config.webAuth.authorizationServer });
  const clientId = await client.register({ clientName: 'Money (web)', redirectUris: [config.webAuth.redirectUri] });
  process.stdout.write(
    [
      `Registered at ${config.webAuth.authorizationServer}`,
      `Redirect URI: ${config.webAuth.redirectUri}`,
      '',
      `TAICO_WEB_CLIENT_ID=${clientId}`,
      '',
      'Sign in once within 45 minutes, or Taico prunes the unused client.',
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Registration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
