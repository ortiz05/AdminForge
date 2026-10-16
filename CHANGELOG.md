# Changelog

All notable changes to AdminForge are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Closes the gaps found by comparing the build with the original plan (see the plan's "Revision 3" block and
`docs/decisions.md` → Plan review).

### Added

- **Engineer onboarding guide** (`docs/onboarding/`): a reading path for new contributors — setup, how AdminForge
  works, repository map, security for contributors, coding standards, API and web guides, content, testing, git and
  pull requests, documentation, Claude Code, releases — plus checklists (first day/week, PR author, reviewer, security
  review, definition of done), a glossary and templates (ADR, commit message). `CONTRIBUTING.md` points to it.
- **Commit message and pull request title check**: Conventional Commits with AdminForge's types and scopes
  (`tooling/git/commit-message.mjs`), enforced by a new `.githooks/commit-msg` hook and a `pr-title` workflow that
  re-runs when a pull request is retitled (the title is passed through the environment, never interpolated into the
  script). Merge, revert and autosquash commits pass locally; GitHub's `Revert "…"` titles pass when the reverted header
  is valid. Dependabot titles use `chore(deps)`, `ci(deps)` and `chore(runner)` prefixes. New
  `.github/pull_request_template.md`; CODEOWNERS now lists every path the onboarding guide sends to security review
  (scheduler, connectors, engine, expressions, probes, feeds, the news host list, hooks and tooling).
