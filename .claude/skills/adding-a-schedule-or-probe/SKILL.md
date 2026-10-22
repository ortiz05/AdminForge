---
name: adding-a-schedule-or-probe
description: Use when asked to schedule something to run unattended in AdminForge (a recurring report, check, scheduled action, synthetic test), add monitoring, a configuration/compliance check, an alert threshold, or a KQL query that should run unattended.
---

# Adding a schedule or probe

## Overview

Schedules (`portal/content/schedules/`) are run by the scheduler inside the API process (`portal/apps/api/src/schedules`;
ADR-016) as the **automation identity** (app-only; ADR-011) — never as a person. Probes (`portal/content/probes/`) are
synthetic tests and configuration checks that write time-series results shown on Synthetic monitoring (`/monitoring`).

## When not to use

- **An existing report delivered on a schedule** (file, e-mail to a configured list, Teams) at most hourly: an
  Operator schedules it in the portal — **Reports** (`/reports`) → the report → **Schedule**. Those schedules run at
  once, live only in the database (`source: portal`, keys `portal.<report>-<hex>`) and are edited or deleted by their
  creator or a `Portal.Admin` (`POST/PUT/DELETE /api/schedules`, `docs/api.md`). Write content YAML instead when the
  schedule should ship with the product or be reviewed, needs more than that form offers (`notify.onSuccess`, a
  delivery `path`, subject/message templates, `overlap`, runs more often than hourly, a picker/date/hidden param),
  must keep running whoever leaves (a portal schedule stops when its creator loses access), or isn't a report (probes,
  playbooks, content health, news).
- **A new News and changes source** → `add-news-feed`: one hourly schedule already collects every feed.
- **A new synthetic transaction kind** (beyond `mailFlow`, `fileRoundTrip`, `onlineMeeting`) → code in
  `portal/apps/api/src/probes/transactions.ts` with a security review — never a generic write probe.
- **Unattended PowerShell**: `script` jobs fail with `script_not_supported` until the runner can sign in as the
  automation identity — prefer a `kql` probe or a report.

## Steps

1. **Reuse first.** `pnpm adminforge list --kind probe,schedule --section <section>` shows a section's checks and
   schedules. Probes are swept by tag: tag a new probe (`sweep-15m`, `sweep-1h`, `sweep-6h`, `config-check`, `synthetic-transaction`) and an existing
   sweep schedule (`schedules/probes/*.schedule.yaml`, `job.select.tags`) picks it up — often no new schedule needed.
2. **Scaffold:** `pnpm adminforge new probe probes/<name>` (writes `probes/<name>.probe.yaml`, id `probes.<name>`;
   set `group:`) / `new schedule <job group>/<name>` (`reports/`, `maintenance/`, `billing/`; sweeps are `sweep.*` in
   `schedules/probes/` — `portal/content/README.md` › Probes and schedules), design the query in
   **Query Studio** (`/query`; it offers the sources the installation switched on, `AF_QUERY_SOURCES`) and use _Save as
   probe/report/schedule_, or build a schedule in the **schedule editor** (`/schedules/new`: choices, plain English or
   cron, with the next runs, any IANA time zone, job, retries, alerts → YAML for review).
3. **Pick the check:** `check.kind` = `http`, `dnsResolve`, `certExpiry`, `graph`, `graphCount` (how many items a
   Graph list holds), `arm`, `tokenAcquisition`, `appCredentialExpiry`, `licenseThreshold`, `signInHealth`,
   `functionHealth`, `auditChain` (AdminForge's own audit log), **`kql`**, or a synthetic transaction (`mailFlow`,
   `fileRoundTrip`, `onlineMeeting`).
   - Tenant-wide configuration questions → `kql` with `source: resourceGraph` (all subscriptions, one query) or
     `logAnalytics` (`docs/content-recipes.md` › Log Analytics for the workspace). `metric: rowCount` or
     `{ column, aggregate }`; `detailsLimit` keeps the offending rows. Resource Graph queries obey the join limits in
     `CLAUDE.md` (non-negotiable 14), detailed in the `adding-a-page-or-report` skill. `advancedHunting` (the Defender
     portal) is out of scope since 2026-10-17: the retired-content test refuses it.
   - Every KQL probe's id goes in `CONFIG_CHECKS` in `tests/content/probes-schedules.test.ts` (the exact set). A
     configuration check is tagged `config-check` (the 6-hourly sweep); one that watches service health (hosts down,
     capacity, failures) is tagged `sweep-15m` or `sweep-1h` instead and listed in `OPERATIONAL` with that tag
     (`probes.avd-session-hosts-unavailable`).
   - Put `// af:<probe id>` as the first KQL line (fixtures match on it).
   - A workload's own sign-in failure rate → `signInHealth` with `resourceId` (Exchange Online
     `00000002-0000-0ff1-ce00-000000000000`, SharePoint Online `00000003-0000-0ff1-ce00-000000000000`, Teams Services
     `cc15fd57-2c6c-4117-a88c-83b1d56b4bbe`).
   - **Synthetic transactions** (ADR-015) — `mailFlow`, `fileRoundTrip`, `onlineMeeting` — send, upload or create on
     **test objects named in configuration only** (`from`/`to`/`site`/`organizer` must be one whole `${ env.AF_… }`
     reference) and remove what they made. Tag them `synthetic-transaction` (`sweep.synthetic-transactions` runs them
     every 15 minutes). A mail check needs `timeoutMs` ≥ `waitSeconds` × 1000 + 10000. The identity's access to the
     test objects is an administrator's step (`docs/operations.md` › Synthetic transactions).
