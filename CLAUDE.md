# AdminForge — working in this repo

AdminForge is an admin portal for Entra ID, Microsoft 365, Intune, Defender, and Azure. Engineers sign in with SSO and
work through **delegated** permissions (read-only by default; "armed" write access is time-boxed and step-up
authenticated). Unattended schedules run as a separate **automation identity**. Most features are **declarative
content** (YAML) rendered and executed by a generic engine. It is deployed as one Kubernetes pod with all state in one
SQLite file on a PersistentVolume (ADR-016, ADR-017).

Extending AdminForge is meant to be done with Claude Code: use the project skills in `.claude/skills/` — one per
extension point — and the reviewer agents in `.claude/agents/`.

## Layout

| Path                       | What                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `portal/apps/web`          | React SPA: shell, `/p/$key` content renderer, playbook drawer, runs, schedules, Query Studio          |
| `portal/apps/api`          | BFF (Fastify), also the run worker and the scheduler: auth, request policy, datasources, runs, SQLite |
| `portal/apps/scheduler`    | Scheduler one-shots (`--once`, `--probe`, `--schedule`); the scheduler itself runs in the API         |
| `portal/apps/runner`       | PowerShell runner (Exchange/Teams/SharePoint), the pod's sidecar — pinned scripts, delegated tokens   |
| `portal/packages/*`        | `design-tokens`, `ui`, `widgets`, `schemas`, `expressions`, `connectors`, `engine`, `config`          |
| `portal/content`           | Pages, dashboards, reports, playbooks, runbooks, schedules, probes, connections, feeds, scripts, nav  |
| `portal/tools/cli`         | `adminforge` CLI (env check, provision, new, validate, test, publish, audit, db, fixtures)            |
| `portal/deploy/kubernetes` | Images (`build-images.sh`), kustomize base and example overlay, the deployment runbook (`README.md`)  |
| `tests/`                   | **All** tests and test-only deps (unit, component, api, content, e2e, live, guards, fixtures)         |
| `docs/`                    | Every doc, indexed in `docs/README.md`: architecture, API, operations, ADRs, extending, backlog       |
| `docs/onboarding/`         | Engineer onboarding: setup, conventions for code, API, web, content, tests, git, docs, security       |
| `config/example.env`       | Every configuration key, documented. Real values live outside the repo.                               |

## Non-negotiables

1. **Nothing tenant-specific in git.** Tenant/client/subscription/workspace ids, domains, UPNs, secrets live only in
   `~/.config/adminforge/<env>.env`. Content refers to them as `${env.X}` (key must exist in `config/example.env`).
   Fixtures are synthetic (`Example Org`, `example.com`). The guard tests and the pre-commit hook enforce this — never
   bypass them (`--no-verify` is not acceptable).
2. **Tests live under `tests/`**, mirroring the package (`tests/unit/<package>/…`, `tests/component/…`). Runtime code in
   `portal/` never imports test libraries. Add **new** test files; don't append to shared suites like
   `tests/content/validate-all.test.ts`.
3. **Content first.** A new page, report, playbook, runbook, schedule, or probe is YAML in `portal/content`, not code.
   Only when the renderer/engine can't express it, extend them _generically_ (and document in `docs/widgets.md` or the
   schema) — never special-case one page.
4. **Reuse before adding.** Search existing content first (`rg -l "<topic>" portal/content`, `rg "^id:" portal/content`).
   Extend an existing playbook or page (bump its `version`) rather than creating a near-duplicate.
5. **Design tokens only.** UI code uses token utilities (`bg-panel`, `text-fg-2`, `border-line`, `h-(--af-control-h)`);
   no raw colours, no arbitrary Tailwind values. Change the look in `portal/packages/design-tokens/src/tokens.ts`.
   Ember (`armed`) means write mode — nothing else may use it.
6. **Identity and write safety.** Interactive work is delegated (Read app; Write app only while armed). Writes must be
   declared by published content (`mode: write` steps, `describe`, `risk`, `confirm`/`approval`). Never add a generic
   write proxy or app-only permissions to interactive paths. Scheduled writes need two-person approval.
7. **Untrusted input in queries:** `$odata()` / `$odataSearch()` for Graph, `$kql()` for KQL, `$encode()` for path
   segments. Advanced filters are compiled server-side (`${ advanced }`) — never read raw filter params.
8. **Secrets** are never printed, logged, committed, or kept in run outputs (`secretOutputs` on playbook steps).
9. **Licences are data, not blockers.** Declare `requires.licences`; the UI gates and explains. Record new findings in
   `docs/licensing-review.md`; record gaps you can't fix now in `docs/backlog.md`.
10. **Errors are written for the person in front of the browser:** `message` says what happened, `hint` what to do
    (which role or group, licence, or action); every error shows a reference. Never raw JSON, stack traces or header
    names in the UI (env keys and CLI commands only in setup errors meant for administrators, e.g.
    `*_not_configured`); failed browser navigations go to the public problem page. See `SECURITY.md` for
    the security model these rules protect.
11. **Every change ships complete:** content/code + tests + fixtures + docs. If you changed how something is extended,
    update the matching skill in `.claude/skills/` and `docs/extending.md`.
