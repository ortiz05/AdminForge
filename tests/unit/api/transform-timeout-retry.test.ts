import { ExpressionTimeoutError } from '@adminforge/expressions';
import { DatasourceRunner, type LoadedPage, type RunInput } from '@adminforge/api/src/datasources/executor';
import type { ExecutionIdentity, OutboundExecutor } from '@adminforge/api/src/execution/types';

// The transform budget is wall-clock, so another request's big crawl can take it from a transform that normally fits:
// a timed-out transform runs once more on the same data (no second Graph call) before the page shows an error, and
// that error says what happened instead of blaming the definition.
const render = vi.hoisted(() => ({ timeouts: 0, onTimeout: undefined as undefined | (() => void) }));
vi.mock('@adminforge/expressions', async (orig) => {
  const real = await orig<typeof import('@adminforge/expressions')>();
  return {
    ...real,
    renderString: async (str: string, scope: Record<string, unknown>, opts?: object) => {
      if (str.includes('$count(value.value)') && render.timeouts > 0) {
        render.timeouts--;
        render.onTimeout?.();
        throw new real.ExpressionTimeoutError(str, 250);
      }
      return real.renderString(str, scope, opts as never);
    },
  };
});

function setup() {
  let calls = 0;
  const outbound: OutboundExecutor = {
    async execute(_identity, call) {
      calls++;
      return {
        data: { value: [{ id: 1 }, { id: 2 }] },
        status: 200,
        provenance: { service: 'graph', path: call.path, ms: 1 },
      } as never;
    },
  };
  const runner = new DatasourceRunner({
    definitions: { onChange: () => () => undefined } as never,
    outbound,
    env: () => ({}),
    now: () => new Date('2026-10-17T00:00:00Z'),
  });
  return { runner, calls: () => calls };
}

const page = {
  kind: 'page',
  key: 'identity.users',
  version: '1.0.0',
  sha256: 'sha-1',
  def: {
    datasources: {
      users: { source: 'graph', request: { path: '/users' }, transform: '${ $count(value.value) }' },
    },
  },
} as unknown as LoadedPage;

const input: RunInput = {
  identity: {
    kind: 'delegated',
    mode: 'read',
    session: { userOid: 'u1', idHash: 'h1', upn: 'u1@example.com' },
  } as unknown as ExecutionIdentity,
  user: { oid: 'u1', upn: 'u1@example.com', name: 'U', roles: ['Portal.Reader'] },
  page,
  datasource: 'users',
  params: {},
  correlationId: 'c',
};

describe('a transform that runs out of its budget', () => {
  it('runs once more on the same data, and the page gets its result', async () => {
    const t = setup();
    render.timeouts = 1;
    const out = await t.runner.run(input);
    expect(out.data).toBe(2);
    expect(t.calls()).toBe(1);
  });

  it('fails after the second timeout, saying what happened (not "fix the definition")', async () => {
    const t = setup();
    render.timeouts = 2;
    await expect(t.runner.run(input)).rejects.toMatchObject({
      code: 'content_error',
      message: 'Preparing this data took longer than AdminForge allows.',
      extras: { hint: expect.stringMatching(/Try again in a moment/) },
    });
    expect(t.calls()).toBe(1);
  });

  it('is not retried once the request has gone (closed during the first attempt)', async () => {
    const t = setup();
    render.timeouts = 2;
    const gone = new AbortController();
    render.onTimeout = () => gone.abort();
    await expect(t.runner.run({ ...input, signal: gone.signal })).rejects.toBeTruthy();
    render.onTimeout = undefined;
    // Only the first attempt ran.
    expect(render.timeouts).toBe(1);
  });

  it('the timeout class is the one the expressions package throws', () => {
    expect(new ExpressionTimeoutError('x', 250)).toBeInstanceOf(Error);
  });
});
