import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { ScheduleEvents } from '@adminforge/api/src/schedules/events';
import type { JobContext, JobResult, JobRunner } from '@adminforge/api/src/schedules/jobs';
import { Scheduler, SETTLE_GRACE_MS } from '@adminforge/api/src/schedules/scheduler';
import { MemoryScheduleStore } from '@adminforge/api/src/schedules/store';
import { FakeClock, FakeDefinitions, flush, schedule } from '../support/scheduler';

// D-23a: when a run hits its time limit the scheduler records `timeout` at once, but the job itself may ignore the
// abort and run on — holding outbound slots and event-loop time in the one API process. Its scheduler slot (and its
// schedule's overlap) now stays taken until the job really settles, capped at SETTLE_GRACE_MS after the stop so a job
// that never ends can't pin a slot for good.
const MIN = 60_000;

/** Jobs that ignore their abort signal: each ends only when the test says so. */
class StubbornJobs implements JobRunner {
  readonly calls: JobContext[] = [];
  private readonly ends: Array<() => void> = [];
  run(ctx: JobContext): Promise<JobResult> {
    this.calls.push(ctx);
    return new Promise((resolve) => this.ends.push(() => resolve({ result: { ok: true } })));
  }
  /** Lets the oldest job finish (long after it was told to stop). */
  finish() {
    this.ends.shift()?.();
  }
}

function setup(
  defs = new FakeDefinitions()
    .set(schedule('sweep.slow', { cron: '15 12 * * *', timeoutSeconds: 60 }))
    .set(schedule('sweep.other', { cron: '17 12 * * *' })),
) {
  const clock = new FakeClock();
  const store = new MemoryScheduleStore(clock.now);
  const jobs = new StubbornJobs();
  const warnings: string[] = [];
  const scheduler = new Scheduler({
    store,
    definitions: defs,
    jobs,
    audit: new MemoryAuditWriter(clock.now),
    events: new ScheduleEvents(),
    now: clock.now,
    timers: clock,
    concurrency: 1,
    log: { warn: (_o, msg) => warnings.push(msg), error: () => undefined, info: () => undefined },
  });
  const runs = async (key: string) => {
    const s = (await store.getSchedule(key))!;
    return (await store.listRuns(s.id, { limit: 50 })).reverse().map((r) => r.status);
  };
  return { clock, store, jobs, scheduler, runs, warnings };
}

const IGNORED = 'scheduler: a job ignored its stop signal; its slot is free again';

describe('a scheduler slot after a run times out', () => {
  it('stays taken until the job itself ends, then the next run starts', async () => {
    const t = setup();
    await t.scheduler.start();
    await flush();
    // 12:00 → sweep.slow at 12:15 (60 s limit), sweep.other at 12:17; one slot.
    await t.clock.advance(15 * MIN);
    expect(await t.runs('sweep.slow')).toEqual(['running']);

    // The time limit: recorded at once, but the job ignores the abort and runs on.
    await t.clock.advance(61_000);
    expect(await t.runs('sweep.slow')).toEqual(['timeout']);
    expect(t.scheduler.activeRuns).toHaveLength(1);

    // sweep.other comes due: the only slot is still taken, so it waits in the queue.
    await t.clock.advance(MIN);
    expect(await t.runs('sweep.other')).toEqual(['queued']);
    expect(t.jobs.calls.map((c) => c.schedule.key)).toEqual(['sweep.slow']);

    // The stubborn job ends: its slot frees and the queued run starts.
    t.jobs.finish();
    await flush();
    await t.clock.advance(1);
    expect(t.jobs.calls.map((c) => c.schedule.key)).toEqual(['sweep.slow', 'sweep.other']);
    expect(await t.runs('sweep.other')).toEqual(['running']);
    expect(t.warnings).not.toContain(IGNORED);
    t.jobs.finish();
    await t.scheduler.stop(0);
  });

  it("keeps the schedule busy too: its next tick doesn't start a second copy beside the first", async () => {
    const t = setup(
      new FakeDefinitions().set(schedule('sweep.slow', { cron: '* * * * *', timeoutSeconds: 30 })),
    );
    await t.scheduler.start();
    await flush();
    await t.clock.advance(MIN + 31_000);
    expect(await t.runs('sweep.slow')).toEqual(['timeout']);
    // Its next minute comes while the first job still runs (inside the grace): skipped (overlap: skip).
    await t.clock.advance(30_000);
    expect(await t.runs('sweep.slow')).toEqual(['timeout', 'skipped']);
    expect(t.jobs.calls).toHaveLength(1);
    await t.scheduler.stop(0);
  });

  it('is freed SETTLE_GRACE_MS after the stop if the job never ends, with a warning', async () => {
    const t = setup(
      new FakeDefinitions().set(schedule('sweep.slow', { cron: '15 12 * * *', timeoutSeconds: 60 })),
    );
    await t.scheduler.start();
    await flush();
    await t.clock.advance(15 * MIN + 60_000);
    expect(await t.runs('sweep.slow')).toEqual(['timeout']);
    await t.clock.advance(SETTLE_GRACE_MS - 1_000);
    expect(t.scheduler.activeRuns).toHaveLength(1);
    await t.clock.advance(1_000);
    await flush();
    expect(t.scheduler.activeRuns).toHaveLength(0);
    expect(t.warnings).toContain(IGNORED);
    await t.scheduler.stop(0);
  });
});
