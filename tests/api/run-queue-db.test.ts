import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { RetryLater, SqliteRunQueue } from '@adminforge/api/src/runs/queue';
import { testDatabasePath } from './db';

// The run queue on the `run_jobs` table (replaces pg-boss): at most one queued and one active job per run, the
// earliest start wins, failures retry with backoff, a dead process's job runs again once its lease runs out, and a
// shutdown puts unfinished jobs back instead of losing them.
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await settle(10);
  }
}

describe('SqliteRunQueue', () => {
  let file: string;
  let database: Database;
  let queues: SqliteRunQueue[];
  const jobs = () =>
    database.sqlite
      .prepare('select run_id, state, attempts from run_jobs order by run_id, state')
      .all() as Array<{
      run_id: string;
      state: string;
      attempts: number;
    }>;
  const make = (db = database, opts: ConstructorParameters<typeof SqliteRunQueue>[2] = {}) => {
    const q = new SqliteRunQueue(db, undefined, {
      pollMs: 20,
      retryDelayMs: 20,
      busyDelayMs: 20,
      gracefulMs: 200,
      ...opts,
    });
    queues.push(q);
    return q;
  };

  beforeEach(async () => {
    file = await testDatabasePath();
    database = createDatabase(file);
    queues = [];
  });
  afterEach(async () => {
    for (const q of queues) await q.stop();
    await database.close();
  });

  it('coalesces enqueues per run and delivers each run id to the handler', async () => {
    const q = make();
    await q.enqueue('r1');
    await q.enqueue('r1');
    await q.enqueue('r2');
    expect(jobs().map((j) => j.run_id)).toEqual(['r1', 'r2']);
    const seen: string[] = [];
    await q.work(async (id) => void seen.push(id), { concurrency: 2 });
    await until(() => seen.length === 2 && jobs().length === 0);
    expect(seen.sort()).toEqual(['r1', 'r2']);
  });

  it('defers with startAfter, and an earlier start replaces a later one (an approval wakes a waiting run)', async () => {
    const q = make();
    await q.enqueue('r1', { startAfter: new Date(Date.now() + 3_600_000) });
    const seen: string[] = [];
    await q.work(async (id) => void seen.push(id), { concurrency: 1 });
    await settle(80);
    expect(seen).toEqual([]);
    await q.enqueue('r1', { startAfter: new Date(Date.now() + 7_200_000) }); // later: ignored
    await q.enqueue('r1'); // now: wins
    await until(() => seen.length === 1);
  });

  it('a run enqueued while it is being driven runs again afterwards — never twice at once', async () => {
    const q = make();
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    await q.work(
      async (id) => {
        active++;
        maxActive = Math.max(maxActive, active);
        calls++;
        if (calls === 1) await q.enqueue(id); // e.g. a child finished while the parent was running
        await settle(40);
        active--;
      },
      { concurrency: 4 },
    );
    await q.enqueue('r1');
    await until(() => calls === 2 && jobs().length === 0);
    expect(maxActive).toBe(1);
  });

  it('retries a failing job with backoff and drops it after the retry limit', async () => {
    const warnings: string[] = [];
    const q = new SqliteRunQueue(
      database,
      { warn: (_o, m) => void warnings.push(m), error: (_o, m) => void warnings.push(m) },
      {
        pollMs: 10,
        retryDelayMs: 5,
        retryLimit: 2,
      },
    );
    queues.push(q);
    let calls = 0;
    await q.work(
      async () => {
        calls++;
        throw new Error('Graph said no');
      },
      { concurrency: 1 },
    );
    await q.enqueue('r1');
    await until(() => calls === 3 && jobs().length === 0);
    expect(warnings.filter((w) => w === 'run job failed')).toHaveLength(2);
    expect(warnings.at(-1)).toMatch(/failed too often; dropped/);
  });

  it('RetryLater (the run is locked elsewhere) comes back shortly without counting as a failure', async () => {
    const q = make();
    let calls = 0;
    await q.work(
      async () => {
        calls++;
        if (calls < 3) throw new RetryLater();
      },
      { concurrency: 1 },
    );
    await q.enqueue('r1');
    await until(() => calls === 3 && jobs().length === 0);
  });

  it("a dead process's job runs again once its lease runs out", async () => {
    let t = Date.now();
    const dead = new SqliteRunQueue(database, undefined, { pollMs: 1_000_000, leaseMs: 1_000, now: () => t });
    await dead.enqueue('r1');
    // The dead process claimed the job and never finished it.
    let started = 0;
    await dead.work(
      async () => {
        started++;
        await new Promise(() => undefined);
      },
      { concurrency: 1 },
    );
    await until(() => started === 1);
    expect(jobs()).toEqual([{ run_id: 'r1', state: 'active', attempts: 0 }]);
    const other = createDatabase(file, { name: 'next-pod' });
    try {
      const seen: string[] = [];
      const q = make(other, { now: () => t });
      await q.work(async (id) => void seen.push(id), { concurrency: 1 });
      await settle(60);
      expect(seen).toEqual([]); // lease still valid
      t += 2_000;
      await until(() => seen.length === 1);
      await until(() => jobs().length === 0);
    } finally {
      await other.close();
    }
  });

  it('a handler that stalled past its lease, finishing late, does not end the claim that took over', async () => {
    let t = Date.now();
    const q = make(database, { leaseMs: 1_000, renewMs: 1_000_000, now: () => t });
    const finish: Array<() => void> = [];
    await q.work(() => new Promise<void>((resolve) => finish.push(resolve)), { concurrency: 2 });
    await q.enqueue('r1');
    await until(() => finish.length === 1);
    t += 2_000; // the first handler stalled: its lease ran out, and the job is claimed again
    await until(() => finish.length === 2);
    finish[0]!(); // the stale handler finally returns…
    await settle(40);
    expect(jobs()).toEqual([{ run_id: 'r1', state: 'active', attempts: 1 }]); // …and the new claim still holds the job
    finish[1]!();
    await until(() => jobs().length === 0);
  });

  it('a shutdown aborts what is still running and queues it again', async () => {
    const q = make(database, { gracefulMs: 30 });
    let aborted = false;
    await q.work(
      (_id, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        }),
      { concurrency: 1 },
    );
    await q.enqueue('r1');
    await until(() => jobs()[0]?.state === 'active');
    await q.stop();
    expect(aborted).toBe(true);
    expect(jobs()).toEqual([{ run_id: 'r1', state: 'queued', attempts: 0 }]);
  });
});
