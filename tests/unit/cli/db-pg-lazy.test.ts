// The `pg` driver is kept only for the one-time `db import-postgres` (ADR-016): loading the CLI's db commands — `db
// backup` runs every night — must not load it.
describe('the CLI db commands load the Postgres driver only for the import', () => {
  afterEach(() => {
    vi.doUnmock('pg');
    vi.resetModules();
  });

  it('importing the module does not load pg', async () => {
    let loaded = false;
    vi.resetModules();
    vi.doMock('pg', () => {
      loaded = true;
      return { default: {} };
    });
    const db = await import('@adminforge/cli/src/commands/db');
    expect(typeof db.importPostgres).toBe('function');
    expect(loaded).toBe(false);
  });
});
