import { DEV_DATABASE_PATH, localKeys } from '@adminforge/api/src/scripts/init-local';

// The onboarding path copies config/example.env and runs init:local: the example's CHANGE_ME placeholders must be
// replaced, not kept.
describe('init:local with a copied example env file', () => {
  it('replaces CHANGE_ME placeholders', () => {
    const add = localKeys({ DATABASE_PATH: 'CHANGE_ME', TOKEN_CACHE_KEY: 'CHANGE_ME' });
    expect(add.env.DATABASE_PATH).toBe(DEV_DATABASE_PATH);
    expect(add.env.TOKEN_CACHE_KEY).toBeDefined();
    expect(add.env.TOKEN_CACHE_KEY).not.toContain('CHANGE_ME');
  });

  it('still keeps a real value and only fills the missing one', () => {
    const add = localKeys({ TOKEN_CACHE_KEY: 'real-key', DATABASE_PATH: 'CHANGE_ME' });
    expect(add.env).not.toHaveProperty('TOKEN_CACHE_KEY');
    expect(add.env.DATABASE_PATH).toBe(DEV_DATABASE_PATH);
  });
});
