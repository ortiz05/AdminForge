# 9. Testing

What to test, where the test goes, and how to keep the suite fast and trustworthy for everyone. The reference is
[`tests/README.md`](../../tests/README.md); this page is the contributor's rulebook.

## Where tests live

**Every test lives under `tests/`** (`@adminforge/tests`), mirroring what it tests. Runtime code in `portal/` never
imports a test library. Add a **new** test file for new behaviour rather than appending to shared suites such as
`content/validate-all.test.ts` — small files make ownership and review obvious.

| You changed…                                         | Test in                                                    | Runs with                      |
| ---------------------------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| Pure logic in a package or app                       | `tests/unit/<package>/<topic>.test.ts`                     | vitest `unit`                  |
| An API route or service                              | `tests/api/<area>.test.ts` (`app.inject`, memory stores)   | vitest `api`                   |
| Database behaviour (transactions, triggers, queries) | `tests/api/<area>-db.test.ts` (a temporary SQLite file)    | vitest `api`                   |
| A React component or coded page                      | `tests/component/<area>/<Component>.test.tsx` (jsdom, axe) | vitest `component`             |
| Content logic (a transform, a rule)                  | `tests/content/<topic>.test.ts`                            | vitest `content`               |
| A transform at enterprise size (the 250 ms budget)   | `tests/content/content-at-scale-<topic>.scale.test.ts`     | vitest `scale`                 |
| A playbook or runbook                                | its own `tests:` block                                     | `pnpm adminforge test`         |
| A user journey or a visible change                   | `tests/e2e/<feature>.spec.ts` + screenshots                | Playwright                     |
| What only the production bundle shows (CSP, chunks)  | `tests/e2e/prod/<topic>.spec.ts`                           | `pnpm test:e2e:prod`           |
| Code that starts real PowerShell (runner workers)    | `tests/unit/runner/<topic>.pwsh.test.ts`                   | vitest `pwsh`                  |
| A PowerShell script or the runner module             | `tests/runner/pester/` (stub cmdlets)                      | Pester (through vitest `pwsh`) |
| Behaviour only a real tenant can show                | `tests/live/` (never in CI)                                | Playwright (live)              |

## Commands

```bash
pnpm test                                                        # unit, component, api, content, guards, pwsh; then scale
pnpm --filter @adminforge/tests test:pwsh                        # real pwsh only: runner workers, Pester
pnpm --filter @adminforge/tests exec vitest run --project api api/schedules   # one project, a path filter
pnpm --filter @adminforge/tests exec vitest --project component  # watch mode
pnpm guard                                                       # guards (also the pre-commit hook)
pnpm test:e2e                                                    # Playwright, mock mode, visual baselines
pnpm adminforge test [pattern]                                   # playbook/runbook tests
pnpm --filter @adminforge/tests exec pwsh -NoLogo -NoProfile -File runner/pester/run.ps1   # Pester (PowerShell 7.4+)
```

