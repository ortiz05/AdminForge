# Changelog

All notable changes to AdminForge are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Closes the gaps found by comparing the build with the original plan (see the plan's "Revision 3" block and
`docs/decisions.md` → Plan review).

### Added

- **Delivery:** scheduled reports by email (Graph `sendMail` as the automation identity, from `AF_MAIL_SENDER`) and to
  Teams (Workflows webhooks on Microsoft hosts only); schedule failure/success alerts; approver notifications for run
  approvals and schedule enable requests. Recipients and webhooks are configuration keys, never content.
- **Schedule editor** (`/schedules/new`): build a schedule with a live cron preview (next five runs) and get its YAML
  to commit — schedules stay in git.
- **PIM indicator** in the session rail: active and eligible directory roles, with "Activate" opening
  `identity.pim-activate`; activation refreshes the person's tokens so new rights apply without signing out.
- **Live updates:** publishing content, arming and signing out elsewhere refresh open pages (server-sent events).
- **Organization defaults:** a default theme alongside default density and text size (Appearance).
- **Operations:** retention for runs, schedule runs, probe results and report files (`RETENTION_*`); worker and
  scheduler heartbeats in `/readyz`; `adminforge audit verify` and an hourly `probes.audit-chain` check; content
  publishes are audited; one structured log line per Microsoft call; history indexes (migration 0005); nightly
  database backups with a restore drill (`adminforge-backup.timer`).
- **Entra content:** assign/remove directory roles, add/remove PIM eligibility, assign/remove app access, revoke a
  consent grant, create Microsoft 365/security/dynamic groups (`identity.create-group` 2.0.0) and edit dynamic rules;
  new-subscription onboarding runbook; advanced filters on groups, enterprise apps, app registrations, sign-ins and
  audit logs.
- **Microsoft 365 content:** mailbox page with Full Access / Send As / Send on Behalf; grant/remove mailbox
  permissions, clear forwarding, automatic replies, address-list visibility; inbox-rule audit report; Teams policies
  per user; OneDrive access for a manager; Defender device vulnerabilities (advanced hunting); advanced filters on
  mailboxes and Intune devices.
- **Platform:** `selection: single` for tables; a `rows` advanced-filter dialect (`$applyAdvanced`) for runner and
  static lists; playbook `refreshTokens`; playbook tests may set `now` and `env`; Graph beta sources are badged
  "preview API".
- **Repository:** API reference (`docs/api.md`), Dependabot, CODEOWNERS, `pnpm audit` and an initial-bundle budget
  (`pnpm check:bundle`, 250 KB gzip) in CI.

### Changed

- `identity.offboard-user` 1.1.0 converts the mailbox to shared, sets an automatic reply, hides it from address lists
  and gives the manager OneDrive access when those workloads are licensed; `identity.leaver` 1.1.0 now only lists what
  offboarding couldn't do.
- `identity.compromised-account` 2.0.0 merges `security.compromised-account-response` (retired).
- Write-app permissions trimmed to what content declares (removed `Policy.ReadWrite.ConditionalAccess`,
  `DeviceManagementManagedDevices.ReadWrite.All`, `IdentityRiskyUser.Read.All`); new ones added for the new playbooks.

### Security

- `requires.portalRoles` now means **every** listed role everywhere (pages and datasources previously accepted any
  one of them).
- Shared saved views are listed only for pages the caller can open.
- Extending write access re-checks the Operator role.

### Fixed

- Playbook preflight checked licences by SKU name instead of feature key, so licensed features could show as missing.
- An admin's default density never applied to people without their own preference.
- The PIM menu and the page renderer shared a query key, so one could overwrite the other's data.
- `adminforge validate --scopes` didn't read the provisioner credentials from the admin env file.

## 0.1.0 — 2026-10-15

First release: an admin portal for Microsoft Entra ID, Microsoft 365, Intune, Defender and Azure that runs on its own
host, signs engineers in with their own identity, and works read-only until they arm write access.

### Added

