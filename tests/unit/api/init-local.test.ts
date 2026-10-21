import { DEV_DATABASE_PATH, localKeys, missingLocalKeys } from '@adminforge/api/src/scripts/init-local';

describe('init:local', () => {
  it('adds every missing key, with a development database file of its own', () => {
    const add = localKeys({});
    expect(Object.keys(add.env).sort()).toEqual([
      'AF_ENV_LABEL',
      'API_PORT',
      'AUTH_MODE',
      'DATABASE_PATH',
      'DATA_MODE',
      'PUBLIC_BASE_URL',
      'TOKEN_CACHE_KEY',
    ]);
    // A SQLite file under the developer's own home (the API creates and migrates it at start), never a deployment's.
    expect(add.env.DATABASE_PATH).toBe(DEV_DATABASE_PATH);
    expect(DEV_DATABASE_PATH).toMatch(/^~\/\.local\/share\/adminforge\/.+\.db$/);
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

  it('keeps an existing DATABASE_PATH', () => {
    expect(localKeys({ DATABASE_PATH: '/srv/af/dev.db' }).env).not.toHaveProperty('DATABASE_PATH');
  });
});
