# AdminForge tests

Every AdminForge test and every test-only dependency lives here (`@adminforge/tests`); runtime code in `portal/` never
imports a test library. Test files mirror what they test (`unit/<package>/…`, `component/<package or area>/…`). Add a
**new** file for new behaviour rather than appending to shared suites such as `content/validate-all.test.ts`.

## Projects

The vitest projects are defined in `vitest.config.ts`; each one maps to a folder.

| Project     | Folder                        | Environment                                    | What it covers                                                                                                                                |
| ----------- | ----------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`      | `unit/<package>/`             | node                                           | Pure logic per package: api, cli, connectors, design-tokens, engine, expressions, runner, scheduler, …                                        |
| `component` | `component/<area>/`           | jsdom (`component/setup.ts`)                   | React components: `ui` primitives, widgets, web pages, Query Studio; `axe` checks via `component/axe.ts`                                      |
| `api`       | `api/`                        | node (`api/setup.ts`), files run one at a time | BFF routes through Fastify `inject` with a mock session; DB-backed suites (see below)                                                         |
| `content`   | `content/`                    | node                                           | Every definition in `portal/content` validates; widget configs; focused tests for content-specific logic                                      |
| `guards`    | `guards/`                     | node                                           | No secrets or tenant-specific values in committable files; design tokens only in UI code                                                      |
| `live`      | `live/**/*.test.ts` (none)    | node                                           | Reserved; the live suite is Playwright (`live/README.md`)                                                                                     |
| `scale`     | `SCALE` in `vitest.config.ts` | node                                           | Transforms and native helpers at enterprise size under the 250 ms wall-clock budget — run by `pnpm test` after the others, one file at a time |
| `perf`      | `perf/**/*.test.ts`           | node                                           | Enterprise-scale budgets against a synthetic 100k-user tenant — `pnpm test:perf` only ([`perf/README.md`](perf/README.md))                    |

```bash
pnpm test                       # unit, component, api, content, guards; then scale (one file at a time)
pnpm guard                      # guards only (also the pre-commit hook)
pnpm test:perf                  # enterprise-scale datasource budgets (not part of pnpm test; ~4 min)
pnpm --filter @adminforge/tests exec vitest run --project <unit|component|api|content|guards|scale> [path filter]
pnpm --filter @adminforge/tests exec vitest --project component   # watch mode
```

Example: `pnpm --filter @adminforge/tests exec vitest run --project component component/query`.

### API tests and the database

API tests use in-memory stores by default. The DB-backed suites (`*-pg.test.ts`, `pg-stores`, `definitions-db`, part of `views`) use
`TEST_DATABASE_URL` as-is, or create and migrate a separate `adminforge_test` database next to the `DATABASE_URL` from
your env file (so test rows never reach the dev audit chain). When Postgres isn't reachable they skip. Start it with
`pnpm db:up`.

## Shared helpers

Where a helper lives says who owns it: next to one project when only that project uses it (`api/`, `unit/<package>/`,
`e2e/support/`, `component/`), in `support/<area>/` when several projects share it, and in `lib/` when it is generic
(no product area). Every helper module starts with a header comment (what, inputs/outputs, who uses it). Before
writing a new fake, look here.

### Generic (`lib/`)

| Module               | What it's for                                                                                                   | Imported by                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `lib/repo.ts`        | `repoRoot`, `committableFiles()`, `readText()`, `parseEnvFile()`, `localEnvFiles()`                             | guards, content, api, unit (api, cli, connectors, deploy, engine, runner, tooling) |
| `lib/clock.ts`       | `Clock` (settable `now`) and `FakeClock` (also the scheduler's `Timers`: timeouts fire as it advances), `flush` | `api/helpers.ts` (as `Clock`), `support/scheduler.ts` (as `FakeClock`)             |
| `lib/kql-columns.ts` | `analyzeKql()`: static column types of a Resource Graph query (computed booleans arrive as 1/0)                 | content (`resource-graph-booleans`)                                                |

### Shared across projects (`support/`)

| Module                           | What it's for                                                                                                                    | Imported by                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `support/scheduler.ts`           | Scheduler fakes: `FakeDefinitions`, `FakeJobs`, `schedule()`, `probe()`; re-exports `FakeClock`, `flush`                         | `unit/scheduler/helpers.ts`, api (schedules, portal schedules)   |
| `support/web/mock-handler.ts`    | The mock portal API contract (`MockHandler`, `MockRequest`, `MockReply`), transport-free                                         | `e2e/support/mock-api.ts`, `component/web/automation/render.tsx` |
| `support/web/mock-automation.ts` | `automationApi()`: stateful mock of runs, previews, approvals, schedules, probes, audit, settings, emergency stop                | e2e specs, `component/web/automation`                            |
| `support/web/mock-reports.ts`    | `reportsApi()`: stateful mock of the report catalogue and portal report schedules                                                | `e2e/reports.spec.ts`, `component/reports`, `unit/web`           |
| `support/web/fixtures/*.ts`      | Synthetic API payloads: `session` (`FIXED_NOW`, `me()`, `NAV`), `overview`, `automation`, `news`, `query`, `reports`, `renderer` | e2e specs and `e2e/support`, component tests, `unit/web`         |

### API tests (`api/`)

| Module                            | What it's for                                                                                                                     | Imported by                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `api/support/app.ts`              | `buildTestApp()` (the app on in-memory stores, test clock, no network) and `sessionFor()` (a signed-in session + request helpers) | the harnesses below                                                         |
| `api/support/people.ts`           | Synthetic people (`AVERY`, `BLAKE`, `CASEY`, `DREW`, `DANA`, `READER`: unique oids and UPNs) and role sets                        | the harnesses below (re-exported)                                           |
| `api/helpers.ts`                  | `mockConfig()` / `entraConfig()`, `makeApp()`, `mockLogin()`, cookie helpers, `FakeAuthClient`, `json()`, `noNetwork`             | most api tests; `e2e/support/backend-server.ts`                             |
| `api/runs-helpers.ts`             | `runsApp()`: runs module on `StaticDefinitions` + `FakeExecutor`, in-process queue; `login(person, roles, { armed })`             | runs*, run-role-recheck, schedule-approval-binding                          |
| `api/schedules-helpers.ts`        | `schedulesApp()`: fake content, jobs and outbound, `FakeClock` timers, temporary artifacts directory                              | schedules*, probes, news, emergency, artifact, query, schedule-editor tests |
| `api/portal-schedules-helpers.ts` | Report definitions, delivery configuration and `portalApp()` for the Reports catalogue and portal schedules                       | portal-schedules-*, reports-catalog                                         |
| `api/content-helpers.ts`          | `setupContent()` (a private copy of `fixtures/content/platform/`), `fixturesApp()`, `liveApp()`, `TEST_USERS`                     | content-routes, datasources*, advanced-*, export, admin, views              |
| `api/db.ts`                       | `testDatabaseUrl()` (migrated `adminforge_test`, or null to skip), `resetTables()`                                                | DB-backed suites (`*-pg`, pg-stores, …)                                     |
| `api/runner-fake.ts`              | Reads a runner job request and builds the runner's signed answers                                                                 | runner-port tests                                                           |
| `api/setup.ts`                    | Project setup: `NODE_ENV=test`                                                                                                    | vitest `api` project                                                        |

### One project only

| Module                                   | What it's for                                                                                                                                    | Imported by                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `unit/scheduler/helpers.ts`              | `harness()`: a `Scheduler` on memory stores, fakes and a `FakeClock`; re-exports `support/scheduler.ts`                                          | unit/scheduler                                                 |
| `unit/runner/helpers.ts`                 | Runner keys, fake JWTs, a fake worker command, scripts directories, signed requests and event parsing                                            | unit/runner; api runner-port tests (`newKey`, `testConfig`, …) |
| `e2e/support/mock-api.ts`                | `mockApi(page)`: the mock API in `page.route` (feature handlers, then session/nav/overview defaults); `setPrefs`, `settle`, `growViewportToPage` | e2e specs                                                      |
| `e2e/support/content-backend.ts`         | `routeContentBackend(page)`: content endpoints forwarded to `backend-server.ts`                                                                  | renderer, reports and prod e2e specs                           |
| `e2e/support/backend-server.ts`          | The real BFF content pipeline as a local process (real content, synthetic fixtures, mock session)                                                | spawned by `content-backend.ts`                                |
| `component/setup.ts`, `component/axe.ts` | jsdom shims and jest-dom; `axeViolations()` (contrast is left to Playwright)                                                                     | vitest `component` project; component tests                    |
| `component/web/automation/render.tsx`    | `renderApp()`: the real app in jsdom over the shared mock API                                                                                    | component/web/automation                                       |
| `component/web/ensure-route-tree.ts`     | Generates the web app's (git-ignored) route tree before the router is imported                                                                   | component/web                                                  |

### Live (`live/lib/`)

Used by the live suite (`live/e2e/`) and scripts (`live/scripts/`) only, never in CI; the pure parts are unit-tested in
`unit/live/`. Details and the conventions for a new script: [`live/README.md`](live/README.md#library-lib).

| Module                       | What it's for                                                                                                                         | Imported by                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `live/lib/entra-login.ts`    | `signInWithEntra()` (Microsoft sign-in pages, TOTP, first-time MFA registration, nudge check), `testUserCredentials(env)`             | `portal-session.ts`, `portal.live.spec.ts`, register-test-user-mfa |
| `live/lib/portal-session.ts` | `openPortalSession()` (signed-in headless Chrome + `api()`), `createApiCall(request)`, `armWriteAccess()`                             | the scripts, `portal.live.spec.ts` (`createApiCall`)               |
| `live/lib/runs.ts`           | Preview → run → poll: `previewThenRun()`, `settle()`, `waitForRun()`, `stepOutput()`; one "settled" rule (engine's terminal + parked) | run-playbook, `portal.live.spec.ts`                                |
| `live/lib/placeholders.ts`   | `@<kind>:<name>[#field]` placeholders in playbook inputs, resolved as the validation user (never printed)                             | run-playbook, check-placeholders                                   |
| `live/lib/mask.ts`           | `mask()`, `maskError()`, `why()`, `maskUrl()`: ids, addresses/UPNs and tenant hosts masked in everything live output prints           | every script and lib module, `portal.live.spec.ts`                 |
| `live/lib/output.ts`         | `liveOutDir()`: the private output directory (`AF_LIVE_OUT`, default `~/.cache/adminforge/live`, refused inside the repository)       | `live/e2e/playwright.config.ts`, `portal.live.spec.ts`, scripts    |
| `live/lib/totp.ts`           | RFC 6238 codes from the validation user's TOTP seed                                                                                   | `entra-login.ts`                                                   |

## Guards

`guards/no-tenant-data.test.ts` scans every committable file (tracked plus untracked-but-not-ignored) for secrets and
tenant-specific values; `guards/design-tokens.test.ts` rejects raw colours and arbitrary Tailwind values in UI code. They
run in CI and in the pre-commit hook (`.githooks/pre-commit`; `pnpm install` sets `core.hooksPath`, or run
`git config core.hooksPath .githooks`). Never bypass them with `--no-verify`.

## Fixtures

- `fixtures/<service>/…` (`graph`, `arm`, `resourceGraph`, `logAnalytics`, `runner`, `hosts`): synthetic connector
  responses for `DATA_MODE=fixtures` (the API's default `ADMINFORGE_FIXTURES_DIR`), the e2e content backend and the
  API/content tests. The file naming scheme and the `$fixture` variant format are documented at the top of
  `portal/packages/connectors/src/fixtures.ts`. Resource Graph and Log Analytics queries usually pick their
  variant with a `// af:<id>` comment on the first query line (`match.bodyIncludes`).
- Data is synthetic only: `Example Org`, `example.com`, generated GUIDs. `pnpm adminforge new …` writes a fixture stub;
  `pnpm adminforge fixtures record <page>` reads a page live (read-only, automation identity) and writes sanitized
  fixtures.
- `fixtures/content/<set>/`: synthetic content trees with their own connector fixtures (`content/` + `responses/`),
  for tests that must not depend on `portal/content`; `platform/` is loaded by `api/content-helpers.ts`. No service
  is called `content`, so `DATA_MODE=fixtures` never reads them.
- `support/web/fixtures/`: API payloads the mock portal API answers with (Playwright specs and component tests).

## End-to-end and visual (Playwright)

```bash
pnpm test:e2e                                                                  # all specs
pnpm --filter @adminforge/tests exec playwright test -c e2e/playwright.config.ts query.spec.ts
pnpm --filter @adminforge/tests exec playwright test -c e2e/playwright.config.ts --update-snapshots   # intended UI changes only
pnpm build && pnpm test:e2e:prod                                               # production-build smoke (vite preview)
```

- `e2e/prod/` runs against the **built** app (`vite preview` of `dist/` on :4174, config `playwright.prod.config.ts`)
  with the same mocked API. It catches what only the bundler breaks — tree-shaken side effects, chunking,
  minification — which the dev server never shows. Run `pnpm build` first; CI runs it after the build.

- Uses the **system Chrome** (`channel: 'chrome'`); Playwright downloads no browser.
- Starts only the Vite dev server (`pnpm --filter @adminforge/web dev`, reused if one already runs on :5173). `/api`
  and `/auth` calls are answered in the browser (`e2e/support/mock-api.ts` with the handlers in `support/web/`); content specs route
  definitions, datasources and exports to a small local BFF process (`e2e/support/backend-server.ts`: real content and
  transforms, synthetic fixtures, mock session, no network, no database). The clock is pinned for stable screenshots.
- Visual baselines (`visual.spec.ts`, `automation-visual.spec.ts` and the screenshot assertions in other specs) live in
  `e2e/__screenshots__/<spec>/`; failures and diffs go to `test-results/e2e`. Look at the images before updating a
  baseline.

## PowerShell runner (Pester)

`runner/pester/` holds the runner module tests (`AdminForge.Runner.Tests.ps1`, `ModuleLayout.Tests.ps1` for the split
module's exports, `InstallModules.Tests.ps1` for the pinned module installer) and the content script tests
(`Scripts.Tests.ps1` and one file per script area, with stub cmdlets); see `runner/README.md`. Needs PowerShell 7.4+; `run.ps1` installs the pinned Pester version into the
runner's module directory if it is missing:

```bash
pnpm --filter @adminforge/tests exec pwsh -NoLogo -NoProfile -File runner/pester/run.ps1
```

## Content definitions

Playbook and runbook `tests:` blocks run with `pnpm adminforge test [pattern]` (dry runs with mocked step outputs);
`pnpm adminforge validate` checks schemas, references, expressions and env keys. The `content` project also validates
everything on every `pnpm test`.

## Live (real tenant)

Never in CI. See `live/README.md`.
