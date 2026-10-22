import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'X-Up-Authenticity-Signature';

/** Up signs the raw request body: hex SHA-256 HMAC keyed by the webhook's secretKey */
export function signBody(rawBody: string | Buffer, secretKey: string): string {
  return createHmac('sha256', secretKey).update(rawBody).digest('hex');
}

/** Constant-time check of a received signature header against the raw body */
export function verifySignature(rawBody: string | Buffer, secretKey: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signBody(rawBody, secretKey));
  const received = Buffer.from(signature.trim().toLowerCase());
  return expected.length === received.length && timingSafeEqual(expected, received);
}
