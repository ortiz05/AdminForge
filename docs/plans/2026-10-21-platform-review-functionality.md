# Platform review 2026-10-21 — Functionality: findings and remediation plan

> **Status:** proposed. One of four review plans produced on 2026-10-21 (design, organization, functionality,
> security). Baseline: `main` @ f243038 plus the uncommitted SharePoint-sharing work (not implicated in any failure).
> Method: a read-only reviewer agent ran every test suite on the tree as-is, `pnpm adminforge validate|test|env check`,
> and the API alone in mock mode (`AUTH_MODE=mock DATA_MODE=fixtures`, in-memory stores) to sweep every content
> datasource and about thirty error paths. No Microsoft API was called; perf and e2e were not run. The High finding
> and the three Medium code findings were re-verified by hand. Sibling plans:
> `2026-10-21-platform-review-design.md`, `2026-10-21-platform-review-organization.md`,
> `2026-10-21-platform-review-security.md`.
> **Validated** on 2026-10-21 against `feat/sqlite-on-pvc` @ 2c7103d (one SQLite file on a PersistentVolume, Kubernetes
> only): see the next section. §2 and §5 follow the validation; §1, §3, §4 and §6 keep the original wording (changed
> findings are annotated; F-20 is new). No finding is obsolete as a whole; one of F-01's four failing tests is.

## Validation against feat/sqlite-on-pvc (2026-10-21)

Every finding was re-checked in the worktree of `fix/platform-review` (identical to `feat/sqlite-on-pvc` @ 2c7103d):
code read, the plan's failing tests re-run alone, the full suite run twice, and the API run from the worktree in mock
mode (in-memory stores) to reproduce F-02, F-05, F-06, F-10, F-12 and F-13 and to run every probe sweep.
**CONFIRMED**: still there (evidence updated). **CHANGED**: still there in another form, or with another cause,
severity or remediation. **OBSOLETE**: the code or file it was about is gone. **NEW**: found while validating. Nothing
was FIXED by the SQLite change. Paths: `api/` = `portal/apps/api/src/`, `web/` = `portal/apps/web/src/`, `pkg/<name>/`
= `portal/packages/<name>/src/`, `cli/` = `portal/tools/cli/src/`, `k8s/` = `portal/deploy/kubernetes/`, `runner/` =
`portal/apps/runner/`. Test files marked (new) are new files (CLAUDE.md rule 2). **WP-x** is the work package in §5;
their file sets do not overlap (shared files: see §5).

