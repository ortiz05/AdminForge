---
name: validating-against-a-tenant
description: Use when verifying AdminForge changes against a real Microsoft tenant — live sign-in, live data on a page, running a write playbook for real, checking a schedule or probe live, or diagnosing 401/403/licence errors.
---

# Validating against a tenant

## Overview

Configuration lives in `~/.config/adminforge/<env>.env` (never in the repo; never print values). A dedicated validation
user (`AF_TEST_USER_UPN`) signs in automatically, answering MFA from a TOTP seed. Its credentials and the provisioner's
live in the admin-only `<env>.admin.env` next to the env file (read by the CLI and the live tests, never by the
services).

## Setup (once per tenant)

`pnpm adminforge env check` → `pnpm adminforge provision entra` → `provision test-identities` → (Azure) `provision
azure-test` → `pnpm exec tsx tests/live/scripts/register-test-user-mfa.ts` (registers TOTP if Entra asks).
`pnpm adminforge provision status` must be all ✓ (licence-blocked items are listed separately).

## Checks

- API end to end (SSO, overview, arm, logout): `pnpm db:up`, start the API, then
  `pnpm exec tsx tests/live/scripts/verify-api-live.ts`.
- Full sweep (every page, Query Studio, schedules, read-mode refusals, reversible writes, audit chain):
  `pnpm test:live` — prerequisites and env knobs in `tests/live/README.md`. Against the host services behind Caddy:
  `PUBLIC_BASE_URL=https://<lan-address>:8443 AF_LIVE_INSECURE_TLS=1 NODE_EXTRA_CA_CERTS=<caddy root.crt> pnpm test:live`.
- Credentials for provisioning and the test user live in `<env>.admin.env` (the CLI and live tests read it; the
  services never do). Don't put them back in `<env>.env` — `adminforge env check` flags that.
- Never run `pnpm dev` against the services' database: the host services use the `host` overlay
  (`<env>.host.env`); dev uses the database in `<env>.env`.
- In a browser test: `openPortalSession()` / `armWriteAccess()` from `tests/live/lib/portal-session.ts`.
- Writes: **only** against `AF-Test-*` users/groups/resources that provisioning created. Dry run first, then run,
  then run the compensating playbook; check `/audit` (chain verified).
- Read-only checks with the automation identity: print counts/statuses only — never ids, names, or tokens.

## Reading failures

| Symptom                                 | Likely cause                                                  |
| --------------------------------------- | ------------------------------------------------------------- |
| 403 with hint "Needs X on the Read app" | Scope missing → add to provisioning, `provision entra`        |
| 403 `licence_required`                  | Tenant lacks the licence → note in `docs/licensing-review.md` |
| 401 `reauth`                            | CAE/claims challenge or expired session → sign in again       |
| 403 `rearm` / `not_armed`               | Write step without an armed session                           |
| Data empty in Log Analytics             | Activity-log export can take ~15 min after provisioning       |
