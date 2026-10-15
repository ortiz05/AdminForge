import { LeaderElector } from '@adminforge/api/src/schedules/leader';
import { Scheduler } from '@adminforge/api/src/schedules/scheduler';
import { FakeJobs, flush, harness, schedule } from './helpers';

const MIN = 60_000;
const WRITE_JOB = {
  job: { kind: 'playbook', ref: 'identity.disable-user', mode: 'write', approvedBy: ['approval-1'] },
};

async function started(h: ReturnType<typeof harness>) {
  await h.scheduler.start();
  await flush();
  return h;
}

const runsOf = async (h: ReturnType<typeof harness>, key: string) => {
  const s = (await h.store.getSchedule(key))!;
  return (await h.store.listRuns(s.id, { limit: 100 })).reverse();
};

describe('scheduler', () => {
  it('fires a due schedule once, records the run and audits "scheduled by X, executed as automation identity"', async () => {
    const h = await started(harness());
    h.defs.set(schedule('sweep.a'));
    await h.clock.advance(1);
    expect((await h.store.getSchedule('sweep.a'))!.nextRunAt?.toISOString()).toBe('2026-10-15T12:15:00.000Z');
    expect(h.jobs.calls).toHaveLength(0);

    await h.clock.advance(15 * MIN);
    await h.scheduler.drain();
    expect(h.jobs.calls).toHaveLength(1);
    const [run] = await runsOf(h, 'sweep.a');
    expect(run).toMatchObject({
      trigger: 'cron',
      status: 'succeeded',
      result: { ok: true },
      startedAt: new Date('2026-10-15T12:15:00Z'),
    });
    expect(await h.store.getSchedule('sweep.a')).toMatchObject({
      lastStatus: 'succeeded',
      lastRunAt: new Date('2026-10-15T12:15:00Z'),
      nextRunAt: new Date('2026-10-15T12:30:00Z'),
    });
    const audit = h.audit.rows.find((r) => r.action === 'schedule.run')!;
    expect(audit).toMatchObject({
      actorOid: 'automation',
      actorUpn: 'automation identity',
      mode: 'read',
      targetId: 'sweep.a',
      result: 'success',
    });
    expect(audit.details).toMatchObject({
      summary: 'Scheduled by content (owner: test-team), executed as automation identity.',
      trigger: 'cron',
      executedAs: 'automation identity',
      scheduleRunId: run!.id,
    });
    expect(h.published.filter((e) => e.type === 'schedule.updated').map((e) => e.data.status)).toEqual([
      'running',
      'succeeded',
    ]);
    await h.scheduler.stop();
  });

  it('skips a tick while the previous run is still going (overlap: skip)', async () => {
    const jobs = new FakeJobs();
    jobs.manual = true;
    const h = await started(harness({ jobs }));
    h.defs.set(schedule('sweep.a', { timeoutSeconds: 3600 }));
    await h.clock.advance(15 * MIN);
    await h.clock.advance(15 * MIN);
    expect((await runsOf(h, 'sweep.a')).map((r) => r.status)).toEqual(['running', 'skipped']);
    jobs.finish();
    await h.scheduler.drain();
    expect((await runsOf(h, 'sweep.a')).map((r) => r.status)).toEqual(['succeeded', 'skipped']);
    await h.scheduler.stop();
  });

  it('queues the tick instead with overlap: queue, and runs it when the first one ends', async () => {
    const jobs = new FakeJobs();
    jobs.manual = true;
    const h = await started(harness({ jobs }));
    h.defs.set(schedule('sweep.q', { overlap: 'queue', timeoutSeconds: 3600 }));
    await h.clock.advance(15 * MIN);
    await h.clock.advance(15 * MIN);
    expect((await runsOf(h, 'sweep.q')).map((r) => r.status)).toEqual(['running', 'queued']);
    jobs.finish();
    await flush();
    await h.clock.advance(1);
    expect((await runsOf(h, 'sweep.q')).map((r) => r.status)).toEqual(['succeeded', 'running']);
    jobs.finish();
    await h.scheduler.drain();
    expect(jobs.calls).toHaveLength(2);
    await h.scheduler.stop();
  });

  it('retries failures with backoff, then raises schedule.failed for each failure', async () => {
    const jobs = new FakeJobs(() => ({
      status: 'failed',
      error: { code: 'upstream_error', message: 'Graph returned 503' },
    }));
    const h = await started(harness({ jobs }));
    h.defs.set(
      schedule('reports.r', { cron: '0 6 * * *', retry: { max: 2, backoff: 'exponential', delay: '1m' } }),
    );
    await h.clock.advance(18 * 60 * MIN); // to 06:00 next day
    await h.scheduler.drain();
    expect((await runsOf(h, 'reports.r')).map((r) => [r.trigger, r.status])).toEqual([
      ['cron', 'failed'],
      ['retry', 'queued'],
    ]);
    await h.clock.advance(1 * MIN);
    await h.scheduler.drain();
    await h.clock.advance(2 * MIN);
    await h.scheduler.drain();
    await h.clock.advance(10 * MIN);
    const runs = await runsOf(h, 'reports.r');
    expect(runs.map((r) => [r.trigger, r.status, r.result?.attempt ?? 0])).toEqual([
      ['cron', 'failed', 0],
      ['retry', 'failed', 1],
      ['retry', 'failed', 2],
    ]);
    expect(runs[1]!.startedAt.getTime() - runs[0]!.endedAt!.getTime()).toBe(1 * MIN);
    expect(runs[2]!.startedAt.getTime() - runs[1]!.endedAt!.getTime()).toBe(2 * MIN);
    expect(h.audit.rows.filter((r) => r.action === 'schedule.failed')).toHaveLength(3);
    const failed = h.published.filter((e) => e.type === 'schedule.failed');
    expect(
      failed.map((e) => [e.data.key, (e.data.error as { code: string }).code, 'retryAt' in e.data]),
    ).toEqual([
      ['reports.r', 'upstream_error', true],
      ['reports.r', 'upstream_error', true],
      ['reports.r', 'upstream_error', false],
    ]);
    await h.scheduler.stop();
  });

  it('stops a run at timeoutSeconds and records it as timed out', async () => {
    const jobs = new FakeJobs();
    jobs.manual = true;
    const h = await started(harness({ jobs }));
    h.defs.set(schedule('sweep.slow', { timeoutSeconds: 60 }));
    await h.clock.advance(15 * MIN);
    expect(jobs.pending).toBe(1);
    await h.clock.advance(60_000);
    await h.scheduler.drain();
    const [run] = await runsOf(h, 'sweep.slow');
    expect(run).toMatchObject({ status: 'timeout', error: { code: 'timeout' } });
    expect(jobs.calls[0]!.signal.aborted).toBe(true);
    expect(h.published.some((e) => e.type === 'schedule.failed' && e.data.status === 'timeout')).toBe(true);
    await h.scheduler.stop();
  });

  it('refuses to run a write-capable schedule nobody approved (and does not retry)', async () => {
    const h = await started(harness());
    h.defs.set(schedule('ops.write', { ...WRITE_JOB, retry: { max: 3 } }));
    await h.clock.advance(1);
    const row = (await h.store.getSchedule('ops.write'))!;
    expect(row.enabled).toBe(false);
    // Even if a row were enabled behind the scheduler's back, the run is refused.
    await h.store.updateSchedule(row.id, { enabled: true, nextRunAt: new Date(h.clock.t + MIN) });
    await h.clock.advance(2 * MIN);
    await h.scheduler.drain();
    const runs = await runsOf(h, 'ops.write');
    expect(runs.map((r) => [r.status, r.error?.code])).toEqual([['failed', 'approval_required']]);
    expect(h.jobs.calls).toHaveLength(0);
    expect(h.audit.rows.find((r) => r.action === 'schedule.run')).toMatchObject({
      mode: 'write',
      result: 'failure',
    });
    await h.scheduler.stop();
  });

  it('runs queued manual requests (even on a disabled schedule) and audits who asked', async () => {
    const h = await started(harness());
    h.defs.set(schedule('sweep.off', { enabled: false }));
    await h.clock.advance(1);
    const row = (await h.store.getSchedule('sweep.off'))!;
    const queued = await h.store.insertRun({
      scheduleId: row.id,
      scheduleKey: row.key,
      trigger: 'manual',
      status: 'queued',
      startedAt: h.clock.now(),
      result: { requestedBy: 'avery@example.com' },
    });
    h.scheduler.wake();
    await h.clock.advance(1);
    await h.scheduler.drain();
    expect(await h.store.getRun(queued.id)).toMatchObject({
      status: 'succeeded',
      trigger: 'manual',
      result: { ok: true, requestedBy: 'avery@example.com' },
    });
    expect(h.audit.rows.find((r) => r.action === 'schedule.run')!.details).toMatchObject({
      summary: 'Scheduled by avery@example.com, executed as automation identity.',
    });
    await h.scheduler.stop();
  });

  it('skips a tick missed while the scheduler was down for longer than the grace period', async () => {
    const h = await started(harness());
    h.defs.set(schedule('sweep.a'));
    await h.clock.advance(1);
    const row = (await h.store.getSchedule('sweep.a'))!;
    await h.store.updateSchedule(row.id, { nextRunAt: new Date(h.clock.t - 2 * 60 * MIN) });
    await h.scheduler.tick();
    expect(h.jobs.calls).toHaveLength(0);
    expect((await h.store.getSchedule('sweep.a'))!.nextRunAt?.toISOString()).toBe('2026-10-15T12:15:00.000Z');
    // A tick missed by less than the grace period runs once, late.
    await h.store.updateSchedule(row.id, { nextRunAt: new Date(h.clock.t - 10 * MIN) });
    await h.scheduler.tick();
    await h.scheduler.drain();
    expect(h.jobs.calls).toHaveLength(1);
    await h.scheduler.stop();
  });

  it('reaps runs a dead scheduler left running', async () => {
    const h = await started(harness());
    h.defs.set(schedule('sweep.a', { timeoutSeconds: 300 }));
    await h.clock.advance(1);
    const row = (await h.store.getSchedule('sweep.a'))!;
    const fresh = await h.store.insertRun({
      scheduleId: row.id,
      scheduleKey: row.key,
      trigger: 'cron',
      status: 'running',
      startedAt: new Date(h.clock.t - 60_000),
    });
    const dead = await h.store.insertRun({
      scheduleId: row.id,
      scheduleKey: row.key,
      trigger: 'cron',
      status: 'running',
      startedAt: new Date(h.clock.t - 30 * MIN),
    });
    await h.scheduler.tick();
    expect(await h.store.getRun(dead.id)).toMatchObject({ status: 'failed', error: { code: 'interrupted' } });
    expect(await h.store.getRun(fresh.id)).toMatchObject({ status: 'running' });
    await h.scheduler.stop();
  });

  it('holds jobs beyond the concurrency limit in the queue', async () => {
    const jobs = new FakeJobs();
    jobs.manual = true;
    const h = await started(harness({ jobs, concurrency: 1 }));
    h.defs.set(schedule('sweep.a')).set(schedule('sweep.b'));
    await h.clock.advance(15 * MIN);
    expect((await runsOf(h, 'sweep.a')).map((r) => r.status)).toEqual(['running']);
    expect((await runsOf(h, 'sweep.b')).map((r) => r.status)).toEqual(['queued']);
    jobs.finish();
    await flush();
    await h.clock.advance(1);
    expect((await runsOf(h, 'sweep.b')).map((r) => r.status)).toEqual(['running']);
    jobs.finish();
    await h.scheduler.drain();
    await h.scheduler.stop();
  });

  it('only the leader fires; losing the lock interrupts its runs', async () => {
    const jobs = new FakeJobs();
    jobs.manual = true;
    let held = true;
    const h = harness({ jobs });
    const leader = new LeaderElector(
      { tryAcquire: async () => held, check: async () => held, release: async () => undefined },
      {
        intervalMs: 5_000,
        timers: h.clock,
        onElected: () => sched.elected(),
        onDemoted: (r) => sched.demoted(r),
      },
    );
    const sched: Scheduler = new Scheduler({
      store: h.store,
      definitions: h.defs,
      jobs,
      audit: h.audit,
      events: h.events,
      now: h.clock.now,
      timers: h.clock,
      leader,
    });
    h.defs.set(schedule('sweep.a'));
    await sched.start();
    expect(sched.isLeader).toBe(true);
    await h.clock.advance(15 * MIN);
    expect(jobs.pending).toBe(1);
    held = false;
    await h.clock.advance(5_000);
    await sched.drain();
    expect(sched.isLeader).toBe(false);
    expect((await runsOf(h, 'sweep.a')).map((r) => [r.status, r.error?.code])).toEqual([
      ['failed', 'interrupted'],
    ]);
    // A standby (not leader) never fires.
    await h.clock.advance(60 * MIN);
    expect(jobs.calls).toHaveLength(1);
    await sched.stop();
  });

  it('shuts down gracefully: lets a running job finish, then stops firing', async () => {
    const jobs = new FakeJobs();
    jobs.manual = true;
    const h = await started(harness({ jobs }));
    h.defs.set(schedule('sweep.a'));
    await h.clock.advance(15 * MIN);
    const stopping = h.scheduler.stop(5_000);
    jobs.finish();
    await stopping;
    expect((await runsOf(h, 'sweep.a')).map((r) => r.status)).toEqual(['succeeded']);
    expect(h.scheduler.isLeader).toBe(false);
    await h.clock.advance(60 * MIN);
    expect(jobs.calls).toHaveLength(1);
  });

  it('runs one schedule on demand without leadership (CLI)', async () => {
    const h = harness();
    h.defs.set(schedule('sweep.a', { enabled: false }));
    const run = await h.scheduler.runOnce('sweep.a', 'cli:operator');
    expect(run).toMatchObject({
      status: 'succeeded',
      trigger: 'manual',
      result: { requestedBy: 'cli:operator' },
    });
    await expect(h.scheduler.runOnce('sweep.nope', 'cli:operator')).rejects.toThrow(/No schedule/);
  });
});
