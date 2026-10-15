import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes, base64url — session ids, CSRF tokens, OAuth state and nonce. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Constant-time string comparison. */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
