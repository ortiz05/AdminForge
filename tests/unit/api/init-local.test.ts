import { localKeys, missingLocalKeys } from '@adminforge/api/src/scripts/init-local';

describe('init:local', () => {
  it('adds every missing key: the dev role URL in the env file, the superuser password in the owner file', () => {
    const add = localKeys({});
    expect(Object.keys(add.env).sort()).toEqual([
      'AF_ENV_LABEL',
      'API_PORT',
      'AUTH_MODE',
      'DATABASE_URL',
      'DATA_MODE',
      'PUBLIC_BASE_URL',
      'TOKEN_CACHE_KEY',
    ]);
    expect(Object.keys(add.owner)).toEqual(['POSTGRES_PASSWORD']);
    // The development database's own non-superuser owner (pnpm db:harden creates it with this password).
    const url = new URL(add.env.DATABASE_URL!);
    expect([url.username, url.hostname, url.port, url.pathname]).toEqual([
      'adminforge_dev',
      '127.0.0.1',
      '55432',
      '/adminforge_dev',
    ]);
    expect(decodeURIComponent(url.password)).not.toBe(add.owner.POSTGRES_PASSWORD);
    expect(Buffer.from(add.env.TOKEN_CACHE_KEY!, 'base64')).toHaveLength(32);
    expect(add.env).toMatchObject({
      PUBLIC_BASE_URL: 'http://localhost:5173',
      API_PORT: '3001',
      AUTH_MODE: 'entra',
      DATA_MODE: 'live',
      AF_ENV_LABEL: 'dev',
    });
  });

  it('never touches keys that already have values; fills empty ones', () => {
    const add = missingLocalKeys({ AUTH_MODE: 'mock', TOKEN_CACHE_KEY: 'existing', DATA_MODE: '' });
    expect(add.AUTH_MODE).toBeUndefined();
    expect(add.TOKEN_CACHE_KEY).toBeUndefined();
    expect(add.DATA_MODE).toBe('live');
  });

  it('keeps an existing DATABASE_URL and a superuser password wherever it already is', () => {
    const existing = 'postgres://adminforge_dev:abc%2Fdef@127.0.0.1:55432/adminforge_dev';
    expect(localKeys({ DATABASE_URL: existing }, { POSTGRES_PASSWORD: 'kept' })).toMatchObject({
      env: expect.not.objectContaining({ DATABASE_URL: expect.anything() }),
      owner: {},
    });
    // An older env file with POSTGRES_PASSWORD keeps it (pnpm db:harden moves it to the owner file).
    expect(localKeys({ DATABASE_URL: existing, POSTGRES_PASSWORD: 'legacy' }).owner).toEqual({});
  });
});
