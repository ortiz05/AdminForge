---
name: validating-against-a-tenant
description: Use when verifying AdminForge changes against a real Microsoft tenant — live sign-in, live data on a page, running a write playbook for real, checking a schedule or probe live, or diagnosing 401/403/licence errors.
---

# Validating against a tenant

## Overview

Configuration lives in `~/.config/adminforge/<env>.env` (never in the repo; never print values; mode 600 — the API and
the CLI refuse a file other users can read and print the `chmod`). A dedicated validation user (`AF_TEST_USER_UPN`)
signs in automatically, answering MFA from a TOTP seed. Its credentials and the provisioner's live in the admin-only
`<env>.admin.env` next to the env file, read only by `provision …`, `validate --scopes` and the live tests — never by
the API or the cluster. `init:local` gives the env file a dev database of its own
(`DATABASE_PATH=~/.local/share/adminforge/dev.db`); `pnpm dev` creates and migrates it and is also the run worker and
the scheduler.

## When not to use

- Checking layout, logic or a transform → mock mode and fixtures first (`CLAUDE.md` › Commands); go live to confirm
  what fixtures can't: that Microsoft accepts the request, the permissions and the licences.
- A deployment's database — never point `DATABASE_PATH` at it: dev uses its own (`<env>.env`); the cluster's is on a
  volume only its pod mounts.
- Writes on anything but `AF-Test-*` objects provisioning created, provisioning runs, `adminforge publish` to a shared
  database or anything against the cluster — not without a code owner asking for that specific action.

## Steps

1. **Set up once per tenant:** `pnpm adminforge env check` → `pnpm adminforge provision entra` →
   `provision test-identities` → (Azure) `provision azure-test` →
   `pnpm exec tsx tests/live/scripts/register-test-user-mfa.ts` (registers TOTP if Entra asks).
   `pnpm adminforge provision status` must be all ✓ (licence-blocked items are listed separately) and report no
   unexpected privilege. Test identities exist only where `AF_ENV_LABEL` is in `AF_TEST_IDENTITY_LABELS` (default
   `dev,test`). `provision test-identities` also excludes the validation user (only it) from Entra's
   authentication-methods registration campaign, whose passkey/Authenticator nudge would stop unattended sign-in.
   Live Exchange / SharePoint write playbooks need `AF_TEST_SERVICE_ADMIN_ROLES=true` in the admin file (tenant-wide
   service admin roles for the validation user; default off). Provisioning refuses any account at `AF_TEST_USER_UPN`
   it didn't create (`af-…` UPN with the "AdminForge validation" marker or "AF Tester" name).
2. **Enable the validation user for the run:** it is **disabled between runs**. `pnpm test:live` enables and disables
   it itself; wrap scripts in `pnpm adminforge provision test-identities --enable` / `--disable`.
3. **Licensed test data (opt-in, admin file):** `AF_TEST_LICENCE_SKU=SPE_E5` (licence for the validation user and
   AF-Test-User-01…03) and `AF_TEST_FIXTURES=pim,named-location,intune,approver,ca-audit` (PIM eligibility,
   `AF-Test-Location`, AF-Test Intune policies on AF-Test-Group-01, 14 report-only `AF-Audit: …` Conditional Access
   policies whose results show in each sign-in's Conditional Access tab, the approver "AF Tester 2" (Portal.Reader +
   Playbook.Approver) for approval flows — enable it with `provision test-identities --enable --approver` (plain
   `--enable` never does; `--disable` covers both); its MFA: `register-test-user-mfa.ts --approver`; its sign-in:
   `testApproverCredentials(env)`; refused where `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`). Each needs a Graph
   application permission on the provisioner (`tests/live/README.md` › Licensed test fixtures) — remove those between
   runs (`provision status` warns while held); `--remove-fixtures` undoes the fixtures (any label).
4. **Pick the check:**
   - API end to end (SSO, overview, arm, logout): start the API (`pnpm dev`), then
     `pnpm exec tsx tests/live/scripts/verify-api-live.ts`.
   - Full sweep (every page, Query Studio, schedules, read-mode refusals, reversible writes, audit chain):
     `pnpm test:live` — prerequisites and env knobs in `tests/live/README.md`. Against a deployment, `PUBLIC_BASE_URL`
     is its Ingress URL (`PUBLIC_BASE_URL=https://adminforge.example.com pnpm test:live`; add `AF_LIVE_INSECURE_TLS=1`
     for a certificate from a private CA).
   - Every page's datasources at once, as the validation user and read-only:
     `pnpm exec tsx tests/live/scripts/check-page-datasources.ts <key>…` (`ok` or the error code per datasource).
   - Schedules and probes as the automation identity: `tests/live/scripts/run-schedule-once.ts` with `--schedule <id>`
     or `--probe <id>…`. Dev database only (it refuses an env overlay and a `DATABASE_PATH` from the process
     environment); delivery is suppressed by default, or `--deliver sender` mails `AF_MAIL_SENDER` itself — never a
     person, never a Teams channel.
   - Playbooks for real: `tests/live/scripts/run-playbook.ts <playbook> '<inputs>'` with placeholders instead of ids —
     `@user:`, `@group:`, `@mailbox:` (email address), `@dl:` (email address), `@team:` (group id), `@site:` (site id;
     `#webUrl` for the URL) followed by the `AF-Test-*` name. `check-placeholders.ts` checks they resolve. Dry run
     first, then run, then run the compensating playbook; check `/audit` (chain verified).
   - In a browser test: `openPortalSession()` / `armWriteAccess()` from `tests/live/lib/portal-session.ts`; preview →
     run → poll through `tests/live/lib/runs.ts`; credentials via `testUserCredentials(env)`.
