import { createCipheriv, randomBytes } from 'node:crypto';
import { keyId, open, seal } from '@adminforge/api/src/security/envelope';
import { loadConfig, tokenCacheKey } from '@adminforge/api/src/config';

// TOKEN_CACHE_KEY rotation (docs/operations.md → Database): blobs name the key that sealed them, earlier keys
// (TOKEN_CACHE_PREVIOUS_KEYS) still open old blobs, and the GCM tag is always the full 16 bytes.
const oldKey = randomBytes(32);
const newKey = randomBytes(32);

/** A blob in the format before key ids ("1.<iv>.<tag>.<ct>"). */
function sealV1(plaintext: string, key: Buffer, aad: string, tagLength = 16) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: tagLength });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    '1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

describe('envelope key ids and rotation', () => {
  it('seals with the current key and names it', () => {
    const blob = seal('x', { current: newKey, previous: [oldKey] }, 'p');
    expect(blob.split('.')).toHaveLength(5);
    expect(blob.split('.')[1]).toBe(keyId(newKey));
    expect(keyId(newKey)).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(keyId(newKey)).not.toBe(keyId(oldKey));
  });

  it('opens a blob sealed with a previous key, and one in the old format', () => {
    const ring = { current: newKey, previous: [oldKey] };
    expect(open(seal('before rotation', oldKey, 'p'), ring, 'p')).toBe('before rotation');
    expect(open(sealV1('legacy', oldKey, 'p'), ring, 'p')).toBe('legacy');
    expect(open(sealV1('legacy current', newKey, 'p'), ring, 'p')).toBe('legacy current');
  });

  it('refuses a blob whose key is no longer configured', () => {
    expect(() => open(seal('x', oldKey, 'p'), newKey, 'p')).toThrow(/unknown key/);
    expect(() => open(sealV1('x', oldKey, 'p'), newKey, 'p')).toThrow();
  });

  it('refuses a shortened authentication tag', () => {
    expect(() => open(sealV1('x', oldKey, 'p', 4), oldKey, 'p')).toThrow(/Unsupported envelope/);
    const parts = seal('x', oldKey, 'p').split('.');
    parts[3] = Buffer.from(parts[3]!, 'base64url').subarray(0, 8).toString('base64url');
    expect(() => open(parts.join('.'), oldKey, 'p')).toThrow(/Unsupported envelope/);
  });

  it('reads TOKEN_CACHE_PREVIOUS_KEYS from the configuration and checks each is 32 bytes', () => {
    const base = {
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      AUTH_MODE: 'mock',
      DATA_MODE: 'fixtures',
    };
    const config = loadConfig({
      ...base,
      TOKEN_CACHE_KEY: newKey.toString('base64'),
      TOKEN_CACHE_PREVIOUS_KEYS: ` ${oldKey.toString('base64')} ,`,
    });
    const ring = tokenCacheKey(config)!;
    expect(ring.current.equals(newKey)).toBe(true);
    expect(ring.previous.map((k) => k.equals(oldKey))).toEqual([true]);
    expect(() =>
      loadConfig({
        ...base,
        TOKEN_CACHE_KEY: newKey.toString('base64'),
        TOKEN_CACHE_PREVIOUS_KEYS: 'c2hvcnQ=',
      }),
    ).toThrow(/TOKEN_CACHE_PREVIOUS_KEYS/);
  });
});
