import type { CookieOptions, Request, Response } from 'express';
import type { WebAuthConfig } from '../config/env.config';

/** Reads one cookie from the request header (no cookie-parser middleware) */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(value) || undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * HttpOnly, host-only, Path=/, SameSite=Lax: sent on same-site requests and
 * on the top-level redirect back from Taico, never readable by scripts.
 * Secure (and the __Host- name prefix) whenever Money is served over https.
 */
function cookieOptions(config: WebAuthConfig, maxAgeMs?: number): CookieOptions {
  return { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', path: '/', ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}) };
}

export function setCookie(response: Response, config: WebAuthConfig, name: string, value: string, maxAgeMs: number): void {
  response.cookie(name, value, cookieOptions(config, maxAgeMs));
}

export function clearCookie(response: Response, config: WebAuthConfig, name: string): void {
  response.clearCookie(name, cookieOptions(config));
}

/** Auth responses carry user state: never cache them, never leak the URL in Referer */
export function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Referrer-Policy', 'no-referrer');
}

/** The Money error envelope, for responses written outside the exception filters */
export function sendError(response: Response, status: number, code: string, message: string): void {
  response.status(status).json({ error: { code, message } });
}
