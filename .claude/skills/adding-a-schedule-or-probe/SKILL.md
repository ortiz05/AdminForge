---
name: adding-a-schedule-or-probe
description: Use when asked to schedule something to run on the AdminForge host (a recurring report, check, scheduled action, synthetic test), add monitoring, a configuration/compliance check, an alert threshold, or a KQL query that should run unattended.
---

# Adding a schedule or probe

## Overview

Schedules (`portal/content/schedules/`) run on this host via `portal/apps/scheduler` as the **automation identity**
(app-only; ADR-011) — never as a person. Probes (`portal/content/probes/`) are synthetic tests and configuration
checks that write time-series results shown on `/monitoring`.

## Report schedules: often no content at all

An Operator who just wants an existing report delivered (file, email to a configured list, Teams) at most hourly can
schedule it in the portal: **Reports** (`/reports`) → the report → **Schedule**. Those schedules run at once, live only
in the database (`source: portal`, keys `portal.<report>-<hex>`), and are edited or deleted by their creator or a
`Portal.Admin` (API: `POST/PUT/DELETE /api/schedules`, `docs/api.md`). Write content YAML instead when the schedule
should ship with the product or be reviewed (every installation gets it), needs more than that form offers
(`notify.onSuccess`, a delivery `path`, subject/message templates, `overlap`, runs more often than hourly, setting a
picker/date/hidden param), must keep running whoever leaves (a portal schedule stops when its creator loses access),
or isn't a report (probes, playbooks, content health, news — content only). The `portal.` id namespace is reserved: a content
schedule may not use it (`adminforge validate` refuses it).

## Steps

1. **Reuse first.** Probes are swept by tag: tag a new probe (`tags: [hourly]`, `[config-check]`) and an existing
   sweep schedule (`schedules/probes/*.schedule.yaml`, `job.select.tags`) picks it up — often no new schedule needed.
2. **Scaffold:** `pnpm adminforge new probe <section>/<name>` / `new schedule <section>/<name>`, design the query
   in **Query Studio** (`/query`; it offers the sources the installation switched on, `AF_QUERY_SOURCES`) and use
   _Save as probe/report/schedule_, or build a schedule in the **schedule
   editor** (`/schedules/new`: choices, plain English or cron, with the next runs, any IANA time zone, job, retries,
   alerts → YAML for review).
3. **Pick the check:** `check.kind` = `http`, `dnsResolve`, `certExpiry`, `graph`, `graphCount` (how many items a
   Graph list holds), `arm`, `tokenAcquisition`, `appCredentialExpiry`, `licenseThreshold`, `signInHealth`,
   `functionHealth`, `auditChain` (AdminForge's own audit log), **`kql`**, or a synthetic transaction (`mailFlow`,
   `fileRoundTrip`, `onlineMeeting`).
   - Tenant-wide configuration questions → `kql` with `source: resourceGraph` (all subscriptions, one query),
     `logAnalytics` (`workspace` defaults to `${env.AF_LOG_ANALYTICS_WORKSPACE_ID}`), or `advancedHunting`
     (Defender licence). `metric: rowCount` or `{ column, aggregate }`; `detailsLimit` keeps the offending rows.
   - Put `// af:<probe id>` as the first KQL line (fixtures match on it).
   - A workload's own sign-in failure rate → `signInHealth` with `resourceId` (Exchange Online
     `00000002-0000-0ff1-ce00-000000000000`, SharePoint Online `00000003-0000-0ff1-ce00-000000000000`, Teams Services
     `cc15fd57-2c6c-4117-a88c-83b1d56b4bbe`).
   - **Synthetic transactions** (ADR-015) — `mailFlow`, `fileRoundTrip`, `onlineMeeting` — are built in: they send,
     upload or create on **test objects named in configuration only** (`from`/`to`/`site`/`organizer` must be one
     whole `${ env.AF_… }` reference) and remove what they made. Tag them `synthetic-transaction`
     (`sweep.synthetic-transactions` runs them every 15 minutes). A mail check needs `timeoutMs` ≥ `waitSeconds` ×
     1000 + 10000. The identity's access to the test objects is an administrator's step (docs/operations.md ›
     Synthetic transactions). Content can't define new transactions: a new kind is code in
     `portal/apps/api/src/probes/transactions.ts` with a security review — never a generic write probe.
