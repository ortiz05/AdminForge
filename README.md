# AdminForge

AdminForge is an administration portal for Microsoft Entra ID, Microsoft 365, Intune, Defender, and Azure.
Engineers sign in with their own SSO identity and work through **delegated** permissions: read-only by
default, with time-boxed, step-up "armed" write access. Pages, dashboards, reports, playbooks, runbooks,
schedules, synthetic probes, and KQL configuration checks are declarative content you can change without redeploying.

## What's in it

- **Identity**: users, groups (incl. membership bulk actions), directory roles & PIM, app registrations and enterprise
  apps (credential expiry), Entra devices, Conditional Access, named locations, auth methods, sign-in and audit logs.
- **Microsoft 365**: service health, message center, licences, usage, Exchange mailboxes and distribution lists
  (PowerShell runner), Teams, SharePoint.
- **Endpoint & Security**: Intune devices/compliance/configuration/apps/autopilot; risky users (Identity Protection),
  Defender for Cloud. The Microsoft Defender portal (incidents, alerts, hunting, Secure Score) is out of scope; that
  content is retired.
- **Azure**: subscriptions, Resource Graph inventory, resource detail, Azure Arc, monitoring (alerts, metrics,
  Log Analytics), Function Apps, RBAC.
- **Automation**: playbooks (dry-run preview → confirm → run; approvals; bulk; show-once secrets), runbooks,
  schedules on this host (automation identity), synthetic probes and KQL checks, Query Studio, reports with
  CSV/XLSX export, audit (hash-chained), appearance and settings.
- **News and changes**: a breaking-news view of what Microsoft is changing in the services AdminForge manages —
  your tenant's Message Center and Microsoft 365 / Azure service health, plus Azure Updates, the Microsoft 365 Roadmap,
  MSRC security updates, product blogs, Learn what's-new pages and PowerShell module releases — collected hourly,
  classified by area, every item cited and linked to its source (`docs/news.md`).

Licensing gaps are explained in the UI ("Requires …") and tracked in `docs/licensing-review.md`.

## Repository layout

| Path                 | Contents                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `portal/`            | Everything needed to run AdminForge: apps (web, api, scheduler, runner), packages, content, CLI, deploy files                                          |
| `tests/`             | Every test and test-only dependency (unit, component, api, content, e2e incl. visual baselines, live, guards, runner, fixtures); see `tests/README.md` |
| `tooling/`           | Developer tooling (lint, CI bundle budget, commit-message check)                                                                                       |
| `config/example.env` | Every configuration key, documented. Real values live outside the repo.                                                                                |
| `docs/`              | Architecture, API, ADRs, decisions, widget reference, extending guide, licensing review, backlog, engineer onboarding (`docs/onboarding/`)             |

## Prerequisites

- **Node.js 24** (`.nvmrc`) and **pnpm 11.10.0** (`packageManager` in `package.json`; `corepack enable` picks it up).
- **Docker** with Compose, for the dev PostgreSQL (`pnpm db:up`, `portal/deploy/docker-compose.dev.yml`).
- **PowerShell 7.4+** (`pwsh`) for the runner (Exchange, Teams, SharePoint) and its Pester tests.
- **Google Chrome** installed on the system: Playwright uses `channel: 'chrome'` and downloads no browser.
- **Caddy** (optional) for TLS when other machines on the LAN use the portal (`portal/deploy/README.md`).

## Quick start

```bash
install -d -m 700 ~/.config/adminforge               # configuration lives outside the repository
cp config/example.env ~/.config/adminforge/dev.env   # fill in tenant settings (never commit)
# provisioner credentials go in ~/.config/adminforge/dev.admin.env (mode 600; CLI and live tests only)
pnpm install                                         # also points git at .githooks (pre-commit guard tests)
git config core.hooksPath .githooks                  # same, explicitly (needed if install ran outside a git checkout)
pnpm --filter @adminforge/api init:local             # generates DB password, token-cache key, local defaults
pnpm db:up && pnpm --filter @adminforge/api db:migrate
pnpm adminforge env check                            # key names and states only, never values
pnpm adminforge provision entra                      # Read/Write/Automation apps, groups, consent (idempotent)
pnpm adminforge provision status                     # every provisioned object ✓/✗ plus live token checks
pnpm dev                                             # http://localhost:5173
```

Playbook runs and schedules in `pnpm dev` need `RUN_WORKER_IN_PROCESS=true` and `SCHEDULER_IN_PROCESS=true` in the env
file. Never point `pnpm dev` at the host services' database: they use their own through the `host` overlay
(`portal/deploy/README.md`), so the two never consume each other's runs.

No tenant handy? This runs everything on synthetic data, in memory, ignoring the env file:

```bash
ADMINFORGE_ENV_FILE=/dev/null PUBLIC_BASE_URL=http://localhost:5173 AUTH_MODE=mock DATA_MODE=fixtures pnpm dev
```

To run AdminForge as services on this host (API + web, run worker, scheduler, PowerShell runner), see
`portal/deploy/README.md`.

## Tests

`pnpm test` (unit, component, api, content, guards) · `pnpm test:e2e` (Playwright in mock mode, including the visual
baselines in `tests/e2e`) · `pnpm guard` (runs on every commit) · `pnpm format:check` · live tenant validation:
`pnpm test:live` (see `tests/live/README.md` and the `validating-against-a-tenant` skill). Details: `tests/README.md`.

## Extending

Use Claude Code: the rules are in `CLAUDE.md`, one skill per extension point lives in `.claude/skills/`, reviewer
agents in `.claude/agents/`, and `docs/extending.md` explains the workflow. The current design is described by
`SECURITY.md`, `docs/architecture.md` and the decision records (`docs/adr/`, `docs/decisions.md`);
`docs/plans/2026-10-15-adminforge-master-plan.md` is the original build plan, kept for history.

## Documentation

- `docs/onboarding/` — **start here if you're joining**: setup, how it works, conventions for code, API, web, content,
  tests, commits, pull requests and docs (`CONTRIBUTING.md` has the essentials)
- `SECURITY.md` — security model and policy
- `docs/architecture.md` — architecture: apps, identities, data flow
- `docs/access.md` — access: sign-in, portal roles, permissions
- `docs/operations.md` — operating AdminForge on this host
- `docs/troubleshooting.md` — troubleshooting
- `portal/deploy/README.md` — host services, systemd units, Caddy
- `docs/extending.md`, `docs/widgets.md` — extending AdminForge with Claude Code; widget reference
- `docs/adr/`, `docs/decisions.md`, `docs/licensing-review.md`, `docs/backlog.md`
- `tests/README.md`, `tests/live/README.md` — test projects and live validation
