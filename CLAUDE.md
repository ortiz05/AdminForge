# AdminForge — working in this repo

AdminForge is an admin portal for Entra ID, Microsoft 365, Intune, Defender, and Azure. Engineers sign in with SSO and
work through **delegated** permissions (read-only by default; "armed" write access is time-boxed and step-up
authenticated). Unattended schedules run on this host as a separate **automation identity**. Most features are
**declarative content** (YAML) rendered and executed by a generic engine.

Extending AdminForge is meant to be done with Claude Code: use the project skills in `.claude/skills/` — one per
extension point — and the reviewer agents in `.claude/agents/`.

## Layout

| Path                    | What                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `portal/apps/web`       | React SPA: shell, `/p/$key` content renderer, playbook drawer, runs, schedules, Query Studio         |
| `portal/apps/api`       | BFF (Fastify): auth, sessions, request policy, datasource executor, definitions, runs, schedules API |
| `portal/apps/scheduler` | Cron service on this host (automation identity): probes, KQL checks, reports, scheduled playbooks    |
| `portal/apps/runner`    | PowerShell runner (Exchange/Teams/SharePoint) — pinned scripts, forwarded delegated tokens           |
| `portal/packages/*`     | `design-tokens`, `ui`, `widgets`, `schemas`, `expressions`, `connectors`, `engine`, `config`         |
| `portal/content`        | Pages, dashboards, reports, playbooks, runbooks, schedules, probes, connections, scripts, navigation |
| `portal/tools/cli`      | `adminforge` CLI (env check, provision, new, validate, test, publish, fixtures)                      |
| `tests/`                | **All** tests and test-only deps (unit, component, api, content, e2e, live, guards, fixtures)        |
| `docs/`                 | Plan (`plans/`), ADRs, `widgets.md`, `licensing-review.md`, `backlog.md`, `extending.md`             |
| `config/example.env`    | Every configuration key, documented. Real values live outside the repo.                              |

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

## Commands

| Task                           | Command                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Install                        | `pnpm install`                                                                                                                           |
| Dev (no tenant needed)         | `ADMINFORGE_ENV_FILE=/dev/null PUBLIC_BASE_URL=http://localhost:5173 AUTH_MODE=mock DATA_MODE=fixtures pnpm dev` → http://localhost:5173 |
| Check the env file             | `pnpm adminforge env check` (key names and states only, never values)                                                                    |
| Provisioning status            | `pnpm adminforge provision status` (every provisioned object ✓/✗ plus live token checks)                                                 |
| Database migrations            | `pnpm --filter @adminforge/api db:migrate`                                                                                               |
| Dev against the tenant         | `pnpm db:up && pnpm --filter @adminforge/api db:migrate && pnpm dev` (config from the env file; see below)                               |
| Scaffold content               | `pnpm adminforge new <kind> <section>/<name> [--template list-detail\|dashboard\|report\|entity]`                                        |
| Validate content               | `pnpm adminforge validate` (add `--scopes` to compare with the app registrations)                                                        |
| Playbook/runbook tests         | `pnpm adminforge test [pattern]`                                                                                                         |
| All tests                      | `pnpm test` · e2e: `pnpm test:e2e` · guards: `pnpm guard`                                                                                |
| Focused tests                  | `pnpm --filter @adminforge/tests exec vitest run --project <unit\|component\|api\|content\|guards> <path>`                               |
| Lint / types                   | `pnpm lint` · `pnpm typecheck`                                                                                                           |
| Format                         | `pnpm format` (write) · `pnpm format:check` (CI)                                                                                         |
| Publish content to the DB      | `pnpm adminforge publish [--dry-run]`                                                                                                    |
| Live smoke (validation tenant) | `pnpm exec tsx tests/live/scripts/verify-api-live.ts` · full sweep: `pnpm test:live` (see `tests/live/README.md`)                        |

Mock mode ignores the env file (`ADMINFORGE_ENV_FILE=/dev/null`), so it runs on in-memory stores and never touches a
shared database; `PUBLIC_BASE_URL` has no default and must be set. Against the tenant, playbook runs and schedules need
`RUN_WORKER_IN_PROCESS=true` and `SCHEDULER_IN_PROCESS=true` in the env file. The host services (`portal/deploy`) use
their own database through the `host` overlay (`<env>.host.env`), so `pnpm dev` never consumes their runs — never point
dev at the services' database. Provisioner and live-test credentials live in `<env>.admin.env` (CLI and live tests
only).

Postgres for dev runs in Docker on `127.0.0.1:55432` (`pnpm db:up`). System Chrome is used by Playwright (no browser
download).

## Before you say "done"

- `pnpm adminforge validate` and `pnpm adminforge test` are clean for content changes.
- The focused vitest project(s) you touched pass; `pnpm guard` passes; `pnpm lint` is clean for your files.
- UI changes: screenshot them (Playwright, steel + daylight) and look at the images.
- Report licence/permission needs you discovered.
