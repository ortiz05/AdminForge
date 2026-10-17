# Operations runbook

How to run AdminForge on its host day to day: services, health, backups, upgrades, secret rotation and certificates.
Installation is in `portal/deploy/README.md`; the security model is in `SECURITY.md`; error codes are in
`docs/troubleshooting.md`.

## What runs where

| Unit (`systemctl --user …`) | What it does                                                                              | Listens on        |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------- |
| `adminforge-proxy`          | Caddy: TLS for the LAN (`tls internal`)                                                   | `*:8443`          |
| `adminforge-api`            | Web app + API (sessions, delegated calls, content)                                        | `127.0.0.1:3300`  |
| `adminforge-worker`         | Playbook runs (pg-boss queue)                                                             | —                 |
| `adminforge-scheduler`      | Schedules, probes, KQL checks, reports, News and changes feeds (one leader via a PG lock) | —                 |
| `adminforge-runner`         | PowerShell runner (Exchange, Teams, SharePoint)                                           | `127.0.0.1:3101`  |
| Docker `adminforge-dev`     | Postgres 18 (both databases)                                                              | `127.0.0.1:55432` |

Configuration (all mode 600 in `~/.config/adminforge/`, mode 700):

| File               | Read by                           | Holds                                                                     |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------- |
| `<env>.env`        | Everything (`ADMINFORGE_ENV=dev`) | Runtime settings, app client ids/secrets, `TOKEN_CACHE_KEY`, dev DB URL   |
| `<env>.host.env`   | api, worker, scheduler            | Overlay (`ADMINFORGE_ENV_OVERLAY=host`): the services' own `DATABASE_URL` |
| `<env>.admin.env`  | CLI and live tests only           | Provisioner credentials, live-test user                                   |
| `<env>.runner.env` | runner only                       | `RUNNER_SHARED_KEY`                                                       |
| `Caddyfile`        | proxy                             | The LAN address                                                           |

The services use the `adminforge` database; `pnpm dev` uses `adminforge_dev`. Commands that should act on the
services' database take the overlay: `ADMINFORGE_ENV_OVERLAY=host pnpm adminforge publish`.

## Start, stop, status

```sh
U="adminforge-proxy adminforge-api adminforge-worker adminforge-scheduler adminforge-runner"
systemctl --user status $U --no-pager | grep -E "●|Active"
systemctl --user restart $U          # after a build or a config change
systemctl --user stop $U             # scheduler: running jobs get 30 s, then are recorded as interrupted
journalctl --user -u adminforge-api -f            # logs (JSON); filter by a Reference:  | grep <reference>
curl -s --cacert ~/.local/share/caddy/pki/authorities/local/root.crt https://<lan-address>:8443/readyz
```

**After the switch to the service accounts** ("Running as a dedicated service account"), the api, worker, scheduler
and runner are system units: `systemctl --user` no longer reaches them, and it fails silently. Use
`sudo systemctl status|restart|stop adminforge-api …` and `journalctl -u adminforge-api` (no `--user`). The proxy and
the backup stay user units. The services read a copy of the configuration in `/etc/adminforge`, so a plain restart
doesn't pick up changes. Wherever this runbook says to change `~/.config/adminforge` and restart, run instead:

```sh
sudo /opt/adminforge/current/portal/deploy/install-service-account.sh --sync-config --checkout ~/Azure-Admin   # copy the config, restart
```

`/healthz` answers when the process is up; `/readyz` also checks the database. Linger is on, so the services run
without anyone logged in (`loginctl enable-linger "$USER"`).

## Content changes

Content in `portal/content` is served from the database in production. After merging content:

```sh
git fetch && git checkout main && git pull --ff-only
ADMINFORGE_ENV_OVERLAY=host pnpm adminforge publish     # the services pick it up within seconds (NOTIFY)
```

`publish` runs the same checks as `validate` and the playbook tests and refuses on errors. It also refuses content
that isn't reviewed: uncommitted changes under `portal/content`, a checkout that isn't a git repository, or a commit
that isn't on `origin/main` as last fetched (it never fetches). `--dry-run` says what would be refused. For an
emergency fix, `--allow-unreviewed` publishes anyway and records the reasons in the `content.published` audit event —
follow it with the reviewed change. (This is a process check on a local ref; branch protection on the repository is
what makes review mandatory.)

If a change adds `requires.scopes`, run `pnpm adminforge validate --scopes` and `pnpm adminforge provision entra`.
Publishing a new version of a playbook that a write-capable schedule runs switches that schedule off at its next run
until a second person approves it again (by design).

## Report schedules created in the portal

Operators can schedule reports from Reports → a report → **Schedule** (report jobs only, at most hourly, delivered to
the recipient lists and Teams webhooks configured in the env file). Unlike content schedules they live **only in the
database** (`schedules` rows with `source = 'portal'`, keys `portal.<report>-<hex>`): `adminforge publish` never
creates, changes or removes them, and the daily backup (the database dump) is what keeps them — a restore brings them
back with their history.

- **Find them:** Schedules (the "Created in portal" badge and the creator), the report's details in Reports, or the
  database:

  ```sql
  select key, enabled, definition->>'owner' as owner, next_run_at from schedules
  where source = 'portal' and coalesce(definition->>'status', 'active') <> 'retired';
  ```

- **Turn one off:** any `Portal.Operator` uses its switch (audited `schedule.disabled`). Its creator or a
  `Portal.Admin` can edit or delete it (`schedule.updated` / `schedule.deleted`). Deleting keeps the row (retired)
  and its run history and files until retention; housekeeping then removes the row (once no run history is left, and
  at least a day after it was created).
- **Creator check:** before every run the scheduler confirms, as the automation identity, that the creator is still an
  enabled member holding `Portal.Operator` and the report's roles (cached 10 minutes). When someone leaves or loses a
  role, their schedules stop at their next run (`creator_access_removed`) and are turned off — audited as
  `schedule.disabled` by the automation identity, with the reason. If the check can't read Entra, runs fail with
  `creator_unverified` and the schedules stay on: check that the automation identity has **User.Read.All**,
  **GroupMember.Read.All** and **Application.Read.All** (`pnpm adminforge provision status`) and that
  `AF_READ_CLIENT_ID` is set in the scheduler's configuration. With mock sign-in there is nothing to check.
- **Who created what:** the Audit page, actions `schedule.created`, `schedule.updated`, `schedule.deleted`.
- **Emergency stop** applies to them like any schedule: while automation is paused nothing fires; they can still be
  created and turned off.
- New recipient lists and webhooks: add an `AF_…_RECIPIENTS` / `AF_…_WEBHOOK` key to the env file and restart the api
  and scheduler; the schedule form offers configured keys only (email also needs `AF_MAIL_SENDER`). The approval keys
  (`AF_APPROVALS_EMAIL`, `AF_APPROVALS_TEAMS_WEBHOOK`) are never offered.

## News and changes

The hourly schedule `maintenance.news-refresh-hourly` (five past every hour, UTC) collects the feeds in
`portal/content/feeds` (`docs/news.md`). Each feed is collected at most every `pollMinutes`, so most runs touch only
the hourly feeds; the `/news` page's Sources control shows each feed's last success and status.

