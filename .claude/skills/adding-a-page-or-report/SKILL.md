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
   - Resource Graph returns **computed** booleans as `1`/`0` (`tostring()` gives `True`/`False`); raw `properties.*`
     booleans stay `true`/`false`. Project flags you compare or map as `iff(cond, 'true', 'false')` in the final `project` (keep the boolean for KQL `where`/`order by`), compare with `= 'true'`, show them with `kind: status` (never `kind: boolean`), and make fixtures
     match what Resource Graph really returns. Only `leftouter`/`inner`/`innerunique` joins (≤ 3): use `leftouter` +
     `where isnull(x)` instead of `leftanti`; every union branch must project the columns used after it.
   - Results that can reach thousands of rows: a rows datasource without a transform (transforms have a 250 ms budget)
     plus a second Resource Graph `summarize` query for KPIs; `<ds>.totalRecords` works directly as a KPI.
   - JSONata: `$filter(arr, function($v, $i) { $i < n })`, not `[[a..b]]` (slow on long lists); `$sum([0, …])` so
     empty sums are 0; `$exists(x) = false`, not `$not(x)`; guard comparisons with `$type(x) = 'number'`. Build lookup sets with the grouping constructor (`ids{ $: true }`, then `$lookup`), not `$merge` of many objects or `in` over long lists.
   - Check every new request once against a real tenant, read-only (fixtures can't catch a request Microsoft
     rejects). Graph checks `$select`/`$expand`/`$filter` before licence checks, so even an unlicensed tenant
     confirms the syntax.
   - JSONata: a comparison with a missing field is false — write `$not(isDeleted = true)`, not `isDeleted != true`;
     never sort on a key that can be `null`. Usage reports may conceal names: detect it by the missing `@` in the UPN.
   - Graph patterns: resolve names with `POST /directoryObjects/getByIds` (an allowed read, ≤ 1,000 ids) and skip it
     with `when` when there are no ids (Graph rejects an empty list); wrap id lists in `$append([], …)` because a
     one-element list becomes a single string; read PIM through `graphBatch`; in directory audit events a group's
     name is only in `modifiedProperties`, so filter with `targetResources/any(t:t/id eq …)`.
   - Fixtures: long queries get hashed file names (find them with `fixtureKey()`); add POST fixtures as `variants`
     rather than overwriting a shared file.
   - User input: `$odata()`, `$odataSearch()`, `$kql()`, `$encode()` (validation flags user data in a `path`/`url`
     without `$encode()`, and in `$filter` / `$search` / `$orderby` — query or body — without `$odata()` /
     `$odataSearch()` / `$guid()`, even inside a quoted literal; `$orderby` takes a literal allow-list). `${ }` values in Markdown text show as plain text; links must be http(s), mailto, `/path` or
     `#`. `$eval` is unavailable; ranges are capped at 1,000,000 items and built text at 10 M characters. Advanced filters: declare
     `filters.advanced.fields` and use `${ advanced }`; never read the raw param. Dialect `odata` (Graph) and `kql`
     (Resource Graph / Log Analytics) compile into the request; for sources with no query language (`runner`,
     `static`, `function`) use `dialect: rows` and keep the matching rows in the transform with
     `$applyAdvanced(<rows>, advanced)` (row fields use `.` paths; computed fields work too).
   - Defender advanced hunting: `source: graph`, `method: POST`, `path: /security/runHuntingQuery`,
     `body: { Query: … }` (a read; the KQL lint checks `body.Query` like any query), transform `value.results`,
     `requires.scopes.graph: [ThreatHunting.Read.All]`. Start a `// af:<page id>#<datasource>` comment line so
     fixtures can match it (`bodyIncludes`). A 403 "Account is not provisioned" (incidents, alerts, hunting) means
     Defender XDR isn't set up for the tenant yet, not a bad request — Graph checks `$filter` first (400).
   - Secure Score: improvement actions come from the latest `secureScores` snapshot's `controlScores` (the controls
     that count for the tenant), joined to `secureScoreControlProfiles` for titles and maximum points — the profiles
     also list controls for products the tenant doesn't have. A new tenant has no snapshot for about 48 hours (show
     empty, not 0 %). `implementationCost` / `userImpact` come in mixed case or `Unknown`, and
     `averageComparativeScores[].averageScore` is a percentage.
   - Later datasources may reference earlier ones as `ds.<name>` (declare dependencies above the datasources that use
     them — `validate` refuses references to later ones and loops; the runtime follows the references, never key order,
     because published definitions come back from Postgres) — in a datasource's `when`, request and runner
     `parameters` the prefix is required (a bare `group.id` is undefined there, so the datasource is always skipped;
     `validate` refuses it). Widgets, headers and actions use bare names. A dependency some viewers can't read gets
     `optional: true`: its dependents then see `null` instead of failing (`dependency_failed`) — e.g. Graph's Teams APIs
     (`/teams`, team settings, channels) answer delegated calls only for people who hold a Teams licence. Their results
     carry the failure as `errors["ds.<name>"]`; a scheduled report built on one ends `report_incomplete`. It never
     hides a missing portal role, `policy_denied`, `licence_required` or a sign-in/arming problem anywhere up the chain.
   - Microsoft 365 usage reports answer 404 `UnknownTenantId` until Microsoft starts them (24–48 h after the tenant's
     first subscription). With concealed names (`/admin/reportSettings` `displayConcealedNames`) UPNs and owners are
     hashes (no `@`) and site URLs are empty or hashes: fall back to `siteId`, and only link rows whose URL starts
     with `https://`.
