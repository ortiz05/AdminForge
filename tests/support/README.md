# Shared test support

Helpers and payloads used by **more than one** test project (`unit`, `component`, `api`, e2e), grouped by area. A
helper used by one project only stays next to that project (`api/support/`, `unit/<package>/helpers.ts`,
`e2e/support/`); generic, area-free helpers (repository paths, clocks) live in `../lib/`.

| Path                     | What                                                                                                 | Used by                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `scheduler.ts`           | Scheduler fakes: `FakeDefinitions`, `FakeJobs`, `schedule()`, `probe()`, `FakeClock`, `flush`, `sha` | `unit/scheduler` (via `helpers.ts`), `api`             |
| `web/mock-handler.ts`    | The mock portal API contract: `MockHandler`, `MockRequest`, `MockReply`                              | `e2e/support/mock-api.ts`, component tests             |
| `web/mock-automation.ts` | `automationApi()`: stateful mock of runs, approvals, schedules, probes, audit, settings              | e2e specs, `component/web/automation`                  |
| `web/mock-reports.ts`    | `reportsApi()`: stateful mock of the report catalogue and portal report schedules                    | `e2e/reports.spec.ts`, `component/reports`, `unit/web` |
| `web/fixtures/*.ts`      | Synthetic API payloads (session, overview, automation, news, query, reports, renderer)               | e2e specs and support, component tests, `unit/web`     |

Conventions:

- Synthetic data only (`Example Org`, `example.com`, generated GUIDs); times relative to `FIXED_NOW`
  (`web/fixtures/session.ts`) so screenshots never drift.
- Handlers are transport-free: Playwright wires them into `page.route` (`e2e/support/mock-api.ts`), component tests
  call them from a stubbed `fetch`. A new endpoint the UI calls needs a handler here before its UI can be tested.
- Every module starts with a header comment saying what it is and who uses it. The full list of helpers is in
  [`../README.md`](../README.md#shared-helpers).
