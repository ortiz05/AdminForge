# 3. Repository map

Where everything lives, which way dependencies point, where a new thing goes, and how things are named. Keeping the
layout predictable is what lets several engineers (and Claude Code) work in it without stepping on each other.

## Top level

```text
.
├── portal/                 everything that runs AdminForge
│   ├── apps/
│   │   ├── web/            React SPA (Vite, TanStack Router + Query)
│   │   ├── api/            BFF (Fastify), also the run worker and the scheduler; SQLite schema and migrations (drizzle/)
│   │   ├── scheduler/      scheduler one-shots (--once, --probe, --schedule; automation identity)
│   │   └── runner/         PowerShell runner, the pod's sidecar (Node host in src/, PowerShell in ps/, pinned modules)
│   ├── packages/           shared libraries (below)
│   ├── content/            declarative content: pages, dashboards, reports, playbooks, runbooks, schedules,
│   │                       probes, connections, feeds, scripts, navigation.yaml
│   ├── tools/cli/          the `adminforge` CLI: env check, provision, new, validate, test, fixtures, publish, audit, db
│   │                       (its README is the command reference)
│   └── deploy/kubernetes/  the app image (Dockerfile, build-images.sh), kustomize base and example overlay,
│                           the loader pod (tools/), the deployment runbook (README.md)
├── tests/                  ALL tests and test-only dependencies (09-testing.md)
├── docs/                   architecture, API, ADRs, decisions, operations, troubleshooting, onboarding (this folder)
├── config/example.env      every configuration key, documented — real values never live in the repo
├── tooling/                lint config, CI helpers, the commit-message check
├── .claude/                Claude Code skills, reviewer agents and hooks (12-claude-code.md)
├── .githooks/              pre-commit (guards) and commit-msg (message format)
├── .github/                CI workflows, CODEOWNERS, Dependabot, pull request template
├── CLAUDE.md               the non-negotiables and commands
├── CONTRIBUTING.md         the essentials, pointing here
├── SECURITY.md             the security model
└── CHANGELOG.md            Keep a Changelog; every user-visible change goes under "Unreleased"
```

## Packages and the direction of dependencies

Dependencies point **down** this list, never up. A package never imports from an app, and no runtime code imports a
test library.

| Package                     | What it is                                                                     | Depends on                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `@adminforge/schemas`       | zod schemas: every content kind and the API contracts; emits JSON schemas      | —                                                                                                 |
| `@adminforge/expressions`   | the `${ … }` expression language (JSONata-based), helpers, limits, validation  | —                                                                                                 |
| `@adminforge/connectors`    | Graph / ARM / Resource Graph / Log Analytics clients, request policy, fixtures | —                                                                                                 |
| `@adminforge/config`        | env file loading and overlays                                                  | —                                                                                                 |
| `@adminforge/design-tokens` | the design system's tokens → CSS variables and Tailwind theme                  | —                                                                                                 |
| `@adminforge/engine`        | playbook/runbook execution: steps, previews, approvals, secrets                | schemas, expressions, connectors                                                                  |
| `@adminforge/ui`            | React primitives and recipes (`tv()` variants), DataTable, icons               | design-tokens                                                                                     |
| `@adminforge/widgets`       | content widgets (kpi, table, chart, list, keyValue, …)                         | schemas, expressions, ui                                                                          |
| apps and `cli`              | composition: wire packages together                                            | packages; `api` and `scheduler` also use the runner app's client; `scheduler` and `cli` use `api` |

If you find yourself wanting an upward import (a package needing something from `apps/api`), the thing belongs in a
package — move it down rather than reaching up.

## Inside the API

`portal/apps/api/src/` is organised **by feature**, each folder owning its logic and storage, with HTTP kept thin:

```text
src/
├── app.ts            builds Fastify: plugins, error handler, the /api block and its guards, route registration
├── context.ts        AppContext — everything a handler needs (config, sessions, outbound, definitions, audit, …)
├── config.ts         zod schema for every configuration key (mirrors config/example.env)
├── errors.ts         AppError → ApiErrorBody, the error handler, audited denials, problem-page redirects
├── routes/<area>.ts  HTTP only: parse, guard, call a service, shape the reply
├── <feature>/        e.g. schedules/: service.ts (rules), store.ts (interface + in-memory), sqlite-store.ts (SQLite),
│                     types.ts, module.ts (wiring), plus focused helpers (cron.ts, sync.ts, …)
├── auth/ security/ execution/   sign-in and sessions; request hardening; the outbound executor and write guards
└── db/              client.ts (the connection, writeTx), schema.ts (the Drizzle schema), signals, leases, backup;
                      migrations in ../drizzle/ (generated, never edited once applied)
```

The [API guide](06-api-guide.md) shows a route, service, store and contract end to end. The runner has its own
configuration schema in `portal/apps/runner/src/config.ts`.

## Inside the web app

`portal/apps/web/src/` is also by feature: `app/` (shell, navigation, command palette), `renderer/` (the generic content
page), `playbooks/`, `runs/`, `ops/` (schedules, monitoring, settings, audit), `reports/`, `news/`, `query/`, `lib/`
(API client, prefs, search), `pages/` (coded one-off pages), and `routes/` (TanStack file routes; `routeTree.gen.ts` is
generated by `pnpm --filter @adminforge/web routes` and is git-ignored). See the [Web guide](07-web-guide.md).

