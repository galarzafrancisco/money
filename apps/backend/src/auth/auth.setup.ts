import { createResourceServer, remoteJwks, resourceAudience, type JwksSource, type ProtectedResource, type ResourceServer } from '@taico/auth';
import type { AppConfig } from '../config/env.config';

export const RESOURCE_SERVER_FACTORY = Symbol('RESOURCE_SERVER_FACTORY');

/**
 * Money's two protected resources. A token minted for one is refused on the
 * other (resourceAudience binds each token to its own URL and below).
 */
export function protectedResources(config: AppConfig): ProtectedResource[] {
  return [
    { id: 'money-mcp', identifier: 'mcp', resourceUrl: config.auth.mcpResourceUrl, name: 'Money MCP', scopes: [] },
    { id: 'money-api', identifier: 'api', resourceUrl: config.auth.apiResourceUrl, name: 'Money REST API', scopes: [] },
  ];
}

/**
 * Verifies Taico access tokens: signature against Taico's JWKS, `iss`,
 * `exp`, and an audience naming the resource being called. Money has no
 * logins of its own.
 */
export function createMoneyResourceServer(config: AppConfig, jwks: JwksSource = remoteJwks(config.auth.jwksUrl)): ResourceServer {
  return createResourceServer({
    issuer: config.auth.issuer,
    jwks,
    audience: resourceAudience(config.auth.mcpResourceUrl, config.auth.apiResourceUrl),
    baseUrl: config.publicBaseUrl,
    realm: 'money',
  });
}