4. **Group** every probe by the service it watches: `group:` a navigation section key (`identity`, `m365`,
   `exchange`, `sharepoint`, `teams`, `endpoint`, `azure`, `avd`, `billing`, …) or `platform` for AdminForge itself.
   Synthetic monitoring groups tiles by it; the section's row in the navigation shows their status, linking to
   `/monitoring?group=<key>`; a dashboard's `probeStatus` with `group:` shows it. Without it the probe lands under
   "Other checks". `platform` probes have no section row.
   **Say what to do** when it warns or fails: `remedy:` (plain sentences, ≤ 1000 characters: the likely causes, the
   first step, and what "not configured" / "forbidden" mean for this check — only what the check really looks at: an
   incidents check that filters `classification eq 'incident'` doesn't cover advisories) and `link: { label, href }` —
   an AdminForge page that lists the items with the same filter (`/p/<key>?<param>=…`; the key must exist and the
   params match the page's own, e.g. `&includeDrained=false`) or a Microsoft admin centre (`https://`; never `//host`
   or a backslash). The probe's detail on Synthetic monitoring shows the remedy, the link and the rows behind the result
   as **What it found** — so the rows (`fields` / `detailsLimit` / the KQL `project`) start with the item's name and the
   value that broke the rule (`displayName, expires, daysRemaining`). Those rows were collected with application
   permissions, so only Operators see them: never put item names into the message (Readers see messages); an
   aggregate is fine (`signInHealth` names the most common error code). Every active probe needs a remedy
   (`tests/content/probe-remedies.test.ts`; plain text over 60 characters; external links only to Microsoft).
5. **Thresholds** `{ warn, crit }` in the direction `PROBE_METRICS` defines for the kind; `intervalHint`, `timeoutMs`.
6. **Schedules:** when it runs as `every:` in plain English — `every weekday at 07:00`, `every Monday at 08:30`,
   `mon, wed and fri at 18:00`, `first Monday of the month at 08:30`, `last Friday of the month at 17:00`,
   `last day of the month at 23:00`, `on the 15th of every month at 06:00`, `every 4 hours`, `every hour at :15`,
   `every 15 minutes` — or `cron` (5/6 fields; one of the two). Validation compiles `every` to cron and names any word
   it doesn't understand. Then `timezone` (IANA; never inside `every`), `identity: automation`, `job.kind` =
   - `probe` (`ref` / `refs` / `select.tags`, optional `concurrency`);
   - `report` (`ref`, `params`, `delivery: [{ type: file, format, path, retain }]`, plus `{ type: email, to }` and
     `{ type: teams, webhook }`). Recipients and webhooks are **always** `${ env.X }` keys (configuration, never
     content); e-mail needs `AF_MAIL_SENDER` and the automation identity's Mail.Send, Teams a Workflows webhook on a
     Microsoft host. Today `validate` refuses any `env.…WEBHOOK` key in content (secret-looking names never reach
     expressions), so a content schedule can't name a Teams webhook yet (`docs/backlog.md`); portal schedules can. The
     file is always kept with the run;
   - `playbook` (`ref`, `inputs`, `mode`; write playbooks need `approvedBy` — enabling them requires a second
     approver);
   - `script` (a pinned runner script; validates, but runs fail with `script_not_supported` — see When not to use);
   - `contentHealth` (`scopes: true` also checks the automation identity's permissions);
   - `news` (collects the News and changes feeds; `maintenance.news-refresh-hourly` already covers every feed).

   Plus `retry`, `timeoutSeconds`, `overlap: skip|queue|allow`, and `notify.onFailure` / `onSuccess` (same e-mail /
   Teams targets; failure alerts are sent only when no retry is left). A time missed by more than an hour (the pod was
   down) is recorded as a skipped run (`schedule_missed`), not run late. Scheduled data (report files, probe rows) is
   visible to Operators by default — widen it deliberately with `requires.portalRoles`.

7. **Permissions:** the automation identity needs **application** permissions / Azure RBAC for what it reads. Declare
   them in `requires.scopes` / `requires.azureRoles`; if new, add them to provisioning
   (`portal/tools/cli/src/provision/catalog.ts`) and run `pnpm adminforge provision entra`.
   **Who it runs as** (ADR-014): keep `identity: automation` unless the schedule needs permissions the shared identity
   shouldn't hold — then `identity: { app: <name> }` with a name from `AF_SCHEDULE_IDENTITIES` (add it to the env file
   if new); `provision entra` gives that app registration exactly the `requires.scopes` of the schedules naming it, and
   `validate --scopes` checks it separately; a write, sensitive-read or tier-0 permission also needs that identity's
   own `AF_IDENTITY_<NAME>_ALLOW_*` opt-in. `news` and `contentHealth` jobs always use `automation`.
   `{ user: creator }` is only for report schedules created in the portal ("Run as: Me") — content can't use it.
   A report with runner (PowerShell) datasources runs as the automation identity only: a named app identity or a
   portal schedule's "Run as: Me" is refused (`runner_identity_not_supported`).
8. **Fixtures (required)** for mock mode: every KQL probe needs its `// af:<probe id>` variant
   (`tests/content/fixtures-complete.test.ts` fails without it; computed booleans are 1/0), and an HTTP, DNS or
   certificate probe a `hosts/`, `dns/` or `tls/` fixture keyed for the synthetic configuration
   (`docs/content-recipes.md` › Fixtures). Mock mode never reaches the network.
9. **Validate:** `pnpm adminforge validate`, `pnpm --filter @adminforge/tests exec vitest run --project content`,
   `pnpm guard`.
10. **Try it once live (read-only):** against the dev database, as the automation identity, with delivery kept away
    from people — `pnpm exec tsx tests/live/scripts/run-schedule-once.ts` with `--probe <id>` or `--schedule <id>`
    (`--deliver sender` mails only `AF_MAIL_SENDER` itself; see `tests/live/README.md`). Then check `/monitoring`.
    **Run now** on a switched-off schedule only writes the file (no e-mail, Teams post or notification), so you can
    try a content schedule before enabling it. The plain one-shots,
    `pnpm --filter @adminforge/scheduler exec tsx src/main.ts --probe <id>` / `--schedule <id>`
    (`portal/apps/scheduler/README.md`), deliver reports to the configured recipients; in a deployment a code owner
    runs them in the pod.

## Done when

- [ ] `pnpm adminforge validate`, the content project and `pnpm guard` are clean
- [ ] Every new probe has `group`, `remedy`, a `link` where one helps, detail rows that start with the item's name,
      no names in its message, and a fixture; a KQL probe is in `CONFIG_CHECKS` (and `OPERATIONAL` if swept faster)
- [ ] The schedule runs as the automation identity (or a named app identity) with application permissions that are in
      provisioning; a write job has `approvedBy` and needs the in-app second approval
- [ ] Each new query ran once live, read-only (`run-schedule-once.ts`) — or is recorded as unchecked in
      `docs/licensing-review.md` and `docs/backlog.md`
- [ ] `content-reviewer` ran and its findings are fixed or answered

## Common mistakes

| Mistake                                                                                                                                                                 | Fix                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One schedule per probe                                                                                                                                                  | Tag the probe; reuse the tag sweep                                                                                                                                                                                            |
| Thousands of Graph calls for a tenant-wide check                                                                                                                        | KQL (Resource Graph / Log Analytics)                                                                                                                                                                                          |
| Delegated scopes for a schedule                                                                                                                                         | Schedules use application permissions on the automation identity                                                                                                                                                              |
| Subscription/workspace ids in YAML                                                                                                                                      | `${env.AF_SUBSCRIPTION_ID}`, `${env.AF_LOG_ANALYTICS_WORKSPACE_ID}`                                                                                                                                                           |
| Write job without approval                                                                                                                                              | `approvedBy` + two-person approval to enable                                                                                                                                                                                  |
| Treating `job.approvedBy` as the approval                                                                                                                               | It's a review note; only the in-app approval counts, and it covers the playbook's current version (a new playbook version switches the schedule off until re-approved)                                                        |
| Report or probe rows visible to every Reader                                                                                                                            | Scheduled data is collected with application permissions: Operators by default; widen deliberately with `requires.portalRoles`                                                                                                |
| Declaring an app-only **write** permission                                                                                                                              | Provisioning skips it unless `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true` — say so in the PR                                                                                                                                  |
| Declaring a **sensitive read** (mail, files, sites incl. `Sites.FullControl.All`, chats, call records, BitLocker keys, LAPS passwords, …)                               | Provisioning skips it unless `AF_AUTOMATION_ALLOW_SENSITIVE_READS=true`, even with the write opt-in — prefer a narrower permission (`Sites.Selected`)                                                                         |
| Declaring a **tier-0** app-only permission (role management, policies, `Organization.ReadWrite.All`, authentication methods, group membership, Intune scripts and apps) | Provisioning skips it unless `AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS=true` and `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true` (list: `isPrivilegedAppRole` in privilege.ts) — a schedule rarely needs one; say so in the PR |
| Alerting on how many items a Graph list holds (too many or too few) with a latency probe                                                                                | `kind: graphCount` — `items: ${ value[...] }` selects what to count, `worse: higher` or `lower`, thresholds on the count, `fields` for the detail rows (see `probes.global-admins-too-few`)                                   |
| An HTTP probe that POSTs                                                                                                                                                | Set `allowPost: true`; HTTP probes never follow redirects or reach private addresses other than the portal                                                                                                                    |
| Literal e-mail addresses in `delivery.to`                                                                                                                               | Recipients are configuration: `${ env.AF_REPORT_RECIPIENTS }` (keys ending RECIPIENTS/EMAIL/ALERTS)                                                                                                                           |
| Content schedule id `portal.…`                                                                                                                                          | Reserved for report schedules created in the portal; use `<section>.<name>` (e.g. `reports.weekly-…`)                                                                                                                         |
| A probe without `remedy`, or details rows that don't say which item                                                                                                     | `remedy:` + `link:`; `fields` with a name and the value that broke the rule (the detail shows them as "What it found" to Operators)                                                                                           |
| A probe without `group`                                                                                                                                                 | `group: <nav section key>` (or `platform`) — otherwise it shows under "Other checks", not on its service's row                                                                                                                |
| A KQL probe without an `af:` fixture variant                                                                                                                            | Add the variant; `fixtures-complete.test.ts` fails without it and mock monitoring shows a generic answer                                                                                                                      |
| An anonymous HTTP probe expecting one exact status                                                                                                                      | Tenants differ (SharePoint answers 401 or 403): accept every status that means "up", e.g. `status: [401, 403]`; check with curl first                                                                                         |
| Filtering service health on a name from a fixture                                                                                                                       | Names change ("OneDrive for Business" is now "Microsoft OneDrive"): read `healthOverviews` live and filter on both names                                                                                                      |
| A "degraded services" count                                                                                                                                             | Advisories keep several services at `serviceDegradation` most days; alert on `serviceInterruption` or open incidents (`classification eq 'incident'`)                                                                         |
| New KQL probe not in the shipped set                                                                                                                                    | Add its id to `CONFIG_CHECKS` in `tests/content/probes-schedules.test.ts` (exact set); a service-health KQL probe also goes in `OPERATIONAL` with its sweep tag                                                               |
| Item names in a probe's message                                                                                                                                         | Readers see messages; names go in the details rows, which only Operators see                                                                                                                                                  |

## See also

- `docs/content-recipes.md` — fixtures, Log Analytics workspaces, versions and retiring
- `docs/onboarding/08-content-guide.md` › Unattended work (schedules and probes); `docs/operations.md` (sweeps,
  synthetic transactions, missed runs); `portal/apps/scheduler/README.md` (one-shots)
- `adding-a-page-or-report` (Resource Graph joins), `add-news-feed`, `validating-against-a-tenant`
