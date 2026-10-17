# Widget configuration reference

Every block in a page/dashboard/report `layout:` is a widget. Common keys (validated by `@adminforge/schemas`):

| Key                    | Meaning                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `widget`               | Widget type (below)                                                                                      |
| `id`                   | Optional stable id (`pageKey#id`; reserved for pinning to a personal dashboard, which is in the backlog) |
| `title`, `description` | Panel header text                                                                                        |
| `span`                 | Columns on the 12-column grid (default 12; KPIs default 3)                                               |
| `rows`                 | Height hint in grid rows (charts default 2)                                                              |
| `data`                 | Datasource reference: `<datasource>` or `<datasource>.<path>` (dot path into the result)                 |
| `when`                 | `${ … }` expression; widget is hidden when false                                                         |
| `empty`                | `{ title, body, action? }` shown when data is empty                                                      |

Formats used by several widgets: `number`, `percent`, `bytes`, `duration`, `date`, `datetime`, `relativeTime`, `text`.
Status values everywhere: `ok`, `warn`, `crit`, `info`, `neutral` (always rendered with icon + label).
A `map` turns raw values into status + label: `map: { "true": [ok, Enabled], "false": [crit, Disabled] }`.

## kpi

```yaml
- widget: kpi
  data: counts.members          # a number (or object + `value` field)
  label: Members
  format: number
  status: ${ value > 0 ? 'warn' : 'ok' }   # optional
  delta: counts.membersDelta     # optional number
  href: /p/identity.users?userType=Member  # optional drill-down
```

## table

```yaml
- widget: table
  id: users # table state in the URL is keyed by this id
  data: users.value
  rowKey: id # default: the row's `id`
  selection: multi # none | single | multi
  search: true # free-text box over the loaded rows
  emptyText: No users match # used when the block has no `empty`
  columns:
    - { field: displayName, label: Name, kind: identity, secondary: userPrincipalName, filter: text }
    - { field: accountEnabled, label: Enabled, kind: boolean }
    - { field: id, label: Object id, kind: guid, hidden: true }
  rowActions:
    - playbook: identity.disable-user
      label: Block sign-in
      inputs:
        userId: ${ row.id }
  bulkActions:
    - playbook: identity.add-group-members
      label: Add to group
      forEach:
        inputs:
          userIds: ${ [row.id] }
  inspect:
    page: identity.user
    params:
      id: ${ row.id }
```

Validated in detail by the schema (`TableWidgetConfig` in `portal/packages/schemas/src/widgets.ts`).

Column `kind` (default `text`):

| Kind           | Renders                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`         | Plain text                                                                                                                                                                                            |
| `identity`     | Primary text plus a second line from `secondary` (a field path)                                                                                                                                       |
| `status`       | Icon + label from `map` (`value: [tone, label]` or `{ tone, label }`)                                                                                                                                 |
| `relativeTime` | "3 days ago", exact time on hover                                                                                                                                                                     |
| `datetime`     | Short timestamp                                                                                                                                                                                       |
| `date`         | Date only                                                                                                                                                                                             |
| `number`       | Formatted number, right-aligned                                                                                                                                                                       |
| `percent`      | A fraction as a percentage (0.42 → 42%)                                                                                                                                                               |
| `bytes`        | Human-readable size                                                                                                                                                                                   |
| `boolean`      | Yes / No (facet filter by default). Only for real JSON booleans (Graph, ARM, raw Resource Graph properties); computed KQL flags arrive as 1/0 — send them as `'true'`/`'false'` text and use `status` |
| `guid`         | Id chip (keyValue fields call this kind `id`)                                                                                                                                                         |
| `tags`         | Chips from a list or an object (`{ env: prod }` → `env: prod`)                                                                                                                                        |
| `link`         | Link to `link: { page, params }` (templated with `row`), or to a URL value (new tab)                                                                                                                  |
| `code`         | Monospace text                                                                                                                                                                                        |

Other column keys: `sortable`, `hidden` (off by default; still in the column chooser and exports), `width` (px),
`align: start|center|end`. Column `filter`: `text`, `facet`, `range`, `date`, or `{ type, param }` to bind it to a page
param (server-side filtering).

Table options:

- `selection`: `multi` always shows row checkboxes; `single` shows them but allows one row at a time (no "select
  all"), for actions that act on exactly one item; `none` never shows them; unset shows them only when the table has
  `bulkActions`.
- `search`: show the free-text box that filters the loaded rows. Default: on, unless the page binds a server-side
  search param (`filters.search`).
- `pageSize`: 10–1000, accepted for compatibility but has no effect: tables are virtualised and load further pages with
  "Load more" (docs/decisions.md).
- `emptyText`: the empty-state title (default "Nothing to show"); a block-level `empty: { title, body }` wins over it.
- `rowKey` (row id path, default `id`), `rowActions`, `bulkActions` (`forEach.inputs`, `concurrency` 1–10, default 5;
  `maxItems` default 100), `inspect`, plus `sort` and `maxHeight` (see Optional keys below).

## chart

```yaml
- widget: chart
  type: line # line | area | bar | stackedBar | donut | heatGrid
  data: signins.value
  x: day # category/time field
  y: [succeeded, failed] # one field or a list (one series each)
  series: status # alternative to y-list: split rows by a field
  format: number
  stack: true # bar/area
```

Rules: one y-axis; ≤ 6 series (more fold into "Other"); donut ≤ 6 slices; a "Table" toggle is always available.

## list

```yaml
- widget: list
  data: incidents.value
  primary: displayName
  secondary: createdDateTime # optional; rendered with `secondaryFormat`
  secondaryFormat: relativeTime
  status: { field: severity, map: { high: [crit, High], medium: [warn, Medium], low: [info, Low] } }
  href: ${ '/p/security.incident?id=' & row.id }
  limit: 8
