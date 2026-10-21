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
- A running stack whose URL is `PUBLIC_BASE_URL`: `pnpm dev` against your dev database (the API is also the run worker
  and the scheduler, so playbook and schedule checks work), or a deployment's Ingress URL
  (`portal/deploy/kubernetes/README.md`).
- System Google Chrome (`channel: 'chrome'`).

## Configuration

Everything comes from the env file (`~/.config/adminforge/<env>.env`; `ADMINFORGE_ENV` / `ADMINFORGE_ENV_FILE` pick
another) plus its admin-only sibling `<env>.admin.env`, which holds the validation user's credentials (the CLI and the
live tests read it; the services never do). The process environment overrides both. Never print or commit their
values.

| Variable                                                                            | Used by        | Meaning                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`                                                                   | suite, scripts | The portal origin the browser signs in to (default `http://localhost:5173`)                                                                                                                 |
| `AF_LIVE_OUT`                                                                       | suite, scripts | Output directory for results and screenshots (default `~/.cache/adminforge/live`, i.e. `$XDG_CACHE_HOME/adminforge/live`; kept 0700; refused inside the repository, also through a symlink) |
| `AF_LIVE_INSECURE_TLS=1`                                                            | suite          | Accept a certificate from a private CA, e.g. a test cluster's Ingress: `PUBLIC_BASE_URL=https://adminforge.example.com AF_LIVE_INSECURE_TLS=1 pnpm test:live`                               |
| `API_PORT`                                                                          | scripts        | The scripts call the API directly on the `PUBLIC_BASE_URL` host and scheme at this port (default 3001), so they target a dev stack, not the Ingress                                         |
| `AF_TEST_USER_UPN`, `AF_TEST_USER_PASSWORD`                                         | both           | The validation user (written by `provision test-identities`)                                                                                                                                |
| `AF_TEST_USER_TOTP_SECRET`                                                          | both           | Base32 TOTP seed (written by the MFA bootstrap)                                                                                                                                             |
| `AF_TEST_APPROVER_UPN`, `AF_TEST_APPROVER_PASSWORD`, `AF_TEST_APPROVER_TOTP_SECRET` | both           | The approver fixture "AF Tester 2" (written by `provision test-identities` and `register-test-user-mfa.ts --approver`; `testApproverCredentials`)                                           |

## Scripts

Run from the repository root with `pnpm exec tsx tests/live/scripts/<script>.ts`:

- **`register-test-user-mfa.ts [--approver]`** — one-time, idempotent MFA bootstrap: signs the validation user (with
  `--approver`: the approver fixture) in to the Read app, registers a TOTP authenticator if Entra asks, and stores the
  seed as `AF_TEST_USER_TOTP_SECRET` (`AF_TEST_APPROVER_TOTP_SECRET`) in `<env>.admin.env`.
