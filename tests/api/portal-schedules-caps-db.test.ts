import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { applyRetention } from '@adminforge/api/src/housekeeping/retention';
import { SqliteScheduleStore } from '@adminforge/api/src/schedules/sqlite-store';
import type { NewSchedule } from '@adminforge/api/src/schedules/types';
import { Schedule } from '@adminforge/schemas';
import { testDatabasePath } from './db';

// Portal schedule caps are counted and the row inserted in one write transaction (BEGIN IMMEDIATE holds the file's write
// lock, so simultaneous requests — from any process — can't pass a cap), and housekeeping removes deleted portal
// schedules once no run history is left.

const file = await testDatabasePath();
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const POLICY = { runDays: 180, scheduleRunDays: 180, probeDays: 35, artifactDays: 90 };
// Schedule runs point at their schedule, so they go first.
const RESET = 'delete from schedule_runs; delete from schedules;';

function portalRow(key: string, createdBy: string, status?: 'retired'): NewSchedule & { createdBy: string } {
  return {
    key,
    source: 'portal',
    definition: Schedule.parse({
      kind: 'schedule',
      id: key,
      version: '1.0.0',
      title: 'Seed',
      owner: 'seed@example.com',
      cron: '0 6 * * 1',
      job: { kind: 'report', ref: 'identity.x', delivery: [{ type: 'file', format: 'xlsx' }] },
      ...(status ? { status } : {}),
    }),
    sha256: `sha-${key}`,
    enabled: false,
    nextRunAt: null,
    createdBy,
  };
}

describe('portal schedules on SQLite: caps and housekeeping', () => {
  let db: Database;
  let store: SqliteScheduleStore;
  beforeAll(() => {
    db = createDatabase(file);
    store = new SqliteScheduleStore(db.db);
  });
  beforeEach(() => {
    db.sqlite.exec(RESET);
  });
  afterAll(async () => {
    db.sqlite.exec(RESET);
    await db.close();
  });
  const count = () => (db.sqlite.prepare('select count(*) as n from schedules').get() as { n: number }).n;

  it('lets exactly perCreator of many simultaneous requests through', async () => {
    // Half the requests come through a second connection (another process on the same file): each count is read
    // inside the write transaction, so it includes what the other connection committed.
    const other = createDatabase(file, { name: 'api-2', pollSignals: false });
    try {
      const stores = [store, new SqliteScheduleStore(other.db)];
      const caps = { total: 200, perCreator: 3, recent: 50, since: new Date(Date.now() - 86_400_000) };
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          stores[i % 2]!.insertPortalSchedule(portalRow(`portal.a-${i}`, A), caps),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      expect(results.filter((r) => !r.ok).map((r) => (r.ok ? null : r.reason))).toEqual(
        Array(9).fill('perCreator'),
      );
      expect(count()).toBe(3);
    } finally {
      await other.close();
    }
  });

  it('applies the total, recent (deleted rows count) and duplicate-key outcomes', async () => {
    const since = new Date(Date.now() - 86_400_000);
    await store.insertSchedule(portalRow('portal.a-old', A, 'retired'));
    expect(
      await store.insertPortalSchedule(portalRow('portal.a-1', A), {
        total: 9,
        perCreator: 9,
        recent: 1,
        since,
      }),
    ).toEqual({ ok: false, reason: 'recent' });
    expect(
      (
        await store.insertPortalSchedule(portalRow('portal.b-1', B), {
          total: 1,
          perCreator: 9,
          recent: 9,
          since,
        })
      ).ok,
    ).toBe(true);
    expect(
      await store.insertPortalSchedule(portalRow('portal.a-2', A), {
        total: 1,
        perCreator: 9,
        recent: 9,
        since,
      }),
    ).toEqual({ ok: false, reason: 'total' });
    expect(
      await store.insertPortalSchedule(portalRow('portal.b-1', A), {
        total: 9,
        perCreator: 9,
        recent: 9,
        since,
      }),
    ).toEqual({ ok: false, reason: 'exists' });
  });

  it('housekeeping removes deleted portal schedules without run history, a day after creation', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 3 * 86_400_000);
    const insert = async (key: string, status?: 'retired') =>
      (await store.insertSchedule(portalRow(key, A, status)))!;
    const gone = await insert('portal.deleted-old', 'retired');
    const withRuns = await insert('portal.deleted-with-runs', 'retired');
    await insert('portal.deleted-today', 'retired');
    const active = await insert('portal.active-old');
    db.sqlite
      .prepare('update schedules set created_at = ? where id in (?, ?, ?)')
      .run(old.getTime(), gone.id, withRuns.id, active.id);
    await store.insertRun({
      scheduleId: withRuns.id,
      scheduleKey: withRuns.key,
      trigger: 'cron',
      status: 'succeeded',
      startedAt: new Date(now.getTime() - 86_400_000),
      endedAt: new Date(now.getTime() - 86_400_000),
    });
    const audit = new MemoryAuditWriter(() => now);
    const result = await applyRetention(db.db, { artifacts: null, audit, now }, POLICY);
    expect(result.portalSchedules).toBe(1);
    const left = (
      db.sqlite.prepare('select key from schedules order by key').all() as Array<{ key: string }>
    ).map((r) => r.key);
    expect(left).toEqual(['portal.active-old', 'portal.deleted-today', 'portal.deleted-with-runs']);
    expect(audit.rows.at(-1)).toMatchObject({
      action: 'housekeeping.retention',
      details: { portalSchedules: 1 },
    });
  });
});
