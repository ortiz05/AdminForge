# @adminforge/scheduler

The scheduler service (R6, ADR-011): runs content schedules — probe sweeps, KQL checks, reports, news collection,
playbook schedules (handed to the run worker) — on this host as the **automation identity**. One process holds the
Postgres leader lock and fires schedules; any other is a hot standby. How it is installed and run on the host is in
[`portal/deploy/README.md`](../../deploy/README.md#the-scheduler).

## Files

| File              | What                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`     | The entry point: parses the flags, logs JSON lines through `safeLogFields`, runs the service (leader election, `SIGINT`/`SIGTERM` shutdown) or a one-shot. |
| `src/one-shot.ts` | One schedule or probes **now**, without leadership, and the status lines they print. Shared with `tests/live/scripts/run-schedule-once.ts`.                |
| `tsup.config.ts`  | Bundles `src/main.ts` (and the workspace packages it uses) into `dist/main.js`; npm dependencies stay external.                                            |

The scheduling logic itself (store, jobs, scheduler, leader election, delivery) lives in the API package and is shared
with the API's in-process scheduler (`SCHEDULER_IN_PROCESS=true` in development). This package reaches it only through
the API's tooling entry points — `@adminforge/api/tooling` (configuration, context, log fields, delivery) and
`@adminforge/api/tooling/scheduler` (runs and schedules modules, `Scheduler`, `runProbe`) — never through
`@adminforge/api/src/…` paths.

## Commands

```sh
pnpm --filter @adminforge/scheduler dev                  # the service, from source (tsx watch)
pnpm --filter @adminforge/scheduler typecheck
node portal/apps/scheduler/dist/main.js                  # the service, built (needs DATABASE_URL)
node portal/apps/scheduler/dist/main.js --once           # every probe once
node portal/apps/scheduler/dist/main.js --probe <key>…   # the named probes once
node portal/apps/scheduler/dist/main.js --schedule <key> # one schedule now (a manual run, audited)
#   add --no-store to a one-shot to skip writing probe results
```

One-shots print keys, statuses, reason codes, counts, report row counts and delivery statuses — never messages,
details, recipients or item contents, which can hold tenant data. A schedule one-shot exits 1 unless the run
succeeded; a probe one-shot prints a summary line and exits 0.

## The one-shot module

`src/one-shot.ts` is the reusable part (exported as `@adminforge/scheduler/one-shot`):

- `openOneShot(config, { log, noStore, delivery })` wires the process — context, runs module without a worker,
  schedules module without the in-process scheduler — and returns `runSchedule`, `runProbes` and `close`. `delivery`
  overrides email/Teams delivery for both report delivery and failure notifications (the live script uses it so no
  real recipient gets mail); without it, jobs deliver from the configuration and a one-shot sends no notifications.
- `runScheduleOnce` / `runProbesOnce` take only the pieces they use, so they are tested with fakes
  (`tests/unit/scheduler/one-shot.test.ts`).
- `scheduleRunLines`, `probeLine`, `PROBE_HEADER`, `probeSummary` and `probeFailed` are the pure formatters both
  callers print with.

A new one-shot flag belongs in `one-shot.ts` (with a test) and is then called from `main.ts`; the live script keeps
only its own safety guards.
