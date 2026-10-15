import { missingLocalKeys } from '@adminforge/api/src/scripts/init-local';

describe('init:local', () => {
  it('adds every missing key with matching Postgres credentials', () => {
    const add = missingLocalKeys({});
    expect(Object.keys(add).sort()).toEqual(['AF_ENV_LABEL', 'API_PORT', 'AUTH_MODE', 'DATABASE_URL', 'DATA_MODE', 'POSTGRES_PASSWORD', 'PUBLIC_BASE_URL', 'TOKEN_CACHE_KEY']);
    expect(add.DATABASE_URL).toBe(`postgres://adminforge:${encodeURIComponent(add.POSTGRES_PASSWORD!)}@127.0.0.1:55432/adminforge`);
    expect(Buffer.from(add.TOKEN_CACHE_KEY!, 'base64')).toHaveLength(32);
    expect(add).toMatchObject({ PUBLIC_BASE_URL: 'http://localhost:5173', API_PORT: '3001', AUTH_MODE: 'entra', DATA_MODE: 'live', AF_ENV_LABEL: 'dev' });
  });

  it('never touches keys that already have values; fills empty ones', () => {
    const add = missingLocalKeys({ AUTH_MODE: 'mock', TOKEN_CACHE_KEY: 'existing', DATA_MODE: '' });
    expect(add.AUTH_MODE).toBeUndefined();
    expect(add.TOKEN_CACHE_KEY).toBeUndefined();
    expect(add.DATA_MODE).toBe('live');
  });

  it('reuses the password from an existing local DATABASE_URL', () => {
    const add = missingLocalKeys({ DATABASE_URL: 'postgres://adminforge:abc%2Fdef@127.0.0.1:55432/adminforge' });
    expect(add.POSTGRES_PASSWORD).toBe('abc/def');
    expect(add.DATABASE_URL).toBeUndefined();
  });
});
