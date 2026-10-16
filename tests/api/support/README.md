# API test harness

The core the `api` project's harnesses are built on. Tests normally import the harness for their feature from
`tests/api/` (`helpers.ts`, `runs-helpers.ts`, `schedules-helpers.ts`, `portal-schedules-helpers.ts`,
`content-helpers.ts`); those build on the two modules here.

- `app.ts` — `buildTestApp(config, { clock, audit, deps })`: the real API app on in-memory stores with a test clock
  and a fetch that refuses the network; `sessionFor(app, person, roles, { armed })`: a signed-in session written
  straight into the store, with `get`/`post`/`patch`/`put`/`del` helpers bound to its cookie and CSRF token.
- `people.ts` — the synthetic people (`AVERY`, `BLAKE`, `CASEY`, `DREW`, `DANA`, `READER`; unique object ids and
  UPNs) and role sets (`ALL_ROLES`, `OPERATOR`, `ADMIN`).

Add a person or role set to `people.ts` rather than declaring one in a test or harness. See
[`tests/README.md`](../../README.md#shared-helpers) for every shared helper.