- **Sign-in and roles**
  - Single sign-on with Microsoft Entra ID. Microsoft tokens stay on the server; the browser holds only a session
    cookie.
  - Read-only by default. Operators arm time-boxed write access (default 60 minutes, extendable once) with a step-up
    sign-in to a separate Write app. Armed mode is shown in ember with a countdown, extend and disarm.
  - Five portal roles (Reader, Operator, Playbook Approver, Playbook Author, Admin), granted through
    `SG-AdminForge-<label>-<Role>` groups.
- **Portal**
  - Web shell with navigation generated from content, command palette, pins and recents, and three themes (Steel,
    Daylight, Contrast) with density options.
  - Content-driven pages (dashboard, list-detail, entity, report and settings templates) built from widgets: KPI,
    table, chart, list, key-value, status grid, timeline, markdown, action bar, licence gate and probe status.
  - Saved views, CSV/XLSX export, an inspector drawer and an advanced query builder on list pages.
  - Licence gates that explain what a missing licence hides ("Requires …").
- **Content** (71 pages, 5 dashboards, 17 reports, 44 playbooks, 6 runbooks, 16 schedules, 33 probes)
  - Identity: users, groups, directory roles and PIM, app registrations and enterprise apps, Entra devices,
    Conditional Access, named locations, authentication methods, MFA registration, sign-in and audit logs.
  - Microsoft 365: service health, message center, licences, usage, Exchange mailboxes and distribution lists,
    Microsoft 365 groups and Teams, SharePoint sites.
  - Endpoint and Security: Intune devices, compliance, configuration, apps and Autopilot; Defender incidents and alerts,
    Secure Score, risky users, Defender for Cloud.
  - Azure: subscriptions, Resource Graph inventory, resource detail, Azure Arc, Monitor alerts and metrics, Log
    Analytics, Function Apps, RBAC.
  - Playbooks for user lifecycle, MFA and Temporary Access Pass, groups, licences, PIM, apps and devices (wipe with
    approval), and Azure resources (start, stop, restart, tags, resource groups, RBAC with approval).
- **Playbooks and runs**
  - Preview (dry run), then confirm; risky changes need a matching recent preview, and some a typed confirmation.
  - Approvals by a second person, bulk runs, live run timelines, and resume after re-arming or signing in again.
  - Show-once secret outputs (temporary access passes, passwords, app secrets) that are never stored.
  - Runbooks: guided procedures that mix instructions, manual checklist steps and child playbooks. Run forms can be
    prefilled from a link.
- **Schedules and monitoring**
  - Scheduler on the host running as a separate automation identity: probe sweeps, report files (CSV/XLSX), scheduled
    playbooks and content health checks, with a hot standby.
  - Synthetic probes for every check kind, including 10 KQL configuration checks: public blob access, insecure storage
    transport, open NSG management ports, Key Vault purge protection, disconnected Arc machines, policy
    non-compliance, Defender recommendations, missing required tags, failed-write spikes and risky OAuth consents.
  - Weekly inactive guests report (Mondays 06:15 UTC, XLSX, 26 files kept).
  - Monitoring page, and a Schedules page with run history, **Run now** and report downloads.
- **Query Studio**: a KQL workbench for Resource Graph, Log Analytics and Defender advanced hunting, with a starter
  gallery, charts, history, and save as report, probe or schedule (YAML for review).
- **PowerShell runner** for Exchange Online, Teams and SharePoint: single-use `pwsh` workers, pinned scripts and
  modules, and read-mode guards.
- **Audit**: an append-only, hash-chained audit log with filters, event detail, CSV export and chain verification.
- **Administration**: appearance editor with contrast checks, and settings.
- **CLI** (`pnpm adminforge`): `env check`; `provision entra`, `test-identities`, `azure-test` and `status`;
  `validate [--scopes]`, `test`, `publish`, `new`, and `fixtures record`.
- **Deployment**: systemd user units for the API, run worker, scheduler and runner, plus a Caddy TLS proxy for LAN
  access; Postgres 18 in Docker.
