import { approximateBytes, Inflight, TtlCache } from '@adminforge/api/src/datasources/cache';
import { DatasourceRunner, type LoadedPage, type RunInput } from '@adminforge/api/src/datasources/executor';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { clientClosed } from '@adminforge/api/src/routes/datasources';

// Enterprise scale in the datasource executor: identical concurrent loads share one execution, cache keys count only
// the params a datasource uses and its dependencies by their own keys, the cache is capped by bytes and invalidated
// per definition, a failed transform is retried on the data already fetched, a person's page load has a deadline,
// and a partial (`truncated`) result says so.

type Change = { keys?: string[]; all?: boolean };

function setup(
  opts: {
    respond?: (call: ServiceCall, n: number) => unknown;
    deadlineMs?: number;
    truncated?: boolean;
  } = {},
) {
  const calls: ServiceCall[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let listener: ((c: Change) => void) | undefined;
  const outbound: OutboundExecutor = {
    async execute(_identity, call, o) {
      calls.push(call);
      signals.push(o?.signal);
      const data = await (opts.respond?.(call, calls.length) ?? { value: [{ id: calls.length }] });
      return {
        data,
        status: 200,
        provenance: { service: 'graph', path: call.path, ms: 1 },
        ...(opts.truncated ? { truncated: true } : {}),
      } as never;
    },
  };
  const runner = new DatasourceRunner({
    definitions: {
      onChange: (l: (c: Change) => void) => {
        listener = l;
        return () => undefined;
      },
    } as never,
    outbound,
    env: () => ({}),
    now: () => new Date('2026-10-17T00:00:00Z'),
    ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
  });
  return { runner, calls, signals, change: (c: Change) => listener?.(c) };
}

const page = (datasources: Record<string, unknown>, key = 'identity.users'): LoadedPage =>
  ({ kind: 'page', key, version: '1.0.0', sha256: 'sha-1', def: { datasources } }) as unknown as LoadedPage;

const session = (oid = 'u1', idHash = 'h1') =>
  ({
    kind: 'delegated',
    mode: 'read',
    session: { userOid: oid, idHash, upn: `${oid}@example.com` },
  }) as unknown as ExecutionIdentity;

const input = (p: LoadedPage, datasource: string, extra: Partial<RunInput> = {}): RunInput => ({
  identity: session(),
  user: { oid: 'u1', upn: 'u1@example.com', name: 'U', roles: ['Portal.Reader'] },
  page: p,
  datasource,
  params: {},
  correlationId: 'c',
  ...extra,
});

const graph = (path: string, extra: Record<string, unknown> = {}) => ({
  source: 'graph',
  request: { path },
  cache: { ttl: 300 },
  ...extra,
});

describe('request coalescing', () => {
  it('identical concurrent loads of the same user and session share one call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({ respond: async () => (await gate, { value: [1] }) });
    const p = page({ users: graph('/users', { cache: undefined }) });
    const runs = [
      t.runner.run(input(p, 'users')),
      t.runner.run(input(p, 'users')),
      t.runner.run(input(p, 'users')),
    ];
    release();
    const out = await Promise.all(runs);
    expect(t.calls).toHaveLength(1);
    expect(out.map((o) => o.data)).toEqual([{ value: [1] }, { value: [1] }, { value: [1] }]);
  });

  it('never across users, sessions or modes', async () => {
    const t = setup();
    const p = page({ users: graph('/users', { cache: undefined }) });
    await Promise.all([
      t.runner.run(input(p, 'users')),
      t.runner.run(input(p, 'users', { identity: session('u2', 'h2') })),
      t.runner.run(input(p, 'users', { identity: session('u1', 'h-other-session') })),
    ]);
    expect(t.calls).toHaveLength(3);
  });

  it('the shared work stops only when every waiting caller has gone', async () => {
    const t = setup({ respond: () => new Promise(() => {}) });
    const p = page({ users: graph('/users', { cache: undefined }) });
    const a = new AbortController();
    const b = new AbortController();
    const ra = t.runner.run(input(p, 'users', { signal: a.signal, deadlineMs: 0 })).catch((e) => e);
    const rb = t.runner.run(input(p, 'users', { signal: b.signal, deadlineMs: 0 })).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    expect(t.calls).toHaveLength(1);
    a.abort(new Error('tab closed'));
    expect(await ra).toMatchObject({ message: 'tab closed' });
    expect(t.signals[0]!.aborted).toBe(false); // b still waits
    b.abort(new Error('tab closed'));
    expect(await rb).toMatchObject({ message: 'tab closed' });
    expect(t.signals[0]!.aborted).toBe(true);
  });

  it('Inflight: a caller arriving after everyone gave up starts afresh', async () => {
    const flights = new Inflight<number>();
    let runs = 0;
    const c = new AbortController();
    const first = flights.run('k', c.signal, () => (runs++, new Promise(() => {}))).catch(() => 'gone');
    c.abort();
    expect(await first).toBe('gone');
    await flights.run('k', undefined, async () => (runs++, 7));
    expect(runs).toBe(2);
  });
});