4. **Group** every probe by the service it watches: `group:` a navigation section key (`identity`, `m365`,
   `exchange`, `sharepoint`, `teams`, `endpoint`, `azure`, `billing`, …) or `platform` for AdminForge itself.
   Synthetic monitoring groups tiles by it, each section's "Service checks" item (`/monitoring?group=<key>`) and a
   dashboard's `probeStatus` with `group:` show it; without it the probe lands under "Other checks".
   **Say what to do** when it warns or fails: `remedy:` (plain sentences, ≤ 1000 characters: the likely causes, the
   first step, and what "not configured" / "forbidden" mean for this check) and `link: { label, href }` — an AdminForge
   page that lists the items (`/p/<key>?<filter>=…`, validated to exist) or a Microsoft admin centre (https). The probe's
   detail on Synthetic monitoring shows them with the rows behind the result (`fields` / `detailsLimit`: keep the
   columns that say _which_ item and _why_ — a name, the date or value that broke the rule), so engineers don't go
   looking. Every active probe needs a remedy (`tests/content/probe-remedies.test.ts`).
5. **Thresholds** `{ warn, crit }` in the direction `PROBE_METRICS` defines for the kind; `intervalHint`, `timeoutMs`.
6. **Schedules:** when it runs as `every:` in plain English — `every weekday at 07:00`, `every Monday at 08:30`,
   `mon, wed and fri at 18:00`, `first Monday of the month at 08:30`, `last Friday of the month at 17:00`, `last day
of the month at 23:00`, `on the 15th of every month at 06:00`, `every 4 hours`, `every hour at :15`, `every 15
minutes` — or `cron` (5/6 fields; one of the two). Validation compiles `every` to cron and names any word it doesn't
   understand. Then `timezone` (IANA; never inside `every`), `identity: automation`, `job.kind` =
   - `probe` (`ref` / `refs` / `select.tags`, optional `concurrency`);
   - `report` (`ref`, `params`, `delivery: [{ type: file, format, path, retain }]`, plus `{ type: email, to }` and
     `{ type: teams, webhook }`). Recipients and webhooks are **always** `${ env.X }` keys (configuration, never
     content); email needs `AF_MAIL_SENDER` and the automation identity's Mail.Send, Teams a Workflows webhook on a
     Microsoft host. The file is always kept with the run;
   - `playbook` (`ref`, `inputs`, `mode`; write playbooks need `approvedBy` — enabling them requires a second
     approver);
   - `script` (a pinned runner script: `script`, `sha256`, `parameters`, `services`, `timeoutSeconds`, `mode`;
     `mode: write` needs `approvedBy`). It validates, but runs currently fail with `script_not_supported` — the runner
     can't yet run scripts as the automation identity (see `docs/backlog.md`), so prefer a `kql` probe or a report;
   - `contentHealth` (`scopes: true` also checks the automation identity's permissions);
   - `news` (collects the News and changes feeds; optional `refs`, `concurrency`). One hourly schedule
     (`maintenance.news-refresh-hourly`) already covers every feed — add a feed, not a schedule (`add-news-feed`).

   Plus `retry`, `timeoutSeconds`, `overlap: skip|queue|allow`, and `notify.onFailure` / `onSuccess` (same email/Teams
   targets; failure alerts are sent only when no retry is left). Scheduled data (report files, probe rows) is visible
   to Operators by default — widen it deliberately with `requires.portalRoles`.

7. **Permissions:** the automation identity needs **application** permissions / Azure RBAC for what it reads. Declare
   them in `requires.scopes` / `requires.azureRoles`; if new, add them to provisioning
   (`portal/tools/cli/src/provision/catalog.ts`) and run `pnpm adminforge provision entra`.
   **Who it runs as** (ADR-014): keep `identity: automation` unless the schedule needs permissions the shared identity
   shouldn't hold — then `identity: { app: <name> }` with a name from `AF_SCHEDULE_IDENTITIES` (add it to the env file
   if new); `provision entra` gives that app registration exactly the `requires.scopes` of the schedules naming it, and
   `validate --scopes` checks it separately; a write, sensitive-read or tier-0 permission also needs that identity's own
   `AF_IDENTITY_<NAME>_ALLOW_*` opt-in. `news` and `contentHealth` jobs always use `automation`. `{ user: creator }`
   is only for report schedules created in the portal ("Run as: Me") — content can't use it. Runner (PowerShell)
   datasources work only as the automation identity.