- **Development**: mock sign-in with synthetic fixtures (no tenant needed), the Claude Code extension kit (`CLAUDE.md`,
  a skill per extension point, reviewer agents, a validation hook), and a live tenant validation suite.

### Security

- Default-deny outbound request policy: in read mode only reads leave the API, and writes happen only through
  published content that declares them. There is no generic write proxy.
- Sign-in uses PKCE, a single-use state that expires after 10 minutes, a nonce, and tenant and user checks. Each round
  trip is bound to the browser that started it, and return paths must be same-origin.
- Write step-up is proven on the server: a Conditional Access authentication context, or a fresh sign-in at most 5
  minutes old. A token without `auth_time` is refused.
- Roles are re-read from Entra every 5 minutes. Removing someone's access ends their session, and losing Operator ends
  write access.
- The token cache is sealed with AES-256-GCM. Every change needs a CSRF header. The API sends CSP (and, in
  production, HSTS) headers, rate-limits requests, and listens on loopback behind Caddy, whose admin API is off.
- Schedule approvals cover a fingerprint of the playbook and its child playbooks. A scheduled run whose playbook
  changed is refused and the schedule is switched off.
- The automation identity gets read-only application permissions unless you explicitly allow write ones.
- Advanced filters are compiled on the server to quoted OData or KQL, so they can't inject through URLs. Service paths
  can't carry `?` or `#`.
- Connections can't request tokens for Microsoft services, and they refuse redirects.
- Scheduled report files and probe results need Operator by default.
- Inputs marked `redact: true` are masked wherever runs, events and the audit log store them.
- Runner requests are HMAC-signed over the timestamp, method, path and body. The runner reads only its own key.
- Provisioner and test credentials are kept in a file the services never read. The services get their own database
  through the `host` overlay. A systemd hardening drop-in is included.
- Guard tests and a pre-commit hook block secrets, tenant-specific values and raw UI colours.

### Changed

- Sign-in and write-access failures open a designed problem page with a specific explanation instead of raw JSON. A
  real signed-out page no longer signs you straight back in, and **Use a different account** opens the account picker.
- Error messages now say what happened and what to do next, and show a Reference to give an administrator.
  Out-of-date pages refresh their CSRF token and retry once. A failed report download opens the problem page instead
  of saving the error as the file.
- Interactive runs always use the current published version of a playbook. Previews check the playbook's roles too.
- Provisioning grants the permissions that content declares, on top of the baseline. It registers redirect URIs for
  every origin in `AF_REDIRECT_BASE_URLS`.
- Microsoft 365 usage reports that answer `UnknownTenantId` are reported as a missing licence.
- Per-probe schedules are replaced by four tag sweeps.
- The mail domain and the licence SKUs that probes watch are configurable (`AF_MAIL_DOMAIN`, `AF_LICENCE_SKU_1`,
  `AF_LICENCE_SKU_2`).
- The CLI prints a single line with the fix for common failures (for example, Postgres down → `pnpm db:up`).
- The first page loads faster: the initial JavaScript bundle shrank from about 246 KB to 220 KB gzipped.

### Fixed

- `TRUST_PROXY=true` no longer stops the API at start-up.
- The runner's request signature now covers the HTTP method and path, so a signed request can't be replayed against
  another endpoint.
- Return paths such as `/.//host` can no longer redirect off-site.
- The create-security-group and delete-stale-device playbooks request the correct delegated permissions.
- Exports record the compiled filter in the audit log.
- Monitoring tiles show units and readable KQL column names.
- `pnpm dev` now passes settings such as `AUTH_MODE` through to the apps.

### Docs

- README, `CLAUDE.md`, `docs/extending.md` and the project skills: extending AdminForge with Claude Code (ADR-012).
- `SECURITY.md`, `docs/architecture.md`, `docs/access.md`, `docs/operations.md` and `docs/troubleshooting.md`.
- `portal/deploy/README.md`: host services, production drop-ins, and LAN access through Caddy.
- Widget reference (`docs/widgets.md`), ADR-001 to ADR-012, the decisions log, licensing review and backlog.
- `tests/README.md` and `tests/live/README.md`.
