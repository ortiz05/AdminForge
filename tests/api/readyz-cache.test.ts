import type { Database } from '@adminforge/api/src/db/client';
import { READY_CACHE_MS, READYZ_RATE_LIMIT } from '@adminforge/api/src/routes/health';
import { makeApp, mockConfig } from './helpers';

// /readyz is unauthenticated: it answers from a cached state (one database round trip per READY_CACHE_MS at most,
// shared by concurrent callers) and is rate limited per client.
function fakeDb(fail: () => boolean) {
  let pings = 0;
  const db = {
    ping: async () => {
      pings++;
      if (fail()) throw new Error('ECONNREFUSED');
    },
    // componentStates() reads the heartbeats; an empty answer → both components `missing` (degraded, still 200).
    db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
    // What building the app reads without querying: the startup file check (`:memory:` has no file to check), the
    // stores' connection handle, the run queue's lease holder (`origin`) and the schedule events' subscription.
    path: ':memory:',
    sqlite: {},
    signals: {
      origin: 'test',
      on: () => () => undefined,
      onResync: () => () => undefined,
      publish: () => undefined,
      prune: () => 0,
      stop: () => undefined,
    },
    close: async () => {},
  } as unknown as Database;
  return { db, pings: () => pings };
}

describe('/readyz', () => {
  it('serves repeated and concurrent calls from one database check, then refreshes', async () => {
    const f = fakeDb(() => false);
    const t = await makeApp(mockConfig(), { database: f.db });
    const all = await Promise.all(
      Array.from({ length: 5 }, () => t.app.inject({ method: 'GET', url: '/readyz' })),
    );
    expect(all.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(all[0]!.json()).toEqual({
      status: 'degraded',
      checks: { db: 'ok', worker: 'missing', scheduler: 'missing' },
    });
    await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(f.pings()).toBe(1);
    t.clock.advance(READY_CACHE_MS);
    await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(f.pings()).toBe(2);
    await t.app.close();
  });

  it('caches a failure for the same short time (503 not_ready), then recovers', async () => {
    let down = true;
    const f = fakeDb(() => down);
    const t = await makeApp(mockConfig(), { database: f.db });
    expect((await t.app.inject({ method: 'GET', url: '/readyz' })).json().error.code).toBe('not_ready');
    down = false;
    expect((await t.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    t.clock.advance(READY_CACHE_MS);
    expect((await t.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    expect(f.pings()).toBe(2);
    await t.app.close();
  });

  it('is rate limited per client', async () => {
    const t = await makeApp(mockConfig());
    for (let i = 0; i < READYZ_RATE_LIMIT.max; i++)
      expect((await t.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    const limited = await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    // Liveness stays exempt.
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await t.app.close();
  });
});
