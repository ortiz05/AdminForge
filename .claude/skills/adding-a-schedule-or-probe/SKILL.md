---
name: adding-a-schedule-or-probe
description: Use when asked to schedule something to run on the AdminForge host (a recurring report, check, scheduled action, synthetic test), add monitoring, a configuration/compliance check, an alert threshold, or a KQL query that should run unattended.
---

# Adding a schedule or probe

## Overview
Schedules (`portal/content/schedules/`) run on this host via `portal/apps/scheduler` as the **automation identity**
(app-only; ADR-011) — never as a person. Probes (`portal/content/probes/`) are synthetic tests and configuration
checks that write time-series results shown on `/monitoring`.

## Steps
1. **Reuse first.** Probes are swept by tag: tag a new probe (`tags: [hourly]`, `[config-check]`) and an existing
   sweep schedule (`schedules/probes/*.schedule.yaml`, `job.select.tags`) picks it up — often no new schedule needed.
2. **Scaffold:** `pnpm adminforge new probe <section>/<name>` / `new schedule <section>/<name>`, or design the query
   in **Query Studio** (`/query`) and use *Save as probe/report/schedule*.
3. **Pick the check:** `check.kind` = `http`, `dnsResolve`, `certExpiry`, `graph`, `arm`, `tokenAcquisition`,
   `appCredentialExpiry`, `licenseThreshold`, `signInHealth`, `functionHealth`, or **`kql`**.
   - Tenant-wide configuration questions → `kql` with `source: resourceGraph` (all subscriptions, one query),
     `logAnalytics` (`workspace` defaults to `${env.AF_LOG_ANALYTICS_WORKSPACE_ID}`), or `advancedHunting`
     (Defender licence). `metric: rowCount` or `{ column, aggregate }`; `detailsLimit` keeps the offending rows.
   - Put `// af:<probe id>` as the first KQL line (fixtures match on it).
4. **Thresholds** `{ warn, crit }` in the direction `PROBE_METRICS` defines for the kind; `intervalHint`, `timeoutMs`.
5. **Schedules:** `cron` (5/6 fields), `timezone` (IANA), `identity: automation`, `job.kind` =
   `probe` (`ref` / `refs` / `select.tags`), `report` (`ref`, `params`, `delivery: [{type: file, format}]`),
   `playbook` (write playbooks need `approvedBy` — enabling them requires a second approver), `contentHealth`.
   `retry`, `timeoutSeconds`, `overlap: skip`.
6. **Permissions:** the automation identity needs **application** permissions / Azure RBAC for what it reads. Declare
   them in `requires.scopes` / `requires.azureRoles`; if new, add them to provisioning
   (`portal/tools/cli/src/provision/catalog.ts`) and run `pnpm adminforge provision entra`.
7. **Fixtures** for mock mode (Resource Graph variants in `tests/fixtures/resourceGraph/POST.json`, matched by the
   `// af:` comment); **validate:** `pnpm adminforge validate`, content tests, `pnpm guard`.
8. **Try it once live (read-only):** run the scheduler sweep for your probe (see `portal/deploy/README.md`) and check
   `/monitoring`.

## Common mistakes
| Mistake | Fix |
|---|---|
| One schedule per probe | Tag the probe; reuse the tag sweep |
| Thousands of Graph calls for a tenant-wide check | KQL (Resource Graph / Log Analytics) |
| Delegated scopes for a schedule | Schedules use application permissions on the automation identity |
| Subscription/workspace ids in YAML | `${env.AF_SUBSCRIPTION_ID}`, `${env.AF_LOG_ANALYTICS_WORKSPACE_ID}` |
| Write job without approval | `approvedBy` + two-person approval to enable |
