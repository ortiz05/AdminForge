import { localKeys } from '@adminforge/api/src/scripts/init-local';

// The onboarding path copies config/example.env and runs init:local: the example's CHANGE_ME placeholders must be
// replaced, not reused as a password.
describe('init:local with a copied example env file', () => {
  it('replaces CHANGE_ME placeholders with generated credentials', () => {
    const add = localKeys({
      DATABASE_URL: 'postgres://adminforge_dev:CHANGE_ME@127.0.0.1:55432/adminforge_dev',
      POSTGRES_PASSWORD: 'CHANGE_ME',
    });
    expect(add.env.DATABASE_URL).toBeDefined();
    expect(add.env.DATABASE_URL).not.toContain('CHANGE_ME');
    expect(add.owner.POSTGRES_PASSWORD).toBeDefined();
    expect(add.owner.POSTGRES_PASSWORD).not.toContain('CHANGE_ME');
  });

  it('still keeps a real value and only fills the missing one', () => {
    const add = localKeys({ POSTGRES_PASSWORD: 'real-secret', DATABASE_URL: 'CHANGE_ME' });
    expect(add.owner).toEqual({});
    expect(add.env.DATABASE_URL).toMatch(/^postgres:\/\/adminforge_dev:[^@]+@127\.0\.0\.1:55432\/adminforge_dev$/);
  });
});
