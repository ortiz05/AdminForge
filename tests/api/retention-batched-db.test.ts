import { randomUUID } from 'node:crypto';
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { createDatabase, reclaimSpace, type Database } from '@adminforge/api/src/db/client';
import { applyRetention } from '@adminforge/api/src/housekeeping/retention';
import { testDatabasePath } from './db';

// D-02: retention shares the event loop with HTTP, runs and schedules (better-sqlite3 is synchronous). Every purge
// deletes in batches of 2,000 rows and lets the loop run between them, a pass stops at its time budget (the rest goes
// next pass), and handing free pages back to the file system happens in steps too.
const file = await testDatabasePath();
const NOW = new Date('2026-10-15T12:00:00Z');
const DAY = 86_400_000;
const POLICY = { runDays: 180, scheduleRunDays: 180, probeDays: 35, artifactDays: 90 };
const SCHEDULE_ID = '00000000-0000-4000-8000-00000000c0de';
const RESET = `delete from probe_results; delete from schedule_runs; delete from schedules;`;

describe('retention in batches (SQLite)', () => {
  let database: Database;
  beforeAll(() => {
    database = createDatabase(file);
  });
  beforeEach(() => {
    database.sqlite.exec(RESET);
  });
  afterAll(async () => {
    await database?.close();
  });

  const count = (table: string) =>
    (database.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

  function probeRows(n: number, daysAgo: number) {
    const insert = database.sqlite.prepare(
      `insert into probe_results (probe_key, ts, status, metric, duration_ms, message) values (?, ?, 'ok', 1, 1, ?)`,
    );
    const ts = NOW.getTime() - daysAgo * DAY;
    database.sqlite.transaction(() => {
      for (let i = 0; i < n; i++) insert.run('probes.example', ts, 'x'.repeat(200));
    })();
  }

  function scheduleRuns(n: number, daysAgo: number) {
    database.sqlite
      .prepare(
        `insert into schedules (id, key, source, definition, sha256, created_at, updated_at)
         values (?, 'sweep.example', 'content', '{}', 'a', ?, ?)`,
      )
      .run(SCHEDULE_ID, NOW.getTime(), NOW.getTime());
    const insert = database.sqlite.prepare(
      `insert into schedule_runs (id, schedule_id, schedule_key, trigger, status, started_at, ended_at)
       values (?, ?, 'sweep.example', 'cron', 'succeeded', ?, ?)`,
    );
    const at = NOW.getTime() - daysAgo * DAY;
    database.sqlite.transaction(() => {
      for (let i = 0; i < n; i++) insert.run(randomUUID(), SCHEDULE_ID, at, at + 1000);
    })();
  }

  const audit = () => new MemoryAuditWriter(() => NOW);

  it('deletes 5,000 probe results in three batches and lets the event loop run between them', async () => {
    probeRows(5_000, 40);
    probeRows(10, 1);
    // An immediate callback queued before the purge runs at its first yield: after one batch, not after all of it.
    const seen: number[] = [];
    setImmediate(() => seen.push(count('probe_results')));
    const result = await applyRetention(database.db, { artifacts: null, audit: audit(), now: NOW }, POLICY);
    expect(result.probeResults).toBe(5_000);
    expect(result.pending).toBe(false);
    expect(seen).toEqual([3_010]);
    expect(count('probe_results')).toBe(10);
  });

  it('batches schedule run history the same way', async () => {
    scheduleRuns(4_500, 200);
    const seen: number[] = [];
    setImmediate(() => seen.push(count('schedule_runs')));
    const result = await applyRetention(database.db, { artifacts: null, audit: audit(), now: NOW }, POLICY);
    expect(result.scheduleRuns).toBe(4_500);
    expect(seen).toEqual([2_500]);
    expect(count('schedule_runs')).toBe(0);
  });

  it('stops at its time budget and finishes on the next pass', async () => {
    probeRows(5_000, 40);
    // A clock that reads 0 at the start and 10 s ever after: the 2 s budget is spent after the first batch.
    let reads = 0;
    const clock = () => (reads++ === 0 ? 0 : 10_000);
    const log = audit();
    const first = await applyRetention(database.db, { artifacts: null, audit: log, now: NOW }, POLICY, {
      budgetMs: 2_000,
      clock,
    });
    expect(first.probeResults).toBe(2_000);
    expect(first.pending).toBe(true);
    expect(count('probe_results')).toBe(3_000);
    expect(log.rows.at(-1)).toMatchObject({
      action: 'housekeeping.retention',
      details: { probeResults: 2_000, pending: true },
    });

    const second = await applyRetention(database.db, { artifacts: null, audit: log, now: NOW }, POLICY);
    expect(second).toMatchObject({ probeResults: 3_000, pending: false });
    expect(count('probe_results')).toBe(0);
  });

  it('writes no audit event when there was nothing to delete', async () => {
    const log = audit();
    const result = await applyRetention(database.db, { artifacts: null, audit: log, now: NOW }, POLICY);
    expect(result).toMatchObject({ probeResults: 0, scheduleRuns: 0, runs: 0, pending: false });
    expect(log.rows).toEqual([]);
  });

  it('hands free pages back in steps, yielding to the event loop between them', async () => {
    expect(database.sqlite.pragma('auto_vacuum', { simple: true })).toBe(2);
    probeRows(5_000, 40);
    await applyRetention(database.db, { artifacts: null, audit: audit(), now: NOW }, POLICY);
    const free = database.sqlite.pragma('freelist_count', { simple: true }) as number;
    expect(free).toBeGreaterThan(30);

    const seen: number[] = [];
    setImmediate(() => seen.push(database.sqlite.pragma('freelist_count', { simple: true }) as number));
    const r = await reclaimSpace(database.sqlite, { pagesPerStep: 10 });
    expect(r).toEqual({ pages: free, pending: false });
    // The callback ran after the first step, with pages still to go.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(free - 10);
    expect(database.sqlite.pragma('freelist_count', { simple: true })).toBe(0);
  });

  it('stops reclaiming at its time budget, leaving the rest for the next pass', async () => {
    probeRows(5_000, 40);
    await applyRetention(database.db, { artifacts: null, audit: audit(), now: NOW }, POLICY);
    const free = database.sqlite.pragma('freelist_count', { simple: true }) as number;
    let reads = 0;
    const clock = () => (reads++ === 0 ? 0 : 10_000);
    const r = await reclaimSpace(database.sqlite, { pagesPerStep: 10, budgetMs: 1_500, clock });
    expect(r).toEqual({ pages: 10, pending: true });
    expect(database.sqlite.pragma('freelist_count', { simple: true })).toBe(free - 10);
    await reclaimSpace(database.sqlite);
    expect(database.sqlite.pragma('freelist_count', { simple: true })).toBe(0);
  });
});