- **Reports catalogue and in-app report schedules** (user decision 2026-10-16, `docs/decisions.md` D9 note): the
  Reports section of the navigation is now one "All reports" entry (`/reports`) instead of every report — navigation
  sections can say `listDefinitions: false`. `GET /api/reports` lists the reports the caller may open with their area,
  tags, requirements, licence badge, params, export formats and the schedules that run them; `GET /api/reports/:key`
  adds the export columns. Operators can schedule a report right there (`POST /api/schedules`, edit with `PUT`, delete
  with `DELETE`, delivery choices from `GET /api/schedules/delivery-options`): report jobs only, at most hourly
  (`cron_too_frequent`), params validated as the automation identity, email/Teams only to configured recipient lists
  and webhooks, 25 per person and 200 in total, audited `schedule.created` / `schedule.updated` / `schedule.deleted`.
  They run at once (no git review), live in the database under the reserved `portal.` key namespace (content
  schedules may not use it) and are edited or deleted by their creator or a `Portal.Admin`; any Operator can turn one
  off. Schedule items gain `createdBy`, `canManage`, `job.params`, `delivery` and `notify` (key names only), and
  `GET /api/schedules/:key` returns one. The schedule editor and in-app creation share one document builder.
  Hardened after the security review: before every run the creator's account and portal roles are confirmed as the
  automation identity (`creator_access_removed` turns the schedule off; `creator_unverified` skips the run); only the
  params the form offers can be set (pickers, dates, hidden params and the query builder keep the report's default);
  names and summaries are plain single-line text, Teams cards escape Markdown and messages say "Scheduled in
  AdminForge by …"; approval keys are never destinations; `redact: true` params are masked in schedule items and JSON
  files (now streamed), and a schedule's details are shown only to people who may open its report; 50 creations per
  person in 24 hours, caps counted atomically; Run now on a portal schedule waits 15 minutes (`run_too_soon`);
  housekeeping removes deleted portal schedules once their history is gone. The read policy allows
  `checkMemberObjects`; provisioning lists User.Read.All and GroupMember.Read.All as built-in automation uses.
- **News and changes** (`/news`, `docs/news.md`): what Microsoft is changing in the services AdminForge manages, in a
  breaking-news layout — a Breaking strip (open incidents, urgent advisories, deadlines in the next 14 days), a
  day-by-day feed filtered by area, kind, source, tag and text, an unread badge in the navigation and a "breaking" pill
  in the top bar. Every item is cited and links back to its first-party source; only a headline, a short excerpt and
  a few facts are kept. 21 feeds (`portal/content/feeds`, new content kind `feed`): your tenant's Message Center and
  Microsoft 365 service health (Graph, automation identity), Azure Service Health (Resource Graph), Azure Updates, the
  Microsoft 365 Roadmap, the MSRC Security Update Guide, the Microsoft Graph changelog, seven product blogs on
  Microsoft Tech Community, five Learn what's-new pages and PowerShell Gallery releases of the modules the runner
  pins. Broad feeds keep only services AdminForge manages (`keep: matched` classification rules). Collected by the
  new hourly schedule `maintenance.news-refresh-hourly` (`job.kind: news`, each feed at most every `pollMinutes`).
  `adminforge new feed`, `validate` (allow-listed hosts, Microsoft citation domains, required permissions, news job
  references) and the `add-news-feed` skill. Security: feed connections are pinned to checked public addresses (no DNS
  rebinding), source text is reduced by a linear scanner (no regex backtracking on hostile markup), citation links
  must stay on the source's own host, future dates are clamped, a feed's portal roles apply when items are read, and
  the slowest-to-succeed feed is collected first within the schedule's time budget.
- HTTP probes and news feeds: documentation, translated, NAT64 local-use, Teredo, site-local and other reserved
  IPv4/IPv6 ranges now count as non-public addresses.
- **Report library** (~40 new reports, each with a delivery schedule): identity (application permissions, consent
  grants, apps and groups without owners, app credential hygiene, app registration risks, licensed disabled accounts,
  password age, high-impact directory changes, AdminForge role-group changes, tenant settings baseline); Microsoft 365,
  endpoint and security (inactive licensed users, mailbox, Teams, SharePoint and OneDrive usage, service health
  review, message center actions, device security and compliance gaps, Autopilot, Defender alerts, Secure Score,
  risky users); Azure (orphaned resources, budgets, monthly cost, storage, database and Key Vault security, VMs without
  backup, Defender plan coverage, privileged, orphaned and custom-role RBAC, Advisor, policy compliance, Arc agent
  health, App Service security). Every query was checked against a live tenant.
- **Count probes** (`kind: graphCount`): alert when a Graph list holds too many or too few items — Global
  Administrators (more than four, fewer than two users), changes to AdminForge's role groups, plus five Azure
  configuration checks and two Microsoft 365 / Defender probes.
- **Production-build smoke test** in CI (`pnpm test:e2e:prod`).
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

- Navigation sections (Identity, Microsoft 365, Azure, …) open and close from their headings; the choice is saved per
  person, and a closed section still shows the page you're on.
- **Live validation tooling:** `provision test-identities` excludes the validation user — and nobody else — from
  Entra's authentication-methods registration campaign (the Microsoft-managed "Sign in faster with your face,
  fingerprint, or PIN" nudge stopped its unattended sign-in); the rest of the campaign is sent back unchanged, and
  `provision status` checks the exclusion ✓/✗. A live sign-in that lands on the nudge anyway fails at once and names
  the fix. `run-playbook.ts` placeholders now cover mailboxes, distribution lists, teams and sites (`@mailbox:`,
  `@dl:`, `@team:`, `@site:`, `…#field`; `tests/live/lib/placeholders.ts`, `check-placeholders.ts`).
  `tests/live/scripts/run-schedule-once.ts` runs a schedule or probes once as the automation identity against the dev
  database (never the host overlay) with email and Teams delivery suppressed, or email sent only to `AF_MAIL_SENDER`
  itself; `check-mail-sender.ts` checks report email through the notifier (the sender mails itself; sending as another
  mailbox must be refused). `docs/operations.md`: Exchange RBAC for Applications needs
  `Enable-OrganizationCustomization` first, and it can take hours to apply.

### Changed

- **Navigation sections start collapsed.** Every section of the left rail starts closed; a closed section still shows
  the page you're on and pages with something new (the unread-news count), and its heading says how many pages it
  hides. Opened sections are remembered per person (`navOpenSections` in `PUT /api/me/prefs`; the older
  `navSections` — the sections people had closed — is no longer read, so everyone starts collapsed once).
- `identity.offboard-user` 1.1.0 converts the mailbox to shared, sets an automatic reply, hides it from address lists
  and gives the manager OneDrive access when those workloads are licensed; `identity.leaver` 1.1.0 now only lists what
  offboarding couldn't do.
- `identity.compromised-account` 2.0.0 merges `security.compromised-account-response` (retired).
- **Defender on Office 365 E5 tenants (checked live 2026-10-16).**
  - New licence feature `defenderEndpoint`: Defender for Endpoint Plan 2 device data (`WINDEFATP` or the
    `TVM_PREMIUM_1` add-on). `security.device-vulnerabilities` 1.0.1 is gated on it. Before, page gates mapped
    `WINDEFATP` to `defender`, which Office 365 E5 satisfies; a service plan now resolves to the most specific feature
    that lists it.
  - Defender XDR's 403 "Account is not provisioned" now reads "Microsoft Defender XDR isn't set up for this tenant yet",
    with the fix: an admin opens security.microsoft.com once. It used to say "licence missing". Probes report it as
    `not_configured`.
  - Secure Score (`security.secure-score` 1.1.0, `security.secure-score-summary` 1.1.0, `security.overview` 1.0.1):
    improvement actions come from the controls in the latest score. The control catalogue lists hundreds that don't
    apply to the tenant; on the live tenant the old approach showed 462 actions worth 2,626 points against a maximum
    of 8. Other fixes:
    - The comparison with other tenants is read as the percentage it is.
    - Cost and impact are normalised (Microsoft mixes `low`, `Low`, `Medium`, `Moderate` and `Unknown`).
    - A tenant without a score yet shows empty values and a note, not 0 %.
  - `security.incident` / `security.alert` 1.1.0 name the email evidence types Defender for Office 365 produces (email
    cluster, user-reported email, mailbox configuration, Teams message, OAuth app, …).
  - Licence-gate text ends each reason with a full stop.
- **Teams, SharePoint and OneDrive on Office 365 E5 (checked live 2026-10-16).**
  - `m365.teams-without-owners` 1.1.0 reads Microsoft Graph instead of Teams PowerShell, so its weekly schedule is
    enabled and runs as the automation identity. The archive state comes from Graph's Teams API, which answers only
    people with a Teams licence: without it every team is listed and the report says so. Only people count as team
    owners there, on `m365.teams` 1.0.1 and on the Microsoft 365 overview (apps can own a group, not manage a team).
  - New datasource option `optional: true`: datasources that use a failed optional one see `null` instead of failing,
    and carry the failure in `errors["ds.<name>"]` (limits under Security).
  - `m365.team` 1.1.1 loads team settings and channels again (its `when` named the group datasource without `ds.`);
    `adminforge validate` now refuses that mistake. Microsoft's "Failed to get license information for the user" now
    explains that the signed-in person needs a Teams licence, instead of claiming the tenant lacks one.
  - OneDrive handover: `m365.grant-onedrive-access` 1.1.0 reads the grant back and undoes it when SharePoint doesn't
    show it, refuses giving the access to yourself, and new `m365.remove-onedrive-access` takes it away
    (`sharepoint/Set-SiteCollectionAdmin.ps1`, tenant admin API).
  - SharePoint sharing (`m365.sharepoint-sharing` 1.1.0, `m365.anyone-link-sites` 1.1.0): readable link settings
    ("Anyone with the link", "Never" for links without expiry), untitled sites show their URL, group-connected sites
    link to their group (the site list has no owner for them).
  - Usage reports: concealed site names fall back to the site id (`m365.sharepoint-sites`,
    `m365.sharepoint-site-usage`); a newly licensed tenant's 404 `UnknownTenantId` says the reports start 24–48 hours
    after the first subscription. Service health KPIs count every unresolved issue whatever the table filters.
  - The runner connects Teams without `-TenantId` (MicrosoftTeams 8 refused it with access tokens: "Not supported
    tenant type").
- Write-app permissions trimmed to what content declares (removed `Policy.ReadWrite.ConditionalAccess`,
  `DeviceManagementManagedDevices.ReadWrite.All`, `IdentityRiskyUser.Read.All`); new ones added for the new playbooks.

- Recent pages and closed navigation sections are saved without an audit event; every page visit used to add a
  `prefs.updated` entry. Settings changes (theme, density, pins) are still audited.

### Security

Platform evaluation (2026-10-16) — organization and security best practices (OWASP ASVS 5.0, NIST SSDF, Microsoft
identity platform guidance, systemd hardening, OpenSSF Scorecard). Fixed:

- **Protected objects, enforced centrally.** The executor refuses every write (REST or PowerShell) that names
  AdminForge's own apps and service principals, any principal holding an AdminForge app role (the `SG-AdminForge-*`
  groups), `AF_PROTECTED_APP_IDS` or the new `AF_PROTECTED_USER_IDS` (break-glass accounts) — by id, read from Graph
  and cached for 10 minutes (`protected_object`, `protected_objects_unavailable`). Previously only some playbooks
  checked group names: `identity.create-user` could add a new account to an approver group and hand its creator the
  TAP, and nothing stopped removing other approvers.
- **Separation of duties.** Approval gates exclude the people a change grants access to (`approval.excludes`,
  `own_access`): the principal getting a directory or Azure role, people added to a role-assignable group, a new app
  owner. Group and app-owner playbooks refuse adding yourself; role-assignable groups and app owners need approval.
  Approvals expire after 72 hours by default. Only the person a manual step waits for can confirm it.
- **Runs follow the current rules.** Resuming re-checks roles and — before anything was changed — the current version
  (`run_outdated`); child playbooks run their current version only; runs waiting for arming or sign-in stop after 24
  hours (`run_expired`); a confirmed change with a preview older than 15 minutes stops before writing. The run worker
  re-checks the initiator's roles every 5 minutes (shared with the API through `sessions.roles_checked_at`, migration
  0007), so removing someone from Operator stops their unattended writes too.