- **`verify-api-live.ts`** — API end to end: SSO sign-in, `/api/me` (role count and modes, never the user's name),
  overview (counts and section error codes), arm, disarm, logout. Needs only the API running (the browser's requests
  are forwarded to it).
- **`check-page-datasources.ts <page key>…`** — executes every datasource of the given pages as the validation user and
  prints, per datasource, `ok` or the error code with its message masked. Exit code 1 when a page is unknown or a
  datasource failed (licence-gated ones included — read the codes). Entity pages take their params after a `?`, as
  placeholders (`'identity.user?id=@user:AF-Test-User-01'`; a literal id works but stays in your shell history); params are
  never printed, and a placeholder that doesn't resolve fails that page only.
- **`check-user-schedule.ts [--report <id>] [--approver] [--needs-sign-in]`** — "Run as: Me" end to end (ADR-014) on
  a deployed portal (`PUBLIC_BASE_URL` = its Ingress URL, plus `AF_LIVE_INSECURE_TLS=1` for a private CA): the
  validation user creates a portal report schedule that runs as its creator (default report
  `identity.groups-without-owners`), checks a run before signing in is skipped, signs in for it through Entra (the
  consent round trip, a fresh sign-in), runs it now, checks the run succeeded, its file opens for the creator and the
  audit log says who it ran as, then deletes it and checks a deleted schedule can't be signed in for. `--approver` also
  checks another person (AF Tester 2, enabled with `provision test-identities --enable --approver`) sees the run but
  can't open the file. `--needs-sign-in` also revokes the validation user's sign-in sessions (as the provisioner) and
  checks the next run is skipped as "needs sign-in" — run it last: Entra may refuse that account's next sign-ins for a
  few minutes. One ✓/✗ line per check, no ids or names; the schedule is always deleted.
- **`check-accuracy.ts [<definition id substring>…]`** — live accuracy (docs/enterprise-scenarios.md › Live accuracy):
  runs the datasources of the list pages, entity pages, KPIs and reports whose answers the test fixtures make known,
  as the validation user through the deployed portal (`PUBLIC_BASE_URL` = its Ingress URL, plus
  `AF_LIVE_INSECURE_TLS=1` for a private CA), and compares them with the fixture catalogue (imported from
  `portal/tools/cli/src/provision/*-fixture-*`) and an independent Graph read (the automation identity, read-only;
  the provisioner only where it can't read). One line per check: ✓ match, ✗ mismatch (field, expected vs shown),
  ≈ documented difference (with the Microsoft reason), · not knowable (not published here, no permission). Exit code 1
  on an unexplained mismatch. Masked: AF-Test names only. Definitions not published on the instance show as not
  knowable — re-run after `pnpm adminforge publish`.
- **`run-playbook.ts <playbook> '<inputs JSON>' [--confirm-from <stepId>.<field>]`** — signs in (an https
  `PUBLIC_BASE_URL` is taken as a deployed portal: its Ingress URL), arms, previews
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
  schedule or probes once **as the automation identity** through the scheduler's own one-shot module
  (`portal/apps/scheduler/src/one-shot.ts`, the same code and status lines as `node dist/main.js --schedule`),
  against the **dev** database file of the env file. It refuses any `ADMINFORGE_ENV_OVERLAY` and a `DATABASE_PATH` set
  in the process environment (a deployment's file). It refuses **playbook schedules** — they would queue a real run
  for the dev API's worker; use `run-playbook.ts`, which previews first. Delivery never
  reaches a person: `--deliver none` (default) blanks every recipient list and Teams webhook, so email and Teams report
  `not_configured`; `--deliver sender` sends the email to `AF_MAIL_SENDER` itself (the report mailbox mails itself) and
  still never posts to Teams. Prints the run status, reason codes, file row counts and delivery statuses. A report
  whose `optional` datasource failed ends `failed — report_incomplete` (the file is still written). Keys are
  definition ids (`probes.graph-reachability`,
  `reports.app-credential-expiry-daily`). No browser sign-in: it doesn't need the validation user.

- **`check-mail-sender.ts [--not-as <display name>]… [--sender-name <display name>]`** — report email through
  AdminForge's own notifier as the automation identity, without mailing anyone: one short message from
  `AF_MAIL_SENDER` to itself (expect `sent`), then, for each `--not-as` mailbox (e.g. `AF-Test-Shared-01`), an attempt
  to send **as** that mailbox, again only to the sender (expect `refused`: the automation identity may send only as
  the report mailbox). `--sender-name` checks a mailbox before `AF_MAIL_SENDER` is configured. Both accept only test
  mailboxes (display name `AF-Test-…`; `--sender-name` also the mailbox `AF_MAIL_SENDER` names), so mail is never sent
  as a real person's mailbox. Exit code 1 when either expectation fails. It uses no database.

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
  and a single tester who can approve would approve its own requests — the `approver` fixture ("AF Tester 2",
  Portal.Reader and Playbook.Approver) is that second account.
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

## Licensed test fixtures (opt-in)

Data only a licensed tenant has, provisioned by the same `pnpm adminforge provision test-identities` run when opted in
from `<env>.admin.env` (nothing changes without the opt-in):

| Opt-in                                 | What it provisions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Provisioner needs (Graph application permission)                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AF_TEST_LICENCE_SKU=<part number>`    | the licence (e.g. `SPE_E5`) for the validation user and AF-Test-User-01…03 — mailboxes, OneDrives, Teams settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `LicenseAssignment.ReadWrite.All`                                                                                                                              |
| `pim` in `AF_TEST_FIXTURES`            | PIM eligibility, never active: AF-Test-User-01 → Reports Reader, the validation user → Message Center Reader                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `RoleEligibilitySchedule.ReadWrite.Directory`                                                                                                                  |
| `named-location` in `AF_TEST_FIXTURES` | `AF-Test-Location`, 192.0.2.0/24 (documentation range), not trusted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `Policy.Read.All`, `Policy.ReadWrite.ConditionalAccess`                                                                                                        |
| `intune` in `AF_TEST_FIXTURES`         | `AF-Test Compliance (Windows)` and `AF-Test Configuration (Windows)`, assigned to AF-Test-Group-01 only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `DeviceManagementConfiguration.ReadWrite.All`                                                                                                                  |
| `approver` in `AF_TEST_FIXTURES`       | "AF Tester 2" (`af-approver@<domain>`, or `AF_TEST_APPROVER_UPN`): Portal.Reader + Playbook.Approver, no directory roles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | nothing beyond the validation user's                                                                                                                           |
| `ca-audit` in `AF_TEST_FIXTURES`       | 14 example Conditional Access policies named `AF-Audit: …`, **report-only** (never enforced) — see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `Policy.Read.All`, `Policy.ReadWrite.ConditionalAccess`, `Application.Read.All` (Graph requires it for a policy with an application condition)                 |
| `directory` in `AF_TEST_FIXTURES`      | AF-Test-User-04…12 (departments, job titles, employee ids, usage locations GB/US/DE/AU and one unset, a manager chain whose top manager is disabled, a disabled user licensed directly, one with no attributes, one whose password never expires; names with an apostrophe and non-Latin letters), AF-Test-Dynamic-01 / -Nested-01 / -M365-01 (owned by AF-Test-User-04 and the provisioner: 2 owners) / -M365-02 (no owner — the provisioner, which Graph makes an owner on create, is removed) / -Empty-01 / -Licence-01 (group-based licensing, SWAY off) and the administrative unit AF-Test-AU-01 with every AF-Test user | `LicenseAssignment.ReadWrite.All` (licences; three seats)                                                                                                      |
| `guest` in `AF_TEST_FIXTURES`          | AF-Test-Guest-01 (invited to an example.com address **without an email**, so it stays "never redeemed", sponsored by AF-Test-User-04 when `directory` is on) and AF-Test-Guest-02 (disabled). Where Microsoft refuses the invitation (some new tenants, whatever the settings say) or the tenant allows none, Guest-01 is created directly as a guest-type account with the external UPN; Guest-02 always is. Neither ever signs in                                                                                                                                                                                            | Directly created guests: the provisioner's directory role. Inviting: `User.Invite.All` (optional — a refused invitation falls back)                            |
| `apps` in `AF_TEST_FIXTURES`           | AF-Test-App-Expiring (secret in 7 days, certificate in 20 — renewed when they lapse), -Hygiene (2-year and three secrets), -Risky (http redirect, implicit grant, public client, personal or multi-tenant audience, Mail.ReadWrite requested, no owner), -NoOwner, and AF-Test-SAML-01 (non-gallery SAML, signing certificate expiring within a month). **Never granted, consented or assigned anything**; secrets are dropped at once, certificates throwaway                                                                                                                                                                 | nothing beyond its directory role                                                                                                                              |
| `auth-methods` in `AF_TEST_FIXTURES`   | an SMS number on AF-Test-User-02 (fictitious +1 206 555-01xx) and a one-use, 60-minute Temporary Access Pass on AF-Test-User-03 (code never shown)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `UserAuthenticationMethod.ReadWrite.All` where its directory role doesn't cover it (and the methods on in the tenant's policy — never changed by provisioning) |
| `intune-more` in `AF_TEST_FIXTURES`    | `AF-Test Compliance (iOS/Android)`, `AF-Test Compliance (macOS)` (unassigned), `AF-Test Update ring (Windows)`, `AF-Test App protection (iOS/Android)` — assigned to AF-Test-Group-01 only                                                                                                                                                                                                                                                                                                                                                                                                                                     | `DeviceManagementConfiguration.ReadWrite.All`, `DeviceManagementApps.ReadWrite.All`                                                                            |
| `sign-ins` in `AF_TEST_FIXTURES`       | AF-Test-SignIn-01 and -02: accounts that only sign in (no role, licence or group), created disabled; then `scripts/generate-sign-ins.ts` (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | nothing beyond its directory role                                                                                                                              |

- **Apply:** `pnpm adminforge provision test-identities --dry-run` shows the plan (and a hint for each permission the
  provisioner's token lacks), then run it without `--dry-run`. Licences need free seats (four); the usage location is
  set from the organisation's country when missing. PIM eligibility is permanent unless the role's settings forbid it
  (then 365 days). The approver is created disabled; its password goes to `<env>.admin.env`; register its MFA with
  `register-test-user-mfa.ts --approver` while it is enabled (`--enable --approver`).
- **Status:** `provision status` lists every fixture ✓/✗ (with the seats used). A fixture Graph refuses shows `✗` with
  the permission to grant; the other fixtures still apply, and the run exits 1. An Intune policy is ✓ only when its one
  assignment includes AF-Test-Group-01 (anything else is re-assigned to exactly that); members of AF-Test-Group-01
  other than provisioning's test accounts and `AF-Test-*` devices are a ⚠ (they'd get the policies). A ⚠ also lists any
  fixture permission the provisioner still holds — remove them between runs (`docs/operations.md` → The provisioner).
- **Enable/disable:** `--enable` enables the validation user only; `--enable --approver` also the approver (approval
  tests only — `pnpm test:live` never does). `--disable` always disables both, trying each even if the other fails.
- **The approver is two-person approval in name only:** both passwords are in one file. It is for testing approval
  flows in a validation tenant: it holds Portal.Reader and Playbook.Approver only, carries its own marker
  ("AdminForge validation approver" — the validation user's checks never accept it, nor its checks the validation
  user), must have a different UPN from the validation user, and is refused (plan and status ✗) wherever
  `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`. A marked approver left after "approver" is taken out of
  `AF_TEST_FIXTURES` is ✗ in `provision status` until `--remove-fixtures` deletes it.
- **Ownership:** only objects provisioning created are changed or removed — users with the validation marker or
  provisioning's display name (the approver: its own marker only), Intune policies whose description carries the
  marker, the named location with exactly that range. Same-named objects are refused (`✗ cannot`).
- **Enterprise fixtures (`directory`, `guest`, `apps`, `auth-methods`, `intune-more`, `sign-ins`):** each in its own
  module (`portal/tools/cli/src/provision/*-fixture*.ts`), opted in one by one. Users and the guest carry the marker
  `employeeType` "AdminForge test fixture" (the sign-in accounts "AdminForge validation sign-ins"); groups, the
  administrative unit, apps (their `notes`) and policies carry "AdminForge validation" in their description — a
  same-named object without it is refused, never changed or removed. Passwords of the directory users are random and
  never stored; the sign-in accounts' go to `AF_TEST_SIGNIN_1_UPN` / `_PASSWORD` and `AF_TEST_SIGNIN_2_UPN` /
  `_PASSWORD` in the admin file. The licences (one direct, two through AF-Test-Licence-01) are planned only when the
  subscription has the seats. Each operation fails on its own (`✗` with the reason) and the others go on. Expiry stays
  true over time: every run checks that the expiring credentials still expire soon (and haven't yet) and replaces them
  when they don't. The administrative unit has no role scoped to it — scoping the validation user's User
  Administrator role to it is an option, not done.
- **Safety checks:** the assigned `intune-more` policies are refused (✗) while AF-Test-Group-01 has members other than
  the test accounts or uses dynamic membership, like the group-scoped audit policies; AF-Test-User-01..03 and
  AF-Test-Group-01 are used (owner, members, nesting, assignment) only when they are the test identities' own.
  `provision status` fails on anything a sign-in account holds (memberships, roles direct or through a group, PIM
  eligibility, licences, app role assignments), warns while one is enabled, and fails on any service principal,
  permission grant or assignment on a fixture app (the SAML app's own service principal must have none). An invited
  guest or a SAML app that can't be marked right after creation is deleted again (a directly created guest carries the
  marker from the start). Fixtures taken out of `AF_TEST_FIXTURES` whose
  objects are still there are ✗ (left over) until `--remove-fixtures`.
- **Sign-ins:** `pnpm exec tsx tests/live/scripts/generate-sign-ins.ts` enables AF-Test-SignIn-01, signs it in to My
  Apps (MFA by a TOTP seed registered on its first sign-in, `AF_TEST_SIGNIN_1_TOTP_SECRET`), disables it, then tries a
  wrong password for AF-Test-SignIn-02 and signs it in while disabled — a success, a failed password and a disabled
  account in the sign-in logs. Both are disabled at the end whatever happened; `--disable` disables them too. Outcomes
  only, never UPNs or passwords.
- **Remove:** `pnpm adminforge provision test-identities --remove-fixtures --dry-run`, then without `--dry-run`:
  takes the licence back from the test users, removes the eligibility, the named location and the Intune policies,
  and deletes the approver (first out of the registration campaign's exclusions; restorable for 30 days; its password
  and TOTP seed are cleared). It covers the opted-in fixtures — keep the keys set until they are removed — the enterprise fixtures' marked
  objects whether or not still opted in (`provision status` shows them ✗ as left over meanwhile), and a marked
  approver in any case. It works in any environment label: it only removes objects carrying provisioning's marks.
- **Audit Conditional Access policies (`ca-audit`):** examples modelled on Microsoft's recommended baseline and
  templates (catalogue: `portal/tools/cli/src/provision/ca-audit-catalog.ts`) — MFA for admins, phishing-resistant MFA
  for admins, MFA for all users, block legacy authentication, MFA for Azure management, MFA for guests, MFA to
  register devices, sign-in risk and user risk (Entra ID P2), block unknown platforms, admin sign-in frequency, and
  three scoped examples (compliant or hybrid-joined device, app protection on mobile, block outside
  AF-Test-Location). They are **report-only**: evaluated at every sign-in and logged (each sign-in's Conditional
  Access results, Conditional Access insights) but never enforced — the code can't create or update a policy in any
  other state, and works with Security Defaults on. Scope: most target all users (or the admin roles, or guests) so
  real sign-ins produce data, excluding the break-glass accounts in `AF_PROTECTED_USER_IDS` (a ⚠ in the plan and
  status while it is empty) and, as Microsoft's templates do, the Directory Synchronization Accounts role. The two that
  **block** all users (legacy authentication, unknown platforms) also exclude Global Administrator: Graph refuses a
  block that could lock everyone out (`1032 … BlockEveryonePolicy`). The device-dependent
  ones (compliant/hybrid-joined device, app protection) target **AF-Test-Group-01 only**: Microsoft documents that
  report-only device-state policies can prompt macOS, iOS and Android users to pick a device certificate. The location
  example targets AF-Test-Group-01 too (everyone is "outside" a documentation range) and needs the `named-location`
  fixture; the group-scoped ones are refused (`✗ cannot`) while AF-Test-Group-01 has members other than the test
  accounts or uses dynamic membership. Ownership is an allow-list of name and state (policies have no description):
  only a catalogue-named policy that is **report-only** is updated; one that is on, off or in an unknown state is left
  alone (`✗ cannot`). A report-only policy someone changed or widened is put back: Graph merges a PATCH into nested
  objects, so the update sends every list it doesn't set explicitly empty, carries no state, is re-checked before
  each attempt (writes go without client retries; a throttled one waits and re-checks), and is read back — `✓` only
  when Graph now holds the catalogue policy. One rejected policy prints `✗` and the others are still created. When Graph's refusal names the permission it wants (e.g. "Application.Read.All
  scope is required to add/edit application condition"), the `✗` line shows Graph's (masked) reason and that
  permission (only permissions the fixture needs) — for every fixture. Remove them with `--remove-fixtures`
  (catalogue-named ones that are report-only or off; before the named location, which Graph won't delete while a
  policy refers to it). If one were switched on: phishing-resistant MFA for admins locks out every admin without a
  passkey, Windows Hello or certificate-based authentication; blocking unknown platforms may end AdminForge sessions
  (check its report-only results for the Read/Write apps' non-interactive sign-ins first); the admin 4-hour sign-in
  frequency fails parked delegated runs; the device and location examples block the validation user.
- **Not yet:** a risky user on demand (the Identity Protection live checks) — see the M365 E5 plan.

### Exchange recipients created through AdminForge

Made in the portal, not by the CLI, so the create playbooks themselves are what's tested. With
`AF_TEST_SERVICE_ADMIN_ROLES=true` (re-run `provision test-identities`), the validation user enabled and armed, dry
run then run, in an accepted domain:

| Recipient           | Playbook                        | Inputs                                                                                    |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `AF-Test-Shared-03` | `m365.create-shared-mailbox`    | **Allow sign-in** on (the case the Shared mailboxes page flags)                           |
| `AF-Test-Room-01`   | `m365.create-room-mailbox`      | capacity, booking options as you like                                                     |
| `AF-Test-DL-02`     | `m365.create-distribution-list` | owner `AF-Test-User-01` (licensed — an owner needs a mailbox), **Keep me as an owner** on |

Every create asks for the address to be typed. The distribution list needs the validation user to have a mailbox
(`AF_TEST_LICENCE_SKU` licenses it): Exchange only lets a list's owners change it, so the engineer is an owner while
it is set up and is taken off once everything worked.

`check-accuracy.ts m365.` then compares them (the Exchange recipients block); before they exist those checks read
"not knowable". Running a create playbook again for the same address finishes it (the plan says "on the existing …").
Remove them with `m365.remove-created-recipient`, which refuses anything without AdminForge's mark. Removing
`AF-Test-DL-02` after the validation user stepped down needs Organization Management (tick "I'm not an owner"), which
it doesn't hold — create it with **Keep me as an owner** when you mean to remove it later.

## Safety rules

- **Writes only on `AF-Test-*` objects** that provisioning created. Dry run first, then run, then run the compensating
  playbook (or the reverse write) and check `/audit`.
- Read-only checks print counts and statuses — never ids, names, UPNs or tokens.
- Test tenants only: `provision test-identities` (the validation user and `AF-Test-*` targets) is meant for them, and
  the suite arms write access as that user.
