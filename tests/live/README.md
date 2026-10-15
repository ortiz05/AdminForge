# Live validation (real tenant)

Checks a running AdminForge stack against a real Microsoft tenant with a dedicated validation user. Never runs in CI.
Use a test tenant: it signs in, renders every area, and makes **reversible** writes to `AF-Test-*` objects. It prints
statuses and counts only — never tenant identifiers, names or tokens.

The `validating-against-a-tenant` skill (`.claude/skills/`) is the step-by-step guide; this page is the reference.

## What it covers

`pnpm test:live` runs `e2e/portal.live.spec.ts` (Playwright, serial, one worker):

- sign-in as the validation user through Entra (password + TOTP), session roles and read mode;
- every page, dashboard and report renders, with its datasources (licence-gated pages are reported as gated), plus
  the ops pages;
- Query Studio against Resource Graph and Log Analytics; schedules and probes;
- read-mode safety: a dry run of a write playbook, and a write without arming is refused;
- arming write access (step-up sign-in to the Write app), then reversible writes on `AF-Test-*` objects (add then
  remove a group member; disable then re-enable a test user);
- the audit chain verifies; disarm.

## Prerequisites

- A test tenant provisioned for AdminForge: `pnpm adminforge provision entra`,
  `pnpm adminforge provision test-identities` (creates the validation user and the `AF-Test-*` targets, and writes
  `AF_TEST_USER_UPN` / `AF_TEST_USER_PASSWORD` to `<env>.admin.env`), and for KQL checks
  `pnpm adminforge provision azure-test`. `pnpm adminforge provision status` should be all ✓ (licence-blocked items
  are listed separately). Test identities are only provisioned when `AF_ENV_LABEL` is listed in
  `AF_TEST_IDENTITY_LABELS` (default `dev,test`); in any other environment `provision status` fails if they exist.
- The validation user is **disabled between runs**. `pnpm test:live` enables it in Playwright's global setup and
  disables it (revoking its sessions) in global teardown, using the provisioner credential from `<env>.admin.env`, so
  that credential must still be allowed to change a privileged user's account (Global Administrator or Privileged
  Authentication Administrator). For the scripts below, wrap them yourself:
  `pnpm adminforge provision test-identities --enable` before, `--disable` after. `AF_LIVE_KEEP_TESTER=1` makes the
  suite leave the account as it is.
- MFA for the validation user: run the TOTP bootstrap once (below).
- A running stack whose URL is `PUBLIC_BASE_URL`: `pnpm dev` (with `RUN_WORKER_IN_PROCESS=true` and
  `SCHEDULER_IN_PROCESS=true` if no worker/scheduler service runs) or the host services (`portal/deploy/README.md`).
  Playbook checks need a run worker.
- System Google Chrome (`channel: 'chrome'`).

## Configuration

Everything comes from the env file (`~/.config/adminforge/<env>.env`; `ADMINFORGE_ENV` / `ADMINFORGE_ENV_FILE` pick
another) plus its admin-only sibling `<env>.admin.env`, which holds the validation user's credentials (the CLI and the
live tests read it; the services never do). The process environment overrides both. Never print or commit their
values.

| Variable                                    | Used by        | Meaning                                                                                                                                               |
| ------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`                           | suite, scripts | The portal origin the browser signs in to (default `http://localhost:5173`)                                                                           |
| `AF_LIVE_OUT`                               | suite          | Output directory for results and screenshots (default `/tmp/adminforge-live`; keep it outside the repo)                                               |
| `AF_LIVE_INSECURE_TLS=1`                    | suite          | Accept a private CA, e.g. Caddy `tls internal` for LAN access: `PUBLIC_BASE_URL=https://<lan-name>:8443 AF_LIVE_INSECURE_TLS=1 pnpm test:live`        |
| `API_PORT`                                  | scripts        | The scripts call the API directly on the `PUBLIC_BASE_URL` host and scheme at this port (default 3001), so they target a dev stack, not the TLS proxy |
| `AF_TEST_USER_UPN`, `AF_TEST_USER_PASSWORD` | both           | The validation user (written by `provision test-identities`)                                                                                          |
| `AF_TEST_USER_TOTP_SECRET`                  | both           | Base32 TOTP seed (written by the MFA bootstrap)                                                                                                       |

## Scripts

Run from the repository root with `pnpm exec tsx tests/live/scripts/<script>.ts`:

- **`register-test-user-mfa.ts`** — one-time, idempotent MFA bootstrap: signs the validation user in to the Read app,
  registers a TOTP authenticator if Entra asks, and stores the seed as `AF_TEST_USER_TOTP_SECRET` in `<env>.admin.env`.
- **`verify-api-live.ts`** — API end to end: SSO sign-in, `/api/me`, overview, arm, disarm, logout. Needs only the API
  running (the browser's requests are forwarded to it).
- **`check-page-datasources.ts <page key>…`** — executes every datasource of the given pages as the validation user and
  prints status + error code per datasource.
- **`run-playbook.ts <playbook> '<inputs JSON>' [--confirm-from <stepId>.<field>]`** — signs in, arms, previews
  (retrying through Graph replication lag) and runs one playbook. `@user:AF-Test-User-02` / `@group:AF-Test-Group-01`
  placeholders resolve through the portal search, so no ids go on the command line.

`register-test-user-mfa.ts` and `verify-api-live.ts` take an optional failure-screenshot path; the default is under
`/tmp`. Keep screenshots out of the repository — they can show tenant data.

## What the validation user can do

Exactly what the suite needs, nothing standing that it doesn't:

- **Portal roles:** `Portal.Reader` (pages, Query Studio, schedules, probes), `Portal.Operator` (arm, write
  playbooks) and `Portal.Admin` (audit chain, admin pages). Not `Playbook.Approver`: approvals need a second person,
  and a single tester who can approve would approve its own requests — approval flows aren't covered by this suite.
- **Directory roles:** Global Reader (every page reads) and User Administrator (disable/re-enable `AF-Test-User-02`).
  It owns `AF-Test-Group-01` instead of holding Groups Administrator; `provision test-identities` removes a Groups
  Administrator assignment left by earlier versions. User Administrator can still manage ordinary (not
  role-assignable) groups, which is why the account is disabled between runs; see `docs/backlog.md` for scoping it to
  an administrative unit.

## Safety rules

- **Writes only on `AF-Test-*` objects** that provisioning created. Dry run first, then run, then run the compensating
  playbook (or the reverse write) and check `/audit`.
- Read-only checks print counts and statuses — never ids, names, UPNs or tokens.
- Test tenants only: `provision test-identities` (the validation user and `AF-Test-*` targets) is meant for them, and
  the suite arms write access as that user.
