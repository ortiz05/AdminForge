import { missingLocalKeys } from '@adminforge/api/src/scripts/init-local';

// The onboarding path copies config/example.env and runs init:local: the example's CHANGE_ME placeholders must be
// replaced, not reused as the Postgres password.
describe('init:local with a copied example env file', () => {
  it('replaces CHANGE_ME placeholders with generated, matching credentials', () => {
    const add = missingLocalKeys({
      DATABASE_URL: 'postgres://adminforge:CHANGE_ME@127.0.0.1:55432/adminforge',
      POSTGRES_PASSWORD: 'CHANGE_ME',
    });
    expect(add.POSTGRES_PASSWORD).toBeDefined();
    expect(add.POSTGRES_PASSWORD).not.toContain('CHANGE_ME');
    expect(add.DATABASE_URL).toBe(
      `postgres://adminforge:${encodeURIComponent(add.POSTGRES_PASSWORD!)}@127.0.0.1:55432/adminforge`,
    );
  });

  it('still keeps a real password and only fills the missing half', () => {
    const add = missingLocalKeys({ POSTGRES_PASSWORD: 'real-secret', DATABASE_URL: 'CHANGE_ME' });
    expect(add.POSTGRES_PASSWORD).toBeUndefined();
    expect(add.DATABASE_URL).toBe('postgres://adminforge:real-secret@127.0.0.1:55432/adminforge');
  });
});
