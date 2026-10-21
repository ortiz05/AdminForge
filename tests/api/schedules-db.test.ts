import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { ScheduleEvents, type ScheduleEvent } from '@adminforge/api/src/schedules/events';
import { leaseLock } from '@adminforge/api/src/schedules/leader';
import { SqliteScheduleStore } from '@adminforge/api/src/schedules/sqlite-store';
import type { ScheduleApprovalPolicy } from '@adminforge/api/src/schedules/types';
import { syncSchedules } from '@adminforge/api/src/schedules/sync';
import { schedule } from '../support/scheduler';
import { testDatabasePath } from './db';

const file = await testDatabasePath();
const NOW = new Date('2026-10-15T12:07:00.000Z');

// Children first (probe results point at schedule runs, schedule runs at schedules), and a schedule's approvals only
// once the schedule is gone (the approvals_delete_with_subject trigger).
const RESET = `delete from probe_results; delete from schedule_runs; delete from schedules;
  delete from approvals where subject_type = 'schedule';`;

describe('scheduler on SQLite', () => {
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

  it('syncs content into schedules and guards concurrent updates', async () => {
    const def = schedule('sweep.a');
    expect(await syncSchedules(store, [{ key: 'sweep.a', def, sha256: 'sha-1' }], NOW)).toEqual({
      inserted: ['sweep.a'],
      updated: [],
    });
    const row = (await store.getSchedule('sweep.a'))!;
    expect(row).toMatchObject({
      key: 'sweep.a',
      source: 'content',
      enabled: true,
      sha256: 'sha-1',
      nextRunAt: new Date('2026-10-15T12:15:00Z'),
      definition: { cron: '*/15 * * * *', job: { kind: 'probe', ref: 'probes.example' } },
    });
    expect(
      await store.insertSchedule({
        key: 'sweep.a',
        source: 'content',
        definition: def,
        sha256: 'other',
        enabled: false,
        nextRunAt: null,
      }),
    ).toBeNull();
    // Optimistic claim of a due tick: only the first matching update wins.
    expect(
      await store.updateSchedule(
        row.id,
        { nextRunAt: new Date('2026-10-15T12:30:00Z') },
        { nextRunAt: row.nextRunAt },
      ),
    ).toMatchObject({ nextRunAt: new Date('2026-10-15T12:30:00Z') });
    expect(
      await store.updateSchedule(
        row.id,
        { nextRunAt: new Date('2026-10-15T12:45:00Z') },
        { nextRunAt: row.nextRunAt },
      ),
    ).toBeNull();
    expect(await store.updateSchedule(row.id, { enabled: false }, { sha256: 'stale' })).toBeNull();
    expect((await store.getScheduleById(row.id))!.key).toBe('sweep.a');
  });

  it('stores runs, claims queued ones once, and pages history', async () => {
    const row = (await store.insertSchedule({
      key: 'sweep.b',
      source: 'content',
      definition: schedule('sweep.b'),
      sha256: 's',
      enabled: true,
      nextRunAt: NOW,
    }))!;
    const runs = [];
    for (let i = 0; i < 4; i++)
      runs.push(
        await store.insertRun({
          scheduleId: row.id,
          scheduleKey: row.key,
          trigger: 'cron',
          status: 'succeeded',
          startedAt: new Date(Date.UTC(2026, 9, 15, i)),
          result: { i },
        }),
      );
    const queued = await store.insertRun({
      scheduleId: row.id,
      scheduleKey: row.key,
      trigger: 'manual',
      status: 'queued',
      startedAt: NOW,
      result: { requestedBy: 'avery@example.com' },
    });
    expect((await store.runsInStatus(['queued'])).map((r) => r.id)).toEqual([queued.id]);
    expect(await store.updateRun(queued.id, { status: 'running', startedAt: NOW }, 'queued')).toMatchObject({
      status: 'running',
      result: { requestedBy: 'avery@example.com' },
    });
    expect(await store.updateRun(queued.id, { status: 'running' }, 'queued')).toBeNull();
    await store.updateRun(
      queued.id,
      { status: 'failed', endedAt: NOW, error: { code: 'upstream_error', message: 'x' } },
      'running',
    );
    const page1 = await store.listRuns(row.id, { limit: 2 });
    expect(page1.map((r) => r.status)).toEqual(['failed', 'succeeded']);
    const page2 = await store.listRuns(row.id, {
      limit: 10,
      before: { startedAt: page1[1]!.startedAt, id: page1[1]!.id },
    });
    expect(page2.map((r) => r.result?.i)).toEqual([2, 1, 0]);
    expect(await store.getRun(queued.id)).toMatchObject({ error: { code: 'upstream_error' } });
  });

  it('keeps probe results as a time series with details', async () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 15, h));
    for (const h of [8, 9, 10, 11])
      await store.insertProbeResult({
        probeKey: 'probes.a',
        ts: at(h),
        status: h === 11 ? 'warn' : 'ok',
        metric: h,
        durationMs: 5,
        message: `m${h}`,
        details: { rows: [{ h }] },
        scheduleRunId: null,
      });
    await store.insertProbeResult({
      probeKey: 'probes.b',
      ts: at(9),
      status: 'error',
      metric: null,
      durationMs: 1,
      message: 'not configured',
      details: null,
      scheduleRunId: null,
    });
    expect((await store.latestProbeResults()).map((r) => [r.probeKey, r.status, r.metric])).toEqual([
      ['probes.a', 'warn', 11],
      ['probes.b', 'error', null],
    ]);
    const series = await store.probeSeries(at(9), 2);
    expect(series.map((r) => [r.probeKey, r.metric, r.details])).toEqual([
      ['probes.a', 11, null],
      ['probes.a', 10, null],
      ['probes.b', null, null],
    ]);
    expect((await store.probeResults('probes.a', at(10), 10)).map((r) => r.details)).toEqual([
      { rows: [{ h: 11 }] },
      { rows: [{ h: 10 }] },
    ]);
  });

  it('keeps schedule approvals apart from run approvals', async () => {
    const policy = {
      kind: 'approval',
      action: 'enable',
      approvers: ['Playbook.Approver'],
      minApprovals: 1,
      title: 't',
      message: 'm',
      definitionKey: 'ops.x',
      definitionVersion: '1.0.0',
      sha256: 's',
      requestedByUpn: 'avery@example.com',
      initiatorOid: 'a',
      writesAfter: false,
    } satisfies ScheduleApprovalPolicy;
    const a = await store.insertApproval({ subjectId: 'ops.x', policy, requestedBy: 'a', expiresAt: null });
    expect(await store.getApproval(a.id)).toMatchObject({
      subjectType: 'schedule',
      subjectId: 'ops.x',
      status: 'pending',
      decisions: [],
    });
    expect((await store.listApprovals({ status: 'pending', subjectId: 'ops.x' })).map((x) => x.id)).toEqual([
      a.id,
    ]);
    const decided = await store.updateApproval(
      a.id,
      {
        status: 'approved',
        decisions: [
          { oid: 'b', upn: 'blake@example.com', decision: 'approve', comment: null, at: NOW.toISOString() },
        ],
        decidedAt: NOW,
      },
      'pending',
    );
    expect(decided).toMatchObject({ status: 'approved' });
    expect(await store.updateApproval(a.id, { status: 'rejected' }, 'pending')).toBeNull();
  });

  it('lets exactly one process hold the scheduler lock; a standby gets it after release', async () => {
    // Two processes on the same file: each has its own connection and its own holder id.
    const pa = createDatabase(file, { name: 'scheduler-a', pollSignals: false });
    const pb = createDatabase(file, { name: 'scheduler-b', pollSignals: false });
    try {
      const a = leaseLock(pa, { name: 'adminforge.scheduler.test' });
      const b = leaseLock(pb, { name: 'adminforge.scheduler.test' });
      expect(await a.tryAcquire()).toBe(true);
      expect(await b.tryAcquire()).toBe(false);
      expect(await a.check()).toBe(true);
      await a.release();
      expect(await a.check()).toBe(false);
      expect(await b.tryAcquire()).toBe(true);
      await b.release();
    } finally {
      await pa.close();
      await pb.close();
    }
  });

  it('frees the lock of a leader that stopped renewing once its lease expires (a dead process)', async () => {
    // The equivalent of Postgres releasing a dead session's advisory lock: nobody releases it, the lease runs out.
    let t = NOW.getTime();
    const clock = { now: () => t, ttlMs: 30_000, name: 'adminforge.scheduler.expiry' };
    const pa = createDatabase(file, { name: 'scheduler-a', pollSignals: false });
    const pb = createDatabase(file, { name: 'scheduler-b', pollSignals: false });
    try {
      const a = leaseLock(pa, clock);
      const b = leaseLock(pb, clock);
      expect(await a.tryAcquire()).toBe(true);
      t += 29_000;
      expect(await b.tryAcquire()).toBe(false);
      // Renewing pushes the expiry out again.
      expect(await a.check()).toBe(true);
      t += 29_000;
      expect(await b.tryAcquire()).toBe(false);
      // a hangs: no renewal for longer than the lease.
      t += 31_000;
      expect(await b.tryAcquire()).toBe(true);
      // The old leader finds out at its next check and steps down.
      expect(await a.check()).toBe(false);
      expect(await a.tryAcquire()).toBe(false);
      await b.release();
    } finally {
      await pa.close();
      await pb.close();
    }
  });

  it('relays schedule events between processes with signals', async () => {
    // The API and a scheduler one-shot are two processes on the same file: each has its own connection, and the
    // scheduler sees the API's events on its next poll of the signals table (called directly instead of waiting).
    const apiDb = createDatabase(file, { name: 'api' });
    const schedulerDb = createDatabase(file, { name: 'scheduler' });
    const api = new ScheduleEvents({ signals: apiDb.signals });
    const scheduler = new ScheduleEvents({ signals: schedulerDb.signals });
    try {
      const seen: ScheduleEvent[] = [];
      scheduler.on((e) => seen.push(e));
      await scheduler.start();
      api.publish({ type: 'schedule.run_requested', data: { key: 'sweep.a', scheduleRunId: 'r1' } });
      expect(seen).toEqual([]);
      schedulerDb.signals.poll();
      expect(seen).toEqual([
        { type: 'schedule.run_requested', data: { key: 'sweep.a', scheduleRunId: 'r1' } },
      ]);
      // A process ignores its own echo: its listeners get the event at once, and its poller skips its own row (read
      // here because the API's next event changes the file under it).
      scheduler.publish({ type: 'schedules.changed', data: { key: 'x' } });
      api.publish({ type: 'schedule.updated', data: { key: 'y' } });
      schedulerDb.signals.poll();
      schedulerDb.signals.poll();
      expect(seen.map((e) => e.type)).toEqual([
        'schedule.run_requested',
        'schedules.changed',
        'schedule.updated',
      ]);
    } finally {
      await scheduler.stop();
      await api.stop();
      await apiDb.close();
      await schedulerDb.close();
    }
  });
});