```sh
# collect now (prints one line per feed with its status and code — never item text)
ADMINFORGE_ENV_OVERLAY=host node portal/apps/scheduler/dist/main.js --schedule maintenance.news-refresh-hourly
```

The host needs outbound https to the feed hosts (www.microsoft.com, api.msrc.microsoft.com,
techcommunity.microsoft.com, www.powershellgallery.com, learn.microsoft.com, developer.microsoft.com) besides Graph and
Azure Resource Manager. The tenant feeds need the automation app's ServiceMessage.Read.All and ServiceHealth.Read.All
(`pnpm adminforge provision entra`) and Reader on the subscriptions. Feed failures and their codes are listed in
`docs/news.md`.

## Synthetic transactions

Synthetic monitoring (`/monitoring`, grouped by service; each service's section links to its own checks with
"Service checks") runs two kinds of M365 checks. **Read-only checks** work as soon as the automation identity has its
permissions: Exchange Autodiscover, the Outlook (MAPI) and Outlook on the web front doors, the SharePoint front door
(`AF_SPO_TENANT_NAME`), the Teams web app, the Microsoft 365 web portal, Entra realm discovery for the primary
domain, an open-incident check per workload (Exchange, SharePoint, OneDrive, Teams, Entra, Intune) and services in
"service interruption", sign-in failure rates per workload (Exchange, SharePoint, Teams; Entra ID P1 sign-in logs),
the Intune service through Graph and the channels of a test team (`AF_SYNTHETIC_TEAM_ID`, no new permission).

A probe's detail (click a tile) says what failed and why without going looking: the latest message (sign-in checks
name the most common error code and reason), **What it found** — the rows behind the result, e.g. which SAML apps'
certificates expire and when, which storage accounts allow public access — **What to do** (the probe's `remedy`) with
a button to the AdminForge page or Microsoft admin centre where it's fixed (`link`), and **What this checks**. The rows
were collected with the automation identity's application permissions, so only Operators see them (others see the
message, the remedy and the link, whose page reads with their own permissions). A dashboard's service checks
(`probeStatus`) open to the same remedy and link to the detail.

**Synthetic transactions** (ADR-015; `sweep.synthetic-transactions`, every 15 minutes) do what a person does and
remove what they made: they act **only** on dedicated test objects named in `AF_SYNTHETIC_*` keys (the mail check also
sends from `AF_MAIL_SENDER`), and do nothing ("not configured", the run succeeds with a note) until those are set. Use
test objects nobody reads, and scope the identity to them. Runs in which they acted are audited as writes
(`schedule.run`); turning the schedule off also stops **Run now**. To keep their permissions off the shared automation
identity, give the sweep a named identity of its own (ADR-014) and grant the scopes below to it:

| Probe                               | Does                                                                                                    | Needs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probes.exchange-mail-flow`         | Sends a message from `AF_MAIL_SENDER` to `AF_SYNTHETIC_MAILBOX`, waits up to 90 s, checks Junk, deletes | A test mailbox (a shared mailbox needs no licence). The sender already has "Application Mail.Send" for report email (go-live checklist). Exchange Online PowerShell: `New-ManagementScope -Name AdminForgeSyntheticMailbox -RecipientRestrictionFilter "PrimarySmtpAddress -eq '<test mailbox>'"`, then `New-ManagementRoleAssignment -App <automation app id> -Role "Application Mail.ReadWrite" -CustomResourceScope AdminForgeSyntheticMailbox`. No Entra permission.                                                                                       |
| `probes.sharepoint-file-round-trip` | Uploads a 16 KB JSON file to the test site's default library, downloads it from SharePoint, deletes it  | A test site; its Graph id in `AF_SYNTHETIC_SITE_ID` (`GET /v1.0/sites/<tenant>.sharepoint.com:/sites/<path>?$select=id`). **Sites.Selected** (granted by `provision entra`, no opt-in: it reaches nothing by itself) plus write on that site only, by a SharePoint admin: `Grant-PnPAzureADAppSitePermission -AppId <automation app id> -DisplayName "AdminForge automation" -Site <site url> -Permissions Write` (or Graph `POST /sites/{id}/permissions` with `roles: ["write"]`) — `write`, never `fullcontrol`, which could manage the site's permissions. |
| `probes.teams-online-meeting`       | Creates a Teams meeting for the test user an hour ahead (no invitation), checks the join link, deletes  | A Teams-licensed test user (`AF_SYNTHETIC_USER_ID`, object id). **OnlineMeetings.ReadWrite.All** — an application write permission, granted only with `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true` — limited to that user by a Teams application access policy: `New-CsApplicationAccessPolicy -Identity AdminForge-Synthetic -AppIds <automation app id>`, `Grant-CsApplicationAccessPolicy -PolicyName AdminForge-Synthetic -Identity <test user object id>` (takes up to 30 minutes).                                                                       |

Check them once before relying on them (writes only to the test objects, and removes them):

```sh
pnpm exec tsx tests/live/scripts/run-schedule-once.ts --no-store \
  --probe probes.exchange-mail-flow --probe probes.sharepoint-file-round-trip --probe probes.teams-online-meeting
