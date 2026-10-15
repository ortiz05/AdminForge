# AdminForge

AdminForge is an administration portal for Microsoft Entra ID, Microsoft 365, Intune, Defender, and Azure.
Engineers sign in with their own SSO identity and work through **delegated** permissions: read-only by
default, with time-boxed, step-up "armed" write access. Pages, dashboards, reports, playbooks, runbooks,
schedules, and synthetic probes are declarative content you can change without redeploying.

## Repository layout

| Path | Contents |
|---|---|
| `portal/` | Everything needed to run AdminForge: apps (web, api, scheduler, runner), packages, content, CLI, deploy files |
| `tests/` | Every test and test-only dependency (unit, component, api, content, e2e, visual, live, guards, fixtures) |
| `tooling/` | Developer tooling (lint) |
| `config/example.env` | Every configuration key, documented. Real values live outside the repo. |
| `docs/` | Plans, ADRs, decisions, licensing review, runbooks |

## Quick start (this host)

```bash
cp config/example.env ~/.config/adminforge/dev.env   # fill in tenant + secrets (never commit)
pnpm install
pnpm db:up                                           # Postgres on 127.0.0.1:55432
pnpm adminforge provision entra                      # creates/updates the Entra apps, writes IDs to your env file
pnpm adminforge db migrate
pnpm dev                                             # http://localhost:5173
```

Mock mode (no tenant needed): set `AUTH_MODE=mock` and `DATA_MODE=fixtures`.

## Tests

`pnpm test` (unit, component, api, content, guards) · `pnpm test:e2e` (Playwright) · `pnpm test:live` (opt-in, against a configured tenant) · `pnpm guard` (runs on every commit).

See `docs/plans/2026-10-15-adminforge-master-plan.md` for the full design.
