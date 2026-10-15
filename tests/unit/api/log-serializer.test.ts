import { loggerOptions } from '@adminforge/api/src/app';
import { loadConfig } from '@adminforge/api/src/config';
import { serializeError, stripParams } from '@adminforge/api/src/logging';

// A failed database query arrives as drizzle's DrizzleQueryError: message, stack and `params` carry every bound value
// (CSRF tokens, PKCE verifiers, raw run inputs). Postgres adds key values in `detail`. None of it may be logged.
class DrizzleQueryError extends Error {
  constructor(
    readonly query: string,
    readonly params: unknown[],
    cause?: unknown,
  ) {
    super(`Failed query: ${query}\nparams: ${params}`);
    if (cause) this.cause = cause;
  }
}

const SECRET = 'csrf-9f8e7d6c5b4a';
const VERIFIER = 'pkce-verifier-0123456789';

describe('error serializer', () => {
  const pgError = Object.assign(new Error('duplicate key value violates unique constraint "preauth_pkey"'), {
    code: '23505',
    constraint: 'preauth_pkey',
    detail: `Key (state)=(${SECRET}) already exists.`,
  });
  const err = new DrizzleQueryError(
    'insert into "preauth" ("state", "verifier") values ($1, $2)',
    [SECRET, VERIFIER],
    pgError,
  );

  it('keeps what helps (type, SQL text, pg code and constraint) and drops every bound value', () => {
    const out = serializeError(err);
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(VERIFIER);
    expect(out.type).toBe('DrizzleQueryError');
    expect(out.message).toBe(
      'Failed query: insert into "preauth" ("state", "verifier") values ($1, $2)\nparams: [redacted]',
    );
    expect(out.stack).toContain('params: [redacted]');
    expect(out.stack).toMatch(/\n\s+at /);
    expect(out.params).toBeUndefined();
    expect(out.query).toContain('insert into "preauth"');
    expect(out.cause).toMatchObject({ code: '23505', constraint: 'preauth_pkey' });
    expect((out.cause as Record<string, unknown>).detail).toBeUndefined();
  });

  it('also strips params from a nested cause and from non-Error values', () => {
    const wrapped = new Error('run failed', { cause: err });
    expect(JSON.stringify(serializeError(wrapped))).not.toContain(SECRET);
    expect(serializeError(`Failed query: x\nparams: ${SECRET}`).message).toBe(
      'Failed query: x\nparams: [redacted]',
    );
  });

  it('survives cycles', () => {
    const a = new Error('a') as Error & { self?: unknown };
    a.cause = a;
    expect(() => serializeError(a)).not.toThrow();
  });

  it('stripParams leaves ordinary messages alone', () =>
    expect(stripParams('Request failed with status 500')).toBe('Request failed with status 500'));

  it('is the API logger’s err serializer', () => {
    const cfg = loadConfig({
      NODE_ENV: 'development',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      AUTH_MODE: 'mock',
      DATA_MODE: 'fixtures',
    });
    const opts = loggerOptions(cfg) as { serializers: Record<string, unknown> };
    expect(opts.serializers.err).toBe(serializeError);
    expect(opts.serializers.error).toBe(serializeError);
  });
});