```

What the results mean: `not_configured` — the `AF_SYNTHETIC_*` key is unset or isn't a mailbox / Graph site id / object
id; `forbidden` — the message names the role, grant or policy that's missing; `not_delivered` — the message didn't
arrive within the wait (critical); `junk` — it arrived in Junk Email (degraded: check the sender's SPF/DKIM/DMARC and
anti-spam policies); `cleanup_failed` — the check worked but its test item stayed (degraded; the next run removes
leftovers it recognises); `expectation_failed` — SharePoint returned another file or no download address, or Teams no
join link; `writes_paused` — the emergency stop is on (transactions pause with every other change). Probe results are
the record of these runs; they don't add audit events.

## Azure Billing

The **Azure Billing** section (the overview dashboard and Invoices; its reports are in the Reports catalogue under
"Azure Billing": cost analysis, this month and last, monthly trend, chargeback by tag, top resources, budgets) reads
Cost Management for **every subscription under one management group** by default — the tenant root group (its id is
`AF_TENANT_ID`), or the group in `AF_COST_MANAGEMENT_GROUP_ID`. Each view can narrow to one subscription, or switch to
the **billing account** in `AF_BILLING_ACCOUNT_ID` (an EA enrollment number or an MCA billing account id: Cost
Management + Billing → Properties). Cost by tag uses `AF_COST_TAG_NAME` (default `CostCenter`); turn on **tag
inheritance** in Cost Management (Settings → Manage tag inheritance) so resource-group and subscription tags count
for the resources in them.

**Finance users** sign in like everyone else and need `Portal.Reader` (`SG-AdminForge-<label>-Portal.Reader`) plus, in
Azure, **Cost Management Reader** (or Reader) on that management group — or a billing role on the billing account for
the billing-account scope (EA: Enterprise read-only; MCA: Billing account reader). The Invoices page needs **Billing
account reader** or **Invoice manager** on the billing account; Enterprise Agreement invoices stay in the EA views of
Cost Management + Billing. Their Graph-backed pages elsewhere simply report what their account can't read.

**Schedules** run as the automation identity and mail the finance team (`AF_FINANCE_RECIPIENTS`, with
`AF_MAIL_SENDER`): `reports.azure-monthly-cost-weekly` (Mondays 06:45 UTC, cost by subscription),
`billing.month-close` (the 4th at 07:00 UTC, last month by subscription and service — Cost Management settles a month
within 72 hours) and `billing.chargeback-monthly` (the 4th at 07:30 UTC, last month's amortized cost by tag value and
subscription). The automation identity needs **Cost Management Reader on the management group**: provisioning grants
it Reader on `AF_SUBSCRIPTION_ID` only, so assign the role yourself —
`az role assignment create --assignee <automation app id> --role "Cost Management Reader" --scope /providers/Microsoft.Management/managementGroups/<group id>`.
The three schedules **ship turned off**: once the role is assigned and `AF_FINANCE_RECIPIENTS` is set, turn them on
under Automation › Schedules. (Without the role a run fails with `forbidden` and says which role is missing.)

Files and exports carry **every row** Cost Management returned (the page lists the 500 highest) — up to its 5,000-row
answer; beyond that a view says "Partial data" and a narrower scope or grouping is needed. Grouping by resource group
or subscription **name** adds up names that repeat across subscriptions (`rg-network` in each); add _Then by:
Subscription_ in cost analysis to keep them apart.

Cost Management allows only a few queries a minute per scope: every view caches for an hour; a throttled query
is retried after Microsoft's Retry-After and otherwise shows "Microsoft is limiting requests right now". Cost data lags by up to a day (72 hours for some EA usage), the newest day is partial, and amounts
are in the billing currency (a view across billing accounts in different currencies says so). Offers without Cost
Management (some CSP and sponsorship offers) answer with a clear error; see `docs/licensing-review.md` › Azure Billing.

## Sizing for a large tenant

**Design target: about 50 engineers using AdminForge at the same time**, which one API process with the defaults
serves with about 4× headroom: measured on the 100k-user synthetic tenant, lists and entity pages answer in ~0.15 s
(p95 ≤ 0.3 s at 15–30 s between page loads), nothing is refused, the event loop stays under 40 ms at p99 and the
process at 1.1–1.5 GB; 200 engineers at 15 s still see no refusals (lists p95 0.8 s). Plan 2 GB for the API process.
If usage grows: refusals or slow lists → raise `OUTBOUND_CONCURRENCY` (below); a busy event loop → more API processes
behind the proxy; many people opening the crawling dashboards → snapshots ([backlog](backlog.md)). Numbers, method
and what happens far beyond the target: [performance.md](performance.md#many-engineers-at-once).

The API's limits for Microsoft calls and page loads (all in the env file; defaults in brackets):

- **Outbound slots** — `OUTBOUND_CONCURRENCY` [48] per service per process for people and
  `OUTBOUND_USER_CONCURRENCY` [6] per person per service. A slot is taken for each attempt — each page, each retry —
  and released while a throttled call waits on `Retry-After`, so throttling doesn't pin the slots.
  - **Lanes**: list pages, entity reads, `$batch` requests, writes and the first two pages of a `paging: all` are
    served first; the pages after those (a crawl) may hold only `OUTBOUND_CRAWL_SHARE` [0.5] of the slots, so a
    dashboard that crawls a whole collection can't keep the users list waiting.
  - **Schedules** (the automation identity) have their own `OUTBOUND_AUTOMATION_CONCURRENCY` [8] slots per service.
  - **Busy**: only the first attempt of a person's read waits at most `OUTBOUND_QUEUE_WAIT_MS` [15 s] (then 503
    `outbound_busy` — nothing was sent). Writes, retries, later pages and polls of a long-running operation always
    wait, so a change that reached Microsoft is never answered "try again".
  - **Microsoft's limits** are per app and tenant: for directory reads one app in a tenant over 500 users gets 8,000
    resource units per 10 s (a request costs 1–3, `$select` −1, `$expand` +1), Intune 1,000 requests per 20 s, the
    sign-in and audit reports 5 requests per 10 s. 48 slots stay within the directory budget when all are busy; the
    stricter services answer 429 and AdminForge waits their `Retry-After`. All API processes of an installation share
    those budgets (the Read app's), so more processes don't buy more Graph. Raise `OUTBOUND_CONCURRENCY` (160 removed
    every refusal at 1,000–2,000 engineers, see performance.md) only while the `microsoft call` log lines show no
    `throttled` / `throttledRetries`.
- **Timeouts** — `OUTBOUND_TIMEOUT_MS` [30 s] per attempt, one more try after a timeout; the slow reads in
  `OUTBOUND_TIMEOUT_OVERRIDES` [sign-in and audit logs, usage reports, Log Analytics: 120 s] get one longer attempt
  instead. `DATASOURCE_DEADLINE_MS` [120 s] caps one datasource of a person's page load, every page and retry
  included (504 `datasource_timeout`); exports and schedules aren't cut short. A page left while it loads stops its
  calls.
- **Cache** — results are cached per person for each datasource's `cache.ttl`, at most 1,000 entries and
  `DATASOURCE_CACHE_MAX_MB` [256 MB] per API process; identical concurrent loads of one session share one execution;
  publishing a page drops only that page's cached results.
- **Request limits** — per session, not per address: `RATE_LIMIT_PER_MINUTE` [600], background requests apart
  (`RATE_LIMIT_BACKGROUND_PER_MINUTE` [600]), and `RATE_LIMIT_PER_ADDRESS_PER_MINUTE` [20,000] for one address across
  all its sessions (behind a NAT every engineer shares one). Sign-in counts per address
  (`RATE_LIMIT_SIGNIN_PER_ADDRESS_PER_MINUTE` [300]; behind a NAT where hundreds sign in at 9:00, raise it), and so does
  anything without a valid session (`RATE_LIMIT_ANONYMOUS_PER_ADDRESS_PER_MINUTE` [600]). An IPv6 address counts by
  its /64.
- **Transforms** — run on the API's event loop with a 250 ms budget (wall clock: with many people loading heavy pages
  at once, a transform can run out of budget sooner; it is then tried again on the data already fetched for 60 s
  instead of fetching everything again). Sorting (`^( … )`) and a constant slice right after it (`[[0..9]]`) run
  natively: 100k rows in a few hundred ms. Other per-row work over whole collections doesn't scale the same way —
  content for big collections filters and counts at the source (`$filter`, `$count`, KQL `summarize`).

Measured numbers at 100k users for 50–200 engineers (and beyond), and a sizing guide: [performance.md](performance.md)
(`pnpm test:perf` for the datasource budgets, `tests/perf/load.ts` for a load test before a large roll-out).

## Upgrade

```sh
git pull
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @adminforge/api db:migrate                               # dev database
ADMINFORGE_ENV_OVERLAY=host pnpm --filter @adminforge/api db:migrate   # services' database (as adminforge_owner)
pnpm db:harden --dry-run                                               # should report nothing to change
ADMINFORGE_ENV_OVERLAY=host pnpm adminforge publish                     # needs a clean checkout of origin/main
pnpm adminforge validate --scopes     # if permissions changed: pnpm adminforge provision entra
pnpm --filter @adminforge/runner modules:install   # only if portal/apps/runner/modules.lock.json changed
systemctl --user restart adminforge-api adminforge-worker adminforge-scheduler adminforge-runner
# with the service accounts, instead of the restart (new release, config, units, restart; --rollback goes back):
# sudo /opt/adminforge/current/portal/deploy/install-service-account.sh --release --checkout ~/Azure-Admin
```

Migrations only add; they are safe to apply before restarting the old processes. Deploy from a checkout of a reviewed
commit (ideally a tag, in a directory the services can't write to), not from a working copy someone is editing: the
units run `dist/` from their `WorkingDirectory`, so anything built there goes live at the next restart.

Runner workers start with `portal/apps/runner/ps/powershell.config.json` (PowerShell's own script-block and module
logging off). If the journal grew before that, reclaim it with `journalctl --user --vacuum-size=…`. Installed
Caddyfiles made from an older example should add `header -Via` at site level (`header_down -Via` has no effect).

## Postgres hardening

The database holds the audit log, sessions, the sealed token cache, runs, schedules and approvals. It is set up so that
no process that serves requests can rewrite history or take over the cluster:

| Role                                     | What it is for                                                         | Where its credential lives                            |
| ---------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| `adminforge` (the container's superuser) | one-off administration over the container's local socket only          | `<env>.owner.env` (`POSTGRES_PASSWORD`, new clusters) |
| `adminforge_owner` (`AF_PG_OWNER`)       | owns the services' database, runs its migrations; no superuser         | `<env>.host.owner.env` (`DATABASE_MIGRATION_URL`)     |
| `adminforge_app`                         | the services: row access only; audit log insert/select only            | `<env>.host.env` (`DATABASE_URL`)                     |
| `adminforge_dev` (`AF_PG_DEV_USER`)      | owns `adminforge_dev` and `adminforge_test` (`pnpm dev`, the DB tests) | `<env>.env` (`DATABASE_URL`)                          |

- **No superuser in any connection string the services read.** The superuser may sign in only over the container's
  local socket (`docker exec … psql`); `pg_hba.conf` rejects it over TCP (`portal/deploy/db/initdb/`). The API, the
  worker and the scheduler refuse to start in production when the role they connect as (`current_user` or
  `session_user`) is a superuser or `BYPASSRLS`, can update, delete or truncate `audit_events`, is a member of the audit
  table's owner, can create objects in `public`, or holds `pg_read_server_files` / `pg_write_server_files` /
  `pg_execute_server_program` — and when that check can't run at all (fail closed). Development warns about a
  superuser or `BYPASSRLS` role only. The owner's credentials are in the **owner files** (`*.owner.env`, mode 600),
  which only `db:migrate` and the database scripts read — the services' configuration loader never opens them. That
  keeps them out of the services' memory, not out of reach: any code running as the services' Unix account can read
  the files. Only a dedicated service account separates them for real ("Running as a dedicated service account").
- **Passwords never reach the server.** `db:harden` and `create-app-role.sh` compute a SCRAM-SHA-256 verifier on this
  side (`portal/deploy/db/scram.mjs`) and send only that, in sessions that turn statement logging off — the server log
  (which records DDL) never sees a password. If `db:harden` or `create-app-role.sh` ran in an earlier version against a
  container that already logged DDL, run `pnpm db:harden --rotate` and `create-app-role.sh … --rotate`, then recreate
  the container (`pnpm db:down && pnpm db:up`) so the old log goes with it.
- **`adminforge_app`** (`portal/deploy/db/create-app-role.sh`): no DDL; row access on every table; **insert/select
  only on `audit_events`**, so a compromised service can't rewrite the audit log or drop its triggers. The run queue
  (pg-boss) installs and partitions its own tables, so it owns the `pgboss` schema (and nothing in `public`). Tables
  added by later migrations get row access through the owner's default privileges; a migration that adds another
  append-only table must `REVOKE UPDATE, DELETE, TRUNCATE` on it from `adminforge_app` itself. Per-role limits:
  `statement_timeout` 60 s, `idle_in_transaction_session_timeout` 60 s, `lock_timeout` 15 s, and a connection cap of
  3 × (`DATABASE_POOL_MAX` + 4 for the run queue + 3 LISTEN clients) + 1 scheduler lock + 10 for the CLI — 62 with the
  default pool of 10 (`db:harden` sets it from the overlay's `DATABASE_POOL_MAX`; raise `max_connections` with it).
- **Every connection** also carries its own limits and a name (`application_name = adminforge-api|worker|scheduler|
listen-…|scheduler-lock|cli|migrate`): `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_LOCK_TIMEOUT_MS`,
  `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`, pool size `DATABASE_POOL_MAX` — one stuck transaction can't stall every
  audited action (they share the audit chain's lock). Migrations run without a time limit. `idle_session_timeout` is
  never set: the LISTEN clients and the scheduler's session lock idle by design.
- **Databases are closed to `PUBLIC`**; each owner and `adminforge_app` (its database only) keep `CONNECT`.
- **Integrity in the database:** foreign keys (a run's steps and events go with it; a purged parent run, schedule or
  schedule run leaves the link empty; a schedule with history can't be deleted) and CHECK constraints on every status
  column (migration 0009); **approval decisions are append-only** (migrations 0010–0011): a new approval starts
  pending with no decisions; a recorded decision never changes, except that the same person resuming a run may rebind
  its `sessionHash` — only to a session of theirs (the run worker likewise acts only through a session of the person
  the run or decision names); a decided approval is final; and an approval is deleted only together with its run or
  schedule (checked at commit), so a rejection can't be deleted and replaced by a fresh approval. The trigger functions
  run with a fixed `search_path`, so objects in a schema the services own (`pgboss`) can't change their checks. This
  stops history being rewritten; it can't stop a compromised service recording a forged decision — the audit log
  records every decision too.
- **Audit chain anchor:** every verification (the probe, the Audit page, `adminforge audit verify`) walks the chain in
  batches and the services write the verified tail as an `audit chain checkpoint` log line (`seq`, `hash`) to the
  journal. Someone who can rewrite the table can re-hash the chain, but not checkpoints already in the journal: compare
  them with `adminforge audit verify` (it prints the tail), and forward the journal off the host to make the anchor
  independent of this machine.
- **Server:** the container image is pinned by digest; Postgres logs connections, disconnections, DDL, lock waits and
  statements slower than 2 s (`docker logs adminforge-dev-postgres-1`, rotated at 5 × 10 MB); no privilege escalation
  in the container; 2 GB and 256 processes at most. The port is bound to loopback only. A database on another host
  needs `?sslmode=verify-full` in `DATABASE_URL` (production refuses anything else). A change to the compose file's
  `command` or limits applies when `pnpm db:up` recreates the container (data is kept in the volume).

**Set up or repair** (idempotent; `--dry-run` first — it only reads the catalog). Stop the api, worker and scheduler
before applying: each script runs as one transaction and waits at most 10 s for a lock (ownership changes need the
tables the services hold), and the services must reconnect afterwards anyway. It refuses to run while the overlay's
`DATABASE_URL` still uses the superuser (run `create-app-role.sh` first) or names a database other than
`AF_PG_DATABASE`, and saves each new credential as soon as its role has it.

```sh
pnpm db:harden --dry-run
pnpm db:harden                     # owners, ownership moved from the superuser, app role limits, PUBLIC, pg_hba
portal/deploy/db/create-app-role.sh ~/.config/adminforge/dev.host.env   # if adminforge_app doesn't exist yet, then db:harden again
pnpm db:harden --rotate            # new passwords for adminforge_owner and adminforge_dev
pnpm db:harden --rotate-superuser  # new superuser password (it is in older, unencrypted backups)
portal/deploy/db/create-app-role.sh ~/.config/adminforge/dev.host.env --rotate   # new password for adminforge_app
systemctl --user restart adminforge-api adminforge-worker adminforge-scheduler   # service accounts: --sync-config
```

`db:harden` moves `POSTGRES_PASSWORD` from the env file and `DATABASE_MIGRATION_URL` from the overlay into the owner
files, points the env file's `DATABASE_URL` at `adminforge_dev` (the development database; run `db:migrate` once if it
was new), and prints names only, never a value. Tested against a fake `psql` in `tests/unit/deploy/harden-postgres.test.ts`;
the SQL was exercised against throwaway postgres:18 containers in both layouts (an older cluster where the superuser
owned everything, and a new one) before it was committed.

**`TOKEN_CACHE_KEY` rotation:** sealed blobs carry the id of the key that sealed them. For a routine rotation put the
old key in `TOKEN_CACHE_PREVIOUS_KEYS`, a new one (`openssl rand -base64 32`) in `TOKEN_CACHE_KEY`, restart api, worker
and scheduler together: new tokens are sealed with the new key, existing ones still open; after `SESSION_ABSOLUTE_HOURS`
remove the old key. **If the key may have leaked, never keep it** in `TOKEN_CACHE_PREVIOUS_KEYS`: set only the new key
and empty the token cache (`truncate token_cache` in the services' database) — everyone signs in again, which is the
point (nothing else is lost).

## Running as a dedicated service account

The services should not run as a login account in the `docker` group: that is root on the host and superuser on the
Postgres container, which undoes the database roles above. `portal/deploy/install-service-account.sh` (dry run by
default) moves the api, worker and scheduler to the `adminforge` system account and the runner to
`adminforge-runner`, with sandboxed system units. `portal/deploy/README.md` → "Running as a dedicated service account"
has the steps. Root runs it, so read it first and never allow it through a `NOPASSWD` sudoers rule. After the
switch:

| What                            | Where                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Code (read-only, per release)   | `/opt/adminforge/releases/<sha>.<time>`, `/opt/adminforge/current` (newest three kept)                                |
| node and PowerShell             | `/opt/adminforge/runtime/{node,powershell}`                                                                           |
| Configuration the services read | `/etc/adminforge/<env>.env`, `<env>.<overlay>.env` (0640 root:adminforge), copied from `~/.config/adminforge`         |
| The runner's configuration      | `/etc/adminforge/<env>.runner.env` (0600 root, read by systemd; `RUNNER_*` keys only)                                 |
| Report files, the API's home    | `/var/lib/adminforge/{artifacts,home}` (`StateDirectory`, `/etc/tmpfiles.d/adminforge.conf`)                          |
| The runner's home               | `/var/lib/adminforge-runner`                                                                                          |
| Units                           | `/etc/systemd/system/adminforge-{api,worker,scheduler,runner}.service` (+ `.d/10-carried.conf`, your `override.conf`) |
| Loopback firewall (optional)    | `/etc/adminforge/loopback.nft` (`--firewall`; include it from `/etc/nftables.conf` to keep it after a reboot)         |
| Logs                            | `journalctl -u adminforge-api` (system journal, no `--user`)                                                          |

Deploys become: build, migrate and publish as the owner, then `--release` (from `/opt/adminforge/current`; `--rollback`
returns to the previous release). After any change to `~/.config/adminforge` (a rotated secret, a new setting), run
`--sync-config`, or the services keep the old copy. The admin and owner files never leave the owner's account, so the
CLI, provisioning, migrations and backups keep running as the owner. The owner is in the `adminforge` group so the
backup can read the report files. Log out and back in once after `--apply`; until then the backup reports that it
couldn't read them, and fails.

## Backup and restore

`adminforge-backup.timer` runs `portal/deploy/backup/adminforge-backup.sh` daily at 02:30 (and catches up after
downtime). Each backup is a folder in `~/adminforge-backups/<UTC timestamp>/` (mode 700) holding:

- `adminforge.dump` — the services' database (`pg_dump -Fc`), checked to contain the audit table. The rows of
  `sessions`, `preauth` and `token_cache` are left out (their tables are kept), so a copied backup holds no sign-ins
  or refresh tokens and a restore signs everyone out;
- `config.tgz` — the services' configuration in `~/.config/adminforge` (env files incl. client secrets and
  `TOKEN_CACHE_KEY`). **Never included:** `<env>.admin.env` (provisioner and validation-user credentials — re-issue
  them instead of restoring them), the database owner's credentials (`*.owner.env`, and `DATABASE_MIGRATION_URL` /
  `POSTGRES_PASSWORD` lines an older env file still has — after a restore, `pnpm db:harden --rotate`) and stray copies
  (`*.bak*`);
- `data.tgz` — report files and Caddy's data. Caddy's private keys (local CA and site certificate) are included only
  when the backup is encrypted; otherwise a restore issues a new local CA and browsers must trust it again;
- `state.tgz` — with the service accounts, the report files in `/var/lib/adminforge/artifacts`, read through the
  `adminforge` group (`AF_BACKUP_STATE_DIR`). If the owner can't read them, the rest is backed up and the run fails,
  naming the fix. Restore it on a fresh host with `sudo tar -C /var/lib/adminforge -xzf state.tgz`, before the units
  start; tar keeps the files' owner.

**Encryption (required):** set `AF_BACKUP_GPG_RECIPIENT` in a drop-in of the backup unit
(`systemctl --user edit adminforge-backup.service` → `Environment=AF_BACKUP_GPG_RECIPIENT=<fingerprint>`) to a GPG key
whose **private key is not on this host** — e.g. the platform owner's key, imported with `gpg --import owner.pub` and
trusted. Every file is then written as `*.gpg` and the plaintext is shredded; restore with `gpg --decrypt` on a machine
that holds the private key. Without a recipient the backup **refuses to run** unless the drop-in says
`Environment=AF_BACKUP_ALLOW_PLAINTEXT=1` — plaintext backups hold the services' client secrets and `TOKEN_CACHE_KEY`.

Folders older than 14 days are deleted (`AF_BACKUP_KEEP_DAYS`; also `AF_BACKUP_DIR`, `AF_BACKUP_PG_CONTAINER`,
`AF_BACKUP_DATABASE`; the container, user, database and port default to `portal/deploy/defaults.env`). Install it with:

```sh
portal/deploy/install-units.sh --dry-run backup   # shows what would change
portal/deploy/install-units.sh backup             # unit, timer and hardening drop-in; never restarts anything
systemctl --user daemon-reload && systemctl --user enable --now adminforge-backup.timer
systemctl --user start adminforge-backup     # one now; journalctl --user -u adminforge-backup for the result
```

**Off the host:** a backup on the same disk as the database doesn't survive the disk. Copy each encrypted folder to
storage this host can't delete from — e.g. a second unit after the backup (`ExecStartPost=`) running
`restic backup ~/adminforge-backups` or `rclone copy ~/adminforge-backups remote:adminforge-backups` to an
object-lock (immutable) bucket — and keep them access-controlled: they hold the services' client secrets and the
token-cache key. Without `TOKEN_CACHE_KEY` the sealed token cache can't be read (everyone signs
in again; nothing else is lost).

**Restore:** stop the api, worker and scheduler; restore the dump
(`docker exec -i adminforge-dev-postgres-1 pg_restore -U adminforge -d adminforge --clean --no-owner < adminforge.dump`);
put `config.tgz` and `data.tgz` back (and `state.tgz`, then `--sync-config`, with the service accounts); start the
services; run `ADMINFORGE_ENV_OVERLAY=host pnpm adminforge audit verify`.

**Restore drill** — do one after every upgrade that adds a migration, and at least quarterly: restore the newest dump
into a scratch database (`createdb adminforge_restore_drill`, `pg_restore … -d adminforge_restore_drill`), compare row
counts of `audit_events`, `runs`, `schedules`, `definitions` with the live database, run `adminforge audit verify`
against it (point `DATABASE_URL` at the scratch database), then drop it. Record it here.

| Date       | Backup               | Result                                                                                              |
| ---------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| 2026-10-15 | 2026-10-15T08-41-14Z | Restored; counts matched (625 audit events, 93 runs, 16 schedules, 194 definitions); chain verified |

## Emergency: switch AdminForge off

If AdminForge or an account using it may be compromised, stop it from acting before investigating:

0. **Pause from the portal** (fastest, no shell needed): Admin → Settings → Emergency stop → pause **changes** and/or
   **automation**, with a reason. A `Playbook.Approver` or `Portal.Admin` can pause; only a `Portal.Admin` resumes.
   Every write (interactive, scheduled, PowerShell) is refused and no schedule fires; reads and AdminForge's
   notification mail keep working. This doesn't help if the host or the services' configuration is compromised — then
   continue with the steps below.
1. **Disable the enterprise apps** in Entra (Enterprise applications → AdminForge Read / Write / Automation `[<label>]`
   → Properties → _Enabled for users to sign in?_ = No). Sign-ins and token refreshes stop within minutes; Write first
   if time is short.
2. **Stop unattended work:** `sudo systemctl stop adminforge-scheduler adminforge-worker` (with the service
   accounts — `systemctl --user stop` does nothing to system units; on user units it is
   `systemctl --user stop adminforge-scheduler adminforge-worker`). Check with `systemctl status` that they stopped.
3. **Revoke sessions:** `sudo systemctl stop adminforge-api adminforge-runner` (user units: `systemctl --user stop …`),
   then (if needed)
   `docker exec adminforge-dev-postgres-1 psql -U adminforge -d adminforge -c 'truncate sessions, token_cache'`.
4. **Rotate secrets** (table below), starting with the automation and Write app secrets and the provisioner. With the
   service accounts, run `--sync-config` after editing `~/.config/adminforge`, or the services start again on the old
   secrets.
5. **Investigate** with the audit log (`adminforge audit verify`, then the Audit page or `audit_events` by
   `correlation_id`/actor) and the Entra sign-in and audit logs. Re-enable in reverse order.

## Disaster recovery (new host)

1. Install the prerequisites (README), clone the repository at the deployed commit, `pnpm install --frozen-lockfile`,
   `pnpm build`.
2. Restore `config.tgz` to `~/.config/adminforge` and `data.tgz` to `~/.local/share`; start Postgres (`pnpm db:up`)
   and restore the dump as above; then run `pnpm db:harden`, `portal/deploy/db/create-app-role.sh` and
   `pnpm db:harden` again (the roles live in the Postgres cluster, not in the dump). Re-issue the provisioner credential (`<env>.admin.env` is never backed up).
3. Install the units (portal/deploy/README.md), or the service accounts (`install-service-account.sh --apply`, then
   `state.tgz` into `/var/lib/adminforge`), and start them. If the host name or address changed, update the
   Caddyfile, `PUBLIC_BASE_URL` overrides and `AF_REDIRECT_BASE_URLS`, then `pnpm adminforge provision entra`.
4. Check: `/readyz` is `ok`, `adminforge audit verify` passes, the live suite passes (`tests/live/README.md`).

## Go-live checklist

- [ ] Provisioner secret rotated (it was shared during setup) and stored only in `<env>.admin.env`.
- [ ] People added to the `SG-AdminForge-<label>-*` groups (`docs/access.md`); the validation test user removed or
      disabled outside test tenants.
- [ ] TLS: a DNS name and a certificate from your CA (or Caddy's root trusted on every client); address reserved.
- [ ] Branch protection on `main` with code-owner review by a **second person** (`.github/CODEOWNERS` lists more than
      one owner for content and security-sensitive paths); CI green; the services run a reviewed commit.
- [ ] `WRITE_AUTH_CONTEXT` set if you have Entra ID P1 (Conditional Access step-up). Without it, arming proves only a
      fresh sign-in, not MFA (Admin → Settings shows "Fresh sign-in only"; `adminforge env check` warns).
- [ ] `AF_PROTECTED_USER_IDS` lists your break-glass / emergency-access accounts (object ids), so nothing in AdminForge
      can change them; the automation identity holds Application.Read.All so the protected set can be read.
- [ ] Alerts go somewhere: `AF_SCHEDULE_ALERTS` and/or `AF_TEAMS_ALERTS_WEBHOOK` set, and the probe sweep schedules
      notify on failure — otherwise a failing scheduler, backup or audit-chain check is only visible on the
      Monitoring page.
- [ ] Delivery configured if wanted: `AF_MAIL_SENDER`, Teams webhooks, `AF_APPROVALS_*`. Let the automation identity
      send **only as that mailbox**: leave Entra `Mail.Send` withheld (it can send as any mailbox, and Exchange
      permissions add to it rather than narrowing it) and assign Exchange RBAC for Applications instead —
      `New-ServicePrincipal -AppId <automation app id> -ObjectId <its service principal id>`,
      `New-ManagementScope -Name AdminForgeSender -RecipientRestrictionFilter "PrimarySmtpAddress -eq '<sender>'"`,
      `New-ManagementRoleAssignment -App <automation app id> -Role "Application Mail.Send" -CustomResourceScope