12. **Browser code runs under `script-src 'self'`:** no `eval`, `new Function`, inline scripts or libraries that need
    them (Zod's eval probe is switched off first, `disableEvalProbe`). `pnpm test:e2e:prod` fails on any CSP violation.
13. **Checks explain themselves.** Every probe has a `group` (its service's nav section, or `platform`), a `remedy`
    (what to do) and, where one helps, a `link` (where to act); its detail rows name the item and the value that broke
    the rule. Those rows are collected with application permissions — Operator-only, never copied into messages.
14. **Queries Microsoft accepts.** Resource Graph: at most three `join`/`union` per query and one join to another table
    unless all are `resources` ↔ `resourcecontainers` (`validate` refuses the rest). Run every new query once live,
    read-only — fixtures can't catch what Microsoft rejects — and record what you couldn't check in
    `docs/licensing-review.md` / `docs/backlog.md`. Retire content (`status: retired` + version bump), never delete it.

## Commands

| Task                           | Command                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Install                        | `pnpm install`                                                                                                                           |
| Dev (no tenant needed)         | `ADMINFORGE_ENV_FILE=/dev/null PUBLIC_BASE_URL=http://localhost:5173 AUTH_MODE=mock DATA_MODE=fixtures pnpm dev` → http://localhost:5173 |
| Check the env file             | `pnpm adminforge env check` (key names and states only, never values)                                                                    |
| Provisioning status            | `pnpm adminforge provision status` (every provisioned object ✓/✗ plus live token checks)                                                 |
| Database migrations            | `pnpm --filter @adminforge/api db:migrate` (optional: the API migrates its database file at start)                                       |
| Dev against the tenant         | `pnpm --filter @adminforge/api init:local` once, then `pnpm dev` (config from the env file; see below)                                   |
| Scaffold content               | `pnpm adminforge new <kind> <section>/<name> [--template list-detail\|dashboard\|report\|entity]`                                        |
| Validate content               | `pnpm adminforge validate` (add `--scopes` to compare with the app registrations)                                                        |
| Playbook/runbook tests         | `pnpm adminforge test [pattern]`                                                                                                         |
| All tests                      | `pnpm test` · e2e: `pnpm test:e2e` · production build: `pnpm build && pnpm test:e2e:prod` · guards: `pnpm guard`                         |
| Focused tests                  | `pnpm --filter @adminforge/tests exec vitest run --project <unit\|component\|api\|content\|guards\|pwsh\|scale> <path>`                  |
| Real PowerShell tests          | `pnpm --filter @adminforge/tests test:pwsh` (runner workers, Pester; `pnpm test` runs them where `pwsh` is installed)                    |
| Lint / types                   | `pnpm lint` · `pnpm typecheck` (type-checks only: builds nothing and writes no `dist/`)                                                  |
| Format                         | `pnpm format` (write) · `pnpm format:check` (CI)                                                                                         |
| Publish content to the DB      | `pnpm adminforge publish [--dry-run]` (runs validate + tests; needs committed content on `origin/main`, else `--allow-unreviewed`)       |
| Deploy to Kubernetes           | Code owners only, when asked: `portal/deploy/kubernetes/README.md` › Upgrade (build and push images, apply, publish, `/readyz`)          |
| Live smoke (validation tenant) | `pnpm exec tsx tests/live/scripts/verify-api-live.ts` · full sweep: `pnpm test:live` (see `tests/live/README.md`)                        |

Mock mode ignores the env file (`ADMINFORGE_ENV_FILE=/dev/null`), so it runs on in-memory stores and never touches a
database file; `PUBLIC_BASE_URL` has no default and must be set. Against the tenant, `init:local` writes
`DATABASE_PATH=~/.local/share/adminforge/dev.db` into the env file; the API creates and migrates that file at start and
is also the run worker and the scheduler — no Docker, nothing else to start. Never point `DATABASE_PATH` at a
deployment's file. Provisioner and live-test credentials live in `<env>.admin.env` (CLI and live tests only). System
Chrome is used by Playwright (no browser download).

**Never build or install in a checkout a running service serves.** A service that runs from a checkout uses its
`dist/` and `node_modules`, so `pnpm build`, `pnpm install` or `pnpm dev` there (anything that writes them) is a
deploy: the web app changes at once, server code at the next restart. Work in a clone or worktree no service runs
from; `pnpm typecheck` builds nothing and is safe anywhere. Content goes live only through `adminforge publish`.

## Commits and pull requests

Conventional Commits with AdminForge's types and scopes — `<type>(<scope>): <summary>`, e.g.
`fix(scheduler): skip deleted portal schedules` (header ≤ 100 characters, no full stop; body says why). The
`commit-msg` hook and CI (pull request title) check it with `tooling/git/commit-message.mjs`; the full rules, branch
naming and review process are in `docs/onboarding/10-git-and-pull-requests.md`. One logical change per commit — a
session that spans several features commits each on its own (shared files such as `CHANGELOG.md` split by hunk).

## Before you say "done"

- `pnpm adminforge validate` and `pnpm adminforge test` are clean for content changes.
- The focused vitest project(s) you touched pass; `pnpm guard` passes; `pnpm lint` is clean for your files.
- UI changes: screenshot them (Playwright, steel + daylight) and look at the images. Web dependencies or bundling:
  `pnpm build && pnpm test:e2e:prod`, in a checkout no service serves.
- The reviewer agents that apply (`content-reviewer`, `security-reviewer`, `design-reviewer`) ran and their findings
  are fixed or answered.
- Report licence/permission needs you discovered, and what you could only check against fixtures.