| Id   | Verdict | Evidence in W | Adjusted remediation | Decision | Effort | Files |
| ---- | ------- | ------------- | -------------------- | -------- | ------ | ----- |
| F-01 | CHANGED (still High) | Sort test: `tests/content/m365-overview-sorts.test.ts:15` pins `now`, `:58-59` build the dates from `Date.now()`; `$daysUntil` counts from the scope clock (`pkg/expressions/helpers.ts:1163-1164`): fails in both runs and alone. Timeouts: `tests/vitest.config.ts:29-58` set no `testTimeout` for unit, component and content (only live `:71`, perf `:82`); `unit/cli/retired-scopes.test.ts` timed out at 5,000 ms in run 2; 14 (run 1) and 20 (run 2) tests took 3.5–5.0 s. `unit/deploy/backup-script.test.ts` is gone with `portal/deploy/backup` (that part OBSOLETE). Skips: no database suite skips any more; today's 3 skips are `unit/runner/integration.test.ts` (pinned modules absent); `tests/api/import-postgres.test.ts:21-41` falls back to dev.env's `DATABASE_URL` and creates and drops a scratch database there. | (1) Dates from the pinned `now`. (2) `testTimeout: 15_000` for the unit, component and content projects; no `maxWorkers` change (nothing points at the worker count). (3) The importer test reads only `TEST_POSTGRES_URL` (CI sets it) and fails instead of skipping when `CI=true`; module skips stay until the runner CI job exists (backlog "CI:"). | — | S | WP-A: `tests/content/m365-overview-sorts.test.ts`, `tests/vitest.config.ts`, `tests/api/import-postgres.test.ts` |
| F-02 | CONFIRMED (reproduced) | Mock API from W: `identity.disable-user` preview succeeded; the armed, typed-confirmed run failed at `disable` with `FixtureNotFound` for `PATCH …/users/…0101` (naming the file to create). `acceptWrites` exists (`pkg/connectors/fixtures.ts:35,216`) and is still never set (`api/datasources/services.ts:96`). 14 POST fixtures, none for PATCH, PUT or DELETE. The runs API tests still use `FakeExecutor` (`tests/api/runs-helpers.ts:55,90`). | (1) `createFixtureFetch(dir, { acceptWrites: config.AUTH_MODE === 'mock' })` — keyed on **mock sign-in**, not on `DATA_MODE`: `AUTH_MODE=entra DATA_MODE=fixtures` is allowed (`api/config.ts:238-248,323-343`) and a silent 204 there would mislead someone signed in for real; mock is already refused in production and off loopback (`config.ts:250-255,330-335`). Drop the "mock-specific wording": the 404 that remains (reads, and POSTs whose output later steps use) tells the developer which file to create. (2) PATCH/DELETE fixtures only for a forced failure (`$fixture` status 500) and for POST bodies that steps read. (3) API test through the real `createOutboundExecutor` and fixture fetch: dry run → confirm → run → failure → `compensate`; `runs-helpers.ts` takes any `OutboundExecutor`. | — | S + M | WP-B: `api/datasources/services.ts`, `tests/api/runs-helpers.ts`, `tests/fixtures/graph/v1.0/users/<AF-Test id>/{PATCH,DELETE}.json`, `docs/onboarding/01-setup.md`; `tests/api/mock-mode-writes.test.ts`, `tests/api/runs-real-executor-compensate.test.ts` (new) |
| F-03 | CONFIRMED | No test maps datasources to fixtures (`tests/content/validate-all.test.ts` checks schema and expressions); `tests/e2e` visits 9 `/p/<key>` pages. Today's sweep (mock API, W): 158 active page-like definitions, 144 swept, 431 datasources: 374 ok, 57 skipped by `when`, **0** `FixtureNotFound` or `content_error`; 14 entity pages had no derivable sample id. | As planned, on the existing harness (`tests/content/engineer-report-library.test.ts:31-57`: `DatasourceRunner`, fixture fetch, `fixtureRunner`, fixed clock), with an explicit key → sample-id map for entity pages and a 60 s file timeout (a timed-out transform is already retried once, `api/datasources/executor.ts:794-806`). It closes O-16 only if it also runs the KQL probes; otherwise O-16 stays with the organization plan. | — | M | WP-C: `tests/content/fixtures-complete.test.ts` (new); fixtures for the gaps it finds (not `graph/v1.0/users/*/PATCH\|DELETE`) |
| F-04 | CHANGED → F-20 | The cause is not missing host fixtures: HTTP, DNS and certificate probes never use fixtures (F-20). In mock mode (empty env) `entra-home-realm-discovery` got a real 200 without `DomainName` and `exchange-autodiscover-service` a real 400. | Folded into F-20 (host fixtures for every HTTP probe host). | — | — | WP-C (see F-20) |
| F-05 | CONFIRMED (reproduced) | `GET /api/definitions/page/security.incidents` (retired, 1.1.0) and `…/page/nope.nothing` both → 404 `definition_not_found`, hint "Check the id, or publish the content (adminforge publish)." (`api/definitions/registry.ts:20-30`). The FS source hides retired keys (`fs-source.ts:210,218`), so does the SQLite store (`db-store.ts:279`); `definitionRetired` has no hint (`current.ts:21-22`). | Both sources hand the definitions route the latest record including retired ones; it answers 409 `definition_retired` with a hint for the person (open the section from the navigation, or search). Unknown key: 404 "Check the address, or open it from the navigation." — no CLI command in a browser-facing hint (rule 10). No successor field (the schemas have none; don't add one for this). | — | S | WP-E: `api/definitions/{fs-source,db-store,registry,current}.ts`; `tests/api/definitions-retired-key.test.ts`, `tests/api/definitions-retired-key-db.test.ts` (new) |
| F-06 | CONFIRMED (reproduced) | `POST /api/query` with four `join`s → 200 with fixture rows. `QueryService.run` (`api/query/service.ts:95-130`) never calls `resourceGraphJoinProblem` (`pkg/schemas/datasource.ts:59-93`, exported). Save-as-report already refuses it (content validation). | After `requireQuerySource`, for `resourceGraph`: `resourceGraphJoinProblem(query)` → 400 `invalid_query` (message: the rule; hint: split the query), before the audit and before any call. | — | S | WP-E: `api/query/service.ts`; `tests/api/query-join-limit.test.ts` (new) |
| F-07 | CONFIRMED | Routes from the built app (mock and Entra, `printRoutes`): **70** = 2 health + 10 auth + 58 `/api`. `docs/api.md:177-179` says 66 = 2 + 9 + 55; the index (`:181-251`, 69 rows) lacks `POST /auth/schedule-consent` (documented at `:334`, limit at `:143`); `GET /auth/login` and `/auth/callback` say 30/min (`:276,287`), the table (`:140`) and `api/config.ts:94-95` say 300. | Fix the text; `tests/api/api-doc-index.test.ts` builds the mock and Entra apps (`tests/api/helpers.ts`) and compares `printRoutes()` with the index rows and the count sentence. | — | S | WP-E: `docs/api.md`; `tests/api/api-doc-index.test.ts` (new) |
| F-08 | CHANGED | pg-boss is gone. `SqliteRunQueue` (`api/runs/queue.ts:80-91`): 50 attempts, 5 s doubling to 300 s (≈ 3.75 h, not 5 h); claims strictly by `start_after, id` (`:160-166`): no priority, no per-user share. `RUN_WORKER_CONCURRENCY` default 4 (`api/config.ts:228`) now reaches the API's own worker (`api/runs/module.ts:232`); previews are runs on the same queue (`api/runs/service.ts:370-373`) and the same 4 slots serve scheduled playbook runs. No per-user cap in `api/runs/`. | Cap open (queued + running) root runs per user, previews included, a bulk run counted once, parked runs (`awaiting_*`) not counted → 429 `too_many_runs` with a hint. Raise the worker default to 8 (steps mostly wait on Microsoft; outbound keeps its own per-identity slots). Drop dry-run priority (a `run_jobs` column and a migration) unless the cap proves insufficient. Coordinate the numbers with the security plan. | Q2 | S–M | WP-F: `api/runs/{service,types,sqlite-repository,memory-repository}.ts`, `api/config.ts`, `config/example.env`, `tests/api/run-worker-concurrency.test.ts` (default); `tests/api/runs-per-user-cap.test.ts`, `tests/api/runs-per-user-cap-db.test.ts` (new) |
| F-09 | CONFIRMED | `api/schedules/scheduler.ts:260-266` unchanged (a log line, `continue`); `skipPaused` (`:372-400`) records and audits; `tests/unit/scheduler/scheduler.test.ts:200` pins the silent skip. With `Recreate` a deploy is seconds (ADR-017), so only outages over an hour hit it (node loss, volume re-attach, a crash-looping pod), and nothing else records them. | Generalise `skipPaused` to `recordSkipped(s, trigger, now, error)`; a missed tick → `skipped` with error `schedule_missed` ("AdminForge wasn't running at 07:00, so this run was skipped." / hint: run it now if the result is still needed), audited, `schedule.updated`. Keep the 1 h grace. Leave the content-health "stale schedule" check for later. Agree the status with design D-09. | Q3 | S | WP-D: `api/schedules/scheduler.ts`, `tests/unit/scheduler/scheduler.test.ts` (expectation at `:200`); `tests/unit/scheduler/missed-tick.test.ts` (new) |
| F-10 | CONFIRMED (reproduced) | `POST /api/schedules/billing.month-close/run` (`enabled: false`) → 202 and a succeeded run with an xlsx. That schedule also emails `AF_FINANCE_RECIPIENTS` (`portal/content/schedules/billing/month-close.schedule.yaml:29-37`) and `api/schedules/jobs.ts:381-415` delivers whatever `enabled` says: live, run now on the switched-off schedule mails finance. Six active schedules are off. Write-capable (`api/schedules/service.ts:528-534`) and synthetic-transaction (`:537-545`) schedules are already refused while off. | Keep run now (it is how an owner tries a schedule before turning it on), **file only** while the schedule is off: `jobs.ts` skips email and Teams with a delivery note, `scheduler.ts:617` skips `notify.onSuccess`, and the Run now control says so. | Q1 | S | WP-D: `api/schedules/{jobs,scheduler}.ts`, `web/ops/ScheduleControls.tsx`; `tests/api/schedules-run-now-disabled.test.ts`, `tests/component/web/automation/run-now-disabled.test.tsx` (new) |
| F-11 | CONFIRMED | 389 active of 420 (31 retired); `validate` warns on the same 16 Graph-beta definitions; no marker field (`pkg/schemas/common.ts:49,160` has only `status`). | `preview: true` rather than `validatedLive: <date>` (dates for 320+ definitions can't be back-filled honestly) on the fixture-only and beta definitions; a quiet "Preview" badge in the page header; `validate` lists them; a generated table in `docs/licensing-review.md`. | Q4 | M | WP-H: `pkg/schemas/common.ts` (+ generated schemas), `web/renderer/PageParts.tsx`, `cli/commands/validate.ts`, `docs/licensing-review.md`, `docs/extending.md`, `.claude/skills/adding-a-page-or-report/SKILL.md`, the flagged content |
| F-12 | CONFIRMED (reproduced) | `POST /auth/mock/state {roles: []}` → 200 with `roles: []`; then `/api/me` 200 and `/api/nav` 403 (`api/auth/mock-routes.ts:52-55`). The real path ends the session (`api/auth/session-plugin.ts:293`; `api/auth/routes.ts:241-243`, `no_portal_role`). No test relies on a role-less mock session. | End the session and answer 403 `no_portal_role`, as with Entra. | — | S | WP-E: `api/auth/mock-routes.ts`; `tests/api/mock-state-no-roles.test.ts` (new) |
| F-13 | CONFIRMED (reproduced) | No hint: `not_found` (`api/app.ts:303`), `run_not_found` (`api/runs/service.ts:366,1136`), a bad cursor (`invalid_request` "The cursor is not valid.", `runs/service.ts:173`, `schedules/service.ts:220`), `datasource_not_found` (`api/datasources/executor.ts:486-490`). Zod text: export `{"format":"pdf"}` → `format: Invalid option: expected one of "csv"\|"xlsx"` (`api/errors.ts:55-62`). Also: a 300 KB body → 413 `ctp_body_too_large` "Request body is too large", no hint (Fastify's code passed through, `errors.ts:117-120`). | Plain phrases in `parseBody` for the common zod issues (option, missing, type); 413 → `body_too_large` with a hint; hints where a person can act. Split by file owner. | — | S | WP-E: `api/errors.ts`, `api/app.ts`, `api/datasources/executor.ts`, `tests/unit/api/error-wording.test.ts` (new); WP-F: `api/runs/service.ts`; WP-D: `api/schedules/service.ts` |
| F-14 | CHANGED (matters more) | `api/datasources/executor.ts:794-806` (wall clock, one retry), `:911-914` → 500 `content_error`; `tests/perf/budgets.json` unchanged (42 `knownSlow`, 21 `mayTimeOut`, 11 `maxTransformMs` of 400–988 ms). The run worker, the sweeps and scheduled exports now share the event loop with every page (ADR-016), and "add API processes" is no longer an option (`docs/performance.md:198-201`). The perf numbers predate this: the harness runs no worker or scheduler. | First re-measure `pnpm test:perf` with the worker and sweeps in the process; then a `worker_threads` pool for transforms (scheduled runs and exports first, larger budget), now the only CPU lever; the copy-free derived hand-over as before. | — | L | WP-I (re-measure): `tests/perf/harness/*`; later: `api/datasources/executor.ts`, `pkg/expressions/*` |
| F-15 | CONFIRMED | `docs/backlog.md:515-517`, unchanged. | As planned. | — | M | later: `api/datasources/executor.ts`, `api/reports/*`, `web/renderer/ExportMenu.tsx` |
| F-16 | CONFIRMED | Still no `link` on the 8 platform probes (`token-{graph,arm,exchange,log-analytics,sharepoint-admin,teams}`, `portal-readiness`, `portal-tls-certificate`; the last two were reworded for the cluster on this branch). `identity.revoke-consent-grant` 1.1.0: `risk: high`, `confirm: click`, no approval (`playbook.yaml:12,19-26`). | There is no Provisioning status page to link to (it is `adminforge provision status`): the token probes link to Entra's App registrations (https, no tenant id; check the URL once); readiness and TLS stay without a link (nothing in the portal or at Microsoft acts on the cluster; rule 13 says "where one helps"). Typed confirmation of the client app's name (`steps.client.output.displayName`), version 1.2.0. | — | S | WP-G: `portal/content/probes/token-*.probe.yaml` (6), `portal/content/playbooks/identity/revoke-consent-grant.playbook.yaml` |
| F-18 | CHANGED | The runner is a loopback sidecar holding only `RUNNER_SHARED_KEY` (ADR-017; `k8s/base/deployment.yaml:92-111`); the automation certificate is mounted into the api container only (`:143-147`). An app-only sign-in in the runner would put a credential into the sidecar. | The API acquires app-only Exchange, Teams and SharePoint tokens for automation runs and forwards them as it forwards delegated ones; the runner stays credential-free. Needs a licensed tenant. | Q6 | L | later: `api/execution/*`, `api/schedules/jobs.ts`, `runner/*` |
| F-19 | CONFIRMED | `docs/backlog.md:343-347`; `m365.teams-user-policies` 1.1.0 is still active (`portal/content/pages/m365/teams-user-policies.page.yaml:4`). | Flag it now (`preview: true` with F-11, or a known-issue line in its summary); the fix needs a real token in a worker. | Q5 | S + M | WP-H: the page YAML; later: `runner/*` |
| F-20 | NEW, Medium | `api/schedules/module.ts:117-128` gives probes `ctx.fetch` (global `fetch`, `api/context.ts:102`) and no `dns`, `tls` or `lookup`, so `api/probes/checks.ts:245` (lookup), `:286` (fetch), `:464-506` (system resolver) and `:559,596` (TLS) use the network in `DATA_MODE=fixtures`; Teams delivery too (`module.ts:133`). Reproduced with the five sweeps on the mock API: `m365-web-portal` 200 in 285 ms, `teams-web-client` 200 in 244 ms, `exchange-outlook-web` 302, `exchange-outlook-connectivity` 401, DNS probes `ENOTFOUND`. `sweep.every-15-minutes` is enabled, so every mock `pnpm dev` does this every 15 minutes. Same code at f243038. | In fixtures mode `module.ts` passes the fixture fetch to probes and delivery, plus a fixture lookup (a synthetic public address, so the SSRF guard still runs), a fixture DNS resolver and a fixture TLS inspector (`ProbeDeps` already takes `dns`, `tls`, `lookup`, `checks.ts:89-96`); host fixtures for every HTTP probe host. Unset env keys keep reporting "not configured" (the backlog wants `skipped`). Related: security S-24/S-40 (probe egress in the cluster). | — | S–M | WP-C: `api/schedules/module.ts`, `api/probes/fixture-network.ts` (new), `tests/fixtures/hosts/…`, `tests/fixtures/dns/…` (new), `docs/onboarding/09-testing.md`, `.claude/skills/adding-a-schedule-or-probe/SKILL.md`; `tests/api/probes-fixtures-offline.test.ts` (new) |

(F-17 was never assigned.)

**Owner decisions.** Each has a recommended answer; nothing else in this plan waits on the owner.

- **Q1 (F-10)** Run now on a switched-off schedule: allowed? — _Recommended:_ yes, file only: no email, Teams or
  `notify` until the schedule is on (the run says so).
- **Q2 (F-08)** Per-user run limit? — _Recommended:_ 5 open (queued + running) root runs per person, previews
  included, a bulk run counted once; worker concurrency 8; no dry-run priority for now.
- **Q3 (F-09 = D-09)** How is a missed tick recorded? — _Recommended:_ `skipped` with error `schedule_missed` (no
  migration; the UI already shows skipped runs), keeping the 1 h grace (no late catch-up). The design plan proposes a
  new `missed` status; one answer for both plans.
- **Q4 (F-11)** A "Preview" badge on fixture-only and Graph-beta content? — _Recommended:_ yes, quiet, from
  `preview: true`; removed when the definition has run live.
- **Q5 (F-19)** `m365.teams-user-policies` until it works live: flag or hide? — _Recommended:_ flag (`preview`), keep
  it reachable; it fails with an explained error.
- **Q6 (F-18)** Scheduled PowerShell: where do app-only tokens come from? — _Recommended:_ the API acquires and
  forwards them; the runner sidecar never holds a credential.

**What this validation ran.** The full `unit, component, api, content, guards` suite twice and `--project scale`
(§2); the plan's three remaining named tests alone; `pnpm adminforge validate`, `test` and `env check`; and the API from
W in mock mode on port 3399 (stopped afterwards): every active page, dashboard and report datasource, the F-02 write
flow, the F-05, F-06, F-12 and F-13 error paths, run now on `billing.month-close`, and run now on the five probe sweeps.
**Network:** that last step is how F-20 was found — the HTTP, DNS and certificate probes sent real, unauthenticated
requests from this host to public Microsoft endpoints (`login.microsoftonline.com/common/userrealm`;
`outlook.office365.com` autodiscover, OWA and MAPI; `m365.cloud.microsoft`; `teams.cloud.microsoft`) and to public DNS,
with an empty env (no tenant id, domain or credential in them). Any mock `pnpm dev` does the same every 15 minutes. No
Graph, ARM or Log Analytics request left the host (those go through the fixture fetch). The importer test created and
dropped a scratch database on the dev Postgres that dev.env's `DATABASE_URL` names, as designed (F-01 (3) stops that).
Not run: e2e, visual, `test:e2e:prod`, `test:perf`, a cluster, an image build.

## 1. Verdict

**Functionally solid and unusually well tested; the gaps are in test reliability, mock-mode completeness and the
share of content that has never run live.** The core read, arm, run, approve and schedule behaviour held under every
negative path tried: stale previews by five causes, foreign cursors, self-approval, role loss mid-run, parked runs
resumed after arming, the sixth event stream refused, oversized bodies refused. Every provoked error body carried a
code, a message and a reference, and role denials named the exact group.

Three things need attention before the suites can be trusted as a gate: `pnpm test` is red today for reasons
unrelated to any change (one date-bound test, three load-dependent timeouts); no write playbook can complete in mock
mode, so the confirm → run → compensate path through the real executor is exercised only by fakes; and nothing asserts
that every content datasource has a fixture, so a fixture typo ships silently.

## 2. Results

Today's run on `feat/sqlite-on-pvc` @ 2c7103d beside the original run on `main` @ f243038. The test sets differ: the
branch deleted the deploy and Postgres-only tests and added the SQLite ones; the original baseline also held the
uncommitted SharePoint-sharing tests.

| Check | `main` @ f243038 (original) | `feat/sqlite-on-pvc` @ 2c7103d (2026-10-21) |
| ----- | --------------------------- | ------------------------------------------- |
| `pnpm test` projects (unit·component·api·content·guards) | **4 failed / 5,418 passed** (5,422 tests, 451 files), 268 s, exit 1 | Run 1: **1 failed / 5,394 passed / 3 skipped** (5,398 tests, 451 files), 247 s, exit 1. Run 2, with the mock API and its sweeps running beside it: **2 failed / 5,393 passed / 3 skipped**, 257 s (the sort test, and `retired-scopes` timed out) |
| `vitest --project scale` | 295 / 295, 41 s | 292 / 292, 39 s |
| `pnpm adminforge validate` | 420 definitions valid; 16 warnings for Graph beta endpoints | same |
| `pnpm adminforge test` | 318 passed, 0 failed (75 definitions with tests) | same |
| `pnpm adminforge env check` | ready; one warning (`WRITE_AUTH_CONTEXT` unset, so arming proves a fresh sign-in, not MFA) | exit 1 against this host's dev.env: portal not ready (`DATABASE_PATH` missing); dev.env still sets `DATABASE_URL` and `RUN_WORKER_IN_PROCESS` (this host stays on the Postgres release, ADR-017); the same `WRITE_AUTH_CONTEXT` warning |
| Mock-API datasource sweep | 380 / 380 list datasources and 69 / 71 derivable entity datasources render from fixtures | 431 datasources of 144 page-like definitions (134 without required params, 10 entity pages with a derivable id): 374 ok, 57 skipped by `when`, 0 failed; 14 entity pages need a sample id |
| Mock-API error paths | ~30; every body carried `code`, `message`, `correlationId` | re-checked for F-05, F-06, F-10, F-12, F-13: still true; the hints of F-13 still missing; 413 answers `ctp_body_too_large` |
| Mock-mode write playbook | — | `identity.disable-user`: preview ok; the armed run fails at `disable` with `FixtureNotFound` (F-02) |
| Mock-mode probe sweeps | — | 76 probes; the HTTP, DNS and TLS ones used the network (F-20) |

Failing and slow tests on the branch:

| Test | 2026-10-21 on the branch | Alone |
| ---- | ------------------------ | ----- |
| `content/m365-overview-sorts.test.ts:72` | fails in both runs: expected `['overdue','overdue']`, got `['overdue','soon']` | **still fails** |
| `unit/cli/retired-scopes.test.ts:37` | run 1 passed (2,994 ms); run 2 timed out in 5,000 ms | passes (2.1 s) |
| OBSOLETE — `unit/deploy/backup-script.test.ts:169` | deleted with `portal/deploy/backup` (ADR-017) | — |
| `component/query/query-studio.test.tsx:151` | passed both runs, 4,310 and 4,173 ms of 5,000 | passes (1.6 s) |
| 14 (run 1) / 20 (run 2) other tests | 3.5–5.0 s against the 5 s default (news page, ops, schedule run-as, probe detail, playbook drawer, shell, runs, renderer, `unit/cli/news-feeds`, `unit/api/config`, …) | — |

Flow coverage (rating from the tests that exist, with the test files named in the reviewer's report): sign-in,
session expiry, re-auth and CAE, arm and step-up, page render and paging, advanced filters, exports, preview →
confirm → run, compensation, approvals, parked runs, role loss mid-run, bulk runs, schedules, probes, the runner
protocol, news feeds, Query Studio, the CLI, error mapping, throttling, secret outputs and emergency stop are all
**well tested**. **Thin:** a write playbook end to end through the real connectors; every page rendering from fixtures;
missed-run visibility. **Untested:** per-user run limits (no code path); probes in fixtures mode without the network
(F-20); live behaviour of Billing, Arc, AVD and the Graph beta content. On the branch the run queue, leases, signals,
schedules and runs suites run everywhere on a temporary SQLite file (`tests/api/*-db.test.ts`, `run-queue-db`), so
the worker and scheduler paths no longer skip without Postgres.

## 3. Keep doing

- The API suite drives the real Fastify app with the real engine, executor, scheduler and runner clients and only the
  network faked; negative paths dominate.
- Content is validated like code: write-capable playbooks must ship tests; 65 / 65 active write-capable playbooks
  carry `risk`, every write step a `describe`, 64 / 65 a `confirm`, 38 a `compensate`; retired content cannot be
  linked or scheduled.
- The outbound layer defends itself: default-deny before any token, `nextLink` leaving Graph or ARM refused, page and
  item caps with `truncated`, per-service and per-identity slots with a crawl lane, `Retry-After` honoured and capped.
- Run state machine with ten explicit statuses, checkpoints per step, abandoned runs re-queued, parked runs expired
  with audit, single-use 15-minute previews, bulk capped at 1,000.
- Secrets never persist: show-once over the initiator's stream, sealed hand-off between processes.

## 4. Findings

| Id   | Sev    | Title                                                                                        | Status                 | Effort |
| ---- | ------ | -------------------------------------------------------------------------------------------- | ---------------------- | ------ |
| F-01 | High   | `pnpm test` is red on today's tree: one brittle clock test, three load-dependent timeouts    | NEW                    | S      |
| F-02 | Medium | No write playbook can complete in mock mode; no automated end-to-end write through real connectors | NEW              | S–M    |
| F-03 | Medium | Nothing asserts that every content datasource renders from fixtures; e2e visits 9 page keys  | NEW                    | M      |
| F-08 | Medium | No per-user cap on queued/active runs or previews; four global worker slots                  | known (backlog)        | M      |
| F-09 | Medium | Missed cron ticks (> 1 h) are skipped with only a log line                                   | NEW (= design D-09)    | S      |
| F-11 | Medium | About a sixth of the active catalogue has only run against fixtures; 16 definitions use Graph beta | known (backlog)  | M      |
| F-14 | Medium | 250 ms wall-clock transform budget shared with the event loop → `content_error` under load   | known (backlog)        | L      |
| F-05 | Low    | Unknown and retired page keys get an author-facing hint; the FS source never says "retired"  | NEW                    | S      |
| F-06 | Low    | Query Studio accepts Resource Graph queries that `validate` refuses                           | NEW                    | S      |
| F-07 | Low    | `docs/api.md` drift: route count, one route missing from the index, login limit wrong        | NEW                    | S      |
| F-10 | Low    | Run-now executes disabled schedules (the six disabled ones are the unvalidated ones)         | NEW (confirm design)   | S      |
| F-13 | Low    | Several user-reachable 4xx bodies carry no `hint`; zod wording leaks into messages           | NEW                    | S      |
| F-04 | Low    | Mock-mode monitoring shows false `crit` for two HTTP probes whose hosts have no fixture      | NEW                    | S      |
| F-16 | Low    | 8 platform probes have no `link`; `identity.revoke-consent-grant` is high risk with a click confirm | NEW             | S      |
| F-15 | Low    | Derived datasources do not carry `truncated` into exports; incompleteness audited, not shown | known (backlog)        | M      |
| F-18 | Low    | Scheduled PowerShell unsupported while Exchange/Teams content looks schedulable             | known (backlog)        | L      |
| F-19 | Low    | `m365.teams-user-policies` is active but known broken live                                   | known (backlog)        | M      |
| F-12 | Info   | `POST /auth/mock/state` can leave a role-less session (mock, loopback only)                  | NEW                    | S      |
| F-20 | Medium | In `DATA_MODE=fixtures`, HTTP, DNS and TLS probes and Teams delivery use the network          | NEW (validation)       | S–M    |

### F-01 · `pnpm test` is red today (High) — CHANGED, see the validation

**Evidence.** `tests/content/m365-overview-sorts.test.ts:16` pins the scope `now` to `2026-10-17T12:00:00Z`, but
lines 57-58 build the message dates from `Date.now()` under the comment "$daysUntil counts from the real clock". It
does not: `portal/packages/expressions/src/helpers.ts:1163-1164` registers `daysUntil` with `scopeNow(this)`. A
message due three days ago is one day in the future relative to the pinned clock, so it classifies as `soon`. The test
began failing on 2026-10-20; the content is correct. The three timeouts: `tests/vitest.config.ts` sets `testTimeout`
only for the live and perf projects, so unit and component run at 5,000 ms while 48 workers compete; the victims load
the whole content tree, spawn `bash` stubs, or drive `userEvent` through jsdom.

**Failure scenario.** Any engineer runs `pnpm test` and sees red for a reason unrelated to their change; CI loses
its signal and people learn to ignore it.

**Remediation.**

1. Derive the dates in the sort test from the pinned `now` (or drop the pin and compute expectations from the clock).
2. `testTimeout: 15_000` for the unit and component projects (or per file for the three), and a bounded `maxWorkers`
   for the component project.
3. CI: fail on any skipped test when `CI=true` (the backlog already asks for this for Postgres and module skips).

**Done when** `pnpm test` is green three runs in a row on this host and in CI.

### F-02 · Write playbooks cannot complete in mock mode (Medium)

**Evidence.** In mock mode, `identity.disable-user` preview → typed confirmation → run parked the write step while
unarmed; arming and resuming continued it; the write then failed with `FixtureNotFound` for
`PATCH …/users/…/PATCH.json`, exposing a fixture file path. `portal/packages/connectors/src/fixtures.ts:35,216` has an
`acceptWrites` option that answers 204 to undeclared writes; nothing under `portal/apps/api/src` sets it. The tree has
12 write-method fixtures, none for PATCH or DELETE. The e2e automation spec drives a stateful mock of the runs API
(`tests/support/web/mock-automation.ts`), and the API tests use `FakeExecutor`.

**Failure scenario.** A new engineer follows the setup guide ("runs everything on synthetic data"), arms with the dev
toolbar and runs any of the 65 write playbooks: every one fails at its first write. `compensate` and `onError` never
execute outside unit fakes; a regression in the executor's write handling (policy, Write-app token, long-running
operation wait) is caught only by unit tests.

**Remediation.**

1. With `AUTH_MODE=mock`, build the fixture fetch with `acceptWrites: true`; map a remaining 404 to a mock-specific
   message. Keep the switch fenced to mock mode (security lane).
2. PATCH / POST / DELETE fixtures for the `AF-Test-*` shaped objects the playbook tests use.
3. One API test that runs a write playbook through the real `OutboundExecutor` on fixtures: dry run → confirm → run →
   forced failure → `compensate`.

### F-03 · Fixture completeness is unchecked (Medium)

**Evidence.** No test enumerates `portal/content` datasources against `tests/fixtures`; the content tests cover
chosen libraries; `validate-all.test.ts` checks schema and expressions only; the e2e specs reference nine `/p/<key>`
pages. The reviewer's sweep is the first full pass: 158 active page-like definitions, 479 datasources, 449 run, zero
`FixtureNotFound`, zero `content_error`, zero empty lists; 8 entity pages could not be given an id
(`azure.arc-server`, `identity.ca-policy`, `m365.distribution-list`, `avd.host-pool`, `m365.licence`, `m365.mailbox`,
`avd.session-host`, `identity.sign-in`). The setup guide lists "a page is blank in mock mode" as an expected symptom.

**Remediation.** `tests/content/fixtures-complete.test.ts` in the `content` project: load every active page,
dashboard and report, run each datasource through `DatasourceRunner` on `tests/fixtures` with default params (entity
pages via a small key → sample-id map or a `params.<id>.example`), assert no `FixtureNotFound` or `content_error`.
About two seconds for the whole catalogue. This also closes the organization plan's O-16 (eight KQL probes without an
`af:` variant).

### F-08 · No per-user run or preview limits (Medium, known) — CHANGED: `SqliteRunQueue`, not pg-boss

**Evidence.** No per-user cap in `runs/*.ts` or `routes/runs.ts`; `RUN_WORKER_CONCURRENCY` default 4; every preview
is a queued job; pg-boss retries up to 50 times over 5 h.

**Failure scenario.** One Operator's tab retrying previews, or a looping script, occupies all four slots; confirmed
runs queue behind dry runs.

**Remediation.** Cap queued plus running runs per user (about 5) → 429 `too_many_runs` with a hint; a lower cap for
dry runs; confirmed runs ahead of dry runs in the queue. Coordinate the values with the security plan.

### F-09 · Missed cron ticks vanish (Medium; same defect as design D-09)

**Evidence.** `schedules/scheduler.ts:260-266`: a tick overdue by more than the misfire grace (default one hour) logs
`missed run skipped` and `continue`s. No `schedule_runs` row, no audit, no event. Contrast `skipPaused`
(`scheduler.ts:372-400`), which records a `skipped` run and audits.

**Failure scenario.** The host is down from 06:00 to 08:30 on a Monday. Every 07:00 weekly report is skipped; the
Schedules page shows last week's file as the latest; recipients notice days later.

**Remediation.** Record a `skipped` run with `reason: missed` (reuse the `skipPaused` shape), raise a
`schedule.missed` event, and let the content-health job flag schedules whose last run is older than their cadence.

### F-11 · Fixture-only content and beta endpoints (Medium, known)

**Evidence.** 389 active definitions. Fixture-only by the backlog's own lists: Azure Billing (11 active), Arc (15),
AVD (19), plus the Exchange/Teams/OneDrive items, Intune device actions, BitLocker/LAPS, CA report-only via Log
Analytics, Identity Protection writes. 16 definitions call Graph beta (4 dashboards, 3 pages, 1 probe, 8 reports).

**Remediation.** Make the status visible instead of buried in dated backlog sections: a `validatedLive: <date>` (or
`preview: true`) field on definitions, rendered as a quiet badge, and a licensing table generated from it (ties to the
organization plan's O-02 licensing split). Schedule a quarterly beta re-check.

### F-14 · Transform budget under load (Medium, known) — CHANGED: one process, matters more

**Evidence.** `datasources/executor.ts:794-809`: 250 ms wall-clock with one retry; `executor.ts:912-914` → 500
`content_error`. `tests/perf/budgets.json`: 42 `knownSlow`, 21 `mayTimeOut`, 11 entries allowed above 250 ms (up to
988 ms). docs/performance.md: 0–3 of 1,300–4,300 datasources failed at 50 engineers; up to 8 of 8,400 at 200.

**Remediation.** As the backlog says: count only the transform's own CPU time or move transforms to a worker pool
with a larger budget for reports and exports; the copy-free hand-over between derived datasources is the cheapest
next win. The design plan recommends promoting this to High in the backlog.

### F-20 · Probes and Teams delivery use the network in fixtures mode (Medium, new in validation)

**Evidence.** `portal/apps/api/src/schedules/module.ts:117-128` builds the probes' dependencies with `ctx.fetch` (the
global `fetch`) and without `dns`, `tls` or `lookup`, so HTTP probes resolve and fetch for real
(`probes/checks.ts:245,286`), DNS probes ask the system resolver (`:464-506`) and certificate probes open a TLS
connection (`:559,596`) even with `DATA_MODE=fixtures`; Teams delivery gets the same `fetch` (`module.ts:133`). Run
now on the five probe sweeps of the mock API from the worktree: `m365-web-portal` 200 in 285 ms, `teams-web-client` 200
in 244 ms, `exchange-outlook-web` 302, `exchange-outlook-connectivity` 401, `entra-home-realm-discovery` 200 without
`DomainName`, `exchange-autodiscover-service` 400, DNS probes `ENOTFOUND`. The code is the same at f243038.

**Failure scenario.** Every mock `pnpm dev` (and an e2e run that crosses a quarter hour) sends requests to Microsoft
and public DNS every 15 minutes (`sweep.every-15-minutes` is enabled), mock monitoring depends on this machine's
internet, and the setup guide's "every page renders from the synthetic fixtures" is not true for monitoring. With
`AUTH_MODE=entra DATA_MODE=fixtures` and a real env file the probes would look up the real tenant's domain.

**Remediation.** In fixtures mode, give probes and delivery the fixture fetch, a fixture lookup (a synthetic public
address, so the SSRF guard still runs), a fixture DNS resolver and a fixture TLS inspector (`ProbeDeps` already accepts
`dns`, `tls` and `lookup`); add host fixtures for every HTTP probe host; an API test runs every sweep in a mock app whose
global fetch and resolver throw. Related: security S-24 and S-40 (probe egress in the cluster).

### F-05, F-06, F-07, F-10, F-13, F-04, F-16, F-12 · Low and Info

- **F-05** `GET /api/definitions/page/security.incidents` (retired) → 404 `definition_not_found` with the hint "publish
  the content (adminforge publish)"; `definitions/fs-source.ts:210,218` never returns retired records, so
  `definition_retired` (409) can only come from the database store with a version. Resolve retired keys on both
  stores and answer with the retirement note and successor; word the unknown-key hint for the person.
- **F-06** `POST /api/query` accepted a four-`join` Resource Graph query that `validate` refuses; "Save as report" then
  fails after the engineer believes the query works. Run the same join/union lint in `routes/query.ts` → 400
  `invalid_query` naming the rule.
- **F-07** `docs/api.md` says 66 routes; 70 are registered; `POST /auth/schedule-consent` is missing from the index;
  the login section says 30/min while the table and `config.ts:95` say 300. Generate the index from the route table
  in a test (the backlog wants the same for error codes).
- **F-10** `POST /api/schedules/<key>/run` on a content schedule with `enabled: false` → 202 and a `succeeded` run;
  the six disabled schedules are disabled because they are unvalidated. Confirm the intent; if kept, ask for a
  confirmation in the UI or let content say `runNowWhileDisabled: false`.
- **F-13** `not_found`, `invalid_cursor`, `run_not_found`, `datasource_not_found`, 413 and `invalid_request` carry no
  `hint`; zod text ("Invalid option: expected one of \"csv\"|\"xlsx\"") reaches the message. Add hints where a person
  can act; map zod issues to plain phrases in `errors.ts:55-62`.
- **F-04** (CHANGED — the probes don't use fixtures at all; see F-20.) Mock monitoring shows crit for `probes.entra-home-realm-discovery` and
  `probes.exchange-autodiscover-service` because `tests/fixtures/hosts/` lacks their hosts. Add the two fixtures.
- **F-16** Eight `group: platform` probes (`probes.portal-readiness`, `probes.portal-tls-certificate`,
  `probes.token-*`) have no `link`; `identity.revoke-consent-grant` is `risk: high` with `confirm: click` and no
  approval while the playbook skill says high prefers typed. Add links to Provisioning status; switch to a typed
  confirmation (the grant's app name).
- **F-12** `POST /auth/mock/state {roles: []}` leaves a valid role-less session; the real path ends the session. Make
  the mock route match.

## 5. Remediation plan

Rewritten after the validation. Q1–Q6 are the owner decisions (validation section); WP-x the work packages below.

### Now (this week)

| #   | Task | Findings | Depends on | WP |
| --- | ---- | -------- | ---------- | -- |
| 1   | Pin the sort test's clock; `testTimeout: 15_000` for unit, component and content; the importer test needs `TEST_POSTGRES_URL` and fails instead of skipping in CI | F-01 | — | A |
| 2   | Probes and Teams delivery offline in fixtures mode (fixture fetch, lookup, DNS, TLS; host fixtures) | F-20, F-04 | — | C |
| 3   | `acceptWrites` under `AUTH_MODE=mock` only | F-02 (part 1) | — | B |
| 4   | A missed tick becomes a `skipped` run with `schedule_missed`, audited, with an event | F-09 (= D-09) | Q3 | D |
| 5   | API wording and docs: route index and its test, retired and unknown keys, zod and 413 wording, hints, the join lint in `/api/query`, the role-less mock session | F-07, F-05, F-13, F-06, F-12 | — | E |
| 6   | Typed confirmation on `identity.revoke-consent-grant`; links on the six token probes | F-16 | — | G |

### Next (two to four weeks)

| #   | Task | Findings | Depends on | WP |
| --- | ---- | -------- | ---------- | -- |
| 7   | `tests/content/fixtures-complete.test.ts` over every active page, dashboard and report datasource | F-03 | 1 | C |
| 8   | API test: a write playbook through the real executor on fixtures, forced failure → `compensate` | F-02 (part 2) | 3 | B |
| 9   | Per-user cap on open runs (429 `too_many_runs`); worker concurrency 8 | F-08 | Q2 | F |
| 10  | Run now on a switched-off schedule delivers the file only | F-10 | Q1 | D |
| 11  | `preview: true`, its badge and the generated licensing table; flag `m365.teams-user-policies` | F-11, F-19 (flag) | Q4, Q5 | H |
| 12  | Re-measure `pnpm test:perf` with the run worker and the sweeps in the API process | F-14 (part 1) | — | I |

### Later

| #   | Task | Findings | Depends on | WP |
| --- | ---- | -------- | ---------- | -- |
| 13  | Transforms in a `worker_threads` pool (scheduled runs and exports first); copy-free derived hand-over | F-14 | 12 | — |
| 14  | Scheduled PowerShell with app-only tokens the API forwards; Teams PowerShell read path (licensed tenant) | F-18, F-19 | Q6 | — |
| 15  | `truncated` through derived datasources; "incomplete" banner for interactive exports | F-15 | — | — |

### Work packages (file sets do not overlap)

Each package is one branch and one reviewer pass; any order. **Shared files:** `CHANGELOG.md` and `docs/backlog.md`
get one hunk per package (CLAUDE.md: split by hunk). `docs/api.md` and `docs/troubleshooting.md` belong to WP-E: WP-D
(F-09, F-10) and WP-F (`too_many_runs`) put their paragraphs in their pull request and WP-E applies them (it lands
last, or adds them in a follow-up commit; its index test then keeps the index honest). **Across the four plans:** the
security plan also edits `api/errors.ts` (S-12), `api/config.ts` (S-01) and probe egress (S-24, S-40); give each file
one owner across all plans before starting.

| WP | Findings | Owns | Tests | Done when |
| -- | -------- | ---- | ----- | --------- |
| A | F-01 | `tests/content/m365-overview-sorts.test.ts`, `tests/vitest.config.ts`, `tests/api/import-postgres.test.ts` | the suite itself | the five projects are green three runs in a row on this host, one of them beside a second full run; CI green; without `TEST_POSTGRES_URL` the importer test fails under `CI=true` and skips locally |
| B | F-02 | `api/datasources/services.ts`, `tests/api/runs-helpers.ts`, `tests/fixtures/graph/v1.0/users/<AF-Test id>/{PATCH,DELETE}.json`, `docs/onboarding/01-setup.md` | `tests/api/mock-mode-writes.test.ts`, `tests/api/runs-real-executor-compensate.test.ts` (new) | in mock mode `identity.disable-user` preview → typed confirm → armed run succeeds; `AUTH_MODE=entra DATA_MODE=fixtures` still answers 404 to an unfixtured write; the forced failure runs `compensate` through the real executor; `security-reviewer` ran |
| C | F-20, F-04, F-03 | `api/schedules/module.ts`, `api/probes/fixture-network.ts` (new), `tests/fixtures/hosts/…`, `tests/fixtures/dns/…` (new), fixtures for the gaps F-03 finds (not B's), `docs/onboarding/09-testing.md`, `.claude/skills/adding-a-schedule-or-probe/SKILL.md` | `tests/api/probes-fixtures-offline.test.ts`, `tests/content/fixtures-complete.test.ts` (new) | every sweep in a mock app whose global fetch and resolver throw records results without touching the network; mock monitoring shows only "not configured" for unset keys; every active page-like datasource renders from fixtures (entity pages by sample id) in under 10 s |
| D | F-09, F-10, F-13 (cursor) | `api/schedules/{scheduler,jobs,service}.ts`, `web/ops/ScheduleControls.tsx`, `tests/unit/scheduler/scheduler.test.ts` (`:200`), `docs/operations.md` | `tests/unit/scheduler/missed-tick.test.ts`, `tests/api/schedules-run-now-disabled.test.ts`, `tests/component/web/automation/run-now-disabled.test.tsx` (new) | a tick missed by more than the grace leaves a `skipped` run with `schedule_missed`, an audit event and `schedule.updated`; run now on a switched-off schedule writes the file and sends nothing, and says so; screenshots steel and daylight; `design-reviewer` ran |
| E | F-05, F-06, F-07, F-12, F-13 | `api/errors.ts`, `api/app.ts`, `api/datasources/executor.ts` (hint only), `api/definitions/{fs-source,db-store,registry,current}.ts`, `api/query/service.ts`, `api/auth/mock-routes.ts`, `docs/api.md`, `docs/troubleshooting.md` | `tests/api/api-doc-index.test.ts`, `tests/api/definitions-retired-key.test.ts`, `tests/api/definitions-retired-key-db.test.ts`, `tests/api/query-join-limit.test.ts`, `tests/api/mock-state-no-roles.test.ts`, `tests/unit/api/error-wording.test.ts` (new) | the index test passes for mock and Entra; each body reproduced for F-05, F-06, F-12 and F-13 carries a plain message and a hint; `security-reviewer` ran (mock routes, query) |
| F | F-08, F-13 (runs) | `api/runs/{service,types,sqlite-repository,memory-repository}.ts`, `api/config.ts`, `config/example.env`, `tests/api/run-worker-concurrency.test.ts` | `tests/api/runs-per-user-cap.test.ts`, `tests/api/runs-per-user-cap-db.test.ts` (new) | the sixth open root run of one person → 429 `too_many_runs` with a hint (bulk once, parked runs not counted), other people unaffected, in memory and on SQLite; worker default 8; `security-reviewer` ran |
| G | F-16 | `portal/content/probes/token-*.probe.yaml` (6), `portal/content/playbooks/identity/revoke-consent-grant.playbook.yaml` | the playbook's own `tests:`; `validate` | `pnpm adminforge validate` and `test` clean; `content-reviewer` ran |
| H | F-11, F-19 (flag) | `pkg/schemas/common.ts` (+ generated schemas), `web/renderer/PageParts.tsx`, `cli/commands/validate.ts`, `docs/licensing-review.md`, `docs/extending.md`, `.claude/skills/adding-a-page-or-report/SKILL.md`, the flagged content (not G's files) | `tests/unit/schemas/preview-flag.test.ts`, `tests/component/web/preview-badge.test.tsx` (new) | Q4/Q5 answered; `validate` lists the previews; the badge screenshotted steel and daylight; `design-reviewer` and `content-reviewer` ran |
| I | F-14 (measure) | `tests/perf/harness/*`, `docs/performance.md` | `pnpm test:perf` | new numbers with the worker and sweeps in process recorded in `docs/performance.md`; the pool decision (row 13) made from them. The uncommitted SharePoint work in the old checkout also edits `tests/perf/*`: land or rebase that first |

## 6. Not verified

- Anything live: every statement about Graph, ARM, KQL and runner behaviour comes from code and tests. The
  fixture-only groups and the 16 beta-endpoint definitions have never been exercised against a tenant.
- `pnpm test:perf` was not run (it writes `tests/perf/out/` inside the repository and needs about 4 GB of heap); the
  budgets file and the 2026-10-17 numbers in docs/performance.md were read instead.
- e2e, visual and CSP suites were read, not run (the dev stack was in use by the design review, and a production
  build on this host changes what is served).
- Ten entity pages whose sample id could not be derived from fixture paths.
- Scheduler and worker on Postgres end to end are covered by the `*-pg` API suites that ran against the local
  `adminforge_test` database, not observed in mock mode. (On the branch: the `*-db` suites on a temporary SQLite
  file, run in the validation; the scheduler and worker with a database file were not observed outside tests.)
- DST only via the cron unit test; all 63 content schedules are UTC, so the path is unused in shipped content.
