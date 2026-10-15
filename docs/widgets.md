# Widget configuration reference

Every block in a page/dashboard/report `layout:` is a widget. Common keys (validated by `@adminforge/schemas`):

| Key                    | Meaning                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `widget`               | Widget type (below)                                                                      |
| `id`                   | Optional stable id (needed to pin a widget to "My dashboard": `pageKey#id`)              |
| `title`, `description` | Panel header text                                                                        |
| `span`                 | Columns on the 12-column grid (default 12; KPIs default 3)                               |
| `rows`                 | Height hint in grid rows (charts default 2)                                              |
| `data`                 | Datasource reference: `<datasource>` or `<datasource>.<path>` (dot path into the result) |
| `when`                 | `${ … }` expression; widget is hidden when false                                         |
| `empty`                | `{ title, body, action? }` shown when data is empty                                      |

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

Validated in detail by the schema (`columns`, `rowKey`, `rowActions`, `bulkActions`, `inspect`, `selection`). Column `kind`: `text`, `identity` (primary + `secondary` field), `status` (with `map`), `relativeTime`, `datetime`, `number`, `id` (IdChip), `tags`, `link`, `bytes`, `percent`. Column `filter`: `text`, `facet`, `range`, `date`, or `{ param: <name> }` to bind to a page param (server-side filtering).

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
  feature: intune # conditionalAccess | pim | identityProtection | intune | exchange | teams | sharepoint | defender | signInLogs
  title: Intune isn't licensed in this tenant
```

Pages may also set top-level `requires.licences: [intune]`; the renderer then shows a gate above the page and keeps fixture previews available in mock mode.

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
- **keyValue**: field `format`, `href` (for `kind: link`), `columns: 1|2|3`. `kind: tags` accepts a list or an object (`{ env: prod }` → `env: prod`).
- **statusGrid**: `detail` (second line), `href`, `sort: severity|none` (default severity).
- **timeline**: `title` is the per-event title, so the panel heading is `heading`; `limit` (default 20).
- **licenceGate**: `body` (what the page would show).
- **markdown**: `text` may contain `${ … }` (page scope); inserted values are plain text, never HTML.
- `percent` values are fractions (0.42 → 42%).

## Page URLs (renderer)

`/p/<key>` renders any page, dashboard or report. The URL carries:

- page params by name (`?userType=Guest&days=90`; defaults are omitted);
- table state per table block id: `<id>.sort=-field,other`, `<id>.cols=a,b,c` (visible columns in order), `<id>.density=compact`, `<id>.q=text`, `<id>.f={"col":["A"]}`;
- `view=<saved view id>`, `tab=<tab id>`;
- the inspector: `inspect=page:<entity page key>&i.<param>=…` (its tab: `itab`);
- the playbook drawer: `playbook=<key>&inputs=<base64url JSON>` or, for bulk actions, `&items=<base64url JSON array>` (one inputs object per selected row; see `apps/web/src/playbooks/url.ts`).
