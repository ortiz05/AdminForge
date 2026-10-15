import { randomBytes } from 'node:crypto';
import { open, seal } from '@adminforge/api/src/security/envelope';

const key = randomBytes(32);

describe('envelope (AES-256-GCM)', () => {
  it('round-trips', () => expect(open(seal('{"a":1}', key, 'read:abc'), key, 'read:abc')).toBe('{"a":1}'));

  it('does not leak plaintext and uses a fresh IV each time', () => {
    const a = seal('secret-token', key, 'p');
    expect(a).not.toContain('secret');
    expect(seal('secret-token', key, 'p')).not.toBe(a);
  });

  it('rejects tampering', () => {
    const parts = seal('hello', key, 'p').split('.');
    parts[3] = Buffer.from('jello').toString('base64url');
    expect(() => open(parts.join('.'), key, 'p')).toThrow();
  });

  it('binds ciphertext to its partition (AAD)', () => {
    expect(() => open(seal('hello', key, 'read:alice'), key, 'read:bob')).toThrow();
  });

  it('rejects the wrong key and unknown versions', () => {
    expect(() => open(seal('hello', key, 'p'), randomBytes(32), 'p')).toThrow();
    expect(() => open(seal('hello', key, 'p').replace(/^1\./, '2.'), key, 'p')).toThrow(/Unsupported envelope/);
  });

  it('requires a 32-byte key', () => expect(() => seal('x', randomBytes(16), 'p')).toThrow(/32 bytes/));
});