- **Emergency stop.** Admin → Settings pauses all changes (`writes_paused`) or all automation (`automation_paused`,
  including Run now) with a reason; approvers and admins can pause, admins resume; audited and shown in a banner.
  AdminForge's own notification mail still goes out.
- **Publishing.** `adminforge publish` runs the `validate` checks and the playbook tests, and refuses content that isn't
  committed and on `origin/main` unless `--allow-unreviewed` (recorded with its reasons in the audit event).
- **Injection lint.** User data in OData `$filter`, `$search` and `$orderby` (query or body) must go through
  `$odata()` / `$odataSearch()` / `$guid()`, even inside a quoted literal (previously only `&` concatenation was caught).
- **Sessions.** Background polling no longer keeps a session alive (`X-AdminForge-Background`), and an idle tab no
  longer signs itself back in; live run streams and show-once secret delivery stop when the session ends; at most 5
  event streams per session; every `/api` route needs `Portal.Reader` (with a few exemptions); a token without the
  `acct` claim is refused (`account_status_missing`).
- **Step-up visibility.** `session.armed` records whether arming proved an authentication context or only a fresh
  sign-in; Admin → Settings shows it and `adminforge env check` warns without `WRITE_AUTH_CONTEXT`.
- **Audit and logs.** Refused security-relevant requests are audited (`request.denied`, rate-limited); sign-in and arm
  failures keep only the OAuth error code and AADSTS number (an unauthenticated caller could previously write free text
  into the audit log); request logs carry the user's object id and never `/api` query values.