describe('cache keys', () => {
  it('a param the datasource doesn’t use doesn’t refetch it', async () => {
    const t = setup();
    const p = page({
      counts: graph('/users/$count'),
      users: graph('/users', { request: { path: '/users', query: { $search: '${ params.q }' } } }),
    });
    await t.runner.run(input(p, 'counts', { params: { q: 'a' } }));
    await t.runner.run(input(p, 'counts', { params: { q: 'b' } }));
    expect(t.calls.filter((c) => c.path === '/users/$count')).toHaveLength(1);
    await t.runner.run(input(p, 'users', { params: { q: 'a' } }));
    await t.runner.run(input(p, 'users', { params: { q: 'b' } }));
    expect(t.calls.filter((c) => c.path === '/users')).toHaveLength(2);
  });

  it('any other use of params (indexing, $keys) keys on all of them', async () => {
    const t = setup();
    const p = page({ any: graph('/x', { transform: '${ $keys(params) }' }) });
    await t.runner.run(input(p, 'any', { params: { q: 'a' } }));
    await t.runner.run(input(p, 'any', { params: { q: 'b' } }));
    expect(t.calls).toHaveLength(2);
  });

  it('a cached dependent is served without running its dependency again', async () => {
    const t = setup();
    const p = page({
      ids: graph('/groups'),
      names: graph('/directoryObjects/getByIds', { transform: '${ { "n": $count(ds.ids.value) } }' }),
    });
    await t.runner.run(input(p, 'names'));
    expect(t.calls.map((c) => c.path)).toEqual(['/groups', '/directoryObjects/getByIds']);
    // The dependency's result expires sooner (or is evicted): the dependent's cache hit needs nothing.
    t.runner.cache.clear();
    await t.runner.run(input(p, 'names'));
    await t.runner.run(input(p, 'names'));
    expect(t.calls).toHaveLength(4);
  });
});

describe('cache size and invalidation', () => {
  it('caps by approximate bytes and refuses one entry larger than a quarter of the cap', () => {
    const cache = new TtlCache<unknown>(1000, () => new Date(), 4096);
    cache.set('a', { s: 'x'.repeat(400) }, 60);
    cache.set('b', { s: 'x'.repeat(400) }, 60);
    cache.set('c', { s: 'x'.repeat(400) }, 60);
    expect(cache.size).toBeLessThanOrEqual(3);
    expect(cache.approximateSize).toBeLessThanOrEqual(4096);
    cache.set('huge', { s: 'x'.repeat(4000) }, 60);
    expect(cache.get('huge')).toBeUndefined();
  });

  it('approximateBytes samples long arrays instead of walking every row', () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => ({ id: `u${i}`, n: i }));
    const started = performance.now();
    const bytes = approximateBytes(rows);
    expect(performance.now() - started).toBeLessThan(50);
    expect(bytes).toBeGreaterThan(200_000 * 40);
  });

  it('a changed page drops only its own results; a changed connection drops everything', async () => {
    const t = setup();
    const users = page({ users: graph('/users') }, 'identity.users');
    const groups = page({ groups: graph('/groups') }, 'identity.groups');
    await t.runner.run(input(users, 'users'));
    await t.runner.run(input(groups, 'groups'));
    t.change({ keys: ['page:identity.users'] });
    await t.runner.run(input(users, 'users'));
    await t.runner.run(input(groups, 'groups'));
    expect(t.calls.map((c) => c.path)).toEqual(['/users', '/groups', '/users']);
    t.change({ keys: ['connection:hr-sync'] });
    await t.runner.run(input(groups, 'groups'));
    expect(t.calls).toHaveLength(4);
  });
});

describe('a failed transform is tried again on the data already fetched', () => {
  it('the retry reuses the raw result instead of calling Microsoft again', async () => {
    const t = setup();
    const p = page({
      users: graph('/users', { transform: '${ $error("boom") }' }),
    });
    await expect(t.runner.run(input(p, 'users'))).rejects.toMatchObject({ code: 'content_error' });
    await expect(t.runner.run(input(p, 'users'))).rejects.toMatchObject({ code: 'content_error' });
    expect(t.calls).toHaveLength(1);
  });
});

