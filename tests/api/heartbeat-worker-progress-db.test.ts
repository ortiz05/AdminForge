import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { SqliteRunQueue } from '@adminforge/api/src/runs/queue';
import { testDatabasePath } from './db';

// The run worker's heartbeat comes from its queue (D-09): it beats when a poll of `run_jobs` went through, so a
// worker whose polls fail goes stale on /readyz while the process keeps answering /healthz.
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('run queue progress (worker heartbeat)', () => {
  let database: Database;
  let queue: SqliteRunQueue | null = null;

  beforeEach(async () => {
    database = createDatabase(await testDatabasePath());
  });
  afterEach(async () => {
    await queue?.stop();
    queue = null;
    await database.close();
  });

  it('reports progress after each poll that went through, and only while it consumes', async () => {
    let polls = 0;
    queue = new SqliteRunQueue(database, undefined, { pollMs: 20, onPoll: () => polls++ });
    await queue.enqueue('run-1');
    expect(polls).toBe(0);

    await queue.work(async () => undefined, { concurrency: 1 });
    await settle(120);
    expect(polls).toBeGreaterThan(1);

    await queue.stop();
    const stopped = polls;
    await settle(80);
    expect(polls).toBe(stopped);
  });

  it('reports no progress while its polls fail', async () => {
    let polls = 0;
    const log = { warn: () => undefined };
    queue = new SqliteRunQueue(database, log, { pollMs: 20, onPoll: () => polls++ });
    database.sqlite.exec('drop table run_jobs');
    await queue.work(async () => undefined, { concurrency: 1 });
    await settle(120);
    expect(polls).toBe(0);
  });
});