## Where does my change go?

| You want to…                                           | It goes in                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Show data on a new page, dashboard or report           | `portal/content/{pages,dashboards,reports}/` — YAML, no React                                                             |
| Let engineers change something in the tenant           | `portal/content/playbooks/<section>/` (a guided sequence: `runbooks/`)                                                    |
| Run something unattended, monitor, check configuration | `portal/content/{schedules,probes}/`                                                                                      |
| Call your own Entra-secured API or Azure Function      | `portal/content/connections/` (`adding-a-service-connector`)                                                              |
| Call a Microsoft API AdminForge doesn't support yet    | `portal/packages/connectors` + the request policy (`adding-a-service-connector`) — connections refuse Microsoft audiences |
| PowerShell (Exchange, Teams, SharePoint)               | `portal/content/scripts/<service>/` + the runner (`adding-a-runner-script`)                                               |
| A visualisation the widgets can't express              | `portal/packages/widgets` + `docs/widgets.md`                                                                             |
| Backend behaviour content can't express                | `portal/apps/api/src/<feature>/` + `routes/` + `portal/packages/schemas`                                                  |
| A coded screen (not content-driven)                    | `portal/apps/web/src/<feature>/` + a route file                                                                           |
| A new configuration key                                | `portal/apps/api/src/config.ts` **and** `config/example.env` (documented)                                                 |
| A colour, spacing, radius or font change               | `portal/packages/design-tokens/src/tokens.ts` only                                                                        |
| A test                                                 | `tests/<project>/…` mirroring the code ([Testing](09-testing.md))                                                         |
| A decision others must not undo by accident            | `docs/adr/NNN-<slug>.md` or a line in `docs/decisions.md`                                                                 |

Before adding anything, **search for what exists** — extend it and bump its version rather than creating a near
duplicate:

```bash
pnpm adminforge list --section <section>              # what shows in a section, wherever it is filed
pnpm adminforge list --kind report --search "<topic>"
rg -l "<topic>" portal/content                         # full text
```

## Naming

| Thing                     | Convention                                                                                                                                                                                                                                                                                                                                                                                       | Example                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| TypeScript modules        | kebab-case `.ts`                                                                                                                                                                                                                                                                                                                                                                                 | `delivery-keys.ts`, `sqlite-store.ts`                 |
| React components          | PascalCase `.tsx`, one main component per file                                                                                                                                                                                                                                                                                                                                                   | `ReportsPage.tsx`, `ScheduleForm.tsx`                 |
| Content ids               | `<section>.<name>`, lower kebab, dotted; the `portal.` prefix is reserved                                                                                                                                                                                                                                                                                                                        | `identity.inactive-users`, `probes.dns-spf`           |
| Content files             | `<kind folder>/<id prefix>/<name>.<kind>.yaml` (`pnpm adminforge new <kind> <prefix>/<name>` writes it); the folder is the id prefix (`adminforge validate` enforces it; `probes.*` and `feeds.*` sit directly in `probes/` and `feeds/`; exceptions in `portal/content/README.md`)                                                                                                              | `reports/identity/inactive-users.report.yaml`         |
| Content sections          | Mostly the area — `identity`, `m365`, `endpoint`, `security`, `azure`, `avd`, `billing` (Exchange, SharePoint and Teams pages keep their `m365.*` ids and folder; their overviews are `exchange.overview` and so on); schedules are grouped by job (`reports/`, `probes/`, `maintenance/`, `billing/`); section overview dashboards are flat; probes and feeds sit directly in their kind folder |                                                       |
| Tests                     | `<subject>.test.ts(x)`; database-backed `*-db.test.ts`; wall-clock budgets `*.scale.test.ts`; real PowerShell `*.pwsh.test.ts`                                                                                                                                                                                                                                                                   | `tests/api/portal-schedules-create.test.ts`           |
| API paths                 | `/api/<plural-noun>[/:key][/<sub-resource or action>]`                                                                                                                                                                                                                                                                                                                                           | `/api/schedules/:key/runs`, `/api/schedules/:key/run` |
| Error codes               | `snake_case`, specific                                                                                                                                                                                                                                                                                                                                                                           | `cron_too_frequent`, `schedule_is_content`            |
| Audit actions             | `<subject>.<event>`, past tense for new ones                                                                                                                                                                                                                                                                                                                                                     | `schedule.created`, `report.exported`                 |
| Configuration keys        | `UPPER_SNAKE`; installation-specific keys content may read start with `AF_`                                                                                                                                                                                                                                                                                                                      | `RATE_LIMIT_PER_MINUTE`, `AF_REPORT_RECIPIENTS`       |
| Database tables / columns | `snake_case`, plural tables                                                                                                                                                                                                                                                                                                                                                                      | `schedule_runs.started_at`                            |
| Branches                  | `<type>/<short-topic>`                                                                                                                                                                                                                                                                                                                                                                           | `feat/reports-catalogue`                              |
| Test objects in a tenant  | `AF-Test-*`, created by `adminforge provision test-identities`                                                                                                                                                                                                                                                                                                                                   | `AF-Test-Group-01`                                    |

Older ids don't always match their path (`identity.health` lives in `dashboards/identity-health.dashboard.yaml`); keep
an existing id as it is — it's referenced by saved views, schedules and audit records — and follow the convention for
new ones.

## Read next

[Security for contributors](04-security.md).