describe('deadline and partial results', () => {
  it('a person’s page load stops after the deadline with 504 datasource_timeout', async () => {
    const t = setup({ deadlineMs: 30, respond: () => new Promise(() => {}) });
    const p = page({ users: graph('/users', { label: 'Users' }) });
    const err = await t.runner.run(input(p, 'users')).catch((e) => e);
    expect(err).toMatchObject({ status: 504, code: 'datasource_timeout' });
    expect(err.message).toMatch(/^Users took longer than 0 seconds/);
    expect(t.signals[0]!.aborted).toBe(true); // the call was told to stop
  });

  it('exports (paging given) and the automation identity aren’t cut short', async () => {
    const t = setup({
      deadlineMs: 20,
      respond: () => new Promise((r) => setTimeout(() => r({ value: [] }), 60)),
    });
    const p = page({ users: graph('/users') });
    await expect(t.runner.run(input(p, 'users', { paging: 'all', noCache: true }))).resolves.toBeDefined();
    await expect(
      t.runner.run(input(p, 'users', { identity: { kind: 'automation', mode: 'read' } })),
    ).resolves.toBeDefined();
  });

  it('a truncated result says so', async () => {
    const t = setup({ truncated: true });
    const p = page({ users: graph('/users', { paging: 'all' }) });
    expect((await t.runner.run(input(p, 'users'))).truncated).toBe(true);
  });
});

describe('review follow-ups', () => {
  it('a caller that has already gone neither starts shared work nor joins it', async () => {
    const flights = new Inflight<number>();
    const gone = new AbortController();
    gone.abort(new Error('client closed'));
    let started = 0;
    await expect(flights.run('k', gone.signal, async () => (started++, 1))).rejects.toThrow('client closed');
    expect(started).toBe(0);
    expect(flights.size).toBe(0);
  });

  it('a closed page is never swallowed as an optional dependency’s failure', async () => {
    const c = new AbortController();
    const t = setup({
      respond: (call) =>
        call.path === '/enrich'
          ? (c.abort(clientClosed()), Promise.reject(new Error('aborted')))
          : { value: [] },
    });
    const p = page({
      enrich: graph('/enrich', { optional: true, cache: undefined }),
      rows: graph('/rows', { cache: undefined, transform: '${ ds.enrich }' }),
    });
    const out = await t.runner.runMany({ ...input(p, 'rows'), signal: c.signal }, ['rows']);
    expect(out.rows).toMatchObject({ error: { code: 'client_closed' } });
    expect(t.calls.map((x) => x.path)).toEqual(['/enrich']); // `rows` never ran without it
  });

  it('a cached result is refused once the person lost a role a dependency needs', async () => {
    const t = setup();
    const p = page({
      secret: graph('/secret', { requires: { portalRoles: ['Portal.Admin'] } }),
      summary: graph('/summary', { transform: '${ ds.secret }' }),
    });
    const admin = { oid: 'u1', upn: 'u1@example.com', name: 'U', roles: ['Portal.Reader', 'Portal.Admin'] };
    await t.runner.run(input(p, 'summary', { user: admin }));
    await expect(t.runner.run(input(p, 'summary'))).rejects.toMatchObject({ code: 'dependency_failed' });
  });

  it('the raw-result retry is only for cached datasources, at most their ttl, and only once', async () => {
    const t = setup();
    const p = page({
      uncached: graph('/a', { cache: undefined, transform: '${ $error("boom") }' }),
      cached: graph('/b', { cache: { ttl: 300 }, transform: '${ $error("boom") }' }),
    });
    for (let i = 0; i < 2; i++) await t.runner.run(input(p, 'uncached')).catch(() => undefined);
    expect(t.calls.filter((c) => c.path === '/a')).toHaveLength(2); // always fresh
    for (let i = 0; i < 3; i++) await t.runner.run(input(p, 'cached')).catch(() => undefined);
    // Fetch, retry on the kept data (fails again, not kept again), fetch.
    expect(t.calls.filter((c) => c.path === '/b')).toHaveLength(2);
  });

  it('approximateBytes doesn’t undercount wide lookups or rows that grow after the first few', () => {
    const byId: Record<string, unknown> = {};
    for (let i = 0; i < 50_000; i++) byId[`id-${i}`] = { d: 'x'.repeat(1024) };
    expect(approximateBytes(byId)).toBeGreaterThan(JSON.stringify(byId).length);
    const rows = [
      ...Array.from({ length: 64 }, () => ({ d: 'a' })),
      ...Array.from({ length: 5000 }, () => ({ d: 'z'.repeat(1024) })),
    ];
    expect(approximateBytes(rows)).toBeGreaterThan(JSON.stringify(rows).length);
  });

  it('the timeout message names the datasource or says "This data", and suggests filters only when there are any', async () => {
    const t = setup({ deadlineMs: 20, respond: () => new Promise(() => {}) });
    const bare = page({ users: graph('/users') });
    const err = await t.runner.run(input(bare, 'users')).catch((e) => e);
    expect(err.message).toMatch(/^This data took longer/);
    expect(err.extras.hint).not.toMatch(/filter/i);
  });
});
