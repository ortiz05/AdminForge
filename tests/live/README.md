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
- No registration nudge: Entra's authentication-methods registration campaign (Microsoft-managed: "Sign in faster with
  your face, fingerprint, or PIN", or the Authenticator nudge) stops sign-in on `mysignins.microsoft.com/register`,
  which headless Chrome can't complete. `provision test-identities` adds the validation user — only that user — to
  the campaign's exclusions and leaves the rest of the campaign (state, who it targets, snooze) as it is;
  `provision status` checks it. If a live sign-in lands on the nudge anyway it fails at once and says so.
- A running stack whose URL is `PUBLIC_BASE_URL`: `pnpm dev` (with `RUN_WORKER_IN_PROCESS=true` and
  `SCHEDULER_IN_PROCESS=true` if no worker/scheduler service runs) or the host services (`portal/deploy/README.md`).
  Playbook checks need a run worker.
- System Google Chrome (`channel: 'chrome'`).

## Configuration

Everything comes from the env file (`~/.config/adminforge/<env>.env`; `ADMINFORGE_ENV` / `ADMINFORGE_ENV_FILE` pick
another) plus its admin-only sibling `<env>.admin.env`, which holds the validation user's credentials (the CLI and the
live tests read it; the services never do). The process environment overrides both. Never print or commit their
values.

| Variable                                    | Used by        | Meaning                                                                                                                                                                                     |
| ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`                           | suite, scripts | The portal origin the browser signs in to (default `http://localhost:5173`)                                                                                                                 |
| `AF_LIVE_OUT`                               | suite, scripts | Output directory for results and screenshots (default `~/.cache/adminforge/live`, i.e. `$XDG_CACHE_HOME/adminforge/live`; kept 0700; refused inside the repository, also through a symlink) |
| `AF_LIVE_INSECURE_TLS=1`                    | suite          | Accept a private CA, e.g. Caddy `tls internal` for LAN access: `PUBLIC_BASE_URL=https://<lan-name>:8443 AF_LIVE_INSECURE_TLS=1 pnpm test:live`                                              |
| `API_PORT`                                  | scripts        | The scripts call the API directly on the `PUBLIC_BASE_URL` host and scheme at this port (default 3001), so they target a dev stack, not the TLS proxy                                       |
| `AF_TEST_USER_UPN`, `AF_TEST_USER_PASSWORD` | both           | The validation user (written by `provision test-identities`)                                                                                                                                |
| `AF_TEST_USER_TOTP_SECRET`                  | both           | Base32 TOTP seed (written by the MFA bootstrap)                                                                                                                                             |

## Scripts

Run from the repository root with `pnpm exec tsx tests/live/scripts/<script>.ts`:

- **`register-test-user-mfa.ts`** — one-time, idempotent MFA bootstrap: signs the validation user in to the Read app,
  registers a TOTP authenticator if Entra asks, and stores the seed as `AF_TEST_USER_TOTP_SECRET` in `<env>.admin.env`.
