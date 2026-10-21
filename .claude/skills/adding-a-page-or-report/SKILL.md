---
name: adding-a-page-or-report
description: Use when asked to add or change an AdminForge page, dashboard, entity/detail view, list, or exportable report (anything shown under /p/<key>), including new columns, filters, facets, KPIs, charts, row or bulk actions, or a new navigation section for a service.
---

# Adding a page or report

## Overview

Pages, dashboards and reports are YAML in `portal/content/{pages,dashboards,reports}/<prefix>/` — the folder is the id
prefix (`portal/content/README.md`). The generic renderer
(`/p/$key`) and the datasource executor do the rest: **no React for a new page**. Widget keys are in `docs/widgets.md`;
the expression helpers, JSONata habits, Microsoft quirks and fixture rules are in `docs/content-recipes.md`.

## When not to use

- A change to the tenant → `adding-a-playbook` (the page only offers it as a row, bulk or bar action).
- An existing report delivered by e-mail, Teams or file → nothing to build: Operators schedule it in the portal
  (Reports → the report → Schedule). Anything else unattended → `adding-a-schedule-or-probe`.
- A screen the renderer can't express (runs, schedules, Query Studio) → `adding-a-coded-screen`; a visualisation the
  widgets can't → `adding-a-widget`; data only PowerShell returns → `adding-a-runner-script`, then `source: runner`.

## Steps

1. **Reuse first.** `pnpm adminforge list --section <section> --kind page,dashboard,report` (or `--search "<topic>"`)
   and `rg -l "<topic>" portal/content`. If a page already covers it, extend it and bump `version` (minor for
   additions).
2. **Scaffold:** `pnpm adminforge new page <prefix>/<name> --template list-detail|dashboard|entity|report` (reports:
   `new report …`); the prefix is the section the page belongs to, and `validate` refuses a file outside the folder
   its id names. Keep the `$schema` line — VS Code autocompletes from it.
3. **Datasources** — `source: graph|graphBatch|arm|resourceGraph|logAnalytics|function|runner|static`:
   - Filter and count **at the source** (`$filter`, `$select`, `$top`, `$count`, KQL `where` / `summarize`), not in
     `transform`: transforms run on the API thread with a 250 ms budget. Tenant-wide questions that would need many
     Graph calls → KQL. Lists that can reach thousands of rows get no per-row transform and their numbers from a
     second query (`docs/content-recipes.md` › Big lists, exports and partial data).
   - **User data** goes through `$encode()` / `$odata()` / `$odataSearch()` / `$kql()` / `$guid()`, placed as
     `docs/content-recipes.md` › Quoting user data shows; validation follows it through wrappers, lambdas and
     variables. Advanced filters: declare `filters.advanced.fields` and use `${ advanced }`.
   - **Resource Graph joins** (Azure refuses the rest; `validate` checks it — `resourceGraphJoinProblem` in
     `portal/packages/schemas/src/datasource.ts`): no leading `union`; only `leftouter` / `inner` / `innerunique` joins
     (`leftouter` + `where isnull(x)` instead of `leftanti`); at most three `join` + `union` together; only **one**
     join to another table, unless every one is `resources` ↔ `resourcecontainers`; a `union` stays in one table or
     that pair, and every branch projects the columns used after it. Subscription names and split queries:
     `docs/content-recipes.md` › Resource Graph.
   - Every Resource Graph or Log Analytics query starts with a `// af:<page id>#<datasource>` line (fixtures match on
     it).
   - `ds.<name>` references: declare a dependency above the datasources that use it (`validate` refuses references to
     later ones and loops). In a datasource's `when`, request and runner `parameters` the `ds.` prefix is required;
     widgets, headers and actions use bare names. A dependency some viewers can't read gets `optional: true`: its
     dependents see `null` (and `errors["ds.<name>"]`; a scheduled report ends `report_incomplete`) — it never hides a
     missing portal role, `policy_denied`, `licence_required` or a sign-in or arming problem.
   - Widget, header and action expressions (`when`, `href`, `text`, `hint`) run **in the browser**, where `env` is
     always empty: read configuration in a `source: static` datasource (`docs/content-recipes.md` › Configuration in
     browser expressions).
   - **Out of scope: the Microsoft Defender portal** (owner decision 2026-10-17) — incidents, alerts, advanced hunting,
     Secure Score and device vulnerabilities (`/security/…`, `source: advancedHunting`, the `defender` /
     `defenderEndpoint` licences). That content is retired and `tests/content/retired-content.test.ts` refuses any
     active definition that reads it. Defender **for Cloud** through Resource Graph and Entra ID Protection stay.
4. **Layout** — widgets and their keys exactly as in `docs/widgets.md`. Tables: `columns` (`kind`, `filter`, `hidden`,
   `wrap: true` for messages), `rowActions`, `bulkActions` (playbook + `forEach.inputs`), `inspect` (an entity page in
   the drawer), `export` (reports require it).
   - `kind: status` is for a value that is fine or not (at least one value maps to `ok`, `warn` or `crit`); a plain
     category — a type, a source, a computed `'true'`/`'false'` flag with no good or bad — is `kind: enum`
     (`map: { "true": "On", "false": "Off" }`; `tests/content/status-tones.test.ts`).
   - `rowKey` is unique per row: a table grouped by several columns gets a composite key in the query.
   - KPI labels: about 22 characters a line, two lines at `span: 2`; a hint after a status pill is cut off — keep it to
     two or three words or leave it out (`docs/widgets.md` › kpi).
   - Entity pages declare `entity: user|group|device|app|resource` and take an `id` param; one page per kind, and all
     five are taken (`tests/unit/api/search-entity-pages.test.ts`). A new entity page gets a sample id in
     `SAMPLE_PARAMS` (`tests/content/fixtures-complete.test.ts`).
