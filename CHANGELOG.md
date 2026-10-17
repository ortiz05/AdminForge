# Changelog

All notable changes to AdminForge are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Closes the gaps found by comparing the build with the original plan (see the plan's "Revision 3" block and
`docs/decisions.md` → Plan review).

### Added

- **Who a schedule runs as** (ADR-014): `identity: automation | { app: <name> } | { user: creator }`. Named app
  identities (`AF_SCHEDULE_IDENTITIES`, `AF_IDENTITY_<NAME>_CLIENT_ID` / `_CERT_PATH` / `_CLIENT_SECRET`) are
  provisioned, checked and pruned by `provision entra` / `status` with exactly the permissions of their schedules, and
  `validate --scopes` compares them one by one. Portal report schedules can run with their creator's own read access
  (one sign-in through the Read app, `POST /auth/schedule-consent`; "Needs sign-in" with **Sign in again** when
  Microsoft asks). Runs and audit events record "executed as …" (migration 0012: `schedule_grants`,
  `runs.identity_name`); the UI has a **Run as** field in the report schedule form and the schedule editor and a
  **Runs as** column; `GET /api/schedules/identities`.
  Hardening from review: a creator schedule's files open only for the creator (or a Portal Admin, audited); lost access
  removes the grant and turns the schedule off on either check; the sign-in requires a fresh `auth_time` (Read app
  claim) and lands in a temporary partition first; per-identity opt-ins `AF_IDENTITY_<NAME>_ALLOW_*` and
  `AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS` for tier-0 application permissions; retired identities stay protected
  and fail `provision status`; approvals and audit events name the identity.
- **Enterprise-scale performance tests** (`tests/perf/`, `pnpm test:perf`, `docs/performance.md`): a deterministic
  synthetic tenant (100k users, 50k groups incl. a 100k-member one, 30k managed devices, 20k apps, 1M sign-ins a day
  computed on demand), a fake Microsoft Graph that pages, caps, counts, searches and throttles like Graph and refuses
  what it doesn't model, every page/dashboard/report datasource run through the real engine against it with budgets
  (requests, bytes, transform time, heap, estimated live time, truncation) that fail when something gets slower or new
  content doesn't meet the default, and a load test (`tests/perf/load.ts`) with up to thousands of signed-in sessions.
  First results: 39 of 326 datasources fail at 100k users (transforms out of budget after fetching whole collections),
  and one API process with 16 Graph slots serves ~25–30 page loads a second before people get `outbound_busy`.
- **Engineer report library** (plan 2026-10-17, phase E): SAML signing certificate expiry (with a daily schedule and
  two probes: 30 days warn, 7 days or expired critical), subscription renewals and lapses (probe: grace period,
  suspended, trials ending), Intune connector and token health (Apple push certificate, ADE and VPP tokens, Managed
  Google Play, Autopilot sync — "Not configured" when unused; ADE and VPP probes), licence assignment errors (per group,
  the failed members with the reason, licensed users without a usage location), user attribute completeness (with an
  optional manager check), group lifecycle (expiring Microsoft 365 groups, single-owner, paused dynamic and restorable
  deleted groups), unused applications, authentication method strength, BitLocker recovery key escrow and Windows LAPS
  coverage (metadata only), and Conditional Access report-only impact (every sign-in through Log Analytics, a sample of
  the newest 300 from Graph otherwise; the Log Analytics path is optional and falls back to the sample). Weekly
  stale-devices and daily non-compliant-devices schedules, shipped off until those reports meet their perf budget; one
  licence-seat
  probe over every SKU the tenant has (replaces the fixed E3/E5 probes, retired); the duplicate identity licence
  utilisation report is retired in favour of Licence utilization and Licence assignment errors. Every list is filtered
  by Graph and capped where its transform fits the 250 ms budget (measured; scale tests in
  `tests/content/engineer-report-library.test.ts`).
