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
- **Endpoint & Security**: Intune devices/compliance/configuration/apps/autopilot; Defender incidents/alerts,
  Secure Score, risky users, Defender for Cloud.
- **Azure**: subscriptions, Resource Graph inventory, resource detail, Azure Arc, monitoring (alerts, metrics,
  Log Analytics), Function Apps, RBAC.
- **Automation**: playbooks (dry-run preview → confirm → run; approvals; bulk; show-once secrets), runbooks,
  schedules on this host (automation identity), synthetic probes and KQL checks, Query Studio, reports with
  CSV/XLSX export, audit (hash-chained), appearance and settings.

Licensing gaps are explained in the UI ("Requires …") and tracked in `docs/licensing-review.md`.

## Repository layout

| Path                 | Contents                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `portal/`            | Everything needed to run AdminForge: apps (web, api, scheduler, runner), packages, content, CLI, deploy files |
| `tests/`             | Every test and test-only dependency (unit, component, api, content, e2e, visual, live, guards, fixtures)      |
| `tooling/`           | Developer tooling (lint)                                                                                      |
| `config/example.env` | Every configuration key, documented. Real values live outside the repo.                                       |
| `docs/`              | Plan, ADRs, decisions, widget reference, extending guide, licensing review, backlog                           |

## Quick start

```bash
cp config/example.env ~/.config/adminforge/dev.env   # fill in tenant + provisioner credentials (never commit)
pnpm install
pnpm --filter @adminforge/api init:local             # generates DB password, token-cache key, local defaults
pnpm db:up && pnpm --filter @adminforge/api db:migrate
pnpm adminforge provision entra                      # Read/Write/Automation apps, groups, consent (idempotent)
pnpm dev                                             # http://localhost:5173
```

No tenant handy? `AUTH_MODE=mock DATA_MODE=fixtures pnpm dev` runs everything on synthetic data.

To run AdminForge as services on this host (API + web, run worker, scheduler, PowerShell runner), see
`portal/deploy/README.md`.

## Tests

`pnpm test` (unit, component, api, content, guards) · `pnpm test:e2e` (Playwright, mock mode) ·
`pnpm guard` (runs on every commit) · live tenant validation: `tests/live` (see the `validating-against-a-tenant` skill).

## Extending

Use Claude Code: the rules are in `CLAUDE.md`, one skill per extension point lives in `.claude/skills/`, reviewer
agents in `.claude/agents/`, and `docs/extending.md` explains the workflow. The full design is in
`docs/plans/2026-10-15-adminforge-master-plan.md`.
