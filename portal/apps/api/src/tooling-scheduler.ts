/**
 * `@adminforge/api/tooling/scheduler` — the scheduler wiring tools may use: the runs and schedules modules, the
 * `Scheduler` (for one-shot runs without leadership) and probes. Used by the scheduler one-shots
 * (`portal/apps/scheduler/src/main.ts` and `one-shot.ts`) and, through `one-shot.ts`,
 * `tests/live/scripts/run-schedule-once.ts`.
 *
 * The rules are those of `tooling.ts` (the other barrel, which explains why there are two): tools import from here,
 * never from `@adminforge/api/src/…`; the API's own modules never import a barrel.
 */

// The FastifyRequest augmentation (`request.session`), as in tooling.ts.
import type {} from './auth/session-plugin';

// Runs (scheduled playbook runs are enqueued for the run worker) and schedules (store, jobs, events, probe deps).
export { createRunsModule, type RunsModule } from './runs/module';
export { createSchedulesModule, type SchedulesModule, type SchedulesOptions } from './schedules/module';

// One schedule run now (`Scheduler.runOnce`), and the run row it returns.
export { Scheduler, type SchedulerOptions } from './schedules/scheduler';
export type { ScheduleRunRow } from './schedules/types';

// One probe now.
export { runProbe, type ProbeOutcome } from './probes/checks';

// The emergency stop one-shots read ("automation paused"), and the error a one-shot without the database refuses
// changes with (one-shot.ts).
export { isPaused } from './execution/emergency';
export { AppError } from './errors';