8. **Fixtures** for mock mode (Resource Graph variants in `tests/fixtures/resourceGraph/POST.json`, matched by the
   `// af:` comment); **validate:** `pnpm adminforge validate`, content tests, `pnpm guard`.
9. **Try it once live (read-only):** against the dev database, as the automation identity, with delivery kept away
   from people — `pnpm exec tsx tests/live/scripts/run-schedule-once.ts` with `--probe <id>` or `--schedule <id>`
   (`--deliver sender` mails only `AF_MAIL_SENDER` itself; see `tests/live/README.md`). Then check `/monitoring`. On
   the host, the scheduler's own one-shot is in `portal/deploy/README.md`.

## Common mistakes

| Mistake                                                                                  | Fix                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One schedule per probe                                                                   | Tag the probe; reuse the tag sweep                                                                                                                                     |
| Thousands of Graph calls for a tenant-wide check                                         | KQL (Resource Graph / Log Analytics)                                                                                                                                   |
| Delegated scopes for a schedule                                                          | Schedules use application permissions on the automation identity                                                                                                       |
| Subscription/workspace ids in YAML                                                       | `${env.AF_SUBSCRIPTION_ID}`, `${env.AF_LOG_ANALYTICS_WORKSPACE_ID}`                                                                                                    |
| Write job without approval                                                               | `approvedBy` + two-person approval to enable                                                                                                                           |
| Treating `job.approvedBy` as the approval                                                | It's a review note; only the in-app approval counts, and it covers the playbook's current version (a new playbook version switches the schedule off until re-approved) |
| Report or probe rows visible to every Reader                                             | Scheduled data is collected with application permissions: Operators by default; widen deliberately with `requires.portalRoles`                                         |
| Declaring an app-only **write** permission                                               | Provisioning skips it unless `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true` — say so in the PR                                                                           |
| Declaring a **sensitive read** (mail, files, sites, chats, calendars, BitLocker keys, …) | Provisioning skips it unless `AF_AUTOMATION_ALLOW_SENSITIVE_READS=true` — prefer a narrower permission                                                                 |
| Alerting on how many items a Graph list holds (too many or too few) with a latency probe | `kind: graphCount` — `items: ${ value[...] }` selects what to count, `worse: higher                                                                                    | lower`, thresholds on the count, `fields`for the detail rows (see`probes.global-admins-too-few`) |
| An HTTP probe that POSTs                                                                 | Set `allowPost: true`; HTTP probes never follow redirects or reach private addresses other than the portal                                                             |
| Literal email addresses in `delivery.to`                                                 | Recipients are configuration: `${ env.AF_REPORT_RECIPIENTS }` (keys ending RECIPIENTS/EMAIL/ALERTS)                                                                    |
| Content schedule id `portal.…`                                                           | Reserved for report schedules created in the portal; use `<section>.<name>` (e.g. `reports.weekly-…`)                                                                  |
| A probe without `remedy`, or details rows that don't say which item                      | `remedy:` + `link:`; `fields` with a name and the value that broke the rule (the detail shows them as "What it found" to Operators)                                    |
| A probe without `group`                                                                  | `group: <nav section key>` (or `platform`) — otherwise it shows under "Other checks", not on its service's page                                                        |
| An anonymous HTTP probe expecting one exact status                                       | Tenants differ (SharePoint answers 401 or 403): accept every status that means "up", e.g. `status: [401, 403]`; check with curl first                                  |
| Filtering service health on a name from a fixture                                        | Names change ("OneDrive for Business" is now "Microsoft OneDrive"): read `healthOverviews` live and filter on both names                                               |
| A "degraded services" count                                                              | Advisories keep several services at `serviceDegradation` most days; alert on `serviceInterruption` or open incidents (`classification eq 'incident'`)                  |
| New `config-check` KQL probe not in the shipped set                                      | Add its id to `CONFIG_CHECKS` in `tests/content/probes-schedules.test.ts` (the test asserts the exact set)                                                             |
