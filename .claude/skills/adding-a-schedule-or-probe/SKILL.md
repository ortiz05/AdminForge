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
   in **Query Studio** (`/query`) and use _Save as probe/report/schedule_, or build a schedule in the **schedule
   editor** (`/schedules/new`: cron builder with preview, job, retries, alerts → YAML for review).
3. **Pick the check:** `check.kind` = `http`, `dnsResolve`, `certExpiry`, `graph`, `graphCount` (how many items a
   Graph list holds), `arm`, `tokenAcquisition`, `appCredentialExpiry`, `licenseThreshold`, `signInHealth`,
   `functionHealth`, `auditChain` (AdminForge's own audit log), or **`kql`**.
   - Tenant-wide configuration questions → `kql` with `source: resourceGraph` (all subscriptions, one query),
     `logAnalytics` (`workspace` defaults to `${env.AF_LOG_ANALYTICS_WORKSPACE_ID}`), or `advancedHunting`
     (Defender licence). `metric: rowCount` or `{ column, aggregate }`; `detailsLimit` keeps the offending rows.
   - Put `// af:<probe id>` as the first KQL line (fixtures match on it).
4. **Thresholds** `{ warn, crit }` in the direction `PROBE_METRICS` defines for the kind; `intervalHint`, `timeoutMs`.
5. **Schedules:** `cron` (5/6 fields), `timezone` (IANA), `identity: automation`, `job.kind` =
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

6. **Permissions:** the automation identity needs **application** permissions / Azure RBAC for what it reads. Declare
   them in `requires.scopes` / `requires.azureRoles`; if new, add them to provisioning
   (`portal/tools/cli/src/provision/catalog.ts`) and run `pnpm adminforge provision entra`.
7. **Fixtures** for mock mode (Resource Graph variants in `tests/fixtures/resourceGraph/POST.json`, matched by the
   `// af:` comment); **validate:** `pnpm adminforge validate`, content tests, `pnpm guard`.
8. **Try it once live (read-only):** run the scheduler sweep for your probe (see `portal/deploy/README.md`) and check
   `/monitoring`.

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
| New `config-check` KQL probe not in the shipped set                                      | Add its id to `CONFIG_CHECKS` in `tests/content/probes-schedules.test.ts` (the test asserts the exact set)                                                             |