AdminForgeSender`. (Granting Entra `Mail.Send` needs `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`.) A tenant that
      has never been customised refuses `New-ManagementScope` ("you first need to run …
      Enable-OrganizationCustomization"): run `Enable-OrganizationCustomization` once, then retry the scope —
      it can keep refusing for hours after `Get-OrganizationConfig` already reports `IsDehydrated: False`. New
      role assignments take up to an hour or two to apply. Check it (prefix `ADMINFORGE_ENV_OVERLAY=host` for the
      services' configuration; only the sender itself is mailed): `pnpm exec tsx tests/live/scripts/check-mail-sender.ts --not-as "<another mailbox>"` — the
      sender's own message `sent`, sending as the other mailbox `refused`.
- [ ] Backups: timer enabled, encrypted to an off-host key (`AF_BACKUP_GPG_RECIPIENT`), copied off the host, restore
      drill recorded above.
- [ ] Services connect as `adminforge_app` (`portal/deploy/db/create-app-role.sh`), not the database owner, and
      `pnpm db:harden --dry-run` reports nothing to change (non-superuser owners, limits, no superuser over TCP).
- [ ] The services' journal is forwarded off the host (it holds the audit chain's checkpoints).
- [ ] `AF_PROTECTED_APP_IDS` lists the provisioner's client id (AdminForge's own playbooks then refuse to touch it).
- [ ] Monitoring page green (portal readiness, audit chain, token probes); licence gaps reviewed
      (`docs/licensing-review.md`).
- [ ] Run under an account dedicated to AdminForge — no other network-facing services under it, and not in the
      `docker`, `sudo`, `lxd` or `adm` groups (docker group membership is root on the host):
      `sudo portal/deploy/install-service-account.sh --apply --firewall` (see "Running as a dedicated service
      account").

## Secret and key rotation

| Secret                                   | How                                                                                                                                                                                                                                                                                                                                                                          | Effect                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Provisioner client secret                | Create a new secret on the provisioner app in Entra, put it in `<env>.admin.env`, delete the old one in Entra. **Do this now if it was ever shared** (for example in a chat).                                                                                                                                                                                                | None on the services                                |
| Read / Write / Automation client secrets | Valid 180 days. `provision entra` creates a new one only when the stored one is missing or expired: to rotate early, empty the key (`AF_READ_CLIENT_SECRET=`), run `pnpm adminforge provision entra`, restart api/worker/scheduler (service accounts: sync config), then delete the old credential in Entra. The `probes.app-credential-expiry` probe warns ahead of expiry. | Brief restart                                       |
| `TOKEN_CACHE_KEY`                        | Old key into `TOKEN_CACHE_PREVIOUS_KEYS`, a new one (`openssl rand -base64 32`) into `TOKEN_CACHE_KEY` in `<env>.env`, restart api/worker/scheduler (service accounts: sync config); drop the old key after `SESSION_ABSOLUTE_HOURS` (→ Postgres hardening)                                                                                                                  | None (without the old key: everyone signs in again) |
| Caddy local CA (if trusted by clients)   | Delete `~/.local/share/caddy/pki/authorities/local`, restart `adminforge-proxy`, distribute the new `root.crt`, **remove the old root from every client**                                                                                                                                                                                                                    | Browsers warn until the new root is trusted         |
| `RUNNER_SHARED_KEY`                      | New value in both `<env>.env` and `<env>.runner.env`, restart runner, api and worker together (service accounts: sync config)                                                                                                                                                                                                                                                | Runner calls fail until all three restarted         |
| Database passwords                       | `pnpm db:harden --rotate` (owners), `--rotate-superuser` (container superuser), `portal/deploy/db/create-app-role.sh … --rotate` (services); restart api/worker/scheduler (service accounts: sync config)                                                                                                                                                                    | Brief restart                                       |
| Live-test user password / TOTP seed      | `pnpm adminforge provision test-identities` (password); re-run `tests/live/scripts/register-test-user-mfa.ts` (TOTP)                                                                                                                                                                                                                                                         | Test tenants only                                   |

### The provisioner

The provisioner is the most powerful credential AdminForge uses, and it lives on this host in `<env>.admin.env`
(never read by the services, never backed up). Keep its power short-lived:

- Give it **Global Administrator only while provisioning**. For Azure role assignments use **Role Based Access
  Control Administrator** on the subscription, conditioned to assign only Reader and Log Analytics Reader — not Owner.
- Per run: create a client secret valid for one day, put it in `<env>.admin.env`, run `provision entra` /
  `test-identities` / `status`, then delete the secret in Entra and remove the directory role.
- `provision test-identities --enable/--disable` (and so `pnpm test:live`) changes a privileged user, which needs
  Global Administrator or Privileged Authentication Administrator at that moment.
- `AF_PROTECTED_APP_IDS` (runtime env) should list its client id, so AdminForge's own playbooks refuse to touch it.
- The opt-in licensed test fixtures (`AF_TEST_LICENCE_SKU`, `AF_TEST_FIXTURES`) need Microsoft Graph **application
  permissions** on it — its directory role doesn't cover those APIs app-only (`LicenseAssignment.ReadWrite.All`,
  `RoleEligibilitySchedule.ReadWrite.Directory`, `Policy.Read.All` + `Policy.ReadWrite.ConditionalAccess` (+
  `Application.Read.All` for the audit Conditional Access policies), `DeviceManagementConfiguration.ReadWrite.All`
  (+ `DeviceManagementApps.ReadWrite.All` for `intune-more`), `User.Invite.All` for `guest` (optional: a refused invitation creates the guest directly), and
  `UserAuthenticationMethod.ReadWrite.All` for `auth-methods` where the directory role doesn't cover it; table in
  `tests/live/README.md`), and the Teams test objects need
  `Team.Create`. **Application permissions survive removing the directory role**, and PIM eligibility, Conditional
  Access and Intune configuration are tier-0: grant only the ones the run needs, and remove them when it's done.
  `provision status` shows a ⚠ listing any of them the provisioner's token still holds (it decodes the token; names
  only). To remove them:
  - Entra admin centre → **Enterprise applications** → the provisioner → **Permissions**: the granted application
    permissions are listed there (also under App registrations → API permissions → "Other permissions granted").
    Revoke each one (… → Revoke admin consent), then confirm with `provision status`.
  - Or with Microsoft Graph PowerShell, as an administrator:

    ```powershell
    Connect-MgGraph -Scopes 'AppRoleAssignment.ReadWrite.All','Application.Read.All'
    $sp = Get-MgServicePrincipal -Filter "appId eq '<provisioner client id>'"
    $graph = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
    $drop = 'LicenseAssignment.ReadWrite.All','RoleEligibilitySchedule.ReadWrite.Directory','Policy.Read.All',
            'Policy.ReadWrite.ConditionalAccess','DeviceManagementConfiguration.ReadWrite.All','Application.Read.All',
            'DeviceManagementApps.ReadWrite.All','User.Invite.All','UserAuthenticationMethod.ReadWrite.All','Team.Create'
    Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id |
      Where-Object { $_.ResourceId -eq $graph.Id -and
        ($graph.AppRoles | Where-Object Id -eq $_.AppRoleId).Value -in $drop } |
      ForEach-Object { Remove-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -AppRoleAssignmentId $_.Id }
    ```

    Grant them again (admin consent) before the next fixtures run; until then those fixtures show `✗` with the
    permission each one needs.

### The automation identity on a certificate

```sh
cat cert.pem key.pem > ~/.config/adminforge/automation.pem && chmod 600 ~/.config/adminforge/automation.pem
# set AF_AUTOMATION_CERT_PATH in <env>.env, then:
pnpm adminforge provision entra --dry-run   # shows: register certificate, remove client secrets
pnpm adminforge provision entra && systemctl --user restart adminforge-api adminforge-worker adminforge-scheduler
# service accounts: instead of the restart, --sync-config (copies the certificate to /etc/adminforge too)
pnpm adminforge provision status
```

### Named app identities (ADR-014)

A schedule can run as an app identity of its own instead of the shared automation identity — e.g. a team's reports
that need `AuditLog.Read.All` without granting it to every schedule:

```sh
# <env>.env: AF_SCHEDULE_IDENTITIES=reports-team   (lower-case letters, digits, dashes; comma-separated)
pnpm adminforge provision entra --dry-run   # + AdminForge Identity reports-team [<label>], its secret, its roles
pnpm adminforge provision entra             # writes AF_IDENTITY_REPORTS_TEAM_CLIENT_ID / _CLIENT_SECRET
pnpm adminforge provision status            # checks its token and that it holds exactly its roles
systemctl --user restart adminforge-api adminforge-worker adminforge-scheduler   # service accounts: --sync-config
```

Its permissions are what the schedules naming it (`identity: { app: reports-team }`) declare in `requires.scopes`,
under the automation identity's ceilings **and its own opt-ins**: a write, sensitive-read or tier-0 permission needs
`AF_IDENTITY_<NAME>_ALLOW_WRITE_PERMISSIONS` / `_ALLOW_SENSITIVE_READS` / `_ALLOW_PRIVILEGED_PERMISSIONS=true` in
addition to the matching `AF_AUTOMATION_ALLOW_*` key (the dry run names the missing ones). A certificate works as for
the automation identity: set `AF_IDENTITY_<NAME>_CERT_PATH` and provisioning registers it and removes the secrets.
`validate --scopes` compares each identity separately; `--prune` removes roles it no longer needs. Names are lower-case
letters and digits with single dashes; the app's alternate key is `adminforge-identity-<name>--<label>`.

Removing a name from `AF_SCHEDULE_IDENTITIES` makes its schedules fail with `identity_not_configured`; the app
registration and its permissions stay, so `provision status` fails ("no longer in AF_SCHEDULE_IDENTITIES") until you
delete it in the Entra admin centre (AdminForge keeps refusing writes to it meanwhile). The report schedule form and
the schedule editor offer the configured names under **Run as** — to **every** Operator, so list only identities
whose read access any Operator may use for a report.

### Schedules that run with their creator's access

"Run as: Me" in the report schedule form (portal report schedules, read-only) needs no setup beyond Entra sign-in.
Schedules → the schedule shows **Needs sign-in** when Microsoft asked for a new sign-in (password reset, sign-in
policy, a long break): runs are skipped and the owner was notified; only the creator can press **Sign in again**. When
the creator leaves (loses `Portal.Operator` or a role the report needs), the next run removes the stored sign-in and
turns the schedule off (`creator_access_removed`); someone else must create their own schedule. A Portal Admin saving
someone's "Me" schedule ends its sign-in too (the creator signs in for the changed schedule). Its files open only for
the creator and Portal Admins. The sign-in needs the `auth_time` claim on the Read app: run `pnpm adminforge
provision entra` once after upgrading (until then the sign-in is refused with `signin_not_fresh`). Both databases need
migration 0012 (`schedule_grants`, `runs.identity_name`) before the API and scheduler start.

### Permission opt-ins

`AF_ALLOW_PRIVILEGED_WRITE_SCOPES` (tier-0 delegated scopes on the Write app), `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS`
(application permissions that change data), `AF_AUTOMATION_ALLOW_SENSITIVE_READS` (mail, files, sites, chats, …),
`AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS` (tier-0 application permissions for any app-only identity) and each
named identity's `AF_IDENTITY_<NAME>_ALLOW_*` keys are deliberate decisions: set them in `<env>.admin.env`, review `provision entra --dry-run`, and record the decision in your change record (not in this repository: it's installation state). `provision status` fails on privilege that provisioning didn't grant.

Removing permissions: `provision entra` drops delegated scopes nothing needs any more, but leaves application
permissions it no longer grants (after content is retired, a baseline permission is dropped, or a ceiling is turned
back off) — `provision status` lists them under unexpected privilege. Remove them with
`pnpm adminforge provision entra --dry-run --prune` (review the `- remove` lines), then `pnpm adminforge provision entra --prune`.
It removes only roles on the resources provisioning knows, including ones a ceiling withholds that someone granted by
hand; anything else (another resource) is left for you to remove in the Entra admin centre.

## Certificates (LAN access)

Caddy issues short-lived server certificates from its own root (`~/.local/share/caddy/pki/authorities/local/root.crt`,
valid 10 years) and renews them itself. Its private key sits on this host and the root isn't name-constrained, so
whoever obtains it could issue a certificate for any site to every browser that trusts it. Prefer a certificate for a
DNS name from your own CA; if you trust Caddy's root, trust it only on admins' machines and treat its key like a
secret (rotate: delete `~/.local/share/caddy/pki/authorities/local`, restart the proxy, and remove the old root from
every client). Clients trust the root once:

- Windows: `certutil -addstore -user Root root.crt`
- macOS: Keychain Access → System → import → Always Trust
- Linux (Chrome/Edge): `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n AdminForge -i root.crt`
- Firefox: Settings → Certificates → Import, trust for websites

If the host's address changes, update `~/.config/adminforge/Caddyfile`, `PUBLIC_BASE_URL` in the api/worker/scheduler
overrides and `AF_REDIRECT_BASE_URLS`, run `pnpm adminforge provision entra`, and restart. Prefer a reserved address
or a DNS name with a certificate from your own CA.

## Giving people access

See `docs/access.md`. In short: add the person to `SG-AdminForge-<label>-Portal.Reader` (and `-Portal.Operator` to
make changes). Changes apply within 5 minutes, also for removals.

## Live validation

`tests/live/README.md`: the Playwright live suite signs in as the validation user and exercises reads, arming and
reversible writes on `AF-Test-*` objects only. The validation user is **disabled between runs**: `pnpm test:live`
enables it in its global setup and disables it (revoking sessions) afterwards; for the scripts in `tests/live/scripts`
wrap them in `pnpm adminforge provision test-identities --enable` / `--disable`. Live runs of the Exchange and
SharePoint write playbooks need `AF_TEST_SERVICE_ADMIN_ROLES=true` in `<env>.admin.env` before
`provision test-identities` (tenant-wide Exchange Recipient Administrator and SharePoint Administrator for the
validation user; default off, removed again when the key is off). Provisioning manages only the `af-…` account it
created and refuses any other account at `AF_TEST_USER_UPN`.

```sh
PUBLIC_BASE_URL=https://<lan-address>:8443 AF_LIVE_INSECURE_TLS=1 \
NODE_EXTRA_CA_CERTS=~/.local/share/caddy/pki/authorities/local/root.crt pnpm test:live
```
