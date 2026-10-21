# Platform review 2026-10-21 — Organization: findings and remediation plan

> **Status:** in progress — see `2026-10-21-platform-review-implementation.md`. One of four review plans produced
> on 2026-10-21 (design, organization, functionality, security). Baseline: `main` @ f243038 plus the uncommitted
> SharePoint-sharing work, which was not judged.
> Method: a read-only reviewer agent measured the repository (imports, counts, sizes, docs claims) and ran `pnpm lint`,
> `pnpm format:check` and `pnpm typecheck` (all green; typecheck served from cache). Its highest-leverage claims
> (O-03, O-08, O-11) were re-verified by hand. Sibling plans: `2026-10-21-platform-review-design.md`,
> `2026-10-21-platform-review-functionality.md`, `2026-10-21-platform-review-security.md`.
> Validated against `feat/sqlite-on-pvc` @ 2c7103d on 2026-10-21 (next section); §4 and §5 reflect that validation.

## Validation against feat/sqlite-on-pvc (2026-10-21)

Re-measured in the `platform-review` worktree (`fix/platform-review` = `feat/sqlite-on-pvc` @ 2c7103d: one SQLite
file on a PersistentVolume, Kubernetes only, ADR-016/017, most docs rewritten). Read-only except this file; ran
`pnpm lint`, `prettier --check .`, `pnpm typecheck`, `pnpm guard`, `pnpm adminforge validate` and the unit, component,
api and content projects (§5). The rewrite resolved no finding except the first half of O-14 (the file was deleted),
left all four stale statements of O-10, and added new ones in the files Claude reads first — the most consequential:
the docs now say a local build can't reach production while this host serves a worktree's build (O-10 d, O-11).
Verdicts: 12 CONFIRMED, 3 CHANGED (O-03, O-11, O-14), 1 moved to the functionality plan (O-16), none wholly OBSOLETE.
The evidence in §3 is the baseline's; the branch's numbers are here. Packages P1–P7 are defined in §4.

