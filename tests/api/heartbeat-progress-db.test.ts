import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import {
  componentHealth,
  componentStates,
  Heartbeat,
  HEARTBEAT_MS,
  STALE_MS,
} from '@adminforge/api/src/health/heartbeat';
import { ArtifactStore } from '@adminforge/api/src/artifacts/store';
import { ScheduleEvents } from '@adminforge/api/src/schedules/events';
import { Scheduler } from '@adminforge/api/src/schedules/scheduler';
import { ScheduleService } from '@adminforge/api/src/schedules/service';
import { SqliteScheduleStore } from '@adminforge/api/src/schedules/sqlite-store';
import { FakeClock, FakeDefinitions, FakeJobs, flush, schedule } from '../support/scheduler';
import { testDatabasePath } from './db';

// D-09: /readyz runs in the same process and event loop as the scheduler, so a heartbeat on a timer only proved the
// process was alive (/healthz says that). The scheduler now beats from its ticks: a scheduler whose ticks fail, or
// that doesn't hold the lease, goes stale while the process keeps answering — alive, but not working.
const file = await testDatabasePath();

/** The SQLite store, with a switch that makes every tick fail (the database refusing, a bug in a pass). */
class FlakyStore extends SqliteScheduleStore {
  broken = false;
  override async listSchedules() {
    if (this.broken) throw new Error('disk I/O error');
    return super.listSchedules();
  }
}

describe('heartbeats from progress (SQLite)', () => {
  let database: Database;
  beforeAll(() => {
    database = createDatabase(file);
  });
  beforeEach(() => {
    database.sqlite.exec("delete from settings where key like 'heartbeat:%'; delete from schedules;");
  });
  afterAll(async () => {
    await database?.close();
  });

  const scheduler = () => componentStates(database.db, new Date(clock.t)).then((s) => s.scheduler);
  let clock: FakeClock;

  it('progress beats at most once per interval', async () => {
    clock = new FakeClock();
    const hb = new Heartbeat(database.db, 'scheduler', clock.now);
    hb.progress();
    await hb.settled();
    const first = (await componentHealth(database.db, new Date(clock.t))).scheduler;
    expect(first).toEqual({ state: 'ok', at: new Date(clock.t).toISOString() });
    await clock.advance(HEARTBEAT_MS - 1_000);
    hb.progress();
    await hb.settled();
    expect((await componentHealth(database.db, new Date(clock.t))).scheduler.at).toBe(first.at);
    await clock.advance(1_000);
    hb.progress();
    await hb.settled();
    expect((await componentHealth(database.db, new Date(clock.t))).scheduler.at).toBe(
      new Date(clock.t).toISOString(),
    );
  });

  it('a failed write is reported and retried at the next progress', async () => {
    clock = new FakeClock();
    const errors: unknown[] = [];
    const closed = createDatabase(file);
    await closed.close();
    const hb = new Heartbeat(closed.db, 'scheduler', clock.now, (err) => errors.push(err));
    hb.progress();
    await hb.settled();
    expect(errors).toHaveLength(1);
    hb.progress();
    await hb.settled();
    expect(errors).toHaveLength(2);
  });

  it('the scheduler beats while its ticks work and goes stale when they fail, though the process runs on', async () => {
    clock = new FakeClock();
    const store = new FlakyStore(database.db);
    const hb = new Heartbeat(database.db, 'scheduler', clock.now);
    const s = new Scheduler({
      store,
      definitions: new FakeDefinitions().set(schedule('sweep.a')),
      jobs: new FakeJobs(),
      audit: new MemoryAuditWriter(clock.now),
      events: new ScheduleEvents(),
      now: clock.now,
      timers: clock,
      onProgress: () => hb.progress(),
    });
    await s.start();
    await flush();
    await hb.settled();
    expect(await scheduler()).toBe('ok');

    // Idle but healthy: ticks every 30 s keep it fresh.
    await clock.advance(5 * 60_000);
    await hb.settled();
    expect(await scheduler()).toBe('ok');

    store.broken = true;
    await clock.advance(STALE_MS + HEARTBEAT_MS);
    expect(await scheduler()).toBe('stale');

    store.broken = false;
    await clock.advance(HEARTBEAT_MS);
    await hb.settled();
    expect(await scheduler()).toBe('ok');
    await s.stop();
  });

  it('a scheduler that lost its lease stops beating', async () => {
    clock = new FakeClock();
    const hb = new Heartbeat(database.db, 'scheduler', clock.now);
    const s = new Scheduler({
      store: new SqliteScheduleStore(database.db),
      definitions: new FakeDefinitions(),
      jobs: new FakeJobs(),
      audit: new MemoryAuditWriter(clock.now),
      events: new ScheduleEvents(),
      now: clock.now,
      timers: clock,
      onProgress: () => hb.progress(),
    });
    await s.start();
    await flush();
    await hb.settled();
    expect(await scheduler()).toBe('ok');
    await s.demoted('lease lost');
    await clock.advance(STALE_MS + HEARTBEAT_MS);
    s.wake();
    await s.tick();
    expect(await scheduler()).toBe('stale');
    await s.stop();
  });

  it('the schedule list says whether the scheduler is working, and since when it is not', async () => {
    clock = new FakeClock();
    const dir = mkdtempSync(path.join(tmpdir(), 'af-heartbeat-'));
    const service = new ScheduleService({
      store: new SqliteScheduleStore(database.db),
      definitions: new FakeDefinitions().set(schedule('sweep.a')),
      audit: new MemoryAuditWriter(clock.now),
      events: new ScheduleEvents(),
      artifacts: new ArtifactStore(dir),
      now: clock.now,
      schedulerHealth: async () => (await componentHealth(database.db, clock.now())).scheduler,
    });
    const hb = new Heartbeat(database.db, 'scheduler', clock.now);
    expect((await service.list()).scheduler).toEqual({ state: 'missing', at: null });
    hb.progress();
    await hb.settled();
    const at = new Date(clock.t).toISOString();
    expect((await service.list()).scheduler).toEqual({ state: 'ok', at });
    await clock.advance(STALE_MS + 1_000);
    const list = await service.list();
    expect(list.scheduler).toEqual({ state: 'stale', at });
    expect(list.items.map((i) => i.key)).toEqual(['sweep.a']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('missing until anything beats', async () => {
    expect(await componentHealth(database.db, new Date())).toEqual({
      worker: { state: 'missing', at: null },
      scheduler: { state: 'missing', at: null },
    });
  });
});
