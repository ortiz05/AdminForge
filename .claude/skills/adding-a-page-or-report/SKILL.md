---
name: adding-a-page-or-report
description: Use when asked to add or change an AdminForge page, dashboard, entity/detail view, list, or exportable report (anything shown under /p/<key>), including new columns, filters, facets, KPIs, charts, row or bulk actions.
---

# Adding a page or report

## Overview

Pages, dashboards and reports are YAML in `portal/content/{pages,dashboards,reports}/<section>/`. The generic renderer
(`/p/$key`) and datasource executor do the rest. **No React code for a new page.**

## Steps

1. **Reuse first.** `rg -l "<topic>" portal/content` and `rg "^id:" portal/content/{pages,dashboards,reports}`. If a page
   already covers it, extend it and bump `version` (minor for additions).
2. **Scaffold:** `pnpm adminforge new page <section>/<name> --template list-detail|dashboard|entity|report`
   (reports: `new report …`). Keep the `$schema` line — VS Code autocompletes from it.
3. **Datasources:** `source: graph|graphBatch|arm|resourceGraph|logAnalytics|function|runner|static`.
   - Filter **server-side** (`$filter`, `$select`, `$top`, KQL `where`), not in `transform` — transforms run on the API
     thread with a 250 ms budget and fail on large tenants.
   - Tenant-wide questions that would need many Graph calls → **KQL** (`resourceGraph`, `logAnalytics`).
   - Resource Graph can't start a query with `union a, b`; pipe instead: `resources | where … | union
(resourcecontainers | where …)` (resource groups and subscriptions live in `resourcecontainers`).
     `adminforge validate` rejects the leading form.
   - User input: `$odata()`, `$odataSearch()`, `$kql()`, `$encode()`. Advanced filters: declare
     `filters.advanced.fields` and use `${ advanced }`; never read the raw param. Dialect `odata` (Graph) and `kql`
     (Resource Graph / Log Analytics) compile into the request; for sources with no query language (`runner`,
     `static`, `function`) use `dialect: rows` and keep the matching rows in the transform with
     `$applyAdvanced(<rows>, advanced)` (row fields use `.` paths; computed fields work too).
   - Defender advanced hunting: `source: graph`, `method: POST`, `path: /security/runHuntingQuery`,
     `body: { Query: … }` (a read; the KQL lint checks `body.Query` like any query), transform `value.results`,
     `requires.scopes.graph: [ThreatHunting.Read.All]`. Start a `// af:<page id>#<datasource>` comment line so
     fixtures can match it (`bodyIncludes`).
   - Later datasources may reference earlier ones (`ds.<name>`).
4. **Layout:** widgets exactly as in `docs/widgets.md` (kpi, table, chart, list, keyValue, statusGrid, timeline,
   markdown, actionBar, licenceGate, probeStatus). Tables: `columns` (`kind`, `filter`, `hidden`), `rowActions`,
   `bulkActions` (playbook + `forEach.inputs`), `inspect` (entity page in the drawer), `export` (reports require it).
5. **Declare** `requires.scopes` (exact Graph/ARM permissions), `requires.licences` (`signInLogs`, `conditionalAccess`,
   `pim`, `intune`, `exchange`, `defender`, …) and `nav: { section, label, icon (Phosphor kebab-case), order }`.
6. **Fixtures:** every datasource needs a synthetic fixture so mock mode renders — naming scheme at the top of
   `portal/packages/connectors/src/fixtures.ts`; files under `tests/fixtures/<service>/…`. `Example Org`,
   `example.com`, generated GUIDs only.
7. **Tests:** content tests run automatically; add a focused test file under `tests/content/` only for page-specific
   logic (e.g. a transform), never append to `validate-all.test.ts`.
8. **Check:** `pnpm adminforge validate`, `pnpm --filter @adminforge/tests exec vitest run --project content`,
   `pnpm guard`, then look at it in mock mode (the one-liner in `CLAUDE.md` › Commands) → `/p/<key>`.

## Common mistakes

| Mistake                                              | Fix                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Fetch everything, filter in `transform`              | Push filters to Graph/KQL; keep transforms tiny             |
| Raw `&` concatenation of params into `$filter` / KQL | `$odata()` / `$kql()`; advanced filters via `${ advanced }` |
| Hard-coded tenant ids/domains/SKUs                   | `${env.X}` with a key in `config/example.env`               |
| Missing fixture → blank page in mock mode            | Add the fixture file for every datasource                   |
| `signInActivity` etc. without `requires.licences`    | Declare the licence; the renderer gates and explains        |
