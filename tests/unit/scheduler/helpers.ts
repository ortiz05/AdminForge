/**
 * Scheduler unit-test harness: `harness(opts)` builds a `Scheduler` on an in-memory schedule store, fake content
 * (`FakeDefinitions`), a fake job runner (`FakeJobs`), an in-memory audit writer, the schedule event bus and a
 * `FakeClock` whose timers drive the scheduler's loop. It returns every piece so tests can seed, advance time and
 * inspect what was stored, audited and published (`published` collects the events).
 *
 * The fakes themselves live in tests/support/scheduler.ts (the API tests use them too) and are re-exported here, so
 * unit/scheduler tests import everything from './helpers'.
 */
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { ScheduleEvents, type ScheduleEvent } from '@adminforge/api/src/schedules/events';
import { Scheduler, type SchedulerOptions } from '@adminforge/api/src/schedules/scheduler';
import { MemoryScheduleStore } from '@adminforge/api/src/schedules/store';
import { FakeClock, FakeDefinitions, FakeJobs } from '../../support/scheduler';

export { FakeClock, FakeDefinitions, FakeJobs, flush, probe, schedule, sha } from '../../support/scheduler';

export function harness(
  opts: Partial<SchedulerOptions> & { defs?: FakeDefinitions; jobs?: FakeJobs; clock?: FakeClock } = {},
) {
  const clock = opts.clock ?? new FakeClock();
  const store = new MemoryScheduleStore(clock.now);
  const defs = opts.defs ?? new FakeDefinitions();
  const jobs = opts.jobs ?? new FakeJobs();
  const audit = new MemoryAuditWriter(clock.now);
  const events = new ScheduleEvents();
  const published: ScheduleEvent[] = [];
  events.on((e) => published.push(e));
  const scheduler = new Scheduler({
    store,
    definitions: defs,
    jobs,
    audit,
    events,
    now: clock.now,
    timers: clock,
    concurrency: 4,
    ...opts,
  });
  return { clock, store, defs, jobs, audit, events, published, scheduler };
}
