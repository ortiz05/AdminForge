import { randomBytes } from 'node:crypto';
import { createTokenCache, FixedPartition, MemorySealedBlobStore } from '@adminforge/api/src/auth/token-cache';

describe('sealed MSAL token cache', () => {
  it('seals at rest, opens only under the same partition and key', async () => {
    const blobs = new MemorySealedBlobStore();
    const key = randomBytes(32);
    const warnings: string[] = [];
    const cache = createTokenCache(blobs, key, { warn: (_o, msg) => warnings.push(msg) });
    expect(await cache.get('read:s1')).toBe('');
    expect(await cache.set('read:s1', '{"RefreshToken":"plain-rt"}')).toBe('{"RefreshToken":"plain-rt"}');
    expect(blobs.rows.get('read:s1')).not.toContain('plain-rt');
    expect(await cache.get('read:s1')).toBe('{"RefreshToken":"plain-rt"}');

    blobs.rows.set('read:s2', blobs.rows.get('read:s1')!);
    expect(await cache.get('read:s2')).toBe('');
    expect(warnings).toHaveLength(1);

    await cache.delete('read:s1');
    expect(blobs.rows.has('read:s1')).toBe(false);
  });

  it('FixedPartition always answers its own key', async () => {
    const p = new FixedPartition('write:abc');
    expect(await p.getKey()).toBe('write:abc');
    expect(await p.extractKey()).toBe('write:abc');
  });
});