- **Enterprise test fixtures** (plan 2026-10-17, phase F; opt-in in `AF_TEST_FIXTURES`, each its own module):
  `directory` (AF-Test-User-04…12 with departments, job titles, employee ids, four usage locations and one unset, a
  manager chain with a disabled manager, a disabled user licensed directly, one with no attributes, one whose password
  never expires; dynamic, nested, Microsoft 365 with and without an owner, empty and group-licensing groups; the
  administrative unit AF-Test-AU-01), `guest` (never redeemed, no email sent), `apps` (expiring, long-lived and many
  credentials kept true over time, a risky and an ownerless app, a SAML app with a signing certificate expiring within
  a month — never granted anything; secrets dropped at once, certificates throwaway), `auth-methods` (a fictitious SMS
  number, a Temporary Access Pass never shown), `intune-more` (iOS, Android and an unassigned macOS compliance policy,
  an update ring, app protection) and `sign-ins` (two accounts that only sign in, for the new
  `tests/live/scripts/generate-sign-ins.ts`: a success with MFA, a wrong password, a disabled account). Everything is
  marked, refused when someone else's, removed by `--remove-fixtures`; each operation fails on its own; licences only
  with free seats; `--disable` disables the sign-in accounts too. Graph's 409 "concurrent requests" is retried. `provision status` fails on anything a sign-in account holds, warns while one is enabled, fails on any service
  principal, grant or assignment on a fixture app (the risky app is ownerless), and shows fixtures no longer opted in
  as left over (`--remove-fixtures` removes them anyway, and exits 1 when something couldn't be read); the assigned
  Intune policies are refused while AF-Test-Group-01 has other members; a guest or SAML app that can't be marked is
  deleted again.
- **Schedule times in plain English** (plan 2026-10-17, phase D): one describer and a small closed grammar
  (`@adminforge/schemas` cadence.ts) shared by the API, the web app and content. Content schedules may say `every:
"first Monday of the month at 08:30"` instead of `cron:` (validation compiles it and names any word it doesn't
  understand; the zone stays in `timezone`). The schedule editor and the report schedule form gain every few hours,
  several days of the week, the Nth or last weekday of the month, the last day of the month and a "Type it in English"
  box that echoes what it understood (and takes a zone typed at the end); a searchable field offers every IANA time
  zone with its offset, defaulting to the browser's. Their next runs come from `POST /api/schedules/preview`, which
  now takes `cron` or `every` and answers with the cron, a sentence naming the zone and `tooFrequent`; the schedule
  editor's YAML says `every:` when given English. The report schedule form refuses anything more often than once an
  hour on the cadence field, before saving; a problem shows once, on the field, and screen readers hear what a
  sentence was understood as when typing pauses.
- **`provision entra --prune`:** removes application permissions on AdminForge's three apps that provisioning no longer
  grants (retired content, a dropped baseline permission, a ceiling turned back off, or added by hand) — only roles on
  the resources provisioning knows; review with `--dry-run --prune` first. Without it the plan counts them in one ⚠ line
  and `provision status` points at the flag; delegated consent was already converged both ways.
- **`AF_QUERY_SOURCES`:** an installation can switch off Query Studio sources (`resourceGraph`, `logAnalytics`,
  `advancedHunting`; empty = all). The API refuses a switched-off source before any call to Microsoft (403
  `source_off`), `/api/me` lists the enabled ones, Query Studio hides the rest (an old link opens the first enabled
  source and says why), and `adminforge env check` flags unknown names.
- **`ca-audit` test fixture:** 14 example Conditional Access policies (`AF-Audit: …`) modelled on Microsoft's baseline
  and templates, only ever report-only: creates are checked, updates never send a state and are read back, only
  report-only policies are updated, and ownership is re-checked before every write. Device and location examples on
  AF-Test-Group-01 only (refused if the group has other members or is dynamic); break-glass accounts
  (`AF_PROTECTED_USER_IDS`) and the Directory Synchronization Accounts role excluded; the policies that block all
  users also exclude the Global Administrator role. Needs `Application.Read.All` on the provisioner for app
  conditions.
- **Licensed test fixtures** for `adminforge provision test-identities` (opt-in from the admin file;
  `docs/plans/2026-10-16-m365-e5-unlock-and-tooling.md` Phase 1): `AF_TEST_LICENCE_SKU` licenses the validation user
  and AF-Test-User-01…03; `AF_TEST_FIXTURES` adds PIM eligibility (never active), the named location
  `AF-Test-Location` (192.0.2.0/24, not trusted), AF-Test Intune policies assigned to AF-Test-Group-01 only, and the
  approver account "AF Tester 2" (Portal.Reader + Playbook.Approver, its own marker) for two-account approval tests.
  Only objects provisioning created are changed; `--remove-fixtures` undoes them in any label; `provision status`
  lists them ✓/✗ with the seats used. A fixture Graph refuses prints `✗` with the Microsoft Graph application
  permission the provisioner needs, and the other fixtures still apply. Safeguards from the security review: the
  approver is enabled only with `--enable --approver` (`--disable` always disables both, each attempted), refused
  where `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true` or when its UPN is the validation user's, flagged when left over,
  and taken out of the registration campaign's exclusions before it is deleted; `provision status` warns while the
  provisioner still holds fixture permissions (they outlive its directory role), flags strangers in AF-Test-Group-01,
  and checks PIM-eligible roles of both validation accounts.
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

- **Content rewritten for large tenants** (100k users; measured with `pnpm test:perf`): the licence page, teams page
  and app registrations page page through Graph with server-side search and filters (one request instead of 50–350);
  the identity health and Microsoft 365 dashboards count at the source (`$count`, batched windows) instead of reading
  whole collections; inactive users read only inactive accounts (Graph's sign-in filter); password age, mailbox storage,
  OneDrive, SharePoint site usage, SharePoint sites, teams activity and inactive licensed users use native filters on
  Graph's own rows (they failed beyond ~1,500 accounts before), with storage totals from Microsoft's daily summary
  reports. Past their caps they say the data is partial (derived report data included); the counts stay complete where
  Graph can count. Tables over 10,000 rows show the first 10,000 (sorted first) and the CSV/XLSX export has every row
  read. Inactive users count accounts with no successful sign-in recorded (failed-only sign-ins included).
- **Owners: people and apps.** `GET /groups/{id}/owners` leaves service principals out, so the group and team pages
  read people and apps apart and agree with the owner count; the groups and teams owner reports list "Owned by an app
  only" apart from "No owners", and the teams list labels each team accordingly. "Remove group owner" finds app owners
  too and keeps a person accountable (it won't remove the last person who owns a group).
- **Expressions:** the grouping constructor (`rows{ key: value }`) runs natively — it failed past ~500 keys ("nested or
  recursing too deeply"); `$applyAdvanced` is compiled once per call and takes filters written in content (`notEmpty`,
  `notContains`, `notIn`, field-to-field comparisons, paths through lists); new `$withFields` and `$take`. The native
  grouping and sorting share the expression's single time budget, read own properties only, and leave sources they
  can't reproduce exactly (function results, blocks, conditions) to JSONata; `$__af*` variables are reserved.

- **Database connections** carry per-connection limits and a name (`DATABASE_STATEMENT_TIMEOUT_MS` [60 s],
  `DATABASE_LOCK_TIMEOUT_MS` [15 s], `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` [60 s], `application_name
adminforge-<process>`) and a configurable pool size (`DATABASE_POOL_MAX` [10]); migrations run without a time limit.
- **Local setup:** `init:local` writes your dev database URL for the non-superuser `adminforge_dev` and puts the
  container's superuser password in `dev.owner.env`; `pnpm db:up` / `db:down` go through `portal/deploy/db/compose.sh`
  (it adds the owner file); then `pnpm db:harden` before `db:migrate`. `adminforge env check` reads the owner files
  (states only) and says when owner keys still sit in a file the services read.

- **Cadence wording:** every schedule sentence now names its time zone ("Every 15 minutes (UTC)", "Every weekday
  (Mon–Fri) at 07:00 Europe/London"); the API's `cronText` and the web app use the same describer (they differed),
  and the web app shows times with the browser's 12- or 24-hour clock. Form field errors that wrap keep their icon
  on the first line at full size (`field` recipe).
- **Page loads at enterprise scale** (plan 2026-10-17, phase A):
  - Microsoft calls take a concurrency slot per attempt (each page, each retry) and release it while a throttled call
    waits; a person waits at most `OUTBOUND_QUEUE_WAIT_MS` (503 `outbound_busy`); schedules queue. The overview's
    `$batch` goes through the same slots.
  - A timed-out attempt is tried once more, not four times; the slow reads (`OUTBOUND_TIMEOUT_OVERRIDES`: sign-in and
    audit logs, usage reports, Log Analytics) get one 2-minute attempt. A person's datasource stops after
    `DATASOURCE_DEADLINE_MS` (504 `datasource_timeout`), and a page left while it loads stops calling Microsoft.
  - Identical concurrent loads of one session share one execution; the cache is capped by size
    (`DATASOURCE_CACHE_MAX_MB`) as well as entries, keys on the params a datasource uses and on its dependencies' keys
    (a cached dependent no longer re-runs its dependencies), and drops only the republished page's results. A transform
    that failed is tried again on the data already fetched.
  - `paging: all` and `$batch` collections say when they're partial (`truncated`).
  - Order-by (`^( … )`) and a constant slice after it run natively: 100k rows sort in a few hundred ms (JSONata's
    own sort took over a second for 10k rows and ran out of memory at 50k).
  - Request limits count per session (background requests apart, `RATE_LIMIT_BACKGROUND_PER_MINUTE`) with a coarse
    per-address cap (`RATE_LIMIT_PER_ADDRESS_PER_MINUTE`): behind a NAT, one busy engineer no longer locks out the rest.
  - Retried throttling shows in the `microsoft call` log line (`retries`, `throttledRetries`). Sizing:
    `docs/operations.md` → Sizing for a large tenant.
  - **Lanes for Microsoft calls**: list pages, entity reads, batches, writes and the first two pages of a crawl are
    served first; the rest of a `paging: all` holds at most `OUTBOUND_CRAWL_SHARE` (half) of the slots; schedules have
    their own (`OUTBOUND_AUTOMATION_CONCURRENCY`). `OUTBOUND_CONCURRENCY` defaults to 48 (was 16: within Graph's
    directory budget for one app in a large tenant). Load test at 200 engineers: no `outbound_busy` (users list p50
    1.3 s, was 4.6 s); `docs/performance.md`.
  - Only a person's read can be refused as busy, and only before it is sent: writes, retries, further pages and
    long-running-operation polls always wait.
- The inspector drawer is three times wider, never over the navigation: it covers the list (with a scrim that closes
  it) when too little would be left, and lays out the entity page's widgets and KPIs in columns. "Open full page"
  moved to its header and keeps the current tab.
- `check-page-datasources.ts` takes entity-page params after `?` (placeholders or literal values, never printed).
- **Tooling reorganised so each tool can be maintained on its own** (plan: `docs/plans/2026-10-16-m365-e5-unlock-and-tooling.md`):
  - one rule, one place: the tenant-value rule (`tenantValues` in `@adminforge/config`), the design-token patterns
    (`tooling/lint/design-token-patterns.mjs`, used by ESLint, the guard and the after-edit hook), and runner-script
    sha256 pins (now checked by `adminforge validate` for every definition);
  - the `adminforge` CLI: one module per command, layered `shared → provision → content/env → commands` without
    cycles, header comments throughout and a command reference in `portal/tools/cli/README.md`;
  - tools use the API through `@adminforge/api/tooling` and `@adminforge/api/tooling/scheduler` instead of deep
    imports; the scheduler's one-shot run is a reusable module (`@adminforge/scheduler/one-shot`);
  - the runner's PowerShell module is split by concern (events, errors, inputs, connections, read-only policy) with an
    unchanged export list; Pester and the module installer share one install routine;
  - deploy defaults (container, user, database, port) in `portal/deploy/defaults.env`; `portal/deploy/install-units.sh`
    installs the systemd units (replaces the `sed` step; refuses checkout paths that aren't safe in a unit file, and the
    defaults file accepts only `AF_PG_*` keys);
  - live tooling masks every printed message, shares preview/run/poll and credential helpers, and writes to
    `AF_LIVE_OUT` (default `~/.cache/adminforge/live`; refused inside the repository, also through symlinks); `pnpm live:*`
    aliases; the after-edit hook, bundle check and commit-message check also run when started through a symlinked path;
  - test harness: one app/session builder and one people list for API tests (unique object ids), shared helpers under
    `tests/support/` and `tests/lib/`, content fixtures out of code;
  - READMEs for the CLI, `tooling/`, the runner, content scripts, the scheduler, hooks and test folders; tests for the
    bundle check, the after-edit hook, the module installer, the runner health probe and commit-scope sync; CI and the
    pre-commit hook use `pnpm guard` and `pnpm check:bundle`; the root `lint` script runs the lint package (it had
    been linting nothing from that folder).
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

### Removed

- **Microsoft Defender portal content retired:** AdminForge no longer reads security.microsoft.com. Incidents, alerts,
  advanced hunting, Secure Score and device vulnerabilities (6 pages), the incident playbooks, the alerts, incidents and
  Secure Score reports with their schedules and the two Defender probes are `status: retired` (kept for run and audit
  history); the Defender XDR news feeds stay (public web pages, not portal data). The security overview (2.0.0) keeps users at risk and Defender for
  Cloud; `identity.compromised-account` 3.0.0 drops the optional Defender incident comment. Retired content no longer
  earns permissions (the Read app and automation baselines lose `SecurityIncident.Read.All` and
  `SecurityAlert.Read.All` too): `provision entra` drops the delegated `SecurityIncident.*`, `SecurityAlert.Read.All`,
  `SecurityEvents.Read.All` and `ThreatHunting.Read.All` from the Read and Write apps, and the automation identity's
  Defender application permissions are removed with `provision entra --prune` (run `--dry-run --prune` first). Query Studio's advanced hunting can be switched off with
  `AF_QUERY_SOURCES` (above). A content test keeps active definitions from linking to retired ones.

### Security

- **Rate limits and sign-in**: `/auth/login` and `/auth/callback` count per client address whatever cookie comes
  with them (`RATE_LIMIT_SIGNIN_PER_ADDRESS_PER_MINUTE`), requests without a valid session share
  `RATE_LIMIT_ANONYMOUS_PER_ADDRESS_PER_MINUTE`, IPv6 counts per /64, and the background allowance no longer doubles a
  route's own limit — invented cookies buy no fresh allowance. Failed-sign-in audit events are written at most 10 a
  minute per address, then a `suppressed` count. `TRUST_PROXY=true` is refused in production.
- **Expression budget**: a sort term or group key evaluated per row shares the whole evaluation's 250 ms (each row
  used to get its own); keys JSONata compares only pair by pair fall back to its own sort, and constant slices follow
  its index rules exactly. Datasource cache keys count all params whenever an expression reaches them through the root
  scope or a wildcard, and the query lint treats those as user data. A cached result is refused when a role a
  dependency needs is gone; a closed page is never swallowed as an optional failure.
- **Postgres hardening** (`docs/operations.md` → Postgres hardening, `pnpm db:harden [--dry-run] [--rotate]
[--rotate-superuser]`): the services' database and the dev/test databases get **non-superuser owners**
  (`adminforge_owner`, `adminforge_dev`) and everything the bootstrap superuser owned moves to them; the superuser can
  sign in over the container's socket only (`pg_hba.conf` rejects it over TCP; new clusters get the rule and password
  TCP auth at initdb); databases are closed to `PUBLIC`; `adminforge_app` gets per-role `statement_timeout`,
  `lock_timeout` and `idle_in_transaction_session_timeout` and a connection cap. The owner's URL and the superuser
  password live in owner files (`<env>.owner.env`, `<env>.<overlay>.owner.env`) that only migrations and the database
  scripts read; `create-app-role.sh` writes the owner URL there and runs as the container superuser. Passwords are
  sent only as client-side SCRAM-SHA-256 verifiers (`portal/deploy/db/scram.mjs`) in sessions that log no statements,
  and Postgres never logs bind parameters; each new credential is saved as soon as its role has it; scripts run as one
  transaction with a lock timeout and refuse while the services still use the superuser. The API, worker and scheduler
  refuse to start in production (fail closed) when their role — `current_user` or `session_user` — is a superuser or
  `BYPASSRLS`, can change audit events, belongs to the audit table's owner, can create in `public` or holds a
  `pg_*_server_*` role (development warns about superuser or `BYPASSRLS`), and a database on another host needs
  `sslmode=verify-full` (judged as node-postgres parses the URL; migrations too).
- **Database integrity:** foreign keys between runs, steps, events, schedules, schedule runs and probe results, and
  CHECK constraints on every status column (migration 0009, added `NOT VALID` then validated); **approval decisions
  are append-only** in the database (migrations 0010–0011): approvals start pending, a recorded decision never changes
  (`sessionHash` may be rebound only to a session of the person who decided — the run worker acts only through such a
  session too), a decided approval is final, an approval is deleted only together with its run or schedule, and the
  trigger functions run with a fixed `search_path`.
- **Audit chain:** verification walks the chain in batches (memory stays flat) and records the verified tail
  (`seq`, `hash`) in the services' journal as an external checkpoint; `adminforge audit verify` prints the tail to
  compare.
- **Token-cache key rotation:** envelopes carry a key id and a pinned 16-byte GCM tag; `TOKEN_CACHE_PREVIOUS_KEYS`
  keeps blobs sealed before a rotation readable (older `1.` envelopes still open).
- **Backups refuse to run unencrypted** unless `AF_BACKUP_ALLOW_PLAINTEXT=1`, and never contain the database owner's
  credentials (owner files, and owner keys an older env file still has).
- **Postgres container:** image pinned by digest; connection, DDL, lock-wait and slow-statement logging; rotated
  container logs; `no-new-privileges`, memory and process limits (applied when `pnpm db:up` recreates the container).

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

- The inspector no longer gets stuck in a sign-in/refresh loop when Microsoft keeps asking for a fresh sign-in: the
  app follows a 401 to sign-in at most once per tab per minute, then says "Sign-in didn't finish" with "Sign in again";
  capabilities lookups never start a sign-in themselves.
- When a page's data needs a fresh sign-in, one "Sign in again" banner replaces repeated widget errors with dead "Try
  again" buttons, and the `reauth` error says what to do.
- Closing the inspector returns focus to the row (the list no longer re-mounts when the inspector opens), and a
  header whose data failed no longer shows a guessed status such as "Sign-in blocked".
- The sign-in page (and the inspector) loads in seconds: it filters the sign-ins list on the id, bounded to five
  minutes around the sign-in's time, instead of `GET /auditLogs/signIns/{id}`, which took minutes and timed out
  (`identity.sign-in` 1.1.0; the sign-ins, user and enterprise app pages pass the time). Links without the time search
  the last 7 days, and a sign-in that isn't in the log says so.
- Intune apps loads on Graph v1.0: assignment state comes from `assignments` (`isAssigned` is beta-only)
  (`endpoint.apps` 1.0.1).
- Dismiss and confirm-compromised, and the compromised-account runbooks, read only the requested user's risk
  (filtering `riskyUsers` instead of `riskyUsers/{id}`, an unreadable 404). Dismiss says there's nothing to dismiss,
  confirm no longer skips real errors, and the response summary says whether the MFA methods were removed.
- Live sign-in no longer times out when Entra skips the authenticator registration's confirmation page and goes
  straight to "Stay signed in?" (`tests/live/lib/entra-login.ts`).
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
