# @adminforge/scheduler

The scheduler's one-shots (R6, ADR-011): run every probe, the named probes or one schedule **now**, as the
**automation identity**, and exit. The scheduler itself — probe sweeps, KQL checks, reports, news collection, playbook
schedules — runs inside the API process (ADR-016: one process owns the SQLite file), behind the `adminforge.scheduler`
lease. A one-shot runs beside it against the same `DATABASE_PATH`, without the lease; a playbook run it starts is
queued for the API's run worker.

## Files

| File              | What                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`     | The entry point: parses the flags, logs JSON lines through `safeLogFields`, runs one one-shot and exits. Without a one-shot flag it prints usage and exits 2.           |
| `src/one-shot.ts` | One schedule or probes **now**, without leadership, and the status lines they print. Shared with `tests/live/scripts/run-schedule-once.ts`.                             |
| `tsup.config.ts`  | Bundles `src/main.ts` (and the workspace packages it uses) into `dist/main.js`, which the app image carries; npm dependencies (better-sqlite3 is native) stay external. |

The scheduling logic itself (store, jobs, scheduler, leader election, delivery) lives in the API package. This package
reaches it only through the API's tooling entry points — `@adminforge/api/tooling` (configuration, context, log
fields, delivery) and `@adminforge/api/tooling/scheduler` (runs and schedules modules, `Scheduler`, `runProbe`) — never
through `@adminforge/api/src/…` paths.

## Commands

```sh
pnpm --filter @adminforge/scheduler exec tsx src/main.ts --once            # every probe once, from source (dev env file)
pnpm --filter @adminforge/scheduler exec tsx src/main.ts --probe <key> [--probe <key>…]   # the named probes once
pnpm --filter @adminforge/scheduler exec tsx src/main.ts --schedule <key>  # one schedule now (a manual run, audited)
pnpm --filter @adminforge/scheduler typecheck
#   add --no-store to a probe one-shot to skip writing probe results (no database at all, so it needs
#   CONTENT_SOURCE=fs: with published content, CONTENT_SOURCE=db, it can't load the probes)
```

In the pod the same flags run the bundle:
`kubectl -n adminforge exec deploy/adminforge -c api -- node portal/apps/scheduler/dist/main.js --once`.

One-shots print keys, statuses, reason codes, counts, report row counts and delivery statuses — never messages,
details, recipients or item contents, which can hold tenant data. A schedule one-shot exits 1 unless the run
succeeded; a probe one-shot prints a summary line and exits 0. Their events (`schedule.updated`, `probe.updated`, …)
reach browsers through the `schedule_events` signal, which the API picks up within a second.

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
