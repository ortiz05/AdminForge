import { SqliteAuditWriter } from '@adminforge/api/src/audit/writer';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { ScheduleEvents } from '@adminforge/api/src/schedules/events';
import { Scheduler } from '@adminforge/api/src/schedules/scheduler';
import { SqliteScheduleStore } from '@adminforge/api/src/schedules/sqlite-store';
import { FakeClock, FakeDefinitions, FakeJobs, schedule } from '../support/scheduler';
import { testDatabasePath } from './db';

// F-09 on the database: the missed tick's row passes the schedule_runs status CHECK (`skipped`, no migration) with
// its error stored, the schedule shows it as its last run, and the audit chain holds the event.
const file = await testDatabasePath();
const RESET = `delete from probe_results; delete from schedule_runs; delete from schedules;`;

describe('a missed tick on SQLite', () => {
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

  it('is stored as a skipped run with schedule_missed and audited', async () => {
    const clock = new FakeClock();
    const store = new SqliteScheduleStore(database.db);
    const audit = new SqliteAuditWriter(database.db, clock.now, null);
    const jobs = new FakeJobs();
    const defs = new FakeDefinitions().set(schedule('reports.daily', { cron: '0 7 * * *' }));
    const scheduler = new Scheduler({
      store,
      definitions: defs,
      jobs,
      audit,
      events: new ScheduleEvents(),
      now: clock.now,
      timers: clock,
    });
    await scheduler.start();
    const row = (await store.getSchedule('reports.daily'))!;
    const due = new Date(clock.t - 5 * 3_600_000);
    await store.updateSchedule(row.id, { nextRunAt: due });
    await scheduler.tick();

    expect(jobs.calls).toHaveLength(0);
    const [run] = await store.listRuns(row.id, { limit: 10 });
    expect(run).toMatchObject({
      status: 'skipped',
      trigger: 'cron',
      startedAt: due,
      error: { code: 'schedule_missed', hint: expect.stringContaining('run the schedule now') },
      result: { missedAt: due.toISOString() },
    });
    expect(run!.error!.message).toMatch(/^AdminForge wasn’t running at \d\d:\d\d on \d+ \w{3} \d{4} \(UTC\)/);
    expect(await store.getSchedule('reports.daily')).toMatchObject({ lastStatus: 'skipped', lastRunAt: due });
    const events = database.sqlite
      .prepare(`select action, details from audit_events where target_id = 'reports.daily'`)
      .all() as Array<{ action: string; details: string }>;
    expect(events.map((e) => [e.action, JSON.parse(e.details).error])).toEqual([
      ['schedule.run', 'schedule_missed'],
    ]);
    expect(await audit.verify()).toMatchObject({ ok: true });
    await scheduler.stop();
  });
});