- **`verify-api-live.ts`** — API end to end: SSO sign-in, `/api/me` (role count and modes, never the user's name),
  overview (counts and section error codes), arm, disarm, logout. Needs only the API running (the browser's requests
  are forwarded to it).
- **`check-page-datasources.ts <page key>…`** — executes every datasource of the given pages as the validation user and
  prints, per datasource, `ok` or the error code with its message masked. Exit code 1 when a page is unknown or a
  datasource failed (licence-gated ones included — read the codes).
- **`run-playbook.ts <playbook> '<inputs JSON>' [--confirm-from <stepId>.<field>]`** — signs in, arms, previews
  (retrying through Graph replication lag) and runs one playbook. Inputs may name the test objects instead of ids —
  placeholders resolve as the validation user through the portal itself, so no ids or addresses go on the command
  line or into the output (also inside arrays):

  | Placeholder                                                                       | Becomes                                                      |
  | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
  | `@user:AF-Test-User-02`, `@group:AF-Test-Group-01`                                | object id (portal search)                                    |
  | `@mailbox:AF-Test-Shared-01`                                                      | primary email address (search, then the User page's profile) |
  | `@dl:AF-Test-DL-01`                                                               | the list's email address (search)                            |
  | `@team:AF-Test-Team-01`                                                           | the team's Microsoft 365 group id (search)                   |
  | `@site:AF-Test-Team-01`                                                           | SharePoint site id (`m365.sharepoint-sites` search)          |
  | `…#<field>`, e.g. `@site:AF-Test-Team-01#webUrl`, `@mailbox:AF-Test-Shared-01#id` | another field of the object                                  |

  Example: `run-playbook.ts m365.add-distribution-list-members '{"identity":"@dl:AF-Test-DL-01","addresses":"…"}'`.
  The resolver is `tests/live/lib/placeholders.ts` (`resolvePlaceholders(session, inputs)` for throwaway scripts).
  The preview → run → poll flow is `tests/live/lib/runs.ts`, the same one the suite uses. It prints the run status,
  the error code of a failed run (and of each failed step) and the message masked (`tests/live/lib/mask.ts`); exit
  code 1 unless the run succeeded. It disarms afterwards, also when the run or the script fails. Throwaway scripts go
  in `tests/live/scripts/.tmp-*` (ignored by git).

- **`check-placeholders.ts @<kind>:<name>[#field]…`** — resolves placeholders and prints ok / why not per placeholder,
  never the value. Run it before a playbook when a test object is new (directory and SharePoint search can lag).
- **`run-schedule-once.ts --schedule <key> [--deliver none|sender]`** and **`--probe <key>… [--no-store]`** — runs a
  schedule or probes once **as the automation identity** through the scheduler service's own one-shot module
  (`portal/apps/scheduler/src/one-shot.ts`, the same code and status lines as `node dist/main.js --schedule`),
  against the **dev** database of the env file. It refuses `ADMINFORGE_ENV_OVERLAY=host`, a `DATABASE_URL` set in the process
  environment, and a dev database that is also the services' (where `<env>.host.env` exists and resolves to the same
  `DATABASE_URL`; the URLs are compared, never printed). It refuses **playbook schedules** — use `run-playbook.ts`,
  which previews first. Delivery never
  reaches a person: `--deliver none` (default) blanks every recipient list and Teams webhook, so email and Teams report
  `not_configured`; `--deliver sender` sends the email to `AF_MAIL_SENDER` itself (the report mailbox mails itself) and
  still never posts to Teams. Prints the run status, reason codes, file row counts and delivery statuses. A report
  whose `optional` datasource failed ends `failed — report_incomplete` (the file is still written). Keys are
  definition ids (`probes.graph-reachability`,
  `reports.secure-score-summary-weekly`). No browser sign-in: it doesn't need the validation user.

- **`check-mail-sender.ts [--not-as <display name>]… [--sender-name <display name>]`** — report email through
  AdminForge's own notifier as the automation identity, without mailing anyone: one short message from
  `AF_MAIL_SENDER` to itself (expect `sent`), then, for each `--not-as` mailbox (e.g. `AF-Test-Shared-01`), an attempt
  to send **as** that mailbox, again only to the sender (expect `refused`: the automation identity may send only as
  the report mailbox). `--sender-name` checks a mailbox before `AF_MAIL_SENDER` is configured. Both accept only test
  mailboxes (display name `AF-Test-…`; `--sender-name` also the mailbox `AF_MAIL_SENDER` names), so mail is never sent
  as a real person's mailbox. Exit code 1 when either expectation fails. It uses no database, so `ADMINFORGE_ENV_OVERLAY=host` (the services' configuration) is fine.

`register-test-user-mfa.ts` and `verify-api-live.ts` take an optional failure-screenshot path; the default is
`<AF_LIVE_OUT>/<script>-failure.png`; a path given on the command line is refused inside the repository too.
Screenshots can show tenant data, and the tenant-data guard can't read images.