5. **Report safely:** print everything through `tests/live/lib/mask.ts` (`mask`, `maskError`); files go to
   `AF_LIVE_OUT` (default `~/.cache/adminforge/live`, never inside the repository). With the automation identity,
   print counts and statuses only — never ids, names or tokens.
6. **Screenshots of a live session** (`pnpm dev`, mock or tenant): the server's saved preferences override the
   `adminforge.prefs` localStorage key once you sign in, so switch the theme through the command palette (Ctrl+K →
   "Steel" / "Daylight") before each shot. The mocked-API Playwright specs (`setPrefs`) aren't affected.

### Azure content that hasn't met Azure yet

Azure Billing, the Arc fleet (servers, extensions, patching, Defender coverage) and Azure Virtual Desktop were built on
2026-10-17 against fixtures only — the validation tenant had no subscription. When one exists, before trusting them:

1. The automation identity needs Reader (and Cost Management Reader) at the management group, not only on
   `AF_SUBSCRIPTION_ID`; engineers need the roles in `docs/access.md`.
2. Run every Resource Graph query once in Resource Graph Explorer (each starts `// af:<key>#<ds>`; read-only), or all
   of a page's datasources with `check-page-datasources.ts avd.overview azure.arc-fleet billing.overview …`; then each
   KQL probe with `run-schedule-once.ts --probe <id>`.
3. Check the specific guesses listed under "Validate live" in `docs/backlog.md` (Azure Billing, Hybrid Azure Arc
   servers, Azure Virtual Desktop): property names, `arg_max` with several columns, long `in~` lists, Resource Graph
   freshness for AVD session host status.
4. AVD writes (drain mode, send a message, sign out) only on a host pool and session built for testing, dry run first;
   the sign-out's owner check refuses a session someone else holds.

## Done when

- [ ] Every new request, query or probe ran once live, read-only, with the result per datasource (`ok` or its code)
- [ ] Writes went dry run → run → compensate on `AF-Test-*` objects only, and `/audit` shows a verified chain
- [ ] The validation user is disabled again and held fixture permissions are removed (`provision status` is quiet)
- [ ] What you couldn't check (no licence, no subscription) is recorded in `docs/licensing-review.md` and
      `docs/backlog.md`, and new content says `preview: true` until it is
- [ ] Nothing you pasted holds ids, names, tokens or env values — counts and statuses only

## Common mistakes

| Mistake                                                           | Fix                                                                                                |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Provisioner or test-user credentials put back in `<env>.env`      | They belong in `<env>.admin.env`; `adminforge env check` flags them                                |
| An env file readable by other users                               | `chmod 600 <file>` — the API and the CLI refuse it otherwise                                       |
| A live script refuses to start: `PUBLIC_BASE_URL` on another host | Outside `NODE_ENV=production` Entra sign-in needs a localhost `PUBLIC_BASE_URL` and a loopback API |
| Running a write on a real user, group or resource                 | Only `AF-Test-*` objects provisioning created                                                      |
| Leaving the validation user enabled or fixture permissions held   | `provision test-identities --disable`; remove the provisioner's fixture permissions                |
| Pasting tenant output into a conversation or PR                   | `mask` / `maskError`; counts and statuses only                                                     |

### Reading failures

| Symptom                                                              | Likely cause                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 403 with hint "Needs X on the Read app"                              | Scope missing → add to provisioning, `provision entra`                               |
| 403 `licence_required`                                               | Tenant lacks the licence → note in `docs/licensing-review.md`                        |
| 401 `reauth`                                                         | CAE/claims challenge or expired session → sign in again                              |
| 403 `rearm` / `not_armed`                                            | Write step without an armed session                                                  |
| 403 `user_not_by_id`                                                 | A write names a user by UPN → look the id up in a read step and pass `$guid()`       |
| Data empty in Log Analytics                                          | Activity-log export can take ~15 min after provisioning                              |
| Sign-in stops: "registration campaign"                               | Validation user not excluded → `provision test-identities`                           |
| Fixture `✗ … may not do this: grant…`                                | Provisioner lacks that Graph application permission → grant it, admin consent, rerun |
| Fixture `✗ cannot … not created by provisioning`                     | A same-named object exists that isn't ours → rename or delete it                     |
| Resource Graph 400 "DisallowedMaxNumberOfRemoteTables" / join limits | More than one cross-table join → split the query (`adding-a-page-or-report`)         |

## See also

- `tests/live/README.md` (scripts, knobs, safety rules), `docs/licensing-review.md`, `docs/access.md`
- `docs/content-recipes.md` (the Microsoft Graph and Resource Graph quirks found live)
- `adding-a-page-or-report`, `adding-a-playbook`, `adding-a-schedule-or-probe`