```

## keyValue

```yaml
- widget: keyValue
  data: user
  fields:
    - { field: userPrincipalName, label: UPN, kind: id }
    - {
        field: accountEnabled,
        label: Sign-in,
        kind: status,
        map: { 'true': [ok, Allowed], 'false': [crit, Blocked] },
      }
    - { field: createdDateTime, label: Created, kind: datetime }
```

## statusGrid

```yaml
- widget: statusGrid
  data: health.value
  label: service
  status: status
  map:
    {
      serviceOperational: [ok, Healthy],
      serviceDegradation: [warn, Degraded],
      serviceInterruption: [crit, Interrupted],
    }
  default: [info, Advisory]
```

## timeline

```yaml
- widget: timeline
  data: audit.value
  ts: activityDateTime
  title: activityDisplayName
  detail: ${ initiatedBy.user.userPrincipalName }
  status: { field: result, map: { success: [ok, Success], failure: [crit, Failure] } }
```

## markdown

```yaml
- widget: markdown
  text: |
    Explain what this page shows, what to do, and links to runbooks.
```

## actionBar

```yaml
- widget: actionBar
  actions:
    - { playbook: identity.disable-user, label: Disable sign-in, inputs: { userId: ${ params.id } } }
    - { href: https://entra.microsoft.com/, label: Open in Entra admin center, external: true }
```

## licenceGate

Shown instead of content when a feature isn't licensed (from `/api/me/capabilities`):

```yaml
- widget: licenceGate
  feature: intune # conditionalAccess | pim | identityProtection | intune | exchange | teams | sharepoint | defender | defenderEndpoint | signInLogs
  title: Intune isn't licensed in this tenant
```

Pages may also set top-level `requires.licences: [intune]`; the renderer then shows a gate above the page and keeps fixture previews available in mock mode.
A service plan name (`WINDEFATP`) resolves to the most specific feature that lists it (`defenderEndpoint`, not `defender`);
prefer the feature key.

## probeStatus

```yaml
- widget: probeStatus # latest result + sparkline per probe (synthetic monitoring)
  probes: [graph-reachability, arm-reachability] # omit for all
```

## Optional keys (beyond the examples above)

- **kpi**: `field` (number inside an object result, default `value`), `unit`, `statusLabel` (template; default by tone), `deltaFormat`, `deltaGood: up|down` (default up), `deltaPeriod`, `trend` (datasource path of a number list → sparkline), `hint` (template).
- **table**: `sort: { field, desc? }` (initial sort when the URL has none), `maxHeight` (px). Column filters bound to a param (`filter: { type, param }`) appear in the page filter bar, not on the column.
- **chart**: `labels` (display names for y fields or series values), `xLabel` (category column header in the Table view). Bar charts with long category names render horizontally.
- **list / statusGrid / timeline**: field-or-template keys (`primary`, `secondary`, `detail`, `title`) see the row's fields at the root as well as `row`. Values that contain HTML are shown as plain text.
- **keyValue**: field `format`, `href` (for `kind: link`; a template), `columns: 1|2|3`. Without `href`, a `link` field links its value as written (never evaluated as a template) and only when it's an external URL (http(s) or mailto) — in-app targets need `href`. `kind: tags` accepts a list or an object (`{ env: prod }` → `env: prod`).
- **statusGrid**: `detail` (second line), `href`, `sort: severity|none` (default severity).
- **timeline**: `title` is the per-event title, so the panel heading is `heading`; `limit` (default 20).
- **licenceGate**: `body` (what the page would show).
- **markdown**: `text` may contain `${ … }` (page scope); inserted values are plain text, never HTML.
- `percent` values are fractions (0.42 → 42%).

## Partial data

When a datasource reads only part of what Microsoft has — `paging: all` stopped at its `maxItems` (or the page limit),
or a `graphBatch` collection answered with its first page — the API marks the result `truncated` and the renderer adds
a note under the widget ("Partial data: Microsoft has more than this view reads…"), once per KPI strip. Nothing to
configure for widgets bound to that datasource; a derived datasource (`source: static` built from `ds.<name>`) doesn't
carry the mark — its transform passes it on (`ds.<name>.truncated` when that datasource has no transform, else a flag
its transform returns from `value.truncated`) and the page shows its own markdown note. A page that should show
everything pages through the server (`paging: cursor`) or counts at the source (`$count`) instead of raising
`maxItems`.

## Page URLs (renderer)

`/p/<key>` renders any page, dashboard or report. The URL carries:

- page params by name (`?userType=Guest&days=90`; defaults are omitted);
- table state per table block id: `<id>.sort=-field,other`, `<id>.cols=a,b,c` (visible columns in order), `<id>.density=compact`, `<id>.q=text`, `<id>.f={"col":["A"]}`;
- `view=<saved view id>`, `tab=<tab id>`;
- the inspector: `inspect=page:<entity page key>&i.<param>=…` (its tab: `itab`). The inspector drawer is
  `--af-layout-inspector-wide-factor` (3) × the standard drawer width, but never over the navigation rail
  (`--af-layout-inspector-wide-w` and its `-nav-collapsed` twin). When that leaves less than 24rem of the list beside
  it, it covers the list — a light scrim that closes it, the page inert, Escape still closes; on wider screens it stays
  beside the list and rows switch what it shows. "Open full page" is in its header and opens the inspector's tab. The
  entity page's widgets (and KPI strips) keep their `span`s and columns once the drawer is at least 56rem wide
  (container query) and stack below that;
- the playbook drawer: `playbook=<key>&inputs=<base64url JSON>` or, for bulk actions, `&items=<base64url JSON array>` (one inputs object per selected row; see `apps/web/src/playbooks/url.ts`).
