import { expressionFailure } from '@adminforge/api/src/datasources/expression-errors';
import { DatasourceRunner, type LoadedPage, type RunInput } from '@adminforge/api/src/datasources/executor';
import { AppError } from '@adminforge/api/src/errors';
import type { ExecutionIdentity, OutboundExecutor } from '@adminforge/api/src/execution/types';
import { ExpressionError } from '@adminforge/expressions';

// D-19c: a datasource expression that fails while a page loads used to show JSONata's own message ("The datasource
// transform expression failed: T2001: The left side of the + operator must evaluate to a number — in expression: …"),
// which can also quote the data. The message is a plain sentence now; the expression's path and the JSONata code
// are in `detail` and in the log line under the reference — never the JSONata text or the data.

const SECRET = 'avery.secret@example.com';

function setup(row: Record<string, unknown> = { name: 'Avery', mail: SECRET }) {
  const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const outbound: OutboundExecutor = {
    async execute(_identity, call) {
      return {
        data: { value: [row] },
        status: 200,
        provenance: { service: 'graph', path: call.path, ms: 1 },
      } as never;
    },
  };
  const runner = new DatasourceRunner({
    definitions: { onChange: () => () => undefined } as never,
    outbound,
    env: () => ({}),
    now: () => new Date('2026-10-21T00:00:00Z'),
    log: { warn: (obj, msg) => void warnings.push({ obj: obj as Record<string, unknown>, msg }) },
  });
  return { runner, warnings };
}

const page = (users: Record<string, unknown>) =>
  ({
    kind: 'page',
    key: 'identity.users',
    version: '1.0.0',
    sha256: `sha-${JSON.stringify(users)}`,
    def: { datasources: { users: { source: 'graph', request: { path: '/users' }, ...users } } },
  }) as unknown as LoadedPage;

const input = (p: LoadedPage, params: Record<string, unknown> = {}): RunInput => ({
  identity: {
    kind: 'delegated',
    mode: 'read',
    session: { userOid: 'u1', idHash: 'h1', upn: 'u1@example.com' },
  } as unknown as ExecutionIdentity,
  user: { oid: 'u1', upn: 'u1@example.com', name: 'U', roles: ['Portal.Reader'] },
  page: p,
  datasource: 'users',
  params,
  correlationId: 'corr-d19',
});

const failure = async (p: LoadedPage, params?: Record<string, unknown>) => {
  const t = setup();
  const err = await t.runner.run(input(p, params)).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return { err: err as AppError, warnings: t.warnings };
};

describe('datasource expression failures, for the person in front of the browser', () => {
  it('a type error in a transform: a plain sentence, the path and code in the detail', async () => {
    const { err } = await failure(page({ transform: '${ value.value.(name + 1) }' }));
    expect(err).toMatchObject({ status: 500, code: 'content_error' });
    expect(err.message).toBe(
      'AdminForge couldn’t prepare this data: a calculation in this page’s definition met a value that isn’t a number.',
    );
    expect(err.message).not.toMatch(/T\d{4}|JSONata|expression:|\$|value\.value/);
    expect(err.extras.detail).toBe('datasources.users.transform (T2001)');
    expect(err.extras.hint).toMatch(/reference/);
  });

  it('never quotes the data JSONata tripped over, in the message or the log', async () => {
    const { err, warnings } = await failure(page({ transform: '${ value.value.$number(mail) }' }));
    expect(err.message).toBe(
      'AdminForge couldn’t prepare this data: this page’s definition expects a number where the data has text.',
    );
    expect(JSON.stringify(err)).not.toContain(SECRET);
    expect(err.extras.detail).toBe('datasources.users.transform (D3030)');
    const line = warnings.find((w) => w.msg === 'datasource expression failed');
    expect(line?.obj).toMatchObject({
      page: 'page:identity.users',
      datasource: 'users',
      expression: 'datasources.users.transform',
      code: 'D3030',
      correlationId: 'corr-d19',
    });
    expect(JSON.stringify(warnings)).not.toContain(SECRET);
  });

  it('a request value that should be an object id: names what is wrong, and where', async () => {
    const { err } = await failure(page({ request: { path: '/users/${ $encode($guid(params.id)) }' } }), {
      id: 'not-a-guid',
    });
    expect(err.message).toBe(
      'AdminForge couldn’t prepare this data: a value that should be an object ID isn’t one.',
    );
    expect(err.message).not.toContain('not-a-guid');
    expect(err.extras.detail).toBe('datasources.users.request.path (none)');
  });

  it('an expression that does not compile', async () => {
    const { err } = await failure(page({ when: '${ value.( }' }));
    expect(err.message).toBe(
      'AdminForge couldn’t prepare this data: this page’s definition has an expression AdminForge can’t read.',
    );
    expect(err.extras.detail).toMatch(/^datasources\.users\.when \(S0\d{3}\)$/);
  });
});

describe('expressionFailure', () => {
  const fail = (code: string | undefined, reason = 'x') => new ExpressionError(reason, 'expr', code);
  it.each([
    ['T0410', 'a function in this page’s definition was given the wrong kind of value'],
    ['T1006', 'this page’s definition calls a function that doesn’t exist'],
    ['T2008', 'this page’s definition sorts values that can’t be compared with each other'],
    ['T2010', 'this page’s definition compares values of different kinds, such as text with a number'],
    ['D1009', 'this page’s definition builds a record with a missing or repeated field name'],
    ['D3138', 'this page’s definition expected exactly one matching item'],
    ['D3110', 'the data has a date, time or number format this page’s definition can’t read'],
    ['Z9999', 'this page’s definition didn’t work with the data it got'],
  ])('%s → %s', (code, sentence) => {
    expect(expressionFailure(fail(code), 'ds', 'transform').message).toBe(
      `AdminForge couldn’t prepare this data: ${sentence}.`,
    );
  });

  it('puts the path inside a rendered request after the datasource part', () => {
    const e = Object.assign(fail('T2001'), { path: 'query.$filter' });
    expect(expressionFailure(e, 'ds', 'request')).toMatchObject({
      detail: 'datasources.ds.request.query.$filter (T2001)',
      log: { expression: 'datasources.ds.request.query.$filter', code: 'T2001' },
    });
  });

  it('a plain error (not an expression error) gets the general sentence', () => {
    expect(expressionFailure(new Error('boom'), 'ds', 'data').message).toBe(
      'AdminForge couldn’t prepare this data: this page’s definition didn’t work with the data it got.',
    );
  });
});