5. **Declare** `requires.scopes` (exact Graph/ARM permissions), `requires.licences` (`signInLogs`,
   `conditionalAccess`, `pim`, `intune`, `exchange`, …), `requires.portalRoles` where Readers shouldn't see it,
   `nav: { section, label, icon (Phosphor kebab-case), order }`, specific `tags` and a `summary`. **Reports** keep
   `nav.section: reports` and appear in the Reports catalogue (`/reports`) on their own, under their `area:` (else the
   key's first segment) — always a navigation section key. Move a report with `area:` and a page with `nav.section`,
   never by renaming its key (schedules, links and saved views use it). `export` makes a report schedulable and its
   params become the schedule form: give required ones defaults.
6. **A new navigation section** (as `avd`, `billing`, `exchange` were added): a section in
   `portal/content/navigation.yaml` (bump its `version`); keys `<key>.*`; an Overview dashboard `<key>.overview`
   (`nav.order: 5`) with a `probeStatus` widget `group: <key>` and a markdown block linking its pages and reports;
   reports with `area: <key>`; probes with `group: <key>` — the section's row in the navigation then shows their
   status and links to `/monitoring?group=<key>` (no "Service checks" item); a section in `docs/operations.md` and its
   roles in `docs/access.md`. `avd` is the full example; `billing` is reports-only.
7. **Fixtures:** a synthetic fixture for every datasource (`docs/content-recipes.md` › Fixtures);
   `tests/content/fixtures-complete.test.ts` renders every active page from them.
8. **Tests:** content tests run on their own. Add a new file under `tests/content/` only for page-specific logic (a
   transform) — never append to `validate-all.test.ts`. A transform that can see many rows also gets
   `tests/content/content-at-scale-<area>.scale.test.ts` (the `scale` project).
9. **Lifecycle:** bump `version` on every change; `preview: true` while the page is checked only against fixtures;
   retire with `status: retired`, never delete (`docs/content-recipes.md` › Versions, previews and retiring).
10. **Check:** `pnpm adminforge validate`, `pnpm --filter @adminforge/tests exec vitest run --project content`,
    `pnpm guard`; then `/p/<key>` in mock mode (`CLAUDE.md` › Commands) in steel and daylight. Run every new request
    once against a real tenant, read-only (`validating-against-a-tenant`) — fixtures can't catch a request Microsoft
    rejects.

## Done when

- [ ] `pnpm adminforge validate`, the content project and `pnpm guard` are clean
- [ ] The page renders in mock mode from synthetic fixtures and you looked at it in steel and daylight: KPI labels
      whole, no empty widgets, no alert banners
- [ ] `version` bumped on every changed definition; `requires`, `nav`, `tags` and `summary` set
- [ ] Every new request ran once live, read-only — or the page is `preview: true` and `docs/licensing-review.md` /
      `docs/backlog.md` say what is unchecked
- [ ] `content-reviewer` ran and its findings are fixed or answered

## Common mistakes

| Mistake                                                    | Fix                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Fetch everything, filter in `transform`                    | Push filters to Graph/KQL; keep transforms tiny                                |
| Params in `$filter` / `$search` / KQL wrapped or unquoted  | `$odata()` / `$odataSearch()` / `$kql()` where the value lands                 |
| Hard-coded tenant ids, domains or SKUs                     | `${env.X}` with a key in `config/example.env`                                  |
| Missing fixture → blank page in mock mode                  | A fixture for every datasource; `fixtures-complete.test.ts` names the gap      |
| `signInActivity` etc. without `requires.licences`          | Declare the licence; the renderer gates and explains                           |
| A report without `tags` or `summary`                       | The Reports catalogue filters and searches on them; add both                   |
| A required report param without a default                  | Scheduled runs can't fill pickers or dates: give it a default                  |
| Two joins to other Resource Graph tables                   | One cross-table join per query; names via a `resourcecontainers` + `$attach`   |
| `env.X` in a widget, header or action expression           | Always empty (browser): read it in a `source: static` datasource               |
| A category shown as a neutral status pill                  | `kind: enum`; `status` only when a value is fine or not                        |
| Shipping a page checked only against fixtures, unannounced | `preview: true` (+ version), removed once it works live                        |
| Deleting content you no longer need                        | `status: retired` + version bump, a `Retired — …` summary; remove active links |

## See also

- `docs/content-recipes.md` — quoting, helpers, JSONata habits, Graph / Resource Graph / ARM quirks, fixtures,
  lifecycle
- `docs/widgets.md` — every widget key; `docs/onboarding/08-content-guide.md` — the content model for people
- `adding-a-playbook`, `adding-a-schedule-or-probe`, `validating-against-a-tenant`
