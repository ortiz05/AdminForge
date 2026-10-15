import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Envelope format version (bump when the layout or key scheme changes). */
const VERSION = '1';

function assertKey(key: Buffer) {
  if (key.length !== 32) throw new Error('Envelope key must be 32 bytes');
}

/**
 * AES-256-GCM. Output: "1.<iv>.<tag>.<ciphertext>" (base64url).
 * `aad` binds the blob to its owner (e.g. the token-cache partition), so it can't be replayed elsewhere.
 */
export function seal(plaintext: string, key: Buffer, aad: string): string {
  assertKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function open(sealed: string, key: Buffer, aad: string): string {
  assertKey(key);
  const [version, iv, tag, ct, ...rest] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || ct === undefined || rest.length) throw new Error('Unsupported envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
