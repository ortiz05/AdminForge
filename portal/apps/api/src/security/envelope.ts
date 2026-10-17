import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelopes (the MSAL token cache, the show-once secret hand-off). `aad` binds a blob to its owner (e.g. the
 * token-cache partition), so it can't be replayed elsewhere.
 *
 * Formats (base64url parts):
 *   "2.<kid>.<iv>.<tag>.<ciphertext>" — current; `kid` names the key that sealed it (`keyId`), so a rotated
 *                                       installation opens old blobs with the previous key and new ones with the new;
 *   "1.<iv>.<tag>.<ciphertext>"       — before key ids: opened by trying each key.
 * The tag is always 16 bytes (a shorter tag would weaken the authentication; it is refused).
 */
const VERSION = '2';
const TAG_BYTES = 16;

/** One key, or the current key plus earlier ones that may still open blobs (TOKEN_CACHE_PREVIOUS_KEYS). */
export type Keyring = { current: Buffer; previous: readonly Buffer[] };
export type EnvelopeKey = Buffer | Keyring;

function assertKey(key: Buffer) {
  if (key.length !== 32) throw new Error('Envelope key must be 32 bytes');
}

const ring = (key: EnvelopeKey): Keyring => (Buffer.isBuffer(key) ? { current: key, previous: [] } : key);

/** A short, non-secret fingerprint of a key (8 base64url characters of its SHA-256). */
export function keyId(key: Buffer): string {
  return createHash('sha256').update('adminforge-envelope-kid\n').update(key).digest('base64url').slice(0, 8);
}

export function seal(plaintext: string, key: EnvelopeKey, aad: string): string {
  const k = ring(key).current;
  assertKey(k);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    VERSION,
    keyId(k),
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

function decrypt(key: Buffer, iv: string, tag: string, ct: string, aad: string): string {
  assertKey(key);
  const tagBytes = Buffer.from(tag, 'base64url');
  if (tagBytes.length !== TAG_BYTES) throw new Error('Unsupported envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

export function open(sealed: string, key: EnvelopeKey, aad: string): string {
  const { current, previous } = ring(key);
  const keys = [current, ...previous];
  const parts = sealed.split('.');
  if (parts[0] === VERSION && parts.length === 5) {
    const [, kid, iv, tag, ct] = parts as [string, string, string, string, string];
    const k = keys.find((candidate) => keyId(candidate) === kid);
    if (!k) throw new Error('Envelope sealed with an unknown key');
    return decrypt(k, iv, tag, ct, aad);
  }
  if (parts[0] === '1' && parts.length === 4) {
    const [, iv, tag, ct] = parts as [string, string, string, string];
    let last: unknown;
    for (const k of keys) {
      try {
        return decrypt(k, iv, tag, ct, aad);
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new Error('Unsupported envelope');
  }
  throw new Error('Unsupported envelope');
}