4. **Layout:** widgets exactly as in `docs/widgets.md` (kpi, table, chart, list, keyValue, statusGrid, timeline,
   markdown, actionBar, licenceGate, probeStatus). Tables: `columns` (`kind`, `filter`, `hidden`), `rowActions`,
   `bulkActions` (playbook + `forEach.inputs`), `inspect` (entity page in the drawer), `export` (reports require it).
5. **Declare** `requires.scopes` (exact Graph/ARM permissions), `requires.licences` (`signInLogs`, `conditionalAccess`,
   `pim`, `intune`, `exchange`, `defender`, …) and `nav: { section, label, icon (Phosphor kebab-case), order }`.
   Defender: `defender` = incidents, alerts, email hunting (Office 365 E5 is enough); `defenderEndpoint` = anything on
   devices (`Device*` / `DeviceTvm*` hunting tables, `security.microsoft.com/machines` or `/vulnerabilities` links).
   **Reports** keep `nav: { section: reports, icon, … }` but aren't listed one by one in the rail (the Reports section
   says `listDefinitions: false` and shows "All reports"): they appear in the **Reports catalogue** (`/reports`)
   automatically. There the area is the key's first segment (`identity`, `m365`, `endpoint`, `security`, `azure` — a
   navigation section key), `tags` drive the tag filter and search (give every report specific tags), `summary` is its
   description, `nav.icon` its row icon, `requires` its requirements panel, `export` makes it schedulable, and its
   params become the schedule form (string/number/boolean/enum params without a picker can be set per schedule; the
   others run with their default, so give them sensible defaults). Operators schedule reports from the catalogue
   without YAML (`adding-a-schedule-or-probe` explains when a content schedule is still the right choice).
6. **Fixtures:** every datasource needs a synthetic fixture so mock mode renders — naming scheme at the top of
   `portal/packages/connectors/src/fixtures.ts`; files under `tests/fixtures/<service>/…`. `Example Org`,
   `example.com`, generated GUIDs only.
7. **Tests:** content tests run automatically; add a focused test file under `tests/content/` only for page-specific
   logic (e.g. a transform), never append to `validate-all.test.ts`.
8. **Check:** `pnpm adminforge validate`, `pnpm --filter @adminforge/tests exec vitest run --project content`,
   `pnpm guard`, then look at it in mock mode (the one-liner in `CLAUDE.md` › Commands) → `/p/<key>`.

## Common mistakes

| Mistake                                           | Fix                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| Fetch everything, filter in `transform`           | Push filters to Graph/KQL; keep transforms tiny                                |
| Params in `$filter` / `$search` / KQL unquoted    | `$odata()` / `$odataSearch()` / `$kql()`; advanced filters via `${ advanced }` |
| Hard-coded tenant ids/domains/SKUs                | `${env.X}` with a key in `config/example.env`                                  |
| Missing fixture → blank page in mock mode         | Add the fixture file for every datasource                                      |
| `signInActivity` etc. without `requires.licences` | Declare the licence; the renderer gates and explains                           |
| A report without `tags` or `summary`              | The Reports catalogue filters and searches on them; add both                   |
| A required report param without a default         | Scheduled runs can't fill pickers or dates: give it a default                  |
