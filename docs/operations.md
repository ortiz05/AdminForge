# Operations runbook

How to run AdminForge on Kubernetes day to day: the pod, health, the database, backups, upgrades, secret rotation and
certificates. Installation is in `portal/deploy/kubernetes/README.md`; the security model is in `SECURITY.md`; error
codes are in `docs/troubleshooting.md`. Commands use the example overlay's namespace, `adminforge`.

## What runs where

One Deployment, one pod, one replica (ADR-017). The Ingress (TLS, `PUBLIC_BASE_URL`) sends requests to the Service
`adminforge` (port 80), which sends them to the pod:

| Container | What it does                                                                                                                                                                                                                               | Listens on                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `api`     | Web app + API (sessions, delegated calls, content), the run worker (playbook runs from the `run_jobs` queue) and the scheduler (schedules, probes, KQL checks, reports, News and changes feeds; one leader via a lease) — one Node process | `:3300` (the Service's port 80) |
| `runner`  | PowerShell runner (Exchange, Teams, SharePoint), a sidecar                                                                                                                                                                                 | `127.0.0.1:3101` (pod loopback) |

The volume `adminforge-data` (ReadWriteOncePod, block storage) is mounted at `/var/lib/adminforge`: the database file
`adminforge.db` and the report files (`artifacts/`). Never scale the Deployment past one replica (see Database).

Configuration:

| Where                                                                   | Read by                                                                        | Holds                                                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret `adminforge-env`                                                 | api (every key); runner (`RUNNER_SHARED_KEY` only)                             | The installation's settings, made from `<env>.env`: tenant, app client ids and secrets, `TOKEN_CACHE_KEY`, `AUDIT_CHAIN_KEY`, `RUNNER_SHARED_KEY`, `PUBLIC_BASE_URL` |
| ConfigMap `adminforge-config`                                           | api                                                                            | The pod's layout (`NODE_ENV`, `DATABASE_PATH`, ports, `CONTENT_SOURCE`, `RUNNER_URL`; `TRUST_PROXY` from the overlay). It wins over the Secret                       |
| Secret `adminforge-automation-cert`                                     | api, at `/etc/adminforge/automation`                                           | Optional: the automation identity's certificate                                                                                                                      |
| Secret `adminforge-tls`                                                 | the ingress controller                                                         | The Ingress certificate                                                                                                                                              |
| `~/.config/adminforge/<env>.env` (operator's machine, mode 600, in 700) | `kubectl create secret`, the CLI                                               | The source of `adminforge-env`                                                                                                                                       |
| `~/.config/adminforge/<env>.admin.env`                                  | `provision …`, `validate --scopes` and the live tests only — never the cluster | Provisioner credentials, live-test user                                                                                                                              |

The production database exists only on the volume, so commands that act on it run in the pod:
`kubectl -n adminforge exec deploy/adminforge -c api -- adminforge <command>`. Provisioning, `validate` and the live
tests run on the operator's machine with the env files. A developer's `pnpm dev` uses a database file of its own
(`~/.local/share/adminforge/dev.db`).

### Changing the configuration

Edit `<env>.env` and check it with `pnpm adminforge env check --for portal,schedules` (key names and states only; it
also names keys of the Postgres releases to remove). Keep the file private (`chmod 600`): the API and the CLI's other
commands refuse an env file with any group or world permission and name the fix (`env check` doesn't look at the mode).
Then replace the Secret and restart: the pod reads the Secret only when it starts.

```sh
kubectl -n adminforge create secret generic adminforge-env --from-env-file="$HOME/.config/adminforge/prod.env" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n adminforge rollout restart deploy/adminforge
```

Wherever this runbook says "update the Secret", it means these two commands.

## Start, stop, status

```sh
kubectl -n adminforge get pods -l app.kubernetes.io/name=adminforge   # READY 2/2, Running
kubectl -n adminforge rollout restart deploy/adminforge              # after a configuration change
kubectl -n adminforge scale deploy/adminforge --replicas=0           # stop everything (--replicas=1 starts it again)
kubectl -n adminforge logs deploy/adminforge -c api -f               # logs (JSON); filter by a Reference: | grep <reference>
curl -s https://adminforge.example.com/readyz
```

A stop lets every run finish the step it is on and stop at its next checkpoint: steps get 10 s, then a step still in
flight is interrupted. The runs stay `running` and their jobs are queued again; after the restart they continue where
they stopped — an interrupted step is retried, or, if it is `idempotent: false`, the run ends `needs_review` (check the
target before running it again). Such a step's request is sent at most once at any time: never again after a server
error, a network failure or a timeout (only after a 429), and a sign-in challenge after Microsoft accepted a change
fails the step `accepted_unconfirmed` — the change may have happened, so check the target too. As after any pause, a
resumed run reads and checks again what it read and checked before its next write: if a check no longer holds, the write
isn't sent and the run ends `failed` — or `needs_review` when that write was in flight at the stop and may have gone
out. Running schedule jobs get 30 s (then they are recorded as interrupted). The API gives the whole stop
`SHUTDOWN_TIMEOUT_SECONDS` (50 s), then logs what is still open and exits 1; the pod has 60 s in all.

`/healthz` answers when the process is up (the startup and liveness probes; three failures in a row restart the
container). `/readyz` also reads the database and the heartbeats of the run worker and the scheduler: `ok`; `degraded`
(still 200: the scheduler made no progress for two minutes — its ticks fail or it lost its lease — or the run worker
stopped polling its queue; the API itself still serves); or 503 `not_ready` (the database can't be read — the pod
leaves the Service until it can).

If the pod was down over an hour, each schedule records one skipped run (`schedule_missed`, the time it was due)
instead of running late. Run it now from its page if you still need the result.

## Content changes

Content in `portal/content` ships in the app image and is served from the database (`CONTENT_SOURCE=db`). A merged
change goes live in two steps: an image built from it (Upgrade), then a publish in the pod:

```sh
kubectl -n adminforge exec deploy/adminforge -c api -- adminforge publish --dry-run   # what would be published or retired
kubectl -n adminforge exec deploy/adminforge -c api -- adminforge publish             # the API picks it up within a second
```

`publish` runs the same checks as `validate` and the playbook tests and refuses on errors. It writes new versions in one
transaction and tells the running API (the `definitions_changed` signal); no restart. It also refuses content that isn't
reviewed. The pod has no git checkout: the image's `/app/BUILD.json` records whether `build-images.sh` found
`portal/content` committed and its commit on origin's `main` as it fetched it while building
(`git fetch origin refs/heads/main`; the build stops when it can't), with that `main` commit (`mainCommit`) and origin's
URL without credentials (`remote`). `--dry-run` says what would be refused, and lists published rows stamped with an
older content schema version and whether they still pass. For an emergency fix, `--allow-unreviewed` publishes anyway
and records the reasons in the `content.published` audit event — follow it with the reviewed change. The event also
records what was published and what it was checked against: `git.commit`, `git.mainCommit` and `git.remote`.
(`BUILD.json` is written by whoever builds the image, so this is a process check; branch protection on the repository is
what makes review mandatory.)

If a change adds `requires.scopes`, run `pnpm adminforge validate --scopes` and `pnpm adminforge provision entra`.
Publishing a new version of a playbook that a write-capable schedule runs switches that schedule off at its next run
until a second person approves it again (by design).

## Report schedules created in the portal

Operators can schedule reports from Reports → a report → **Schedule** (report jobs only, at most hourly, delivered to
the recipient lists and Teams webhooks configured in the env file). Unlike content schedules they live **only in the
database** (`schedules` rows with `source = 'portal'`, keys `portal.<report>-<hex>`): `adminforge publish` never
creates, changes or removes them, and backups of the database (Backups) are what keep them — a restore brings them
back with their history.

- **Find them:** Schedules (the "Created in portal" badge and the creator), the report's details in Reports, or a copy
  of the database (`adminforge db backup`, opened with `sqlite3` on your machine):

  ```sql
  select key, enabled, json_extract(definition, '$.owner') as owner,
         datetime(next_run_at / 1000, 'unixepoch') as next_run_at
  from schedules
  where source = 'portal' and coalesce(json_extract(definition, '$.status'), 'active') <> 'retired';
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
  `AF_READ_CLIENT_ID` is set in the `adminforge-env` Secret. With mock sign-in there is nothing to check.
- **Who created what:** the Audit page, actions `schedule.created`, `schedule.updated`, `schedule.deleted`.
- **Emergency stop** applies to them like any schedule: while automation is paused nothing fires; they can still be
  created and turned off.
- New recipient lists and webhooks: add an `AF_…_RECIPIENTS` / `AF_…_WEBHOOK` key to the env file and update the
  Secret (What runs where → Changing the configuration); the schedule form offers configured keys only (email also
  needs `AF_MAIL_SENDER`). The approval keys (`AF_APPROVALS_EMAIL`, `AF_APPROVALS_TEAMS_WEBHOOK`) are never offered.

## News and changes

The hourly schedule `maintenance.news-refresh-hourly` (five past every hour, UTC) collects the feeds in
`portal/content/feeds` (`docs/news.md`). Each feed is collected at most every `pollMinutes`, so most runs touch only
the hourly feeds; the `/news` page's Sources control shows each feed's last success and status.

```sh
# collect now (prints one line per feed with its status and code — never item text)
kubectl -n adminforge exec deploy/adminforge -c api -- \
  node portal/apps/scheduler/dist/main.js --schedule maintenance.news-refresh-hourly
```

The pod needs outbound https to the feed hosts (www.microsoft.com, api.msrc.microsoft.com, techcommunity.microsoft.com,
www.powershellgallery.com, learn.microsoft.com, developer.microsoft.com) besides Graph and Azure Resource Manager: the
NetworkPolicy allows port 443 to public addresses, and an egress firewall in front of the cluster must allow them too.
The tenant feeds need the automation app's ServiceMessage.Read.All and ServiceHealth.Read.All
(`pnpm adminforge provision entra`) and Reader on the subscriptions. Feed failures and their codes are listed in
`docs/news.md`.

## Synthetic transactions

Synthetic monitoring (`/monitoring`, grouped by service; each navigation section's row shows its own checks' status
and links to them) runs two kinds of M365 checks. **Read-only checks** work as soon as the automation identity has its
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

**Synthetic transactions** (ADR-015; `sweep.synthetic-transactions`, every 15 minutes) do what a person does and remove
what they made: they act **only** on dedicated test objects named in `AF_SYNTHETIC_*` keys (the mail check also sends
from `AF_MAIL_SENDER`), and do nothing ("not configured", the run succeeds with a note) until those are set. Use test
objects nobody reads, and scope the identity to them. Runs in which they acted are audited as writes (`schedule.run`);
a one-shot audits each one that acted (`probe.run`). Turning the schedule off also stops **Run now** and a
`--schedule` one-shot (`schedule_disabled`); `--probe` and `--once` still run them, to check them before the schedule
is turned on. While automation is paused no one-shot runs them. Run now on any other disabled schedule runs it
but only writes the file — no email, Teams post or notification — to try a schedule before enabling it; `--schedule`
one-shots deliver as configured. To keep their permissions off the shared automation identity, give the sweep a named
identity of its own (ADR-014) and grant the scopes below to it:

| Probe                               | Does                                                                                                    | Needs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probes.exchange-mail-flow`         | Sends a message from `AF_MAIL_SENDER` to `AF_SYNTHETIC_MAILBOX`, waits up to 90 s, checks Junk, deletes | A test mailbox (a shared mailbox needs no licence). The sender already has "Application Mail.Send" for report email (go-live checklist). Exchange Online PowerShell: `New-ManagementScope -Name AdminForgeSyntheticMailbox -RecipientRestrictionFilter "PrimarySmtpAddress -eq '<test mailbox>'"`, then `New-ManagementRoleAssignment -App <automation app id> -Role "Application Mail.ReadWrite" -CustomResourceScope AdminForgeSyntheticMailbox`. No Entra permission.                                                                                       |
| `probes.sharepoint-file-round-trip` | Uploads a 16 KB JSON file to the test site's default library, downloads it from SharePoint, deletes it  | A test site; its Graph id in `AF_SYNTHETIC_SITE_ID` (`GET /v1.0/sites/<tenant>.sharepoint.com:/sites/<path>?$select=id`). **Sites.Selected** (granted by `provision entra`, no opt-in: it reaches nothing by itself) plus write on that site only, by a SharePoint admin: `Grant-PnPAzureADAppSitePermission -AppId <automation app id> -DisplayName "AdminForge automation" -Site <site url> -Permissions Write` (or Graph `POST /sites/{id}/permissions` with `roles: ["write"]`) — `write`, never `fullcontrol`, which could manage the site's permissions. |
| `probes.teams-online-meeting`       | Creates a Teams meeting for the test user an hour ahead (no invitation), checks the join link, deletes  | A Teams-licensed test user (`AF_SYNTHETIC_USER_ID`, object id). **OnlineMeetings.ReadWrite.All** — an application write permission, granted only with `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true` — limited to that user by a Teams application access policy: `New-CsApplicationAccessPolicy -Identity AdminForge-Synthetic -AppIds <automation app id>`, `Grant-CsApplicationAccessPolicy -PolicyName AdminForge-Synthetic -Identity <test user object id>` (takes up to 30 minutes).                                                                       |

Check them once before relying on them (writes only to the test objects, and removes them). The script uses the dev
database, which records the results and the audit events: without one (`--no-store`) a one-shot can't read the
emergency stop or keep an audit record, so the transactions make no change.

```sh
pnpm exec tsx tests/live/scripts/run-schedule-once.ts \
  --probe probes.exchange-mail-flow --probe probes.sharepoint-file-round-trip --probe probes.teams-online-meeting
```

What the results mean: `not_configured` — the `AF_SYNTHETIC_*` key is unset or isn't a mailbox / Graph site id / object
id; `forbidden` — the message names the role, grant or policy that's missing; `not_delivered` — the message didn't
arrive within the wait (critical); `junk` — it arrived in Junk Email (degraded: check the sender's SPF/DKIM/DMARC and
anti-spam policies); `cleanup_failed` — the check worked but its test item stayed (degraded; the next run removes
leftovers it recognises); `expectation_failed` — SharePoint returned another file or no download address, or Teams no
join link; `writes_paused` — the emergency stop is on (transactions pause with every other change); `automation_paused`
— a one-shot didn't run it because automation is paused; `database_required` — a one-shot without the database
(`--no-store`) refused its writes. Probe results are the record of each check; the audit log has an event per run
that acted (`schedule.run`, or `probe.run` for a one-shot).

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

## Azure Arc servers

Hybrid servers are managed under **Azure**: **Arc fleet** (dashboard: connection and time offline, operating systems,
agent versions, regions, subscriptions and resource groups, failed extensions, patching, Defender coverage, ESU),
**Arc servers**, **Arc extensions**, **Arc patching** (Azure Update Manager) and **Arc Defender coverage** (Defender
for Servers, from Defender for Cloud). Each server opens in the inspector with Updates and Defender tabs. The reports
_Disconnected Arc servers_ (`reports.arc-disconnected-daily`, 06:20 UTC) and _Arc agent and extension health_
(weekly) run as schedules; five configuration checks (disconnected or expired servers, failed extensions, critical or
security updates overdue for 30 days, servers not assessed for 3 days, agents six or more releases behind) appear
under Synthetic monitoring › Azure (the Azure row's status in the navigation) with what each found, what to do and a
link to the list.

Everything is filtered, counted and paged in **Azure Resource Graph**: the lists load a page at a time and export up
to 100,000 rows, the numbers come from `summarize` queries, so thousands of servers cost the same as ten. The fleet
dashboard sends ten queries (cached 5–10 minutes), within Resource Graph's per-person quota. Resource Graph allows one
join to another table per query, so **Arc patching** has two lists: servers Update Manager assessed in the last 3 days
(patch state from the assessment and installation records, which carry the server's name, subscription and resource
group) and servers it didn't (with their connection state and assessment mode); the export holds the first. A **failed
extension** means the same everywhere — provisioning failed or the extension reports an error — on the fleet
dashboard, the server list, the extensions view, the check and the agent health report. **Defender coverage** reads
Defender for Servers per subscription: a plan set on a single server (per-resource Defender for Servers) isn't read,
so such a server shows its subscription's plan.

**Access.** Engineers need **Reader** on the subscriptions (or a management group) that hold the Arc servers. The
checks and schedules run as the automation identity, which provisioning makes Reader on `AF_SUBSCRIPTION_ID` only: for
servers in other subscriptions assign it Reader at the management group —
`az role assignment create --assignee <automation app id> --role Reader --scope /providers/Microsoft.Management/managementGroups/<group id>`.

**Prerequisites in Azure.** Patching data exists only for servers with **periodic assessment** on (Azure Policy
"Configure periodic checking for missing system updates on Azure Arc-enabled servers", one assignment per OS type, with
a remediation task) and in subscriptions registered for `Microsoft.Compute`. Update Manager is billed per Arc server
and connected day unless the server has ESUs enabled by Arc, Defender for Servers Plan 2 covers its subscription, or
Windows Server Software Assurance / pay-as-you-go by Arc applies. Defender coverage counts a server as protected when
Defender for Servers is on for its subscription and the `MDE.Windows` / `MDE.Linux` extension installed. Details and
sources: `docs/licensing-review.md` › Hybrid Azure Arc servers at scale.

Function Apps and Azure Arc-enabled Kubernetes are retired (not needed at this time): their pages, report, schedule,
runbook, trigger-sync playbook, example connection and probe stay in the history but are hidden.

## Azure Virtual Desktop

The **Azure Virtual Desktop** section covers every host pool across subscriptions: **Overview** (session hosts that
can't take connections or need assistance, drain mode, sessions, the busiest pools and the AVD checks), **Host pools**
(capacity: hosts taking new sessions, sessions against the slots they offer, autoscale, Start VM on Connect), **Session
hosts** (health, drain mode, agent and OS versions, Azure VM or Arc-enabled server on Azure Local), **User sessions**
(who is signed in to a pool or host, found by UPN) and **Connections** (from Log Analytics: success rate, failures over
time, the most common errors, the people they hit, round-trip time, one person's recent connections). Each host pool
and session host opens in the inspector; a session host is read **live** from Azure Resource Manager, with its health
checks and their messages. The reports — _AVD session host health_, _AVD host pool capacity_, _AVD session hosts in
drain mode_ and _AVD connection errors_ — are in the Reports catalogue under "Azure Virtual Desktop" and can be
scheduled there.

**Actions** (write mode, `Portal.Operator`): **drain mode** on or off for one host or many at once
(`avd.set-drain-mode`; to undo it, run it again with the other setting), **send a message** to one session or every
session on a host (`avd.send-user-message`; disconnected sessions are skipped and say so) and **sign a user out**
(`avd.log-off-user-session`, high risk: unsaved work in the session is lost; type the person's sign-in name, or for many
sessions how many, to confirm). Session numbers are reused on a host, so a message or a sign-out goes only to the person
the list showed: if someone else holds the session by then, that item stops and changes nothing. A table selects at most
500 rows for one bulk run (the API accepts up to 1,000 items per run). They run with the engineer's delegated Azure
access — **Desktop Virtualization Session Host Operator** for drain mode and **Desktop Virtualization User Session
Operator** for messages and sign-outs, on the host pool (or Desktop Virtualization Contributor).

**Scale.** Session hosts are counted and paged in **Azure Resource Graph** (`desktopvirtualizationresources`), so
thousands of hosts cost a few queries; lists load a page at a time and export up to 100,000 rows. Resource Graph can
trail a status change by a few minutes — the session host page reads Azure Resource Manager directly. User sessions
come from Resource Manager per host pool (up to 10,000; narrow to a host or a UPN beyond that).

**Checks** (Synthetic monitoring, group "Azure Virtual Desktop", as the automation identity): session hosts that
can't take connections and host pools with no capacity or nearly full every 15 minutes, session hosts that need
assistance and connection failures every hour. Each result lists the hosts or pools it found, what to do and a link.
The automation identity needs **Reader** on the subscriptions that hold the host pools (provisioning grants it on
`AF_SUBSCRIPTION_ID` only; assign it at the management group for the rest, as for Arc servers).

**Diagnostics.** Connections, the connection errors report and probe, and a host pool's Connection errors tab read
the host pools' diagnostic settings in Log Analytics: send the **Connections**, **Errors** and **Network data**
categories (WVDConnections, WVDErrors, WVDConnectionNetworkData) to one workspace and set
`AF_AVD_LOG_ANALYTICS_WORKSPACE_ID` to its customer id (empty = `AF_LOG_ANALYTICS_WORKSPACE_ID`). People need **Log
Analytics Reader** (or Reader) on it. Until then those views say no workspace is configured; a workspace without the
tables answers "Failed to resolve table" in the probe's result.

## Sizing for a large tenant

**Design target: about 50 engineers using AdminForge at the same time**, which one API process with the defaults serves
with about 4× headroom: measured on the 100k-user synthetic tenant, lists and entity pages answer in ~0.15 s (p95 ≤ 0.3
s at 15–30 s between page loads), nothing is refused, the event loop stays under 40 ms at p99 and the process at 1.1–1.5
GB; 200 engineers at 15 s still see no refusals (lists p95 0.8 s). The api container's memory limit is 2 GiB, the
runner's 3 GiB (up to six PowerShell workers at about 0.35 GB each; `portal/deploy/kubernetes/base/deployment.yaml`). At
most 5 runs per person are queued or running at once (`RUN_MAX_OPEN_PER_USER`), and the run worker works on 8 at a time
(`RUN_WORKER_CONCURRENCY`). If usage grows: refusals or slow lists → raise `OUTBOUND_CONCURRENCY` (below); a busy event
loop is the limit of this design — one API process, one replica (ADR-016); many people opening the crawling dashboards →
snapshots ([backlog](backlog.md)). Numbers, method and what happens far beyond the target:
[performance.md](performance.md#many-engineers-at-once).

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
    stricter services answer 429 and AdminForge waits their `Retry-After`. The budgets are the Read app's, for the
    whole installation. Raise `OUTBOUND_CONCURRENCY` (160 removed every refusal at 1,000–2,000 engineers, see
    performance.md) only while the `microsoft call` log lines show no `throttled` / `throttledRetries`.
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

The steps are in `portal/deploy/kubernetes/README.md` → Upgrade: build and push both images from a reviewed commit,
take a snapshot or a backup when the release changes the schema (`portal/apps/api/drizzle`), put the new tags or
digests in your overlay and `kubectl apply -k` it, then publish the new image's content (Content changes). Then check:

```sh
kubectl -n adminforge rollout status deploy/adminforge
curl -s https://adminforge.example.com/readyz                                    # "status":"ok"
kubectl -n adminforge logs deploy/adminforge -c api --since=5m | grep -i error   # nothing new
pnpm adminforge validate --scopes     # on your machine; if permissions changed: pnpm adminforge provision entra
```

Build from a checkout of a reviewed commit on `origin/main` (ideally a tag), not from a working copy someone is
editing: `build-images.sh` records in the image whether its content was reviewed, and publishing from any other image
needs `--allow-unreviewed`. `Recreate` stops the old pod before the new one starts (Start, stop, status: running
playbooks continue after the restart), and the new pod migrates the database before it listens (Database): a short
outage. The web app is in the image, so a tab opened on the previous build may fail to load a screen it hasn't opened
yet (its file is gone) until it is reloaded. The runner's PowerShell modules are installed into its image from
`portal/apps/runner/modules.lock.json`; a change there needs only the new image. The base images are pinned by digest;
moving one is a reviewed commit, then an ordinary upgrade.

**The runner image, monthly** (after Microsoft's Patch Tuesday, the second Tuesday), with or without a release: an
image keeps the Ubuntu packages of the day it was built, so rebuild it from the commit that is running and deploy it —
the tag stays the commit's, so pin the new digest. Check github.com/PowerShell/PowerShell/releases at the same time: its
PowerShell, with the .NET runtime inside, moves only by a reviewed bump of the version and hash in its Dockerfile
(`portal/apps/runner/README.md` → Container image); bump it sooner after a PowerShell or .NET security advisory.

A release that bumps the content schema version (`CONTENT_SCHEMA_VERSION`; its pull request says so): after the
upgrade run `publish --dry-run`, which lists the published rows stamped with an older version and whether they still
pass, then publish again. A row that no longer passes is refused when the API loads it (`definition_unavailable`) until
the release's content is published.

Once, after upgrading past the fix that stores a run's app identity (`identity_name`, 2026-10-21): cancel and run
again any queued or parked run of a schedule that names an app identity (ADR-014) — runs created before the fix keep
the automation identity.

To go back, put the previous tags or digests in the overlay and apply it. If the release changed the schema, also
restore the snapshot or backup taken before it (Backups); what changed since then is lost.

## Database

All of AdminForge's state is one SQLite file (ADR-016): `DATABASE_PATH`, in the pod
`/var/lib/adminforge/adminforge.db` on the `adminforge-data` volume. It holds the audit log, sessions and sign-in
round trips, the sealed token cache, settings and preferences, definitions, runs and approvals, schedules and their
history, probe results, News and changes, the run queue, leases and signals. Next to it SQLite keeps
`adminforge.db-wal` and `adminforge.db-shm` (write-ahead logging): they are part of the database. Never copy the main
file alone out of a running pod (use `adminforge db backup`), and never put a file in place next to another file's
`-wal` and `-shm` (Backups → Restore). Data moves in once: from the interim host as its stopped database file, from a
Postgres release with `adminforge db import-postgres` (`portal/deploy/kubernetes/README.md` → Moving the data in).

The api container is the only process that keeps the file open. The CLI (`publish`, `audit verify`, `db backup`) and
the scheduler one-shots open it beside the API, in the same container. Nothing else may: SQLite allows one writer at
a time and its locking needs a local file system, so the volume is ReadWriteOncePod and the Deployment has one
replica with `strategy: Recreate`.

**File checks.** SQLite has no roles: whoever can read the file reads every hashed session id and sealed token, and
whoever can write it can rewrite history (SECURITY.md → Known gaps). The API creates the folder 0700 and the file 0600
before SQLite opens it, tightens an existing file to 0600 when it owns it, and checks the file when it starts.
Production refuses to start; development only warns. The message is
`The database in DATABASE_PATH is not safe to use: <path> <problem>; … (docs/operations.md → Database).`

| Problem                                                                   | What it means                                                                                                                     | What to do                                                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `is not an absolute path`                                                 | `DATABASE_PATH` is relative (production configuration refuses it too).                                                            | Set an absolute path. In the pod the ConfigMap sets it; the Secret can't override it.              |
| `does not exist`                                                          | The file's folder is missing.                                                                                                     | Check that the volume is mounted where `DATABASE_PATH` points (`kubectl describe pod`).            |
| `is writable by other users (they could replace the database)`            | Anyone could swap the file in that folder.                                                                                        | `chmod o-w` the folder (loader pod).                                                               |
| `is on a network filesystem (<type>); SQLite needs local block storage …` | The volume is NFS, SMB/Azure Files, FUSE (blobfuse), Ceph or similar: SQLite's locking is unreliable there and corrupts the file. | Use a block-storage class (AKS `managed-csi`, Azure Disk) and move the data onto it (loader pod).  |
| `can be read or written by other users (chmod 600)`                       | The file, its `-wal` or its `-shm` has permissions for other users (group permissions from the pod's `fsGroup` are allowed).      | `chmod 600` the files (loader pod).                                                                |
| `is owned by another user`                                                | The file belongs to another uid than the API's (10001 in the pod), for example restored by another tool.                          | Replace it through the loader pod: it runs as the API's user, so a file it copies in is the API's. |

The loader pod is `portal/deploy/kubernetes/tools/loader-pod.yaml`: it mounts the volume while the Deployment is
scaled to 0.

**Busy timeout.** One writer at a time: a write transaction takes the write lock up front (`BEGIN IMMEDIATE`) and is
short. A writer in another process waits up to `DATABASE_BUSY_TIMEOUT_MS` (default 15 000) for the lock, then fails
with `SQLITE_BUSY`; the CLI says "The database is busy (another process is writing). Try again in a moment." Run it
again. The API waits the same way, and serves nothing else while it waits (its statements are synchronous), so keep
writes from the CLI short.

**Migrations at start.** The API applies pending migrations (`portal/apps/api/drizzle`) before it listens; the
startup probe allows five minutes for that. No older version has the file open (`Recreate`). `adminforge publish`
brings the schema up to date too. Take a snapshot or a backup before a release that changes the schema (Upgrade).
`pnpm --filter @adminforge/api db:migrate` migrates the file in `DATABASE_PATH` by hand (a developer's file).

**Queue, leases and signals** replace pg-boss, advisory locks and LISTEN/NOTIFY, as tables in the same file:

- `run_jobs` is the run queue: at most one queued and one active job per run. A claimed job holds a 90 s lease,
  renewed every 30 s, so the job of a process that died runs again once its lease lapses. A failing job is retried
  after 5 s, doubling up to 5 minutes, at most 50 times.
- `leases` are named locks with an expiry: the scheduler's leader lease (`adminforge.scheduler`, 30 s, renewed every
  5 s) and per-run locks. A holder that dies stops renewing, and the lease is free once it expires.
- `signals` carry notifications between processes (the CLI's `publish` → the API's definition cache; one-shots →
  browsers): delivered in the same process at once, polled by the others every 500 ms, kept for an hour.

**Retention.** Every 6 hours the API deletes history older than its retention: finished runs with their steps, events
and decided approvals (`RETENTION_RUN_DAYS`, 180), schedule run history (`RETENTION_SCHEDULE_RUN_DAYS`, 180), probe
results (`RETENTION_PROBE_DAYS`, 35), report files (`RETENTION_ARTIFACT_DAYS`, 90), deleted portal schedules without
history, and News and changes items past their feed's retention. Parked runs and runs that need review are kept, the
audit log is never purged, and the purge itself is audited (counts only). Each pass deletes 2,000 rows (or files) at a
time with requests let in between and stops after 2 s; the rest continues at the next 10-minute housekeeping pass
(report files from where it stopped, never following a symbolic link). Freed space goes back to the volume in steps.
Every 10 minutes housekeeping also deletes the tokens of sessions nobody can use any more (the session rows a week
later), expired sign-in round trips and signals older than an hour.

**`TOKEN_CACHE_KEY` rotation:** sealed blobs carry the id of the key that sealed them. For a routine rotation put the
old key in `TOKEN_CACHE_PREVIOUS_KEYS` and a new one (`openssl rand -base64 32`) in `TOKEN_CACHE_KEY`, and update the
Secret: new tokens are sealed with the new key, existing ones still open. After `SESSION_ABSOLUTE_HOURS` remove the old
key and update the Secret again. **If the key may have leaked, never keep it** in `TOKEN_CACHE_PREVIOUS_KEYS`: set only
the new key. Blobs sealed with the old key can't be opened and are ignored, so everyone signs in again (which is the
point), schedules that run with their creator's access lose their stored sign-in, and housekeeping deletes the old
sessions' tokens once those sessions end. Nothing else is lost.

## Backups

What a restore needs, and how each part is kept:

| What                                                                                                                 | Where it lives                                     | How it is kept                                                    |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| The database: audit log, runs, approvals, schedules (the portal-created ones exist only here), settings, definitions | `adminforge.db` on the volume                      | Volume snapshots, and logical copies (`adminforge db backup`)     |
| Report files                                                                                                         | `/var/lib/adminforge/artifacts` on the volume      | Volume snapshots only: a logical copy holds the database alone    |
| `TOKEN_CACHE_KEY`, `AUDIT_CHAIN_KEY` (and earlier audit keys), the apps' credentials, `RUNNER_SHARED_KEY`            | the `adminforge-env` Secret, made from `<env>.env` | Keep `<env>.env` in your secret store, apart from database copies |
| The automation identity's certificate                                                                                | the `adminforge-automation-cert` Secret            | With the env file                                                 |
| Never: `<env>.admin.env`                                                                                             | the operator's machine                             | Re-issue the provisioner and validation-user credentials instead  |

The commands are in `portal/deploy/kubernetes/README.md` → Backups.

- **Volume snapshots** are the primary backup: schedule CSI VolumeSnapshots of `adminforge-data` at least daily (AKS:
  Azure Disk snapshots, for example with Velero or Azure Backup for AKS). A snapshot is crash-consistent, and SQLite's
  write-ahead log recovers from exactly that.
- **Logical copies:** `adminforge db backup -` in the pod writes a consistent copy (SQLite's online backup; the API
  keeps working) to stdout. It leaves out the rows of sessions, sign-in round trips and the token cache — including
  schedules' grant tokens — and of leases and signals, compacts the file so nothing deleted survives in it, and checks
  it (integrity, the audit chain) before it writes it. It is **not encrypted**: pipe it into `gpg --encrypt` on your
  machine, to a key whose private half is not in the cluster (for example the platform owner's). It reports the
  audit chain's tail on stderr (`tail seq …`): note it with the copy. Taking these copies is manual for now
  (`docs/backlog.md`). Each copy is recorded in the audit log before it leaves (`database.backup`: account and machine
  — in the pod the image's user and the pod's name, so note who ran it; `kubectl exec` itself is in the cluster's
  audit log —, stdout or file, plaintext, bytes, the copy's tail seq); if the event can't be written nothing is written
  out, so the account running it needs write access to the database. With `AUDIT_CHAIN_KEY` set, a copy verifies only
  with that key (never in the copy): keep it, and earlier ones, as long as the copies.
- **Off the cluster:** snapshots stay in the cluster's cloud account. Keep the encrypted copies elsewhere too, on
  storage the cluster can't delete from (an object-lock bucket, for example), and access-controlled. Without
  `TOKEN_CACHE_KEY` the sealed tokens in a snapshot can't be read (everyone signs in again; nothing else is lost).

**Restore** (AdminForge scaled to 0 first: `kubectl -n adminforge scale deploy/adminforge --replicas=0`):

- **From a snapshot:** replace `adminforge-data` with a volume made from the snapshot (your backup tool's restore, or
  a PersistentVolumeClaim of that name with the snapshot as its `dataSource`), then scale back to 1. SQLite replays the
  snapshot's own `-wal` at start; report files come back with it.
- **From a logical copy:** decrypt it on your machine, then put it on the volume with the loader pod (the steps are in
  `tools/loader-pod.yaml`). Before copying it in, delete the old file's `-wal` and `-shm` if they are there — they
  belong to the file you replace, and SQLite would apply them to the copy:

  ```sh
  kubectl -n adminforge exec adminforge-loader -- \
    rm -f /var/lib/adminforge/adminforge.db-wal /var/lib/adminforge/adminforge.db-shm
  ```

  Afterwards everyone signs in again, and creators sign in again for schedules that run with their access. On a new
  volume the report files are missing (downloads say "This report file is no longer available"; **Run now** makes new
  ones).

- **Then** check `/readyz`, and run `kubectl -n adminforge exec deploy/adminforge -c api -- adminforge audit verify`:
  for a logical copy its tail is the one the backup reported, and it must agree with the checkpoints in your log store
  (Audit chain checkpoints). A copy from before `AUDIT_CHAIN_KEY` was set needs `AUDIT_CHAIN_KEYED_SINCE` removed (the
  API won't start otherwise); it cuts over again at start — pin the new cut-over's seq afterwards.

**Restore drill** — after every release that changes the schema, and at least quarterly. Decrypt the newest logical
copy on your machine into a scratch file (`drill.db`, mode 600) and verify it, read-only:
`DATABASE_PATH="$PWD/drill.db" pnpm adminforge audit verify` (a keyed copy needs `AUDIT_CHAIN_KEY` and any earlier keys,
from the env file the Secret is made from). Its tail must be the one the backup reported and agree
with the checkpoints in your log store; compare the row counts of `audit_events`, `runs`, `schedules` and `definitions`
(`sqlite3 drill.db 'select count(*) from runs'`) with what you expect, then delete the file. Now and then restore a
snapshot into a scratch volume too, to prove that your storage's restore works. Record it here.

| Date       | Backup                                    | Result                                                                                              |
| ---------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 2026-10-15 | 2026-10-15T08-41-14Z (Postgres host dump) | Restored; counts matched (625 audit events, 93 runs, 16 schedules, 194 definitions); chain verified |

## Logs

Both containers log to stdout: `kubectl -n adminforge logs deploy/adminforge -c api` (`-c runner`; `-f` to follow,
`--since=1h`, `--previous` for the container before a restart). API lines are JSON with the Reference as `reqId`;
refused requests are logged at `info` as "request rejected", failures at `error` with the stack. The scheduler
one-shots (`kubectl exec … node portal/apps/scheduler/dist/main.js …`) print to your terminal, not to the container
log.

Kubernetes keeps only the current and the previous container's log, and the node rotates them. Shipping the api
container's log off the cluster (Container Insights / Log Analytics, or your log store) is **required**: you need it to
trace a Reference after a restart, and it carries the audit chain's checkpoints and cut-overs, the anchor that shows a
rewritten audit log (Audit chain checkpoints).

## Audit chain checkpoints

The audit log is append-only (triggers in the database) and hash-chained. The triggers stop the application
rewriting history; they don't stop someone who can write the volume, because SQLite has no roles (ADR-016,
SECURITY.md → Known gaps). What detects that is the chain and its checkpoints: every verification logs the verified
tail as an `audit chain checkpoint` line (`seq`, `hash`). The hourly `probes.audit-chain` re-checks the last verified
checkpoint and the events after it, and walks the whole chain after a restart, once a day and after any break; the
Audit page and `adminforge audit verify` always walk all of it. Without a key, someone who can rewrite the file can
re-hash the chain, but not the checkpoints already shipped off the cluster.

```sh
kubectl -n adminforge exec deploy/adminforge -c api -- adminforge audit verify        # prints the tail: seq, hash
kubectl -n adminforge logs deploy/adminforge -c api | grep 'audit chain checkpoint'   # recent ones; older: your log store
```

The tail must be the newest shipped checkpoint or come after it. A lower `seq`, or the same `seq` with another hash,
means the chain was rewritten: snapshot the volume as evidence, restore from a backup and investigate who had write
access to the volume.

**The key.** Set `AUDIT_CHAIN_KEY` (`openssl rand -base64 32`, a key of its own — not `TOKEN_CACHE_KEY`) in `<env>.env`,
update the Secret and restart: the API appends a cut-over event and logs an `audit chain cut-over` line (`seq`, `hash`,
`prevHash`, `keyId`); from there on the chain is HMAC-SHA256, so changing an event needs the key, which is never on the
volume. Then set `AUDIT_CHAIN_KEYED_SINCE=<that seq>` and restart, which pins the keyed part. Every start logs
`audit chain keyed` (`since`, `keyId`, `pinned`, `tailSeq`, `tailHash`): the tail must never be lower than the last
shipped checkpoint, and a new cut-over without a key change means keyed events were removed. Check any shipped line
with `kubectl -n adminforge exec deploy/adminforge -c api -- adminforge audit verify --checkpoint <seq>:<hash>`. Once
set, the key can be rotated (Secret and key rotation) but not removed: without it the API doesn't start and the CLI's
writing commands refuse. Until it is set, `/readyz` (`checks.auditChain: unkeyed`), Admin → Settings and
`adminforge env check` say the chain is unkeyed.

## Emergency: switch AdminForge off

If AdminForge or an account using it may be compromised, stop it from acting before investigating:

0. **Pause from the portal** (fastest, no shell needed): Admin → Settings → Emergency stop → pause **changes** and/or
   **automation**, with a reason. A `Playbook.Approver` or `Portal.Admin` can pause; only a `Portal.Admin` resumes.
   Every write (interactive, scheduled, PowerShell) is refused and no schedule fires; reads and AdminForge's
   notification mail keep working. This doesn't help if the cluster, the volume or the `adminforge-env` Secret is
   compromised — then continue with the steps below.
1. **Disable the enterprise apps** in Entra (Enterprise applications → AdminForge Read / Write / Automation `[<label>]`
   → Properties → _Enabled for users to sign in?_ = No). Sign-ins and token refreshes stop within minutes; Write first
   if time is short.
2. **End every session:** `kubectl -n adminforge exec deploy/adminforge -c api -- adminforge db sign-out-everyone --yes`
   deletes every session, pending sign-in and session token (audited); open pages show "signed out" at their next
   request. Add `--schedule-grants` to void the stored access of schedules that run as their creator too. If the
   `adminforge-env` Secret or the volume may be compromised, also rotate `TOKEN_CACHE_KEY` without keeping the old key
   (Database → `TOKEN_CACHE_KEY` rotation), so no sealed token opens any more.
3. **Stop AdminForge:** `kubectl -n adminforge scale deploy/adminforge --replicas=0`. The API, the run worker, the
   scheduler and the runner are one pod, so runs and schedules stop together. Check with `kubectl -n adminforge get
pods` that the pod is gone.
4. **Rotate secrets** (table below), starting with the automation and Write app secrets and the provisioner. Update
   the Secret before scaling back up, or the pod starts on the old secrets.
5. **Investigate** with the audit log and the Entra sign-in and audit logs. Snapshot the volume first, as evidence.
   While AdminForge is stopped, the loader pod (`portal/deploy/kubernetes/tools/loader-pod.yaml`) can take a copy of
   the database off the volume (with its `-wal`, if there is one) for `sqlite3` (`audit_events` by `correlation_id` or
   actor); once it runs again, use the Audit page and `adminforge audit verify` (Audit chain checkpoints). Re-enable
   in reverse order (`--replicas=1` once the rotated Secret is in place).

## Disaster recovery (new cluster)

1. Prepare a cluster that meets the requirements (`portal/deploy/kubernetes/README.md` → Requirements), with the
   namespace and the Secrets made from the env file and certificate you kept (README → Secrets): `adminforge-env`,
   `adminforge-automation-cert`, `adminforge-tls`. Re-issue the provisioner credential if the operator's machine was
   lost (`<env>.admin.env` is never backed up).
2. Restore the data: create `adminforge-data` from the newest snapshot before you apply the overlay; or apply it,
   scale to 0 and replace the empty database the API created with the newest logical copy (Backups → Restore).
3. Apply your overlay with the images of the deployed commit (the digests it pins) and wait for
   `kubectl -n adminforge rollout status deploy/adminforge`. If the URL changed: the Ingress host and certificate,
   `PUBLIC_BASE_URL` (and `AF_REDIRECT_BASE_URLS`) in the env file, `pnpm adminforge provision entra`, then update the
   Secret.
4. Check: `/readyz` is `ok`, `adminforge audit verify` passes and its tail agrees with your shipped checkpoints, the
   live suite passes (`tests/live/README.md`).

## Go-live checklist

- [ ] Provisioner secret rotated (it was shared during setup) and stored only in `<env>.admin.env`.
- [ ] People added to the `SG-AdminForge-<label>-*` groups (`docs/access.md`); the validation test user removed or
      disabled outside test tenants.
- [ ] TLS: the Ingress has a DNS name and a certificate browsers trust (`adminforge-tls`); `PUBLIC_BASE_URL` is that
      URL and a redirect URI of the Read and Write apps (`pnpm adminforge provision entra`).
- [ ] Branch protection on `main` with code-owner review by a **second person** (`.github/CODEOWNERS` lists more than
      one owner for content and security-sensitive paths); CI green; the images are built from a reviewed commit
      (`build-images.sh` says `content reviewed: true`) and pinned by digest in the overlay.
- [ ] `WRITE_AUTH_CONTEXT` set if you have Entra ID P1 (Conditional Access step-up). Without it, arming proves only a
      fresh sign-in, not MFA (Admin → Settings shows "Fresh sign-in only"; `adminforge env check` warns).
- [ ] `AF_PROTECTED_USER_IDS` lists your break-glass / emergency-access accounts (object ids), so nothing in AdminForge
      can change them; the automation identity holds Application.Read.All so the protected set can be read.
- [ ] Alerts go somewhere: `AF_SCHEDULE_ALERTS` and/or `AF_TEAMS_ALERTS_WEBHOOK` set, and the probe sweep schedules
      notify on failure — otherwise a failing scheduler or audit-chain check is only visible on the Monitoring page.
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
      role assignments take up to an hour or two to apply. Check it from your machine with the env file the Secret is
      made from (only the sender itself is mailed):
      `pnpm exec tsx tests/live/scripts/check-mail-sender.ts --not-as "<another mailbox>"` — the sender's own message
      `sent`, sending as the other mailbox `refused`.
- [ ] Backups: volume snapshots scheduled; logical copies encrypted to an off-cluster key and stored off the cluster;
      restore drill recorded above.
- [ ] The database volume is block storage (never Azure Files, NFS or FUSE) and its snapshots restore.
- [ ] The api container's log is shipped off the cluster (required: its checkpoints and cut-overs are the audit
      chain's anchor).
- [ ] `AUDIT_CHAIN_KEY` set (Admin → Settings: "Keyed since event #N"), then `AUDIT_CHAIN_KEYED_SINCE` set to that
      event (Audit chain checkpoints → The key).
- [ ] `AF_PROTECTED_APP_IDS` lists the provisioner's client id (AdminForge's own playbooks then refuse to touch it).
- [ ] Monitoring page green (portal readiness, audit chain, token probes); licence gaps reviewed
      (`docs/licensing-review.md`).
- [ ] The cluster side: `preflight.sh` passes and the readiness checklist in `portal/deploy/kubernetes/README.md` is
      done; `TRUST_PROXY` is the ingress controller's pod network (never `true`); the NetworkPolicy admits only the
      ingress controller, and the cluster enforces NetworkPolicies; the private addresses the pod needs (the Ingress
      for the portal-readiness probe, Private Link endpoints) are named in `networkpolicy-private-egress.yaml`; the
      namespace enforces the `restricted` Pod Security Standard; only the people who operate AdminForge can read the
      `adminforge-env` Secret or exec into the pod (RBAC), and Secrets are encrypted at rest.

## Secret and key rotation

| Secret                                   | How                                                                                                                                                                                                                                                                                                                                                                          | Effect                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Provisioner client secret                | Create a new secret on the provisioner app in Entra, put it in `<env>.admin.env`, delete the old one in Entra. **Do this now if it was ever shared** (for example in a chat).                                                                                                                                                                                                | None on the cluster (it never reaches it)                    |
| Read / Write / Automation client secrets | Valid 180 days. `provision entra` creates a new one only when the stored one is missing or expired: to rotate early, empty the key (`AF_READ_CLIENT_SECRET=`), run `pnpm adminforge provision entra`, update the Secret, then delete the old credential in Entra. The `probes.app-credential-expiry` probe warns ahead of expiry.                                            | Brief restart                                                |
| `TOKEN_CACHE_KEY`                        | Old key into `TOKEN_CACHE_PREVIOUS_KEYS`, a new one (`openssl rand -base64 32`) into `TOKEN_CACHE_KEY` in `<env>.env`, update the Secret; drop the old key after `SESSION_ABSOLUTE_HOURS` (→ Database)                                                                                                                                                                       | None (without the old key: everyone signs in again)          |
| `AUDIT_CHAIN_KEY`                        | Old key into `AUDIT_CHAIN_PREVIOUS_KEYS`, a new one into `AUDIT_CHAIN_KEY` in `<env>.env`, update the Secret (the API cuts over at start). Keep old keys as long as their events and backups must verify; never keep one that may have leaked. Lost: a new key plus the lost key's id in `AUDIT_CHAIN_LOST_KEY_IDS` — only an id a shipped `audit chain cut-over` line names | Brief restart; a lost key's events can no longer be verified |
| Ingress certificate (`adminforge-tls`)   | cert-manager renews it; a certificate you made yourself is replaced before it expires (→ Certificates)                                                                                                                                                                                                                                                                       | None                                                         |
| `RUNNER_SHARED_KEY`                      | A new value (`openssl rand -base64 32`) in `<env>.env`, update the Secret: both containers start with it                                                                                                                                                                                                                                                                     | Brief restart                                                |
| Live-test user password / TOTP seed      | `pnpm adminforge provision test-identities` (password); re-run `tests/live/scripts/register-test-user-mfa.ts` (TOTP)                                                                                                                                                                                                                                                         | Test tenants only                                            |

### The provisioner

The provisioner is the most powerful credential AdminForge uses, and it lives on the operator's machine in
`<env>.admin.env` (never in the cluster, never backed up). Keep its power short-lived:

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
kubectl -n adminforge create secret generic adminforge-automation-cert \
  --from-file=automation.pem="$HOME/.config/adminforge/automation.pem"
# <env>.env: AF_AUTOMATION_CERT_PATH=/etc/adminforge/automation/automation.pem (where the pod mounts it). The CLI on
# this machine reads the local copy, so override the path while provisioning (the environment wins over env files):
export AF_AUTOMATION_CERT_PATH="$HOME/.config/adminforge/automation.pem"
pnpm adminforge provision entra --dry-run   # shows: register certificate, remove client secrets
pnpm adminforge provision entra             # then update the Secret (What runs where → Changing the configuration)
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
# then update the Secret (What runs where → Changing the configuration)
```

Its permissions are what the schedules naming it (`identity: { app: reports-team }`) declare in `requires.scopes`,
under the automation identity's ceilings **and its own opt-ins**: a write, sensitive-read or tier-0 permission needs
`AF_IDENTITY_<NAME>_ALLOW_WRITE_PERMISSIONS` / `_ALLOW_SENSITIVE_READS` / `_ALLOW_PRIVILEGED_PERMISSIONS=true` in
addition to the matching `AF_AUTOMATION_ALLOW_*` key (the dry run names the missing ones). A certificate works as for
the automation identity: set `AF_IDENTITY_<NAME>_CERT_PATH` and provisioning registers it and removes the secrets (in
the pod, add the PEM as another key of the `adminforge-automation-cert` Secret: each key is a file in
`/etc/adminforge/automation`). `validate --scopes` compares each identity separately; `--prune` removes roles it no
longer needs. Names are lower-case letters and digits with single dashes; the app's alternate key is
`adminforge-identity-<name>--<label>`.

Removing a name from `AF_SCHEDULE_IDENTITIES` makes its schedules fail with `identity_not_configured`; the app
registration and its permissions stay, so `provision status` fails ("no longer in AF_SCHEDULE_IDENTITIES") until you
delete it in the Entra admin centre (AdminForge keeps refusing writes to it meanwhile). The report schedule form and
the schedule editor offer the configured names under **Run as** — to **every** Operator, so list only identities
whose read access any Operator may use for a report.

### Choosing the account schedules run as

Each read-only schedule that names no identity runs as the installation default for its kind, else the automation
identity: set `AF_SCHEDULE_DEFAULT_IDENTITY` (all read-only jobs) or `AF_SCHEDULE_DEFAULT_IDENTITY_REPORTS` (reports)
to `automation` or a name in `AF_SCHEDULE_IDENTITIES`, then run `pnpm adminforge provision entra` so that identity
holds the permissions of the schedules it now runs. Write-capable schedules never take a default, nor do probe sweeps
(some run synthetic transactions); a sweep's account is set in content or on its page, and provisioning credits a
sweep's probes to it.

An Operator can also choose one content schedule's account on its page (**Run as**; a portal schedule changes it in its
editor): the identity must already hold the permissions the schedule declares — AdminForge checks and names what is
missing — and choosing **Default** goes back to the definition or the installation default. Changing a write-capable
schedule's account turns it off; turning it on again asks a second person to approve the new account. Each change is
audited (`schedule.run_as_changed`) and the page says who chose it and when. Content health checks every schedule
against the account it runs as now.

### Schedules that run with their creator's access

"Run as: Me" in the report schedule form (portal report schedules, read-only) needs no setup beyond Entra sign-in.
Schedules → the schedule shows **Needs sign-in** when Microsoft asked for a new sign-in (password reset, sign-in
policy, a long break): runs are skipped and the owner was notified; only the creator can press **Sign in again**. When
the creator leaves (loses `Portal.Operator` or a role the report needs), the next run removes the stored sign-in and
turns the schedule off (`creator_access_removed`); someone else must create their own schedule. A Portal Admin saving
someone's "Me" schedule ends its sign-in too (the creator signs in for the changed schedule). Its files open only for
the creator and Portal Admins. The sign-in needs the `auth_time` claim on the Read app: run `pnpm adminforge
provision entra` once after upgrading (until then the sign-in is refused with `signin_not_fresh`).

### Permission opt-ins

`AF_ALLOW_PRIVILEGED_WRITE_SCOPES` (tier-0 delegated scopes on the Write app), `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS`
(application permissions that change data), `AF_AUTOMATION_ALLOW_SENSITIVE_READS` (mail, files, sites — full control of every site included — chats, call records, BitLocker keys and LAPS passwords, …; the write opt-in doesn't replace it),
`AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS` (tier-0 application permissions for any app-only identity) and each
named identity's `AF_IDENTITY_<NAME>_ALLOW_*` keys are deliberate decisions: set them in `<env>.admin.env`, review `provision entra --dry-run`, and record the decision in your change record (not in this repository: it's installation state). `provision status` fails on privilege that provisioning didn't grant — including a permission an identity already holds that a ceiling now withholds (for example `Sites.FullControl.All` granted before it needed the sensitive-read opt-in) until the opt-in is set or `--prune` removes it.

Removing permissions: `provision entra` drops delegated scopes nothing needs any more, but leaves application
permissions it no longer grants (after content is retired, a baseline permission is dropped, or a ceiling is turned
back off) — `provision status` lists them under unexpected privilege. Remove them with
`pnpm adminforge provision entra --dry-run --prune` (review the `- remove` lines), then `pnpm adminforge provision entra --prune`.
It removes only roles on the resources provisioning knows, including ones a ceiling withholds that someone granted by
hand; anything else (another resource) is left for you to remove in the Entra admin centre.

## Certificates (Ingress)

TLS ends at the Ingress, with the certificate in the `adminforge-tls` Secret for the host name in `PUBLIC_BASE_URL`
(the overlay's `ingress.yaml`); behind it the pod speaks plain HTTP inside the cluster. Prefer a certificate browsers
already trust: from cert-manager, which renews it, or from your own CA. A certificate you made yourself is replaced
before it expires:

```sh
kubectl -n adminforge create secret tls adminforge-tls --cert=adminforge.crt --key=adminforge.key \
  --dry-run=client -o yaml | kubectl apply -f -
```

With a private CA, clients trust its root once:

- Windows: `certutil -addstore -user Root root.crt`
- macOS: Keychain Access → System → import → Always Trust
- Linux (Chrome/Edge): `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n AdminForge -i root.crt`
- Firefox: Settings → Certificates → Import, trust for websites

If the host name changes: change the Ingress host and its certificate, set `PUBLIC_BASE_URL` in the env file (and
`AF_REDIRECT_BASE_URLS` for any other origin), run `pnpm adminforge provision entra` (redirect URIs), then update the
Secret. Sign-in works only on the `PUBLIC_BASE_URL` origin.

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
PUBLIC_BASE_URL=https://adminforge.example.com pnpm test:live   # the Ingress URL
# Ingress certificate from a private CA: add NODE_EXTRA_CA_CERTS=<its root.crt> AF_LIVE_INSECURE_TLS=1
```
