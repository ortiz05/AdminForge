# Platform review 2026-10-21 — implementation

> **Status:** done (2026-10-21). Implemented the four validated review plans
> (`2026-10-21-platform-review-{design,organization,functionality,security}.md`, each with a "Validation against
> feat/sqlite-on-pvc" section) on branch `fix/platform-review`, stacked on `feat/sqlite-on-pvc`. Target platform
> confirmed by the owner on 2026-10-21: **a Kubernetes cluster on other hardware** (ADR-017 stands).

## Decisions taken

The validators' recommended answers are taken as defaults so the work can proceed; each is reversible in review.
Items marked **owner** are not done here and are listed at the end.

| Plan  | Decision                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------- |
| D-01  | After a restart interrupted runs resume (repeatable steps retried, others `needs_review`)                        |
| D-10  | Inspector at width factor 2; D-11: no compact default (measure after the header changes)                         |
| D-13  | Breaking-news pill in the rail: info tone always                                                                 |
| D-14  | The eight "Service checks" nav items fold into a status dot on each section header                               |
| D-18  | Content write actions stay clickable with a lock glyph and an "arm to run" hint (the dry run works unarmed)      |
| B-3   | Keep `/monitoring`; retire the content Probe dashboard (`status: retired` + version bump)                        |
| D-05  | Hourly incremental audit-chain check from the last checkpoint plus a daily full walk                             |
| D-08  | The Query Studio gallery stays in code; `PLANNED` goes; entity pages are declared on content                     |
| B-2   | "Transforms off the event loop" becomes High in the backlog; the worker pool itself is deferred (below)          |
| Org   | Tests may import package internals (guard runtime code only; no feature barrels); size ratchet, not splits       |
| O-05  | Option (b): folder = id prefix enforced by `validate`, plus `adminforge list`; nothing moves                     |
| O-08  | `add-news-feed` keeps its name; O-09: British spelling for new identifiers and UI text                           |
| O-13  | Retire commit scope `plan`, rename `dev` → `tooling`                                                             |
| O-10  | One installation-neutral rule: never build, install or typecheck in a checkout a running service serves          |
| F-10  | Run now on a switched-off schedule writes the file only: no e-mail, Teams or notifications, and says so          |
| F-08  | At most 5 open runs per person (previews included, a bulk run once, parked runs not counted); worker default 8   |
| F-09  | A missed tick is a `skipped` run with code `schedule_missed` (status CHECK unchanged), audited, with an event    |
| F-11  | `preview: true` on definitions with a quiet badge; F-19: `m365.teams-user-policies` flagged preview              |
| S-04  | Dependencies wait 7 days (`minimumReleaseAge`, Dependabot cooldown), with a per-package exclude for urgent fixes |
| S-40  | The base NetworkPolicy refuses egress to private ranges; the overlay names exceptions                            |
| S-39  | The `/proc` key read under the restricted pod is an accepted, documented gap                                     |

## Wave 1 — parallel packages

Each package is a branch `review/<name>` from `fix/platform-review` in its own worktree
(`~/.config/superpowers/worktrees/Azure-Admin/review-<name>`). A file has one owner; where two packages must touch
the same file they edit different functions and the merge resolves it. **Reserved for wave 2** (no wave-1 package
edits them; each package reports the text to add instead): `CHANGELOG.md`, `docs/backlog.md`, `SECURITY.md`,
`CLAUDE.md`, `README.md`, `.claude/**`, `docs/extending.md`, `docs/onboarding/**`, `docs/operations.md`,
`docs/licensing-review.md`, e2e screenshot baselines.

| Package        | Findings                                                          | Owns (besides its new tests)                                                                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runs           | D-01, D-24, F-08                                                  | `engine/src/{engine,errors}.ts`, `api/src/runs/**` (heartbeat call site shared with `sched`), `api/src/routes/runs.ts`, `api/src/{main,shutdown}.ts`; adds its keys to `api/src/config.ts` and `config/example.env`                                            |
| sched          | D-02, D-05, D-09, D-23a, D-20, F-09, F-10                         | `api/src/{housekeeping,health}/**`, `api/src/schedules/{scheduler,jobs,service}.ts`, `api/src/schedules/module.ts` (heartbeat), `api/src/audit/writer.ts`, `api/src/db/client.ts`, audit-chain check in `probes/checks.ts`, `web/src/ops/ScheduleControls.tsx`, `docs/architecture.md`, ADR-014 |
| fixtures       | F-20, F-04, F-03 (+O-16), F-02, S-24                              | `api/src/probes/fixture-network.ts`, HTTP path of `probes/checks.ts`, probe wiring in `schedules/module.ts`, `api/src/datasources/services.ts`, `tests/fixtures/**` additions, `tests/api/runs-helpers.ts`                                                    |
| outbound       | S-02, S-15, S-31, S-26, D-03a, D-23b, D-19c                       | `connectors/src/{http,arm}.ts`, `api/src/datasources/executor.ts`, `schemas/src/datasource.ts`, `api/src/execution/protected.ts`, `cli/src/content/lint.ts`, `engine/src/handlers.ts`, `api/src/auth/routes.ts` (tenantProfile), `scheduler/src/one-shot.ts` |
| lint           | S-03, S-13, S-34                                                  | `expressions/src/{validate,evaluate,limits}.ts`                                                                                                                                                                                                                |
| shared         | D-06, D-15, D-16, D-21 (schemas/browser), D-08 (entity pages), S-14 | `schemas/src/{index,widgets,browser,path,param-check,page}.ts`, `schemas/package.json`, `widgets/src/lib/path.ts`, table widget, `ui/src/primitives/DataTable.tsx`, `ui/src/recipes/kpi.ts`, `api/src/reports/export.ts`, `api/src/datasources/params.ts`, `engine/src/inputs.ts`, `api/src/search/search.ts`, `web/src/renderer/{params.ts,QueryBuilder.tsx}`, `docs/widgets.md`, content with neutral `status` columns |
| api-errors     | F-06, F-07, F-12, F-13, S-12, S-28, S-29                          | `api/src/{errors,app}.ts`, `api/src/query/**`, `api/src/routes/query.ts`, `api/src/auth/{mock-routes,preauth-store}.ts`, `api/src/datasources/env.ts`, `docs/api.md`, `docs/troubleshooting.md`                                                             |
| definitions    | F-05, S-07, D-07, S-27, S-06                                      | `api/src/definitions/**`, `api/src/db/schema.ts`, `api/drizzle/0002_*`, `api/src/tooling.ts`, `api/src/events/bus.ts`, `cli/src/commands/publish.ts`, `cli/src/content/review-state.ts`, `deploy/kubernetes/build-images.sh`, `docs/decisions.md`             |
| web-shell      | D-12, D-13, D-14, D-17, B-3, F-16                                 | `web/src/app/{NavRail,BreakingPill}.tsx`, `web/src/ops/MonitoringPage.tsx`, `ui/src/primitives/Chart.tsx`, `ui/src/recipes/panel.ts`, `content/navigation.yaml`, `content/dashboards/monitoring.dashboard.yaml`, `inactive-guests.report.yaml`, the token probes, `revoke-consent-grant.playbook.yaml` |
| web-list       | D-10, D-11, D-18, D-19ab, D-08 (`PLANNED`), F-11, F-19, S-11 (actions) | `design-tokens/src/tokens.ts`, `ui/src/{recipes/page-header.ts,primitives/PageHeader.tsx}`, `web/src/renderer/{blocks,PageView,PageParts,FilterRegion,ActionGroup}.tsx`, `widgets/src/lib/actions.tsx`, `widgets/src/types.ts`, `schemas/src/{api,common}.ts`, `web/src/lib/catalog.ts`, `ComingSoonPage.tsx`, `routes/$.tsx`, `cli/src/commands/validate.ts`, `user.page.yaml`, `teams-user-policies` |
| widgets-safety | S-05, S-11 (links), S-21, S-32                                    | `widgets/src/lib/{text.ts,WidgetPanel.tsx}`, `widgets/src/widgets/{markdown,list,kpi,status-grid}/*`, `web/src/lib/{links.tsx,api.ts}`, `web/src/query/history.ts`                                                                                           |
| config-cli     | S-01/D-04, S-16, S-18, S-19, S-22, S-41                           | `api/src/config.ts` (production rules), `config/example.env`, `cli/src/index.ts`, `packages/config/src/index.ts`, `cli/src/provision/identities-io.ts`, `cli/src/commands/db.ts`                                                                             |
| platform       | target requirements, S-40, S-37 (image pins)                      | `deploy/kubernetes/{README.md,Dockerfile,base/*,overlays/**,tools/*}`, a read-only cluster preflight, `runner/Dockerfile`                                                                                                                                     |
| supply         | S-04, S-20, S-30, S-39, D-21 (scheduler deps), O-11, O-13, O-14, S-35 | `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.github/**`, `.gitignore`, `turbo.json`, `tooling/git/commit-message.mjs`, `runner/package.json`, `scheduler/package.json`, `widgets/tsconfig.json`, `runner/ps/AdminForge.Runner/ReadOnlyPolicy.ps1`        |
| tests          | F-01, O-03 (runtime guard), O-06 (scale and pwsh conventions)     | `tests/vitest.config.ts`, `tests/package.json`, `tests/README.md`, the sort and importer tests, the scale and pwsh test files (renamed), `tests/guards/no-deep-imports.test.ts`                                                                              |

## Wave 2 — after wave 1 is merged

- **Docs and organization:** O-01 (`docs/README.md` index), O-02 (backlog by area, licensing findings split), O-08
  (skill skeleton, new skills, plan directives struck), O-09, O-10 (stale statements, the served-checkout rule),
  O-12 (ADR back-fill), O-05 (`portal/content/README.md`, folder = id prefix, `adminforge list`), S-33, the wave-1 doc
  notes into the reserved files, path/index/skills-shape tests.
- **Security, second wave:** S-10 (keyed audit chain), S-08 (session id rotated on arm), S-25 (other Operators see
  run metadata only), S-23 (`readPost`), O-07 (one GUID pattern, one `formatBytes`), O-04 file-size ratchet.
- **Integration:** full suite three times, e2e and screenshot baselines regenerated once, `pnpm adminforge
  validate|test`, the reviewer agents on the combined diff.

## Deferred, with the reason

| Item                                       | Why not now                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| F-14 / B-2 transforms in a worker pool     | L; acceptance is `pnpm test:perf`, whose harness has uncommitted edits in the old checkout               |
| F-18 scheduled PowerShell, F-19 read path  | L; needs app-only tokens forwarded to the runner and a licensed tenant                                   |
| F-15 `truncated` through derived sources   | Later in the plan; touches the executor the outbound package changes                                     |
| O-04 file splits, O-06 full re-layout, O-15 | Refactors with no behaviour change on an unmerged 280-file branch; the ratchet stops growth meanwhile    |
| B-4 `env.` in browser expressions          | The two pages it must fix are being edited in the old checkout's uncommitted SharePoint work             |
| S-37 module hashes, S-38, CI-signed images | Later; needs CI and registry decisions (owner)                                                           |
| D-03b breaker                              | Only if live throttling shows a need                                                                     |

## Owner actions (not done here)

- **S-09:** set `WRITE_AUTH_CONTEXT` (Entra ID P1, a Conditional Access authentication context requiring MFA) in the
  installation's Secret before write playbooks go live.
- **O-02:** cut release `0.2.0` (the last Postgres release, on `main` before this branch merges) and push the tag.
- **S-10:** an `AUDIT_CHAIN_KEY` in the Secret and container-log shipping off the cluster (wave 2 makes the key
  optional until then).
- The interim host (`adminforge-sqlite.service`) serves a worktree's build; serving a copied release instead is a host
  change for the owner to approve.

## Outcome (2026-10-21)

Everything above except the deferred table landed on `fix/platform-review` (about 310 commits on `feat/sqlite-on-pvc`,
not pushed): the 15 wave-1 packages; wave 2 (S-10 keyed audit chain, S-08 session rotation on arm, S-25/S-23 run
visibility and `readPost`, confirmations rendered by the API, resume re-checks, O-07 helpers, the O-04 ratchet, the
docs index, the skills kit, the content taxonomy, the registers); then a security, design and content review of the
whole branch and four packages that fixed what they found (child-playbook writes count as writes, fixture data never
reaches the runner, one-shots follow the emergency stop, `idempotent: false` requests are sent once, entity page params
are checked as ids; table write locks, the phone session rail; typed confirmations for medium-risk bulk actions and
high-risk runbooks, name fallbacks to object ids). CHANGELOG `Unreleased › Platform review`, SECURITY.md, the backlog
register and the licensing map record it.

Decisions taken during the work, on top of the table above: bulk actions of risk medium or higher confirm by typing
the count; "asked to approve" (S-25) means a gate the person may decide that is pending and not expired; extending or
disarming write access keeps the session id; a prearm resume doesn't ask for the typed confirmation again; the App
Service restart/start/stop playbooks are offered from the App Service security report rather than retired; the size
ratchet starts from the sizes the review left (`engine.ts` 2,401 lines — moving the resume re-check out is the first
split).

Verified: `pnpm test` three runs in a row (7,369 tests and 399 scale tests), e2e 190 against baselines regenerated in
full, the production build's CSP e2e, initial JS 246.5 of 250 KB, `adminforge validate` (420) and `test` (321),
typecheck, lint and format. Not verified: anything live — the cluster, a tenant, the runner image build; the backlog's
`live` rows list each check.
