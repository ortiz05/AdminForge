import { describeFailure } from '@adminforge/cli/src/shared/errors';

// What `adminforge` prints for an unexpected failure: one line with the usual fix, never a stack or a whole SQL text.
const failure = (props: Record<string, unknown>, message = 'failure') =>
  Object.assign(new Error(message), props);

describe('describeFailure', () => {
  it('names the host it could not reach and how to start Postgres', () => {
    expect(describeFailure(failure({ code: 'ECONNREFUSED', address: '127.0.0.1', port: 55432 }))).toBe(
      "Can't connect to 127.0.0.1:55432. If that's Postgres, start it with `pnpm db:up` (and check DATABASE_URL).",
    );
    expect(describeFailure(failure({ code: 'ECONNREFUSED' }))).toMatch(
      /^Can't connect to the configured host\./,
    );
  });

  it('uses the root cause of wrapped driver errors', () => {
    const pg = failure({ code: '28P01' }, 'password authentication failed');
    const drizzle = failure({ cause: pg }, 'Failed query: select 1\nparams: ');
    expect(describeFailure(failure({ cause: drizzle }, 'outer'))).toBe(
      'Postgres rejected the password in DATABASE_URL.',
    );
  });

  it('explains DNS failures and a missing database', () => {
    expect(describeFailure(failure({ code: 'ENOTFOUND' }, 'getaddrinfo ENOTFOUND db.example.com'))).toBe(
      "Can't resolve a host name (getaddrinfo ENOTFOUND db.example.com). Check your network or proxy.",
    );
    expect(describeFailure(failure({ code: 'EAI_AGAIN' }))).toMatch(/^Can't resolve a host name/);
    expect(describeFailure(failure({ code: '3D000' }))).toBe(
      "The database in DATABASE_URL doesn't exist. Run `pnpm --filter @adminforge/api db:migrate`.",
    );
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