Run the focused project while you work; run `pnpm test` and the relevant e2e spec before you push. The `*-db` suites
need nothing running: each makes a migrated SQLite file of its own in a temporary directory (`tests/api/db.ts`) and
never skips. Only `tests/api/import-postgres.test.ts` (the one-time importer) needs a Postgres: it creates and drops a
scratch database on the server `TEST_POSTGRES_URL` names (never an env file's `DATABASE_URL`), skips without it
locally and fails under `CI=true`. `pnpm test` runs Pester through `unit/runner/pester.pwsh.test.ts` wherever `pwsh`
is installed and skips it elsewhere — if you touched the runner or a script on a machine without `pwsh`, say so in the
PR.

## What a good test covers

- **The behaviour, not the implementation:** call the route, the service's public method or the exported rule; assert
  what a person or another component observes (status, error code and message, rows, the audit event).
- **Every refusal, not just the happy path:** each error code, each role (including "a Reader is refused"),
  concurrent-change conflicts, limits. Security rules are tested from the attacker's side.
- **One reason to fail per test**, a name that reads as a sentence (`it('refuses a header over the limit')`).
- **Bugs get a regression test** that fails before the fix.

## Keep tests deterministic

- **Time:** inject a clock (`now: () => fixed`) and use it everywhere in the test — including anything you write to the
  database. Never mix a fixed date with the database's or the machine's `now()`; such tests pass on the day they're
  written and fail later.
- **Load:** the whole suite runs in parallel. Don't assert tight wall-clock times unless the budget is the point; when
  it is (a transform's 250 ms budget), allow a retry (`{ retry: 2 }`) so a saturated machine doesn't fail a fast
  implementation, while a real regression still fails every attempt. The unit, component and content projects allow
  15 s per test; a test whose work is long by nature sets its own `timeout`.
- **No network:** connectors run on fixtures; e2e answers `/api` in the browser or from the local mock BFF. A test that
  needs the internet is a live test.
- **No order dependence:** each test builds its own app and stores; API files run one at a time, so don't rely on
  shared state across files either.
- **No sleeps:** wait for a condition (Playwright locators and `expect.poll`), not for time.
- **Flaky is broken:** CI retries a failed e2e test once; a test that needs that retry to pass is flaky. Fix it, or
  quarantine it with a backlog entry, the same day.

## Rules the suite enforces for everyone

Some tests are there so the next change can't quietly break a convention. Know them; extend them when you add to what
they cover:

- `tests/content/probe-remedies.test.ts` — every active probe has a `remedy`; `tests/content/probes-schedules.test.ts`
  — every probe is swept, configuration checks are exactly `CONFIG_CHECKS` (health-type KQL probes are in
  `OPERATIONAL`).
- `tests/content/retired-content.test.ts` — nothing active links to, embeds, runs or schedules a retired definition.
- `tests/unit/schemas/resource-graph-joins.test.ts` — the Resource Graph join/union lint `validate` applies.
- `tests/content/content-at-scale-*.scale.test.ts` — each big-list transform at its largest size under the real
  budget. Files named `*.scale.test.ts` (in `unit/`, `content/` or `api/`) run in the `scale` project, after the
  others and one file at a time; a busy machine (another suite, background agents) can push one over — rerun that
  file alone before suspecting a regression.
- `tests/content/fixtures-complete.test.ts` — every active page, dashboard and report datasource renders from the
  fixtures (entity pages through its `SAMPLE_PARAMS`; add one for a new entity page), and every Resource Graph or Log
  Analytics datasource and KQL probe names an `af:` variant the fixtures have.
- `tests/e2e/prod/csp-no-eval.spec.ts` — the production build under the API's `script-src 'self'`: no violation.
- `tests/guards/sqlite-only.test.ts` — runtime code is SQLite-only: no `pg` or `pg-boss`, no Postgres-only SQL, no
  `async` transaction function (the one-time importer excepted).
- `tests/guards/kubernetes-manifests.test.ts` — the deployment keeps one replica, `Recreate`, a ReadWriteOncePod
  volume, a locked-down pod and the runner on the pod's loopback.
- `tests/guards/no-deep-imports.test.ts` — runtime code reaches other packages only through their declared `exports`,
  never `@adminforge/<pkg>/src/…`. Tests may import internals.
- `tests/guards/guid-literal.test.ts` — runtime code checks GUIDs with `isGuid` / `GUID_RE` / `GUID_PATTERN` from
  `@adminforge/schemas`; the regex appears only there and in the guard's allow-list.
- `tests/guards/file-size.test.ts` — no runtime file under `portal/` past 800 lines; the listed files may only shrink,
  and an entry is lowered when its file shrinks by more than 50 lines.
- `tests/guards/test-file-names.test.ts` — keeps the names honest: a `content-at-scale` test or one that starts `pwsh`
  without its suffix fails, and `*.scale` / `*.pwsh` files live in `unit/`, `content/` or `api/`.
- `tests/unit/docs/` — every backticked path, link and heading reference (a doc's name, then › and a heading) in
  CLAUDE.md, `.claude/`, the onboarding guides and the docs index resolves; every document has a row in
  `docs/README.md`; every plan has a status line.

A new guard earns its place only if it fails without the fix: prove that once (for the production bundle, build the
old code into a scratch `--outDir` and serve it with `vite preview --outDir … --port 4174`, which the prod config
reuses), and give a browser check a **control** that shows the condition is really in force — `page.evaluate` runs
through DevTools, which ignores the page's CSP, so a control evaluates an inline `<script>`, not `Function('')`.

## Fixtures

- Synthetic only: `Example Org`, `example.com`, generated GUIDs. The guard tests scan fixtures like everything else.
- Connector fixtures live in `tests/fixtures/<service>/…`; the naming scheme and the `$fixture` variant format are at
  the top of `portal/packages/connectors/src/fixtures.ts`. Resource Graph and Log Analytics fixtures usually match on a
  `// af:<id>` comment in the query's first line.
- Add POST variants rather than overwriting a shared file another page depends on.
- Probes in fixtures mode use `portal/apps/api/src/probes/fixture-network.ts`: `hosts/<host>/…` for HTTP (the portal's
  own origin is `hosts/portal.example.com/…`), `dns/<name>/<TYPE>.json` (answers as text, or
  `{ "error": "ENOTFOUND" }`) and `tls/<host>/<port>.json` (`expiresInDays`, `issuedDaysAgo`, …, relative to the
  clock). `tests/api/probes-fixtures-offline.test.ts` runs every sweep with the network switched off.
- Writes for compensation tests go to `AF-Test-User-01` / `-02` (`graph/v1.0/users/…01a1` and `…01a2`); in mock mode
  a write no fixture describes is accepted (there is no tenant), a read without one fails.
- e2e payloads live in `tests/support/web/fixtures/`; the mock API is `tests/e2e/support/mock-api.ts` plus feature
  mocks in `tests/support/web/` (`mock-automation.ts`, `mock-reports.ts`). A new endpoint needs a mock handler there
  before its UI can be tested. Shared helpers are listed in `tests/README.md` → Shared helpers.

## End-to-end and visual

- Playwright uses the system Chrome and a mocked API. Specs pin the clock themselves
  (`page.clock.setFixedTime(FIXED_NOW)`) so screenshots are stable. Specs live in `tests/e2e/`; baselines in
  `tests/e2e/__screenshots__/<spec>/` (the visual specs also cover the contrast theme and both densities).
- UI changes add or update screenshots in **steel and daylight**. Update only the baselines your change intentionally
  alters: `pnpm --filter @adminforge/tests exec playwright test -c e2e/playwright.config.ts <spec> --update-snapshots`.
- **Look at every new or changed image** before committing it; a baseline is a reviewed artefact, not a byproduct.
  `--update-snapshots` rewrites only images that differ by more than the 1 % tolerance, so after changing a new spec's
  fixture, delete its images and run it twice (the first run writes, the second must pass).
- `pnpm build && pnpm test:e2e:prod` smoke-tests the production bundle. Run it in a checkout of your own — never in
  one a running service serves, where the build is a deploy ([CLAUDE.md › Commands](../../CLAUDE.md#commands)).

## Live validation

Live tests run against the validation tenant with a dedicated test user, never in CI, and only by people with access
([`tests/live/README.md`](../../tests/live/README.md), the `validating-against-a-tenant` skill). Writes only on the
`AF-Test-*` objects provisioning created; output and screenshots go to `AF_LIVE_OUT`, outside the repository; report
results as counts and statuses.

## Definition of "tested"

- [ ] The focused vitest project(s) you touched pass; `pnpm guard` passes
- [ ] New behaviour has new tests; refusals and roles covered; regression test for a bug fix
- [ ] Content: `pnpm adminforge validate` + `pnpm adminforge test` clean
- [ ] UI: component test (axe) and e2e with screenshots in both themes, reviewed
- [ ] Big lists: a `content-at-scale-*.scale.test.ts` case; bundling or a web dependency: `pnpm test:e2e:prod`
- [ ] Runner or scripts: Pester ran (`pnpm test` where `pwsh` is installed, or `test:pwsh`)
- [ ] No fixed-date-versus-real-clock mixes, no network, no sleeps

## Read next

[Git and pull requests](10-git-and-pull-requests.md).