- **Browser.** `Permissions-Policy`; production source maps are no longer served; Query Studio's Copy neutralises
  spreadsheet formulas; key-value links without `href` no longer evaluate tenant data as a template; `/readyz` no
  longer names configuration keys; the example Caddyfile drops `Via`.
- **Host and supply chain.** The services' configuration loader drops the database owner URL and `POSTGRES_PASSWORD`;
  backups leave out the rows of `sessions`, `preauth` and `token_cache` and the backup unit gets the hardening drop-in;
  PowerShell workers start with a settings file that keeps script-block and module logging (module source at warning
  level, ~120 MB a day) out of the journal; CI actions are pinned to commit SHAs.
- Docs: SECURITY.md now states the host requirement (an account of its own, not in `docker`/`sudo`), the step-up gap
  without `WRITE_AUTH_CONTEXT`, and the remaining known gaps; ADR-013 records the News feed egress decision; the master
  plan is marked historical. Deferred findings are in `docs/backlog.md` → Platform evaluation.

- **Mailbox, inbox-rule and OneDrive writes** (security and content review 2026-10-16):
  - `m365.set-mailbox-forwarding` 1.1.0 needs a second engineer's approval; the person receiving the mail and the
    mailbox's owner can't approve it. It forwards only to user and shared mailboxes (no groups — they can include
    guests and outside contacts), never to a mailbox that forwards on, to the mailbox itself or to yourself; the script
    (`Set-MailboxForwarding.ps1`) refuses the same. A hybrid mail user is explained as "no mailbox in Exchange Online",
    and an unconfirmed change says "submitted; Exchange doesn't show it yet".
  - `m365.grant-mailbox-permission` 1.1.1 refuses giving yourself access; it and `m365.remove-mailbox-permission`
    1.1.1 name permissions as "Full Access", "Send As" and "Send on Behalf".
  - `m365.set-inbox-rule` 1.0.1 never turns on a rule that forwards or redirects outside the organization (script,
    playbook, and the audit's row actions in `m365.inbox-rules` 1.1.1).
  - `Set-SiteCollectionAdmin.ps1` works on OneDrives only, requires the owner and confirms it from their SharePoint
    profile, reads back whether or not it sent anything, and fails loudly if a removal drops anyone else.
    `m365.grant-onedrive-access` 1.1.1 never takes away access the person already had.
  - The four PowerShell writes take the Entra object ids of the accounts they change and check them against Exchange
    or SharePoint, so the protected-object guard (`AF_PROTECTED_USER_IDS`, AdminForge's own principals) covers them.
  - `identity.leaver` 1.2.1 declares what its Offboard user step needs; `identity.compromised-account` 2.0.1 links the
    inbox rule audit and Clear forwarding.
- News and changes fetches public feeds only over https from a code allow-list of Microsoft hosts (public addresses
  only, redirects only within the list, time and size limits, conditional requests), refuses XML with DOCTYPE or entity
  declarations, renders source text as plain text only and keeps citation links only on Microsoft domains. Tenant feeds
  use the automation identity's read-only ServiceMessage.Read.All / ServiceHealth.Read.All and Reader; data-privacy
  Message Center posts are Portal.Admin only; feed errors are Operator only.
- Second security review (API, runs, runner, identity and RBAC) fixed: connection token scopes and audience allow-list;
  sessions end on `invalid_grant`; guests refused (`acct`); step-up always forces a fresh sign-in; control characters
  in paths; response size caps; HTTP-probe SSRF; expression limits; query parameters kept out of logs; mock mode fenced;
  current-version-only data and exports; email recipients from configuration only; manual-step values only from the
  person asked; scheduled-run outputs need the schedule's roles; connections in approval fingerprints; redaction after
  resume; safe Markdown links; approver and child playbook roles; drafts can't run; single-use previews; runner tokens
  sealed and answers signed; a read-only command policy for PowerShell read jobs.
- Provisioning ceilings for tier-0 Write scopes (`AF_ALLOW_PRIVILEGED_WRITE_SCOPES`) and sensitive automation reads
  (`AF_AUTOMATION_ALLOW_SENSITIVE_READS`); `provision status` fails on privilege it didn't grant; automation identity
  requires assignment and can use a certificate; the validation user drops Groups Administrator and stays disabled
  between live runs.
- AdminForge's playbooks refuse to change its own role groups, its own apps and `AF_PROTECTED_APP_IDS` (the provisioner).
- The services use a least-privilege database role (`adminforge_app`) that can't change the audit log; backups no
  longer include the admin env file or private keys unless encrypted (`AF_BACKUP_GPG_RECIPIENT`).
- `requires.portalRoles` now means **every** listed role everywhere (pages and datasources previously accepted any
  one of them).
- Shared saved views are listed only for pages the caller can open.
- Extending write access re-checks the Operator role.

Security review of the licensed build-out (2026-10-16) fixed:

- **`optional` datasources never hide a denial.** `dependency_failed` keeps its cause, and the whole chain is checked:
  a missing portal role, `policy_denied`, `licence_required` or a sign-in / arming problem anywhere behind an optional
  datasource still fails its dependents. What `optional` does suppress is recorded in the dependents' `errors`
  (`ds.<name>`, also further down the chain) and logged; exports audit it (`incomplete`), and a scheduled report built
  without it writes and delivers the file marked "Incomplete: …" and ends `failed` with `report_incomplete` (not
  retried), so it never succeeds silently on a refused call.
- **Validation user privilege is opt-in and limited to provisioning's own account.** Exchange Recipient Administrator
  and SharePoint Administrator (tenant-wide) are given only with `AF_TEST_SERVICE_ADMIN_ROLES=true` in the admin file
  (default off; licensed tenants list them as withheld, and re-provisioning removes them). Provisioning refuses, before
  changing anything, an existing account it didn't create (UPN not `af-…`, or neither the new `employeeType` marker
  "AdminForge validation" nor the display name "AF Tester"): no password reset, roles, groups, registration-campaign
  exclusion, `--enable` or `--disable`, and no Azure test roles. `provision status` also fails on any other directory
  role the validation user holds — roles outside AdminForge's catalogue, narrower scopes, roles through a group — by
  name only.
- **Live scripts.** `run-schedule-once.ts` refuses a `DATABASE_URL` from the process environment, a dev database that is
  also the host services' (the `host` overlay resolving to the same URL) and playbook schedules;
  `check-mail-sender.ts` sends only as `AF-Test-*` mailboxes or the configured sender; `run-playbook.ts` prints error
  codes and masks ids and addresses in messages (`tests/live/lib/mask.ts`); `tests/live/scripts/.tmp-*` is ignored.
- The tenant-data guard and `fixtures` sanitiser exempt `AF_LICENCE_SKU_<n>` values only when they look like a SKU part
  number (`^[A-Z0-9_]{2,64}$`). The runner's read-only policy classifies `Format-AdminForgeMessage` as internal.

### Fixed

- **Published pages lost their authored key order.** Definitions were stored as Postgres `jsonb`, which sorts object
  keys, so in production (`CONTENT_SOURCE=db`) 15 reports and pages whose datasources reference one declared
  "above" them failed with a content error (e.g. orphaned role assignments, groups without owners, consent grants,
  app registration risks, risky users review, Teams without owners), and 61 parameter forms and 64 playbook input forms
  showed their fields in a different order than in development. The executor now orders datasources by their
  `ds.<name>` references (a loop is the only content error); `adminforge validate` still requires dependencies to be
  declared first; migration 0008 stores definitions as `json`, and `adminforge publish` restores the authored order of
  bodies stored before (reported as "restored to their authored key order", without a new version).
- Development hot reload could go quiet for minutes: Node's recursive file watcher on Linux stops reporting a file once
  it has been replaced by a rename (atomic saves, formatters, `sed -i`), and a content change made while a reload was
  running was dropped. The file source now also compares file stamps every 2 s and runs a reload again when one was
  asked for mid-reload.
- `init:local` replaces the `CHANGE_ME` placeholders of a copied `config/example.env` instead of reusing `CHANGE_ME` as
  the Postgres password (the documented setup path left `env check` complaining).
- `docs/api.md` no longer says a client may choose its `X-Correlation-Id`; the API always generates it.
- Two load-sensitive tests: a Postgres purge test mixed a fixed date with the database clock (failed from the day after
  it was written); the 250 ms transform-budget test retries under a saturated machine; the reports catalogue component
  tests have a larger timeout.
- Azure pages read Resource Graph flags correctly: computed booleans arrive as 1/0, so the Privileged KPI showed 0, the
  resource Access tab never offered "Remove assignment", and several flag columns and facets were wrong (8 pages).
- `identity.*` reports: a one-item id list was sent to Graph as a plain string.
- Error messages never show Microsoft's raw JSON (e.g. usage reports on a tenant without Microsoft 365).
- Graph requests send `Accept-Language: en-US` (direct PIM requests failed with `CultureNotFoundException`).
- Built-in email delivery can get `Mail.Send` (provisioning requests it when `AF_MAIL_SENDER` is set, behind the write
  opt-in; prefer scoping it to that mailbox with Exchange RBAC for Applications).
- Playbook preflight checked licences by SKU name instead of feature key, so licensed features could show as missing.
- An admin's default density never applied to people without their own preference.
- The PIM menu and the page renderer shared a query key, so one could overwrite the other's data.
- `adminforge validate --scopes` didn't read the provisioner credentials from the admin env file.
- Collapse/Expand did nothing in windows narrower than 1024 px: the button treated the rail as collapsed while it
  was drawn expanded. Your own choice now wins; without one, narrow windows start collapsed.
- Opening an Azure resource or resource group failed with "Query is invalid": Resource Graph doesn't accept a leading
  `union a, b` (`azure.resource` 1.1.0). `adminforge validate` now rejects that form in Resource Graph queries.
- Bar, line and area charts stayed empty in production builds (`… is not a constructor`): the bundler dropped the chart
  runtime's top-level registrations. Registration is now explicit, and a production-build smoke test
  (`pnpm test:e2e:prod`, in CI) covers it.

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