## Library (`lib/`)

Shared by the suite and the scripts; each module starts with a comment saying what it does, its inputs and outputs,
and its safety rules. Pure parts are unit-tested in `tests/unit/live/`.

| Module              | What                                                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entra-login.ts`    | `signInWithEntra(page, creds)` drives Microsoft's sign-in pages (password, TOTP, first-time MFA registration, the registration-nudge check); `testUserCredentials(env)` reads the validation user's credentials.                    |
| `portal-session.ts` | `openPortalSession()` signs the validation user in (headless Chrome) and returns `api(method, path, body)`; `createApiCall(request)` is that API caller for any Playwright request context (the suite uses it); `armWriteAccess()`. |
| `runs.ts`           | Preview → run → poll (`previewThenRun`, `settle`, `waitForRun`, `stepOutput`), with one rule for when a run has settled (the engine's terminal and parked statuses) and preview retries through replication lag.                    |
| `placeholders.ts`   | `@<kind>:<name>[#field]` placeholders in playbook inputs, resolved as the validation user through the portal (never printed).                                                                                                       |
| `mask.ts`           | `mask(text)`, `maskError(err)`, `why(err)`, `maskUrl(url)`: GUIDs, addresses and UPNs, tenant hosts masked. **Every** message a live script prints goes through it.                                                                 |
| `output.ts`         | `liveOutDir(...parts)`: the private output directory (`AF_LIVE_OUT`, see Configuration).                                                                                                                                            |
| `totp.ts`           | RFC 6238 codes from the TOTP seed.                                                                                                                                                                                                  |

Conventions for a new script: a header comment with the usage line, inputs, output and safety; statuses, codes and
counts only, any free text through `mask`/`maskError`; files under `liveOutDir()`; API modules only from
`@adminforge/api/tooling` (and `@adminforge/scheduler/one-shot`), never `@adminforge/api/src/…`; the validation user's
credentials from `testUserCredentials`.

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
- **Exchange and SharePoint admin roles (opt-in):** only with `AF_TEST_SERVICE_ADMIN_ROLES=true` in the admin file
  (`<env>.admin.env`; default off), and only where the tenant licenses the workload, it also holds Exchange Recipient
  Administrator and SharePoint Administrator, so the suite can run the Exchange and SharePoint write playbooks on the
  `AF-Test-*` mailboxes and sites. Both are tenant-wide. Without the opt-in the plan lists them as withheld and
  re-provisioning removes them; those write playbooks then fail live with a permission error (reads need only Global
  Reader).
- **Disabled between runs:** `provision test-identities` creates it disabled; enable it only for a run
  (`provision test-identities --enable`) and disable it afterwards (`--disable`, which also revokes its sessions).
  `provision status` warns while it is enabled, and fails if it holds any directory role provisioning didn't give it
  (another role, a narrower scope, or a role through a group).
- **Registration campaign:** excluded from Entra's authentication-methods registration campaign, so no passkey or
  Authenticator nudge interrupts its sign-in. Nobody else is excluded, and the campaign is otherwise left as it is.
- **Only provisioning's own account:** the UPN must start with `af-`, and the account must carry the "AdminForge
  validation" marker (`employeeType`, set at creation) or the display name "AF Tester". Any other account at
  `AF_TEST_USER_UPN` is refused before anything changes: no new password, roles, groups, campaign exclusion,
  `--enable` or `--disable`.

## Safety rules

- **Writes only on `AF-Test-*` objects** that provisioning created. Dry run first, then run, then run the compensating
  playbook (or the reverse write) and check `/audit`.
- Read-only checks print counts and statuses — never ids, names, UPNs or tokens.
- Test tenants only: `provision test-identities` (the validation user and `AF-Test-*` targets) is meant for them, and
  the suite arms write access as that user.