| Id   | Verdict                      | Evidence in W                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Adjusted remediation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Decision  | Effort          | Files                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O-01 | CONFIRMED                    | No `docs/README.md`. `README.md:91-104`, `docs/onboarding/11-documentation.md:8-27` and `docs/onboarding/README.md:66-75` still omit `enterprise-scenarios.md` and `performance.md`; the deploy runbook now lives outside `docs/` (`portal/deploy/kubernetes/README.md`) and only `README.md:100` lists it. Join rule stated in 7 files (`CLAUDE.md:66-67`, `content-reviewer.md:21`, page skill :30-31, `extending.md:69-71`, `glossary.md:16`, `decisions.md:103-105`, `08-content-guide.md:89-92`); `--no-verify` in 8 docs, `remedy` in 15.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | As planned, plus rows for the deploy runbook and the package READMEs (cli, scheduler, runner, `content/scripts`, tooling, tests). "State once" is done by P2a/P2b in the files they own; `docs/decisions.md` keeps its copy (a dated log, not a rule).                                                                                                                                                                                                                                                                                                                                     | —         | M               | P3: new `docs/README.md`, `README.md:84-104`, `docs/onboarding/11-documentation.md:6-27`, `docs/onboarding/README.md:62-75`, new `tests/unit/docs/index.test.ts`                                                                                                                                                                                            |
| O-02 | CONFIRMED                    | `docs/backlog.md` 71,750 B: 18 h2, 11 named by batch (10 dated, new "SQLite on a PersistentVolume, Kubernetes (2026-10-20)" at :697); 253 items, 201 open, 52 done inline. `docs/licensing-review.md` unchanged (120,178 B; 16 of 17 sections dated; 162 lines over 300 characters, longest 1,752). `CHANGELOG.md` `Unreleased` 78.7 KB / 134 entries, no release since `0.1.0` (:789); its intro (:9-10) still says it closes the gaps against the original plan; it now mixes the last Postgres release with a breaking storage and deployment change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | (1) Backlog by area as planned. (2) Keep `docs/licensing-review.md` as the feature → licence map (14 files cite the path, incl. `cli/src/commands/provision.ts:146` and `widgets/src/widgets/licence-gate/Widget.tsx:6`); dated findings → `docs/licensing/findings/<date>-<topic>.md`. (3) Release `0.2.0` = the last Postgres release; SQLite/Kubernetes under the next version — gives "the last Postgres release" (ADR-017, Kubernetes README) a tag. (4) Rules 9/14 then need no edit. Start after the old checkout's uncommitted SharePoint work is committed (it edits both files). | D1        | M               | P4: `docs/backlog.md`, `docs/licensing-review.md`, new `docs/licensing/findings/*.md`, `CHANGELOG.md`, new `tests/unit/docs/registers.test.ts`; tags (code owner)                                                                                                                                                                                           |
| O-03 | CHANGED                      | Exports unchanged (`portal/apps/api/package.json:6-12` incl. `./src/*`; runner `./src/*`; scheduler gained `./one-shot`; web and cli none). Tests: 490 sites, 109 API modules, 178 files (top `execution/types` 28, `db/client` 26, `execution/outbound` 23, `auth/types` 22, `datasources/executor` 20). Runtime: 0 deep imports (`scheduler/src/one-shot.ts:1,12`, `cli/src/content/api-bridge.ts:29` use `/tooling`). Wrong in the plan: tests use 51 web modules (128 sites) and 48 cli modules (180 sites), not two — unit and component tests of single modules, as rule 2 asks. Step 3 is obsolete: no worker or scheduler service exists (ADR-016) and the CLI bundle inlines the tooling barrels (`portal/tools/cli/tsup.config.ts`). `docs/backlog.md:128` still says scheduler and CLI deep-import.                                                                                                                                                                                                                                                                                                                                                                  | Drop the barrels and the server-core extraction. Keep `./src/*` as the tests' entry; `tests/guards/no-deep-imports.test.ts` keeps runtime code at 0 deep imports; move files with a codemod when a refactor needs it. Correct the backlog item (P4).                                                                                                                                                                                                                                                                                                                                       | D2        | S               | P5: new guard; P4: `docs/backlog.md:125-131`                                                                                                                                                                                                                                                                                                                |
| O-04 | CONFIRMED                    | Same eight files at the same sizes (`outbound.ts` 1,804, `engine.ts` 1,778, `runs/service.ts` 1,368, `DataTable.tsx` 1,256, `helpers.ts` 1,241, `executor.ts` 1,165, `probes/checks.ts` 1,084, `design/sections.tsx` 1,009); ten runtime files over 800 lines (plus `schedules/scheduler.ts` 989, `schedules/service.ts` 827); `schedules/` 5,765 lines, `runs/` 4,926. The branch didn't touch them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Ratchet now: `tests/guards/file-size.test.ts`, an 800-line ceiling with the ten files allow-listed at today's count (they may shrink, never grow). Split one file per PR when a feature touches it; `outbound.ts` only with `security-reviewer` and after the security plan's Now items (same file). No longer waits for O-03.                                                                                                                                                                                                                                                             | D3        | S now, L splits | P5: new guard; splits later                                                                                                                                                                                                                                                                                                                                 |
| O-05 | CONFIRMED                    | No `portal/content/README.md`. `pages/m365/` 20 files, 8 with nav section exchange, sharepoint or teams; `reports/m365/` 14, 9 with area exchange (4), sharepoint (3), teams (2); `dashboards/` 9 flat files and 2 in sub-folders; `schedules/` reports 58, probes 5, maintenance 2, billing 2; `probes/` 82 flat; 31 retired; validate: 420 definitions. Folder = id prefix holds everywhere (the billing schedules are `billing.*`) but nothing enforces it (`portal/tools/cli/src/content/check.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Option (b): `portal/content/README.md` (folder = id prefix; section = `nav.section` / `area` / `group`; suffixes; where probes and schedules go); validate enforces folder = id prefix (flat dashboards and probes listed as exceptions); `adminforge list [--kind] [--section]` prints `id · kind · section · status · file` instead of a committed `docs/content-index.md`, which every content PR would conflict on. `schedules/billing/` stays (ids can't change). Rule 4 and the skills' search step name the command in a follow-up.                                                 | D4        | M               | P7: new `portal/content/README.md`, new `portal/tools/cli/src/commands/list.ts`, `portal/tools/cli/src/index.ts`, `portal/tools/cli/src/content/check.ts`, `portal/tools/cli/README.md`, new `tests/unit/cli/content-list.test.ts`, new `tests/unit/cli/content-folder-prefix.test.ts`                                                                      |
| O-06 | CONFIRMED, one number off    | `tests/api/` 93 tests, 8 top-level helpers and `support/`; `tests/component/{news,query,reports}` beside `web/`; `tests/content/` 42 files, 16 named by batch; `SCALE` list `tests/vitest.config.ts:9-19` (9 globs, 17 files). Real `pwsh` in 4 of 13 runner unit files (`integration`, `pester`, `worker-inputs`, `worker-settings`, all `skipIf(!hasPwsh)`), not 8 — the rest spawn the fake node worker. New double suffixes `db-{backup,leases,signals,triggers}-db.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Now: `*.scale.test.ts` replaces the list (rename the 17 files); the four pwsh files become `*.pwsh.test.ts` in a `pwsh` project that `pnpm test` runs. Later, only if still wanted: `tests/api/<feature>/`, `component/web/<feature>/`, topic names for content tests — mechanical, conflicts with every branch that adds tests, no behaviour gain. No longer waits for O-03/O-04.                                                                                                                                                                                                         | —         | S now, M later  | P5: `tests/vitest.config.ts`, `tests/package.json`, the 21 renamed files, `tests/README.md`, `docs/onboarding/09-testing.md`                                                                                                                                                                                                                                |
| O-07 | CONFIRMED, one more          | GUID literal at 32 sites in 31 files (api 18, web 8, engine 2, connectors 1, expressions 1, schemas 3 incl. the `[0-9a-fA-F]` variant `params.ts:26`, cli `provision/ids.ts:13`); `formatBytes` at `web/src/ops/ui.tsx:138` and `widgets/src/lib/format.ts:26` (exported, `widgets/src/index.ts:32`); `truncate` at `api/src/logging.ts:18`, `runner/src/protocol.ts:171`; exponential backoff six times, one new with the SQLite queue (`api/src/runs/queue.ts:229`; `connectors/src/http.ts:178`, `engine.ts:1772`, `cli/src/provision/retry.ts:47`, `runner/src/pool.ts:323`, `schedules/scheduler.ts:116`); sleep exported at `connectors/src/types.ts:24`, abortable copies in `schedules/jobs.ts:115`, `probes/transactions.ts:52`.                                                                                                                                                                                                                                                                                                                                                                                                                                       | `GUID_RE`/`isGuid` from `@adminforge/schemas` for api, web, engine, cli (standalone checks only; GUIDs inside larger patterns stay); expressions and connectors keep one local copy each (no internal dependencies by design, `03-repository-map.md:42-46`); the runner keeps its own (zero-dependency sidecar image). Web uses `formatBytes` from `@adminforge/widgets` (10 MB and up shows "12 MB", not "12.3 MB": check the e2e baselines). Backoff only if one `exponentialDelay()` fits — the six differ in jitter, Retry-After and fixed mode.                                       | —         | S               | P6: `portal/packages/schemas/src/{guid.ts,index.ts,input-values.ts,params.ts,connection.ts}`, the api, web, engine and cli files with a standalone GUID check, `web/src/ops/{ui.tsx,SchedulePage.tsx}`, `web/src/reports/ReportDetails.tsx`, new `tests/unit/schemas/guid.test.ts`, new `tests/guards/guid-literal.test.ts`                                 |
| O-08 | CONFIRMED, plus new          | Skills: api-route and runner-script lack "Common mistakes", service-connector and validating-against-a-tenant lack "Steps", design-system has "Rules"; 0 of 10 have "done when"; the page skill is 235 lines. `design-reviewer.md:7` still points at "§6 of the master plan"; `master-plan.md:8` directive still live and its banner (:3-6) still says hosting is "this host". New: `docs/plans/2026-10-20-sqlite-on-pvc.md:3` has the same "REQUIRED SUB-SKILL … implement this plan task-by-task" on a plan whose §3 says every task is done, with no status line; four of the six older plans have none either. Plan citations unchanged: `.github/CODEOWNERS:1`, `.github/dependabot.yml:1`, `tooling/ci/check-bundle.mjs:3`, `tooling/README.md:38`, `docs/extending.md:111`.                                                                                                                                                                                                                                                                                                                                                                                              | Step 1 widened: every `docs/plans/*.md` opens with a status line (Proposed, Done <date> or Historical) and a done or historical plan carries no agent directive (`tests/unit/docs/plans-status.test.ts`). `design-reviewer.md`: state the direction inline and point at the design-system skill and `tokens.ts` — no new doc. Skeleton, `docs/content-recipes.md` and citations as planned; new skills only for coded screen and configuration key (CLI command → `portal/tools/cli/README.md`, ADR → `templates/adr.md`, expression helper → content recipes).                            | D5        | M               | P2a: five older plans, `.github/CODEOWNERS`, `.github/dependabot.yml`, `tooling/ci/check-bundle.mjs`, `tooling/README.md`, new `tests/unit/docs/plans-status.test.ts`; P2b: `.claude/skills/**`, `.claude/agents/*.md`, `docs/extending.md`, `docs/onboarding/12-claude-code.md`, new `docs/content-recipes.md`, new `tests/unit/docs/skills-shape.test.ts` |
| O-09 | CONFIRMED                    | The branch changed no terms. Wider count (portal, docs, CLAUDE.md, `.claude`; plans excluded): `licenseThreshold` 13 and `LicenseThresholdCheck` 2 against British _licence_ elsewhere; _catalogue_ 113 / _catalog_ 83 (`routes/report-catalog.ts`); _utilisation_ 20 / _utilization_ 33; _preview_ 369 / _dry run_ 60.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | As planned; `licenseThreshold` stays and is listed as an exception (an alias costs the schema, 8 probes and tests for a spelling).                                                                                                                                                                                                                                                                                                                                                                                                                                                         | D6        | S               | P2a: `docs/onboarding/glossary.md`                                                                                                                                                                                                                                                                                                                          |
| O-10 | CONFIRMED, plus new          | All four still wrong: `08-content-guide.md:58` (feeds "by hand"; `cli/src/content/scaffold.ts:24` scaffolds `feed`), `03-repository-map.md:117` and `08-content-guide.md:16` (no `billing/`), `api/src/admin/appearance.ts:2` (it imports `@adminforge/design-tokens` by name, :12), `docs/backlog.md:128`. Every backticked path and link in CLAUDE.md, skills, agents and onboarding exists. New: (a) `SECURITY.md › Host and network`, renamed "Deployment, storage and network" (`SECURITY.md:364`), at `07-web-guide.md:47` and `extending.md:77`; (b) `11-documentation.md:26` calls `portal/deploy/README.md` "host installation"; (c) `03-repository-map.md:19` lists the CLI without `db`; (d) "a local `pnpm build` never reaches production" and "the old host keeps running the last Postgres release" at `CLAUDE.md:99-101`, `13-releases-and-operations.md:35-37,59`, `01-setup.md:83-84`, `09-testing.md:113-115` — false on this host today (O-11); (e) `05-coding-standards.md:19-20` points at a setup caveat that `01-setup.md` no longer has, and `12-claude-code.md` dropped "none builds in the checkout the services run from" while the hazard remains. | Fix all, each in the package that owns the file. The path test also checks `› Heading` and `→ Heading` references, since that is what broke.                                                                                                                                                                                                                                                                                                                                                                                                                                               | D7 (d, e) | S               | P2a: `03`, `07`, `08`, `appearance.ts`, new `tests/unit/docs/paths-exist.test.ts`; P1: `CLAUDE.md`, `01`, `05`, `13`; P5: `09`; P3: `11`; P2b: `extending.md`, `12`; P4: backlog                                                                                                                                                                            |
| O-11 | CHANGED                      | `turbo.json:8` unchanged; typecheck is now 21 tasks (adds `cli:build`, the new tsup bundle). In this never-built worktree it wrote `portal/apps/{api,web,runner,scheduler}/dist`, `portal/tools/cli/dist`, `design-tokens/dist` and `schemas/generated`, 18 of 21 tasks replayed from `/home/tradebosshq/Azure-Admin/.turbo/cache`, which every worktree shares. The hazard moved: the live portal (`adminforge-sqlite.service`, a user unit outside git) runs `feat-sqlite-on-pvc/portal/apps/api/dist/main.js` and serves that worktree's `portal/apps/web/dist` (default `WEB_DIST_DIR`, `api/src/config.ts:354`); the old checkout's runner unit runs its `runner/dist`. A typecheck or build in either is a deploy (web at once, server at the next restart), and the docs now say the opposite (O-10 d). Dropping `^build` is safe: no TypeScript imports a build output (only CSS points at `design-tokens/dist`), tests read `schemas/generated` only as path strings, and CI builds design-tokens itself (`.github/workflows/ci.yml:55`).                                                                                                                              | `"typecheck": {}` in `turbo.json`, pinned by a unit test. One installation-neutral line in CLAUDE.md Commands: never build, install or typecheck in a checkout that a running service serves; fix the statements of O-10 d and e. Out of the repo (code owner): point the interim unit at a copied release (`WEB_DIST_DIR`, a copied api `dist`) so no worktree is live.                                                                                                                                                                                                                   | D7        | S               | P1: `turbo.json`, `CLAUDE.md:86,99-101,115-116`, `docs/onboarding/01-setup.md:83-84`, `05-coding-standards.md:19-20`, `13-releases-and-operations.md:35-37,59`, new `tests/unit/tooling/turbo-tasks.test.ts`                                                                                                                                                |
| O-12 | CONFIRMED                    | ADR-001/002/003/005/006/007/010 still 278–431 bytes; ADR-004 and 008 are superseded (by 016 and 017) and need no back-fill; `docs/onboarding/templates/adr.md` exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | As planned, for the seven.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —         | S               | P3: `docs/adr/{001,002,003,005,006,007,010}-*.md`                                                                                                                                                                                                                                                                                                           |
| O-13 | CONFIRMED                    | `tooling/git/commit-message.mjs:16-51` still lists `plan` (5 commits) and `dev` (7); `content` (26) is the largest. The SQLite work used `api,cli` and `deploy`, which still fit (`deploy` now means Kubernetes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Retire `plan`, rename `dev` → `tooling`; no new scopes (database work is `api` or `cli`). The sync test keeps guide and template aligned.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | D8        | S               | P1: `tooling/git/commit-message.mjs`, `docs/onboarding/10-git-and-pull-requests.md:55`, `docs/onboarding/templates/commit-message.txt`                                                                                                                                                                                                                      |
| O-14 | CHANGED, first half OBSOLETE | `portal/deploy/db/harden-postgres.ts` and `scram.mjs` were deleted with the host deployment (95d1b89); no TypeScript is left under `portal/deploy`. Still true: `ui` has `types: []`, `widgets` `types: ["node"]`, and widgets uses no Node API. Six build configs (four `tsup.config.ts` incl. the new CLI one, `api/drizzle.config.ts`, `web/vite.config.ts`) are outside every tsconfig.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `widgets` → `types: []`. The build configs can stay outside (a broken one fails the build loudly).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —         | S               | P1: `portal/packages/widgets/tsconfig.json`                                                                                                                                                                                                                                                                                                                 |
| O-15 | CONFIRMED                    | `web/src/pages/` 4 coded screens, `web/src/ops/` 7 `*Page.tsx` and 11 helpers, 5,672 lines. The other coded screens already sit in feature folders (`news/`, `query/`, `reports/`, `runs/`, `playbooks/`), so `pages/` and `ops/` are the exceptions. A move touches 28 web files and 5 test files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Later, after the design plan's UI work in `ops/` lands: `ops/` → `schedules/`, `monitoring/`, `admin/`; `pages/*` → `overview/`, `design/`, `public/`.                                                                                                                                                                                                                                                                                                                                                                                                                                     | —         | M               | Later: `portal/apps/web/src/{ops,pages}/**`, their importers and route files                                                                                                                                                                                                                                                                                |
| O-16 | CONFIRMED, moved             | The same eight active KQL probes have no `af:` variant among the 68 keys in `tests/fixtures/resourceGraph/POST.json` and `tests/fixtures/logAnalytics/*/POST.json`. The functionality plan's F-07 (`tests/content/fixtures-complete.test.ts`) says it closes this, but it runs page, dashboard and report datasources, not probes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Fold into F-07: extend its test to KQL probes and add the eight variants there. No task here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —         | S               | Functionality plan F-07                                                                                                                                                                                                                                                                                                                                     |

### Owner decisions

| #   | Question                                                                                                | Recommended answer                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How are releases numbered across the storage change?                                                    | Cut `0.2.0` from `main` just before `feat/sqlite-on-pvc` merges (the last Postgres release); SQLite/Kubernetes ships as `0.3.0` (breaking; 0.x bumps the minor).                                                                         |
| D2  | May tests keep importing package internals through `./src/*`?                                           | Yes. Guard runtime code only (0 deep imports today); drop feature barrels and the server-core package.                                                                                                                                   |
| D3  | God files: refactor sprint, or ratchet and split when touched?                                          | Ratchet now (800-line ceiling, today's ten files allow-listed), split one file per PR when a feature touches it.                                                                                                                         |
| D4  | Content taxonomy: (a) move files under section folders, or (b) document and enforce folder = id prefix? | (b), with `adminforge list` instead of a committed index. Nothing moves; ids and saved references stay valid.                                                                                                                            |
| D5  | Rename `add-news-feed` → `adding-a-news-feed`?                                                          | Not now: cosmetic (the description drives selection) and it touches six files across three packages. Revisit with the next change to that skill.                                                                                         |
| D6  | One spelling for new identifiers and UI text?                                                           | British (licence, catalogue, utilisation); existing ids and routes unchanged; `licenseThreshold` a listed exception.                                                                                                                     |
| D7  | How do the docs state that this host serves a worktree's build until the cluster exists?                | One installation-neutral rule in CLAUDE.md (never build, install or typecheck in a served checkout); the specifics in operator notes outside git; and the code owner points the interim unit at a copied release so no worktree is live. |
| D8  | Commit scopes: retire `plan`, rename `dev` → `tooling`?                                                 | Yes; no new scopes.                                                                                                                                                                                                                      |

## 1. Verdict

Good bones, growing clutter. Boundaries hold: no package imports an app, the web app imports nothing server-side,
no runtime code imports a test library, no test lives under `portal/`, and the dependency table in the repository
map matches the real `package.json` graph exactly. Tooling is unified (one lint config; the design-token pattern
list feeds ESLint, the guard test and the after-edit hook; the commit-message check is shared by hook and CI).
Config is in sync (all 124 keys in `config/example.env` are read somewhere — 117 on the branch; every key read in code
exists there).

What is degrading is **findability**, which matters more here than in most repos because the team extends the
product through Claude Code and the agent finds its way by grepping: there is no documentation index and the same
rule is stated in up to seven files; the backlog, licensing review and changelog are dated journals rather than
registers; the API package exposes `./src/*` so tests couple to 104 internal modules (109 on the branch, which the
validation accepts for tests, D2); and content folders, test folders and skill names each follow two conventions at
once. Nothing here is a defect in behaviour — every item is a cost paid on each future change.

## 2. Keep doing

- Dependency direction and test placement rules (CLAUDE.md rule 2) are followed to the letter; keep the guard tests.
- One source per check (`tooling/lint/design-token-patterns.mjs`, `tooling/git/commit-message.mjs`, the scope sync test).
- Content metadata is uniform where validation enforces it: 420/420 definitions carry `version`, `owner`, `tags`,
  `summary`, `$schema`; zero id/folder mismatches; zero duplicate ids.
- Historical plans are labelled historical and excluded from Prettier.

## 3. Findings

Evidence in this section is as measured on `main` @ f243038; the validation table above has the branch's numbers and
the adjusted remediation, which wins where they differ.

| Id   | Sev    | Title                                                                                          | Status (validated)            | Effort          |
| ---- | ------ | ---------------------------------------------------------------------------------------------- | ----------------------------- | --------------- |
| O-01 | High   | No docs index; rules repeated in up to seven files; two docs unreachable from any map          | NEW · CONFIRMED               | M               |
| O-02 | High   | Backlog, licensing review and CHANGELOG are journals, not registers                            | NEW · CONFIRMED               | M               |
| O-03 | High   | `@adminforge/api` exports `./src/*`; tests deep-import 109 modules (490 import sites)          | partly known · CHANGED        | S               |
| O-04 | Medium | Eight runtime files over 1,000 lines; `schedules/` and `runs/` over 4,900 lines each           | known (backlog) · CONFIRMED   | S now, L splits |
| O-05 | Medium | Content taxonomy: folders, ids, nav sections and job groups follow two conventions             | partly known · CONFIRMED      | M               |
| O-06 | Medium | Test layout: flat API folder, two helper conventions, batch-named content tests                | partly known · CONFIRMED      | S now, M later  |
| O-07 | Medium | Duplicated helpers (GUID regex ×32, `formatBytes` ×2, `truncate` ×2, backoff ×6, sleep ×3)     | mostly known · CONFIRMED      | S               |
| O-08 | Medium | Skills have no shared skeleton or "done when"; plans carry live directives; configs cite plans | NEW · CONFIRMED, plus new     | M               |
| O-09 | Medium | Terminology drift between glossary, code identifiers and UI labels                             | mostly NEW · CONFIRMED        | S               |
| O-10 | Medium | Stale statements in the files Claude reads first (four old, five new)                          | NEW · CONFIRMED, plus new     | S               |
| O-11 | Medium | `pnpm typecheck` depends on `^build`, so it rebuilds what this host serves from a worktree     | known (backlog) · CHANGED     | S               |
| O-12 | Low    | ADR-001…010 are one-sentence stubs                                                             | NEW · CONFIRMED               | S               |
| O-13 | Low    | Commit scopes: `plan` and `dev` are vague                                                      | NEW · CONFIRMED               | S               |
| O-14 | Low    | ~~`harden-postgres.ts` outside every tsconfig~~ (deleted); ui/widgets `types` differ           | NEW · CHANGED, half OBSOLETE  | S               |
| O-15 | Low    | Web: `pages/` and `ops/` are two conventions for coded screens; `ops/` is a grab-bag           | NEW · CONFIRMED               | M               |
| O-16 | Low    | Eight active KQL probes have no `af:` fixture variant; the mapping is untested                 | NEW · CONFIRMED, moved (F-07) | S               |

### O-01 · No documentation index; rules repeated in up to seven files

**Evidence.** `docs/` has no `README.md` or index. The two partial maps (`README.md:84-104`,
`docs/onboarding/11-documentation.md:8-27`) both omit `docs/enterprise-scenarios.md` and `docs/performance.md`. The
Resource Graph join rule is stated in seven files (CLAUDE.md rule 14, `docs/onboarding/08-content-guide.md:89-93`,
`docs/extending.md:69-71`, glossary, `docs/decisions.md`, the page skill, the content-reviewer agent); "remedy" rules
in 15 files; "never `--no-verify`" in 10; the non-negotiables appear three times.

**Why it matters.** When the join rule changed on 2026-10-17 it had to land in all seven places. One missed copy
teaches Claude Code, or a new engineer, a different rule.

**Remediation.**

1. Add `docs/README.md`: one table, `document → what it owns → audience → when to update`, listing every file under
   `docs/` and the onboarding set.
2. Apply the docs' own rule "state once, link elsewhere" (`11-documentation.md:72`): each rule's statement has exactly
   one owner (the skill for how-to, CLAUDE.md for the one-sentence non-negotiable, the glossary for the term); every
   other occurrence becomes a link.
3. Make `README.md`, `11-documentation.md` and `onboarding/README.md:63-77` point at the index instead of keeping their
   own lists.

**Done when** `rg -c "join.*union|three.*join" docs CLAUDE.md .claude` finds one statement and links; the index
lists every `docs/**/*.md`; a unit test under `tests/unit/docs/` fails when a doc is added without an index row.

### O-02 · Backlog, licensing review and CHANGELOG are journals

**Evidence.** `docs/backlog.md`: 18 h2 sections, 12 of them dated batch names; 243 bullets (191 open, 52 done kept
inline); no area, priority or owner. `docs/licensing-review.md`: 16 of 17 sections are dated findings; 162 lines
exceed 300 characters (longest 1,752), so diffs and reviews cannot read them. `CHANGELOG.md`: Keep-a-Changelog
sections respected, but `## Unreleased` is 76 KB / 126 entries with no release since `0.1.0 — 2026-10-15`.

**Why it matters.** CLAUDE.md rules 9 and 14 and every skill say "record it in the backlog / licensing review". With
dated headings each session appends a new dated section (five on 2026-10-17 alone); nothing consolidates or closes,
and "is this already known?" needs a full read.

**Remediation.**

1. Restructure `docs/backlog.md` by **area** (security, engine, content, docs, CI, host) with one table per area:
   `item · status · since · owner-type · link`. Done items move out (they are already in CHANGELOG).
2. Split licensing: `docs/licensing/README.md` keeps the durable feature → licence map; dated findings become
   `docs/licensing/findings/<yyyy-mm-dd>-<topic>.md`, one file each, tables wrapped.
3. Cut release `0.2.0` so `Unreleased` is readable again (code owner).
4. Update CLAUDE.md rules 9/14 and the skills to name the new locations (do this once, after O-01 gives each rule a
   single owner).

**Done when** no backlog heading carries a date; every open item has an area; `Unreleased` is under one screen.

### O-03 · `@adminforge/api` exports `./src/*`

**Evidence.** `portal/apps/api/package.json:6-12` exports `./tooling`, `./tooling/scheduler`, `./src/definitions`,
`./src/runs` and `./src/*`; web and cli have no `exports` field; runner exports `./src/*`. Tests import
`@adminforge/api/src/*` from 104 distinct modules at 474 sites (top: `execution/types` 28, `execution/outbound` 23,
`auth/types` 22, `db/client` 21, `datasources/executor` 20). Scheduler and CLI now use only the `/tooling` entry
points (0 deep imports), so the backlog's premise for the server-package extraction is stale: it is the **tests** that
couple.

**Why it matters.** Any file move inside `apps/api` is a 100-file test refactor, which is why none happens and why the
god files (O-04) keep growing. For an agent, "move this into a package" is only cheap when the import surface is small.

**Remediation.**

1. Replace `./src/*` with explicit per-feature entry points (`./execution`, `./auth`, `./runs`, `./schedules`,
   `./probes`, `./db`, `./definitions`, `./audit`), each an `index.ts` re-exporting the public pieces.
2. Give web and cli an `exports` map (tests need only `web/lib/prefs` and `web/app/router`; cli `provision/*`).
3. OBSOLETE — Then do the server-core extraction the backlog already names (db, definitions, audit, outbound, runs,
   schedules, probes, news into a package the scheduler and CLI import). Since ADR-016 there is no scheduler or worker
   service; steps 1–2 are replaced by a guard (validation table, D2).

**Done when** `rg "@adminforge/api/src/" tests portal | wc -l` is 0 and the wildcard is gone from every `exports`.

### O-04 · God files

**Evidence.** `api/src/execution/outbound.ts` 1,804 lines (request policy + tokens + provenance + dispatch, the
single security choke point), `engine/src/engine.ts` 1,778, `api/src/runs/service.ts` 1,368,
`ui/src/primitives/DataTable.tsx` 1,256, `expressions/src/helpers.ts` 1,241, `api/src/datasources/executor.ts` 1,165,
`api/src/probes/checks.ts` 1,084, `web/src/pages/design/sections.tsx` 1,009. Skills point Claude at these by name.

**Remediation.** After O-03 and O-07: split `outbound.ts` into policy / token / dispatch / provenance; `engine.ts` by
step kind; `runs/service.ts` into lifecycle / approvals / streams; `probes/checks.ts` by check family;
`expressions/helpers.ts` one file per helper family. Keep each public index stable so tests move once.

**Done when** no runtime file exceeds 800 lines (`tests/guards` can enforce a ceiling with a documented allow-list).

### O-05 · Content taxonomy follows two conventions

**Evidence.** `pages/m365/` holds 20 pages of which 8 declare `nav.section: exchange|sharepoint|teams`; `reports/m365/`
14 reports of which 9 declare another `area`. `dashboards/` mixes seven flat files whose name ≠ id with two
sub-foldered ones. `schedules/` is documented as job-grouped (`reports/ probes/ maintenance/`) but has a fourth folder
`billing/` that is a section. `probes/` is 82 flat files; a probe's area lives only in `group:`. No
`portal/content/README.md`, no generated index of the 420 definitions; 31 retired files sit beside active ones.

**Why it matters.** "Reuse before adding" (rule 4) depends on `rg` over folders. An agent asked for "an Exchange report"
looks in `reports/exchange/`, finds nothing, and writes a near-duplicate.

**Remediation (choose one).**

- (a) Move files under nav-section folders. Ids stay (saved views, schedules and audit key on id); paths are not
  referenced anywhere (`$schema` resolves relative to the file; fixtures key on URL or `af:` id).
- (b) Keep paths; document "folder = id prefix, section = `nav.section`/`area`" and make `adminforge validate` enforce it.

Either way: add `portal/content/README.md` (taxonomy, suffixes, where probes and schedules go); add
`adminforge validate --index` that writes `docs/content-index.md` (`id · kind · section · status · owner · file`);
normalise `dashboards/` and `schedules/billing/`.

### O-06 · Test layout

**Evidence.** `tests/api/` is one folder of 97 files: 86 tests, 8 helper modules at top level **and** a `support/`
folder (two documented conventions, `tests/README.md:64-77`). `tests/component/` has `news/`, `query/`, `reports/`
beside `web/` though all are web features. `tests/content/` names 44 files by batch, not subject
(`content-at-scale-round2.test.ts`, `mailbox-teams-defender.test.ts`, five `*-library.test.ts`). The `scale` project
is a hard-coded nine-glob list (`tests/vitest.config.ts:9-19`). Eight of 13 `tests/unit/runner/*.test.ts` spawn real
`pwsh` inside the `unit` project.

**Remediation.** `tests/api/<feature>/` mirroring `apps/api/src/<feature>` with one `_helpers.ts` each;
`tests/component/web/<feature>/`; rename content tests to `<kind>-<section>-<topic>` or split per definition id;
`*.scale.test.ts` as the scale convention instead of a list; a `runner-integration` vitest project for real `pwsh`.
Do this **last**, after O-03/O-04 moves settle the import paths.

### O-07 · Duplicated helpers

**Evidence.** The GUID regex is declared 31 times across `schemas`, `expressions`, `engine`, `connectors`, `api`
(11 sites), `web` (7); only `cli/src/provision/ids.ts:13` exports a `GUID_PATTERN`. `formatBytes` in
`web/src/ops/ui.tsx:138` and `widgets/src/lib/format.ts:26`; `truncate` in `api/src/logging.ts:18` and
`runner/src/protocol.ts:171`; sleep + backoff in nine runtime sites.

**Remediation.** `isGuid`/`GUID_RE` from `@adminforge/schemas`; `formatBytes` from `@adminforge/ui`; `sleep`/`backoff`
from `@adminforge/connectors` (`http.ts` owns them). Add a guard test that the regex literal appears once.

### O-08 · Skills kit shape; historical plan still carries a live directive

**Evidence.** Skill sections differ (two skills lack "Common mistakes", two lack "Steps"); 0 of 10 contain "done when"
or a checklist (the checklists live in `08-content-guide.md:174-186` and `checklists.md`); `add-news-feed` breaks the
`adding-a-*` naming; the page skill is 235 lines with a 160-line step 3 mixing rules, Microsoft quirks and JSONata
reference. `.claude/agents/design-reviewer.md:7` says "read §6 of the master plan" while `security-reviewer.md:9`
says the plan is historical. `docs/plans/2026-10-15-adminforge-master-plan.md:8` still reads
"**For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task" under the
Historical banner. `plan §x` is cited as rationale in `.github/CODEOWNERS:1`, `.github/dependabot.yml:1`,
`tooling/ci/check-bundle.mjs:3`, `tooling/README.md:38`, `docs/extending.md:111`. Four rows of the repository map's
"Where does my change go" (coded screen, configuration key, test, ADR) have no skill; the backlog already asks for an
expression-helper skill.

**Why it matters.** Skills are the team's primary interface; inconsistent shape means Claude's output shape varies by
extension point. A live "implement this plan" directive inside a 215 KB historical file is a footgun for any agent
that opens it.

**Remediation.**

1. Strike the directive at `master-plan.md:8` (keep the Historical banner); point `design-reviewer.md` at a short
   `docs/design-direction.md` (or the header of `design-tokens/src/tokens.ts`) instead of plan §6.
2. One skill template: `Overview · When not to use · Steps · Done when · Common mistakes · See also`; rename
   `add-news-feed` → `adding-a-news-feed`.
3. Move the JSONata helper and Microsoft-quirk reference out of the page skill into `docs/content-recipes.md` and link it.
4. Add the small missing skills: coded screen, configuration key, CLI command, ADR, expression helper.
5. Replace `plan §` citations with the ADR or decision that superseded them.

### O-09 · Terminology drift (10 terms checked)

**Evidence.** _licence_ is British everywhere (138 uses, `LicenceGate*`) except the probe kind `licenseThreshold` (8)
and `LicenseThresholdCheck`; _catalogue_ 42 vs _catalog_ 38 (`routes/report-catalog.ts` vs UI "Reports catalogue");
the probe surface has four names (nav "Synthetic monitoring", route `/monitoring`, items "Service checks" /
"Configuration checks", glossary "Probe"); _dry run_ 9 vs _preview_ 101; _utilisation_ 19 vs _utilization_ 33.
Consistent: portal roles, themes, "Emergency stop", `armed`, `remedy/link/group`, "What it found / What to do".

**Remediation.** Give the glossary a "code identifier / UI label" column; pick one spelling for new identifiers and
document the exceptions (existing ids and routes cannot change); rename `licenseThreshold` only with a schema alias.

### O-10 · Stale statements in the files Claude reads first

**Evidence (4 of 12 sampled claims wrong).** `08-content-guide.md:57-58` says feeds are added by hand, but
`cli/src/content/scaffold.ts:22` scaffolds `feed`; `03-repository-map.md:116` and `08-content-guide.md:16` list
schedule groups without `billing/`; `api/src/admin/appearance.ts:2` says design-tokens is "not (yet) an api
dependency" though `package.json` lists it; `docs/backlog.md:130` says scheduler/CLI deep-import `@adminforge/api/src/*`
(0 hits today). Every path cited in skills and agents exists.

**Remediation.** Fix the four. Add `tests/unit/docs/paths-exist.test.ts`: every backticked path in CLAUDE.md, the
skills, the agents and the onboarding set must exist (the kit already proves the pattern with
`commit-scopes-sync.test.ts`).

### O-11 · `pnpm typecheck` is a build

**Evidence.** `turbo.json:8`: `"typecheck": { "dependsOn": ["^build"] }`. Running it builds design-tokens, schemas,
web (`vite build`), runner, api and scheduler first. The review's run was a 19/20 cache hit so nothing changed, but a
cache miss writes `portal/apps/web/dist`, which this host serves live (`WEB_DIST_DIR`). The caveat lives only in
`01-setup.md:87-89`; `CLAUDE.md:94` and `.github/pull_request_template.md:18` ask for `pnpm typecheck` without it.

**Remediation.** Drop `^build` from `typecheck` (packages are consumed from `src` via `exports`); give only the
consumers of `design-tokens` CSS and `schemas` JSON a dependency on those two builds. State the host caveat in the
CLAUDE.md Commands row until then.

### O-12 to O-16 · Low

- **O-12** ADR-001/002/003/005/006/007/010 are 278–431 bytes. Back-fill options considered and consequences from the
  master-plan sections they came from, then drop the plan citations (O-08).
- **O-13** `tooling/git/commit-message.mjs:16-51`: retire scope `plan`, rename `dev` → `tooling`; add `probes` /
  `playbooks` if content commits keep growing (26 `content` commits is already the largest scope). The sync test keeps
  guide and template aligned.
- **O-14** OBSOLETE (first half) — `portal/deploy/db/harden-postgres.ts` (672 lines) and `scram.mjs` sit outside every
  workspace and tsconfig (type-checked only transitively via `tests/unit/deploy`). Add `portal/deploy/tsconfig.json`
  to the typecheck pipeline or move it to `adminforge db harden`. (Both files were deleted with the host deployment,
  95d1b89.) Still open: align `ui` (`types: []`) and `widgets` (`types: ["node"]`).
- **O-15** `web/src/pages/` holds 4 coded screens, `web/src/ops/` holds 7 (`*Page.tsx` for schedules, monitoring,
  settings, audit, appearance; 5,670 lines). Pick `features/<name>/` or `pages/<name>/` for every coded screen; split
  `ops/` into `schedules/`, `monitoring/`, `admin/`.
- **O-16** Eight active KQL probes (`probes.storage-public-blob-access`, `storage-insecure-transport`,
  `key-vault-purge-protection`, `nsg-open-management-ports`, `policy-non-compliance`,
  `resources-missing-required-tags`, `defender-high-severity-recommendations`, `activity-failed-writes-spike`) have no
  `af:<id>` fixture variant and fall through to a generic body. Add a content test: every active Resource Graph / Log
  Analytics datasource and KQL probe has a fixture variant. (Functional side: see the functionality plan.)

## 4. Remediation plan

Rewritten after the validation. Each task names the work package (P1–P7, below) that owns its files; packages have
disjoint file sets and can run in parallel. Dropped: feature barrels and the server-core package (O-03, D2), a
committed `docs/content-index.md` (O-05), renaming `licenseThreshold` (O-09), `portal/deploy/tsconfig.json` (O-14,
file deleted), O-16 (moved to the functionality plan's F-07).

### Now (days; no code moves; unblocks everything else)

| #   | Task                                                                                                                                                       | Findings               | Package | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------- | ---------- |
| 1   | `typecheck` without `^build`; the served-checkout rule in CLAUDE.md and three onboarding guides; widgets `types`; commit scopes                            | O-11, O-10, O-14, O-13 | P1      | D7, D8     |
| 2   | Fix the stale statements (four old, new a–c); a status line on every plan, strike the two directives; replace plan § citations; path and plan-status tests | O-10, O-08             | P2a     | —          |
| 3   | Guards: no runtime deep imports, file-size ratchet; `*.scale.test.ts` and the `pwsh` project; fix `09-testing.md:113-115`                                  | O-03, O-04, O-06, O-10 | P5      | D2, D3     |
| 4   | `docs/README.md` index; the three old maps link to it; fix `11-documentation.md:26`                                                                        | O-01, O-10             | P3      | —          |
| 5   | Cut `0.2.0` (code owner)                                                                                                                                   | O-02                   | P4      | D1         |

### Next (one to two weeks; structure)

| #   | Task                                                                                                                                      | Findings         | Package | Depends on                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------- | ------------------------------------------------------------- |
| 6   | Backlog by area; dated licensing findings into `docs/licensing/findings/` (map keeps its path); correct the code-organization item        | O-02, O-03       | P4      | 5; the SharePoint-sharing work committed                      |
| 7   | Skill skeleton with "Done when"; reference → `docs/content-recipes.md`; skills for coded screen and configuration key; agents; state once | O-08, O-01, O-10 | P2b     | —                                                             |
| 8   | `portal/content/README.md`; validate enforces folder = id prefix; `adminforge list`                                                       | O-05             | P7      | D4                                                            |
| 9   | Glossary code/UI column and spelling rule (P2a); ADR back-fill (P3)                                                                       | O-09, O-12       | P2a, P3 | D6                                                            |
| 10  | Shared `isGuid`, `formatBytes` (backoff only if it fits)                                                                                  | O-07             | P6      | security plan's Now items in `outbound.ts`, `runs/service.ts` |

### Later (refactors; only when a feature touches the code)

| #   | Task                                                                                                                          | Findings | Depends on                |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------- |
| 11  | Split the ratcheted files, one per PR (`outbound.ts` with `security-reviewer`)                                                | O-04     | 3                         |
| 12  | Web feature folders; split `ops/`                                                                                             | O-15     | the design plan's UI work |
| 13  | Test re-layout beyond task 3 (`tests/api/<feature>/`, `component/web/<feature>/`, topic-named content tests), if still wanted | O-06     | —                         |

Follow-ups after merge (one line each, in the owner's file): CLAUDE.md rule 4 and the skills' search step name
`adminforge list` (after P7); the CLAUDE.md Layout `docs/` row links `docs/README.md` (after P3); `tests/README.md` and
`09-testing.md` list P6's `guid-literal` guard (after P6).

### Work packages (disjoint file sets)

`CHANGELOG.md` and `docs/backlog.md` belong to P4, which writes the entries for every package; `CLAUDE.md` belongs to
P1. Every package branches from `fix/platform-review` and runs the reviewer agents that apply.

| Package                             | Findings                                     | Owns (no other package edits these)                                                                                                                                                                                                                                                                                                                                                                                      | Tests                                                                                                                                                                                | Done when                                                                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 Tooling and served checkouts (S) | O-11, O-10 d/e, O-13, O-14                   | `turbo.json`, `CLAUDE.md`, `portal/packages/widgets/tsconfig.json`, `tooling/git/commit-message.mjs`, `docs/onboarding/{01-setup,05-coding-standards,10-git-and-pull-requests,13-releases-and-operations}.md`, `docs/onboarding/templates/commit-message.txt`                                                                                                                                                            | new `tests/unit/tooling/turbo-tasks.test.ts`; `commit-scopes-sync.test.ts`, `commit-message.test.ts`; `pnpm typecheck` in this worktree only                                         | `turbo run typecheck --dry=json` lists no `build` task and a typecheck in a fresh worktree writes no `dist/`; no doc says a local build never reaches production without the served-checkout rule; scopes synced        |
| P2a Stale statements and plans (S)  | O-10 (four old, a–c), O-08 1/5, O-09, O-01 2 | `docs/onboarding/{03-repository-map,07-web-guide,08-content-guide,glossary}.md`, `portal/apps/api/src/admin/appearance.ts`, `docs/plans/{2026-10-15-adminforge-master-plan,2026-10-15-news-and-changes,2026-10-16-m365-e5-unlock-and-tooling,2026-10-17-enterprise-scale-schedules-and-coverage,2026-10-20-sqlite-on-pvc}.md`, `.github/{CODEOWNERS,dependabot.yml}`, `tooling/ci/check-bundle.mjs`, `tooling/README.md` | new `tests/unit/docs/paths-exist.test.ts` (paths, links and `›`/`→` heading references in CLAUDE.md, `.claude/**`, `docs/onboarding/**`), new `tests/unit/docs/plans-status.test.ts` | both tests green; `rg "plan §" .github tooling` empty; "REQUIRED SUB-SKILL" only in plans whose status is Proposed                                                                                                      |
| P2b Skills kit and agents (M)       | O-08 2–4, O-01 2, O-10 a                     | `.claude/skills/**`, `.claude/agents/*.md`, `docs/extending.md`, `docs/onboarding/12-claude-code.md`, new `docs/content-recipes.md`                                                                                                                                                                                                                                                                                      | new `tests/unit/docs/skills-shape.test.ts` (template sections, frontmatter `name` = folder, a description); P2a's path test                                                          | every skill has the six sections incl. "Done when"; the page skill about half its size; the join rule stated in CLAUDE.md and the page skill only, linked elsewhere; `12-claude-code.md` links the served-checkout rule |
| P3 Docs index and ADRs (M)          | O-01 1/3, O-12, O-10 b                       | new `docs/README.md`, `README.md`, `docs/onboarding/{11-documentation,README}.md`, `docs/adr/{001,002,003,005,006,007,010}-*.md`                                                                                                                                                                                                                                                                                         | new `tests/unit/docs/index.test.ts` (every `docs/**/*.md` outside `plans/` and `adr/`, plus `portal/deploy/kubernetes/README.md`, has a row)                                         | the index lists every doc and the old maps link to it; the seven ADRs have context, options considered and consequences                                                                                                 |
| P4 Registers and release (M)        | O-02, O-03 (backlog item)                    | `docs/backlog.md`, `docs/licensing-review.md`, new `docs/licensing/findings/*.md`, `CHANGELOG.md`                                                                                                                                                                                                                                                                                                                        | new `tests/unit/docs/registers.test.ts` (no dated backlog heading; every open item in an area table)                                                                                 | no dated backlog heading; no licensing-map line over 300 characters; `Unreleased` holds only what follows `0.2.0`; the tag pushed by a code owner                                                                       |
| P5 Test layout and guards (S)       | O-03, O-04 ratchet, O-06 now, O-10 d         | `tests/vitest.config.ts`, `tests/package.json`, `tests/README.md`, `docs/onboarding/09-testing.md`, the 17 scale and 4 pwsh test files (renamed), new `tests/guards/{no-deep-imports,file-size}.test.ts`                                                                                                                                                                                                                 | the two guards; `pnpm test` reports the same case count before and after the renames                                                                                                 | the `SCALE` list is gone; `pnpm guard` green; both guards documented                                                                                                                                                    |
| P6 Shared helpers (S)               | O-07                                         | `portal/packages/schemas/src/{guid.ts,index.ts,input-values.ts,params.ts,connection.ts}`, the api, web, engine and cli files with a standalone GUID check, `portal/apps/web/src/ops/{ui.tsx,SchedulePage.tsx}`, `portal/apps/web/src/reports/ReportDetails.tsx`                                                                                                                                                          | new `tests/unit/schemas/guid.test.ts`, new `tests/guards/guid-literal.test.ts`; unit, component and api projects; e2e baselines if byte formatting changes                           | one GUID pattern outside an allow-list; one `formatBytes`                                                                                                                                                               |
| P7 Content taxonomy (M)             | O-05                                         | new `portal/content/README.md`, new `portal/tools/cli/src/commands/list.ts`, `portal/tools/cli/src/index.ts`, `portal/tools/cli/src/content/check.ts`, `portal/tools/cli/README.md`                                                                                                                                                                                                                                      | new `tests/unit/cli/content-list.test.ts`, new `tests/unit/cli/content-folder-prefix.test.ts`; `pnpm adminforge validate`                                                            | validate refuses a file whose folder isn't its id prefix (listed exceptions); `adminforge list --section exchange` finds the Exchange pages and reports kept under `m365/`                                              |

Across the four review plans: P4 (backlog, CHANGELOG) collides with every plan that records a gap — the other plans
hand it their lines; P6 and the O-04 splits touch `outbound.ts` and `runs/service.ts`, which the security plan
changes; P7 touches `content/check.ts`, which validate findings elsewhere may change; O-15 waits for the design plan.

### Target layouts

```text
docs/
├── README.md                  index: every doc, what it owns, audience, update trigger        (O-01)
├── architecture.md · access.md · api.md · operations.md · troubleshooting.md · widgets.md · news.md
├── performance.md · enterprise-scenarios.md
├── content-recipes.md         JSONata helpers, Graph / Resource Graph quirks (from the page skill) (O-08)
├── backlog.md                 by area; one table per area: item · status · since · owner-type · link (O-02)
├── licensing-review.md        feature → licence map (path kept: 14 files cite it)              (O-02)
├── licensing/findings/<yyyy-mm-dd>-<topic>.md
└── adr/  decisions.md  onboarding/  plans/ (a status line on each; no agent directive once done)
```

```text
portal/content/                                                       (O-05 option b; nothing moves)
├── README.md                  taxonomy: folder = id prefix; section = nav.section / area / group; kind suffix;
│                              where probes and schedules go; `adminforge list` to search
└── pages/ reports/ dashboards/ probes/ schedules/ playbooks/ runbooks/ feeds/ connections/ scripts/ navigation.yaml
```

```text
tests/                                                                (O-06, task 3)
├── **/*.scale.test.ts         the scale project (replaces the SCALE list)
├── unit/runner/*.pwsh.test.ts the pwsh project (real PowerShell)
├── guards/                    + no-deep-imports (O-03), file-size (O-04), guid-literal (O-07)
└── later, if still wanted: api/<feature>/, component/web/<feature>/, content/<kind>-<section>-<topic>
```

## 5. Measurements the plan rests on

Measured in the `platform-review` worktree (`feat/sqlite-on-pvc` @ 2c7103d) on 2026-10-21; tracked files only.

| Measure               | Value                                                                                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspaces            | 15 (4 apps, 8 packages, cli, tests, tooling/lint); dependency table in `03-repository-map.md:40-50` matches every `package.json`                                                                                                                                                               |
| Lines (ts/tsx)        | api 32,932 · web 29,469 · cli 16,219 · ui 5,187 · schemas 4,908 · widgets 4,302 · engine 4,098 · expressions 2,828 · runner 2,385 · connectors 1,486 · design-tokens 478 · scheduler 374 · config 265 · tests 93,715                                                                           |
| Configuration         | 117 keys in `config/example.env` (124 before; the Postgres keys went), each read somewhere                                                                                                                                                                                                     |
| Content               | 420 YAML, `adminforge validate`: 420 valid; page 84 · probe 82 · report 77 · playbook 69 · schedule 67 · feed 21 · dashboard 11 · runbook 7 · connection 1 · navigation 1; 31 retired                                                                                                          |
| Tests (files / cases) | unit 264 (256 run) / 2,686 · content 42 (33 run) / 1,651 · api 93 (92 run) / 574 · component 64 / 453 · guards 5 / 31 · scale 17 (not run) · e2e 29 specs (not run) · perf 2 · Pester 14; one failure, the clock-dependent `tests/content/m365-overview-sorts.test.ts:72` (functionality plan) |
| Fixtures              | 1,190 files (graph 1,025 · arm 106 · Postgres schema 1); e2e baselines 105 PNG / 25.0 MB                                                                                                                                                                                                       |
| Docs (bytes)          | master plan 215,597 · licensing-review 120,178 · api 91,146 · CHANGELOG 87,930 (Unreleased 78,691) · troubleshooting 81,932 · operations 73,196 · backlog 71,750 · SECURITY 58,982                                                                                                             |
| Checks                | `pnpm lint` 0 errors / 1 warning (`DataTable.tsx:807`) · `prettier --check .` clean · `pnpm typecheck` 21/21 (18 replayed from the shared turbo cache; it wrote `dist/` in this worktree) · `pnpm guard` 31 passed                                                                             |

## 6. Not verified

- Three skills (`add-news-feed`, `adding-a-service-connector`, `adding-a-widget`) again appear **without
  descriptions** in a skill listing (this session's, from the old checkout) while the other seven show theirs. The
  frontmatter is well-formed (single-line descriptions of 211–301 characters), and the same listing drops descriptions
  of many plugin skills, which points at the listing's size budget (it depends on the plugins installed) rather than
  the files. Still worth a `/skill-doctor` check.
- Orphaned Graph/ARM fixtures (1,131 URL-keyed files) can only be matched by executing every datasource; only the
  `af:`-keyed variants were checked (O-16).
- Whether all 105 e2e PNG baselines are referenced by a spec.
- Not run in this validation: e2e, scale, perf, Pester, and `tests/api/import-postgres.test.ts` (it creates a
  throwaway database on a reachable Postgres; excluded so it wouldn't touch the dev server).
- The live host was only read (`systemctl --user list-units`, `systemctl --user cat adminforge-sqlite.service`); no
  service was started, stopped or rebuilt, and the `feat-sqlite-on-pvc` worktree was not touched.
