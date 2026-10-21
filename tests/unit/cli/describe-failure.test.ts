import { describeFailure } from '@adminforge/cli/src/shared/errors';

// What `adminforge` prints for an unexpected failure: one line with the usual fix, never a stack or a whole SQL text.
const failure = (props: Record<string, unknown>, message = 'failure') =>
  Object.assign(new Error(message), props);

describe('describeFailure', () => {
  it('names the host it could not reach', () => {
    expect(describeFailure(failure({ code: 'ECONNREFUSED', address: '127.0.0.1', port: 55432 }))).toBe(
      "Can't connect to 127.0.0.1:55432. Check that it is running and the address is right.",
    );
    expect(describeFailure(failure({ code: 'ECONNREFUSED' }))).toMatch(
      /^Can't connect to the configured host\./,
    );
  });

  it('uses the root cause of wrapped driver errors', () => {
    const sqlite = failure({ code: 'SQLITE_BUSY' }, 'database is locked');
    const drizzle = failure({ cause: sqlite }, 'Failed query: select 1\nparams: ');
    expect(describeFailure(failure({ cause: drizzle }, 'outer'))).toBe(
      'The database is busy (another process is writing). Try again in a moment.',
    );
  });

  it('explains the SQLite file problems people hit, naming DATABASE_PATH', () => {
    expect(describeFailure(failure({ code: 'SQLITE_CANTOPEN' }))).toMatch(
      /^Can't open the database file in DATABASE_PATH/,
    );
    expect(describeFailure(failure({ code: 'SQLITE_READONLY' }))).toMatch(/read-only for you/);
    expect(describeFailure(failure({ code: 'SQLITE_NOTADB' }))).toMatch(/not a usable AdminForge database/);
    expect(describeFailure(failure({ code: 'SQLITE_ERROR' }, 'no such table: definitions'))).toMatch(
      /no AdminForge tables yet\. Run `pnpm --filter @adminforge\/api db:migrate`/,
    );
  });

  it("names where the import's Postgres URL comes from when that database refuses it", () => {
    expect(describeFailure(failure({ code: '28P01' }))).toBe(
      'Postgres rejected the password in the URL of the database to import (DATABASE_URL, or --from-env).',
    );
    expect(describeFailure(failure({ code: '3D000' }))).toBe(
      "The Postgres database to import (DATABASE_URL, or --from-env) doesn't exist.",
    );
  });

  it('explains DNS failures', () => {
    expect(describeFailure(failure({ code: 'ENOTFOUND' }, 'getaddrinfo ENOTFOUND db.example.com'))).toBe(
      "Can't resolve a host name (getaddrinfo ENOTFOUND db.example.com). Check your network or proxy.",
    );
    expect(describeFailure(failure({ code: 'EAI_AGAIN' }))).toMatch(/^Can't resolve a host name/);
  });

  it('keeps anything else to its first line, at most 300 characters, and points at ADMINFORGE_DEBUG', () => {
    expect(describeFailure(new Error('Something broke\n    at stack frame'))).toBe(
      'Something broke (run with ADMINFORGE_DEBUG=1 for details)',
    );
    const long = describeFailure(new Error('x'.repeat(1000)));
    expect(long).toBe(`${'x'.repeat(300)} (run with ADMINFORGE_DEBUG=1 for details)`);
    expect(describeFailure('plain text')).toBe('plain text (run with ADMINFORGE_DEBUG=1 for details)');
  });

  it('stops following causes after five levels', () => {
    let err: Error = failure({ code: 'ECONNREFUSED' }, 'deepest');
    for (let i = 6; i >= 1; i--) err = failure({ cause: err }, `level ${i}`);
    expect(describeFailure(err)).toBe('level 6 (run with ADMINFORGE_DEBUG=1 for details)');
  });
});
