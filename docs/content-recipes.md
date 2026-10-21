# Content recipes

How-to reference for content authors and for Claude Code: quoting user data, the expression helpers, JSONata habits
that scale, the Microsoft quirks fixtures can't show, fixtures and the content lifecycle. The rules themselves live in
`CLAUDE.md` (the non-negotiables) and in the skills under `.claude/skills/` (one per extension point); widget keys are in
`docs/widgets.md`. This page holds the detail they link to. Learned something the hard way? Add the recipe here, once,
and link to it.

## Quoting user data

User data is anything a person or the tenant controls: page params (except `enum` params, whose values are a literal
allow-list), playbook inputs, rows and items (`row`, `item`, `forEach` items), a transform's `value`, a datasource's
result (`ds.<name>`, per field — a Microsoft response is tenant data), a step's output and `advanced` on
`dialect: rows` pages. Encode it where it lands:

- **Request path or url segment:** `/users/${ $encode(params.id) }`.
- **OData `$filter`, `$orderby`, `$expand`** (query or body, `filter`/`orderby`/`expand` without the `$` too, and the
  query string of a `$batch` url): `name eq ${ $odata(params.q) }` — `$odata()` brings its own quotes, so it goes
  outside yours. `$orderby` takes a literal allow-list (`params.sort in ['displayName', 'createdDateTime'] ? … : …`).
- **Graph `$search`:** `"displayName:${ $odataSearch(params.q) }"` — inside the `"…"`.
- **KQL:** `| where name contains ${ $kql(params.q) }` — outside quotes.
- **Object ids anywhere:** `$guid(x)` (refuses anything that isn't a GUID).

`adminforge validate`, `publish` and the content-health check run a taint analysis
(`portal/packages/expressions/src/taint.ts`) over every expression. It follows user data through functions
(`$lowercase`, `$trim`, `$string`, `$join`), function values and lambdas (`$map`, `~>`), variables and object or array
constructors, so wrapping doesn't help. An encoder counts only in its own kind of text and position, and a value taken
apart again (`$substring`, `$replace`, `$split`) is user data again. A `$replace` character allow-list counts only
inside a quoted literal. Never strip characters with `$replace` to make a value "safe": it changes what was searched
for.

- A whole `path` may be a `guid` or entity param (`type: user|group|device|app|resource`) as it is.
- A whole KQL query the person typed needs the explicit opt-in `${ /* adminforge: user-query */ params.kql }`.
- Encode a value once in a `source: static` datasource's transform and reuse it: taint is tracked per field, so
  `ds.scope.path` (encoded there) is clean while `ds.scope.label` (the param as it came) is not.
- Assign variables (`$x := …`) only as a block statement, the whole expression or a function body.
- **Writes that name a user** (a `mode: write` step, a changing `$batch` request, any `compensate`): the segment after
  `/users/` — in the path, a `$id` query or an `@odata.id` / `…@odata.bind` reference — is `$guid(…)`, even for an id
  an earlier step returned: `/users/${ $encode($guid(inputs.userId)) }`. Look a UPN up in a `mode: read` step first.
  `validate` refuses anything else and the API refuses such a write (`user_not_by_id`).
- **Advanced filters:** declare `filters.advanced.fields` and use `${ advanced }`; never read the raw param. Dialect
  `odata` (Graph) and `kql` (Resource Graph, Log Analytics) compile into the request; sources with no query language
  (`runner`, `static`, `function`) use `dialect: rows` and keep the matching rows in the transform with
  `$applyAdvanced(<rows>, advanced)` (row fields use `.` paths; computed fields work too).
- `${ }` values in Markdown text show as plain text. Templated links (`href`, Markdown) open only `https://`,
  `http://`, `mailto:`, an in-app `/path` (never `//host` or `/\host`) or `#anchor`; anything else shows as text.
- `$eval` is unavailable; ranges are capped at 1,000,000 items and built text (`$join`, `&`) at 10 million characters.
- Content can't set the headers AdminForge owns on a Microsoft call (`Authorization`, `Cookie`, `Proxy-Authorization`,
  `Host`, `client-request-id`, `x-ms-client-request-id`, in any case): validate refuses them.

## Expression helpers

Registered in `portal/packages/expressions/src/helpers.ts` (`HELPER_NAMES`) and available in every expression, on the
server and in the browser. The row helpers run natively (not in JSONata), fast enough for tens of thousands of rows
within a transform's 250 ms budget; they read own properties only (never into functions) and take at most 64 fields or
paths a call. Adding one is the `adding-an-expression-helper` skill.

### Quoting, ids, dates and secrets

- `$encode`, `$odata`, `$odataSearch`, `$kql`, `$guid` — see Quoting user data.
- `$uuid()`: a fresh GUID (role assignment names). `$secureRandom(n, alphabet?)`: `n` (1–256) characters from a
  cryptographic source with every character class of the alphabet from 8 characters on — an initial password (declare
  the step's `secretOutputs`).
- `$daysAgo(n)` (an ISO timestamp `n` days before now), `$iso(v?)` (a date as ISO; now without an argument),
  `$daysUntil(v)` (whole days until a date, negative when past). All read the evaluation's `now`, which tests pin.

### Filtering rows: `$applyAdvanced`

`$applyAdvanced(rows, { "join": "and", "clauses": [...] })` keeps the rows a filter matches, in one native pass.

- Ops: `eq ne gt ge lt le startsWith contains notContains in notIn isEmpty notEmpty`. `in` over a long list is a set
  lookup here (and only here).
- `field` (+ `times`, a finite number) compares two fields of a row; on dates `"field": "startDateTime", "days": 365`
  shifts the other field instead (`days` replaces `times`).
- Paths are `.`-separated names and read through lists (`passwordCredentials.endDateTime` matches when any credential
  does) — no `[n]` indexes and no keys that contain a dot (`@odata.type`).
- `isEmpty` / `notEmpty` look at plain values (null, `''`, a list without items; an object is never empty). A row
  without the field matches only the negated operators (`ne`, `notContains`, `notIn`) and `isEmpty`; so does a row
  without the other field of a `field` comparison. Build "the rest" as a complement by key (`notIn`), not with the
  opposite operator.
- Several texts in one condition: `containsAny` / `startsWithAny` / `notContainsAny` / `notStartsWithAny` with
  `"type": "string"` and a list `value` (≤ 256 literal texts of ≤ 256 characters, case ignored; a filter holds ≤ 64
  conditions) — one pass over a field (a list path too) instead of one clause per text. Use them over a URI list path
  rather than `$unnest`-ing every URI; unnest only the few rows that need a per-item check
  (`identity.app-registration-risks`).

### Labelling, capping and joining

- `$withFields(rows, { "state": "x" })`: each row with fields added (label a subset).
- `$take(rows, n)`: the first `n` rows (cap a list).
- `$pluck(rows, 'a.b')`: every value at a path, lists on the way read item by item (not a list directly inside a
  list), nulls skipped; `$distinct($pluck(grants, 'principalId'))` lists ids.
- `$unnest(rows, 'licenseAssignmentStates', 'st', 'key')`: one row per item under `st`; rows with a missing or empty
  list are dropped. The new rows leave the list out (a dotted path copies the objects along it without the list;
  through another list on the way its first field is dropped). The optional `key` field is unique:
  `<id>:<path>:<n>` (`#<n>` for a numeric id, `@<position>` without one).
- `$attach(rows, 'skuId', lookup, defaults?, as?)`: joins a lookup built once per distinct value
  (`$names := $skus{ skuId: { "sku": skuPartNumber } }`). Merged, the entry's fields overwrite the row's (any key but
  `_jsonata…`); with `as` it is nested under that name. A list of paths with a list of names joins several ids in one
  copy. Values are compared as text (1 joins "1"). An entry must be an object: group only rows that have the key
  (`notEmpty` first); a key that repeats holds a list and the row gets the default, so keep one per key (split on
  `$withCount(…)` `n eq 1`, group the rest with `{ k: $[0] }`).
- `$pick(rows, ['id', 'displayName'])`: top-level fields only (keeps joined objects and exports small).
- `$withCount(rows, 'appId', 'n')`: each row with how many rows share its value (as text, like `$attach`).
- `$idsWhere(rows, 'id', { "publicClient": filter, … })`: the ids (texts, numbers, true/false) each
  `$applyAdvanced`-style filter matches, all filters in one pass — for many findings over the same rows. Names that
  share one filter object share its work.
- `$flagIn(rows, 'id', { "publicClient": [ids…], … })`: each row copied once with one true/false field per set (then
  pick severities with boolean filters, no id lists through JSONata).

Each `$withFields` / `$attach` / `$unnest` pass copies every row: classify with `$applyAdvanced` first and label only
the subsets you show; build a list in its display order (most severe subset first) rather than sorting tens of
thousands of rows.

### Columnar answers: `$tableRows`, `$withShare`

- `$tableRows(table, names?)`: the rows of a columnar answer (`{ columns, rows }`, as Cost Management and Log Analytics
  tables return them) as objects; `names` picks and renames columns (`{ "cost": "Cost", "group": "ServiceName" }`).
- `$withShare(rows, 'cost', 'share')`: each row with its share of the total (0 when the total is 0).

## JSONata habits

- **Cost.** JSONata costs about 15 µs per operation and row (a filter, a `$merge`); a mapped row with ten fields is
  about ten operations, so a per-row mapping fits only about 1,500 rows in the 250 ms budget. Use the native helpers and
  show Graph's own fields in columns instead of remapping every row (columns take dotted and `[n]` paths, and exports
  read them the same way — `docs/widgets.md` › table).
- **Slices.** `$take(arr, n)`, or a slice right after a sort (`rows^(x)[[0..9]]`) — never `[[a..b]]` on a variable
  (quadratic). Sort before you cap (`$take(rows^(<date>), n)`), and never sort on a key that can be empty or `null`:
  split the rows with `isEmpty` / `notEmpty` first.
- **Native grouping and sorting.** The grouping constructor (`rows{ id: … }`) and `^( … )` run natively when their
  source is a plain path or variable and the keys and values don't use `$$`, `%`, `#` or `@`; otherwise (a function
  call, a block or a condition as the source) JSONata runs them, about 15 µs a row.
- **Missing values.** A comparison with a missing field is false: write `$not(isDeleted = true)`, not
  `isDeleted != true`, and `$not(x = 'a')`, not `x != 'a'`. `$exists(x) = false`, not `$not(x)`. `$exists(null)` is
  true: leave an optional value undefined (`$d ? x`, no `: null`). `$boolean(undefined)` and `$not(undefined)` are
  undefined, so `$not(params.x)` on a param that wasn't given never counts as true: write `params.x ? false : true`.
- **Sums and types.** `$sum([0, …])` so an empty sum is 0; guard comparisons with `$type(x) = 'number'`.
- **Lists of one.** A one-element list becomes a single value: wrap id lists in `$append([], …)`.
- **Filters.** Inside a filter (`$list[…]`) a bare name reads the item: take `now` out into a variable first.

## Big lists, exports and partial data

- **Thousands of rows:** a rows datasource without a transform (the export then streams, page by page) plus a second
  query for the numbers — a Resource Graph `summarize`, Graph `$count` with `ConsistencyLevel: eventual`, or a summary
  report. `<ds>.totalRecords` works directly as a KPI. Page Graph lists with `paging: cursor`. Fold a long tail in KQL
  (top 5 regions + "Other"), not with a JSONata slice of a variable. A collection datasource **with** a transform is
  collected up to its `maxItems` before it exports.
- **A table capped at 10,000 rows that still exports every row:** the list datasource returns the whole sorted list
  (`export.data: <list>.rows`, `export.maxRows` = its `maxItems`) and the page binds its widgets to a `source: static`
  view of it — `${ $merge([value, { "rows": $take(value.rows, 10000), "listCapped": $count(value.rows) > 10000 }]) }`
  — so the browser gets 10,000 rows (`m365.mailbox-storage`: `mailboxList` → `mailboxes`).
- **A list too big for one transform:** a list datasource for the export plus a page view that labels only the first
  rows it shows (`identity.app-credential-hygiene`: `page` / `exportList`). Each datasource has its own budget, but a
  page view built from a list datasource still runs that list on every page load.
- **Partial data.** Over a cap, `paging: all` marks the result `truncated` and the renderer notes it under that
  datasource's own widgets. A derived datasource (`source: static` built from `ds.X`) doesn't carry it: pass it on
  (`ds.X.truncated` when X has no transform; otherwise X's transform returns `"partial": value.truncated = true`) and
  show a markdown note when it is set — never say the counts "include every …" without that check. The export can't
  say it was cut, so the note matters (`docs/widgets.md` › Partial data).
- **Measure:** `AF_PERF_ONLY=<key> pnpm test:perf` (`tests/perf`, a synthetic 100,000-user tenant), and a
  `tests/content/content-at-scale-<area>.scale.test.ts` for a transform that can see many rows (the `scale` project,
  one file at a time: an untimed warm-up, then the real budget on the largest answer the query can return —
  `content-at-scale-arc.scale.test.ts`, `content-at-scale-subscription-names.scale.test.ts`).

## Configuration in browser expressions

Widget, header and action expressions (`when`, `href`, `text`, `hint`) run in the browser, where `env` doesn't exist
(only datasources, `params`, `user`, `now`): `env.X` there is always empty, and `validate` doesn't catch it yet. Read
configuration in a `source: static` datasource and pass on only the answer: `workspace: { configured: … }` in
`avd.connections`, whose `when: ${ workspace.configured = false }` shows the "not configured" note. Content reads only
the `AF_*` keys `config/example.env` declares, minus secret-looking names (`adding-a-configuration-key`).

## Microsoft Graph

- **Names for ids:** `POST /directoryObjects/getByIds` (an allowed read, ≤ 1,000 ids), skipped with `when` when there
  are no ids (Graph rejects an empty list). More than 1,000 ids: one datasource per 1,000, each taking its slice with a
  native sort and slice — `$pluck((ds.x.rows^(<unique field>))[[1000..1999]], 'id')` — and `when` that slice has ids
  (`m365.shared-mailboxes`: `accounts1`…`accounts5`, merged with `$attach`).
- **PIM** reads go through `graphBatch`.
- **Directory audit events:** a group's name is only in `modifiedProperties`, so filter with
  `targetResources/any(t:t/id eq …)`.
- **Teams** (`/teams`, team settings, channels) answers delegated calls only for people who hold a Teams licence: make
  such a dependency `optional: true`.
- **Syntax before licences:** Graph checks `$select`, `$expand` and `$filter` before licences, so even an unlicensed
  tenant confirms a request's syntax.
- **Microsoft 365 usage reports** answer 404 `UnknownTenantId` until Microsoft starts them (24–48 h after the tenant's
  first subscription). With concealed names (`/admin/reportSettings` `displayConcealedNames`) UPNs and owners are hashes
  (no `@` — that is how to detect it) and site URLs are empty or hashes: fall back to `siteId`, and only link rows whose
  URL starts with `https://`.

## Resource Graph

The join and union limits are in `CLAUDE.md` (non-negotiable 14) and the `adding-a-page-or-report` skill; these are
the ways around them.

- **No leading `union`:** pipe instead — `resources | where … | union (resourcecontainers | where …)` (resource groups
  and subscriptions live in `resourcecontainers`).
- **Subscription names for rows that already join another table** (`patchassessmentresources`,
  `recoveryservicesresources`, `desktopvirtualizationresources`, …): a small `resourcecontainers` datasource (with the
  page's subscription filter) joined natively in the rows' transform —
  `${ value.value ? $merge([value, { 'value': $attach(value.value, 'subscriptionId', ds.subs, { 'subscriptionName': null }) }]) : value }`
  (`azure.vms-without-backup` `subs`, `avd.host-pools` `subscriptions`; checked at 50,000 rows in
  `tests/content/content-at-scale-subscription-names.scale.test.ts`). The trade-off: that list now has a transform, so
  its export is collected up to `maxItems` instead of streamed.
- **More than one other table:** split the query (`azure.arc-patching`: `machines` from the assessments, `unassessed`
  from the servers; `azure.arc-defender-coverage`: the plans per subscription in their own query, passed on as a
  `$guid()` list).
- **Computed booleans** come back as `1`/`0` (`tostring()` gives `True`/`False`); raw `properties.*` booleans stay
  `true`/`false`. Project a flag you compare or show as `iff(cond, 'true', 'false')` in the final `project` (keep the
  boolean for KQL `where`/`order by`) and compare with `= 'true'`. Show it with `kind: status` when the value is fine
  or not, else `kind: enum` with `map: { "true": "On", "false": "Off" }` — never `kind: boolean`. Fixtures return
  what Resource Graph really does.
- **Grouped rows** need a composite `rowKey` built in the query:
  `extend Key = strcat(CodeSymbolic, '|', Source, '|', ActivityType)` (`avd.connections`).
- **Defender for Cloud** through Resource Graph (`securityresources`: recommendations, plans —
  `azure.arc-defender-coverage`, `security.cloud-recommendations`) is in scope; the Defender portal is not.

## Azure Resource Manager and Cost Management

- **ARM list answers** (`value[]` of `{ id, name, properties }`) can go to a table as they come: columns take dotted
  paths (`properties.sessionState`) and `$applyAdvanced` counts them (`avd.user-sessions`), so thousands of rows need
  no per-row mapping.
- **Cost Management** (`POST …/providers/Microsoft.CostManagement/query|forecast` at management-group, subscription,
  resource-group, billing-account or billing-profile scope — allowed reads): cache for an hour (`cache: { ttl: 3600 }`;
  it throttles per scope), keep a page to a few queries, default the scope to `AF_COST_MANAGEMENT_GROUP_ID` (else the
  tenant root group). Rows come back as arrays with `columns` beside them: turn them into objects natively with
  `$tableRows(value.properties, { "cost": "Cost", "group": "ServiceName" })`, then total, filter, label and sort
  natively (`$sum($pluck(rows, 'cost'))`, `$applyAdvanced`, `$withFields`, `rows^(>cost)`,
  `$withShare(rows, 'cost', 'share')`); format dates once per distinct value and join them back with `$attach`; map
  only the rows the page lists in JSONata, and export the whole list (`exportRows`, `billing.cost-analysis`).

## Log Analytics

- `workspace` defaults to `${env.AF_LOG_ANALYTICS_WORKSPACE_ID}`. A workload's own workspace falls back to it —
  `workspace: "${ env.AF_X ? env.AF_X : env.AF_LOG_ANALYTICS_WORKSPACE_ID }"` with `when: ${ ds.workspace.configured }`
  (`avd.connections`, `probes.avd-connection-errors`).

## Fixtures

Every datasource and KQL probe needs a synthetic fixture so mock mode, e2e and the content tests render it.

- Files live under `tests/fixtures/<service>/…`, named by the scheme at the top of
  `portal/packages/connectors/src/fixtures.ts`. Long queries get hashed file names: find them with `fixtureKey()`.
- Add POST answers as `variants` rather than overwriting a shared file. The **first** matching variant wins: put a
  specific `af:<id>#<ds>` variant before the generic ones (`tests/fixtures/resourceGraph/POST.json` ends with a
  catch-all `resourcecontainers` variant). Resource Graph and Log Analytics queries start with a
  `// af:<page id>#<datasource>` (probes: `// af:<probe id>`) line so their variant can match it (`bodyIncludes`).
- Keep fixture rows exactly what the query projects (drop a column the query no longer returns; computed booleans are
  1/0).
- Probes: a KQL probe's `af:` variant goes in `tests/fixtures/resourceGraph/POST.json` or
  `logAnalytics/<workspace>/POST.json`; an HTTP, DNS or certificate probe needs a `hosts/`, `dns/` or `tls/` fixture,
  keyed for the synthetic configuration (`example.com`, tenant `00000000-0000-4000-8000-00000000e0e0`, `exampleorg`).
- `tests/content/fixtures-complete.test.ts` renders every active page, dashboard and report datasource from the
  fixtures (entity pages with a sample id from its `SAMPLE_PARAMS`) and checks every KQL probe's variant;
  `tests/api/probes-fixtures-offline.test.ts` runs every probe sweep with the network switched off.
- In mock mode a write with no fixture is accepted (there is no tenant); a read with no fixture fails and the API log
  names the fixture to add.
- `Example Org`, `example.com` and generated GUIDs only. `pnpm adminforge fixtures record <page>` reads a page live,
  read-only, and writes sanitised fixtures — review every file before committing.

## Versions, previews and retiring

- **Every change** to a definition bumps `version`: patch for fixes and wording, minor for additions (a column, a
  filter, an optional input), major for anything an existing input, schedule or saved view relies on. Published
  versions only move forward.
- **Preview:** content not yet confirmed to work against a live tenant (checked on fixtures only, or with a known live
  problem) gets `preview: true` plus a version bump. Pages show a quiet "Preview" badge and `adminforge validate` lists
  them; nothing about how it runs changes. Remove it (another version bump) once it works live, and record what is
  unchecked in `docs/licensing-review.md` and `docs/backlog.md`. Don't use `status: preview` for this.
- **Retiring:** `status: retired` plus a version bump — never delete the file (runs and audit keep pointing at it, and
  the old version stays live in the database). Start the `summary` with `Retired — <why, or replaced by Title (id)>.`:
  that sentence is what people see when they open it (409 `definition_retired`). Retire everything that belongs
  together (pages, reports, schedules — also `enabled: false` — playbooks, runbooks, probes, connections), remove every
  active link, embed, `type: playbook` step and schedule reference (`tests/content/retired-content.test.ts`), fix a
  retired definition only as far as it must still validate, and add a `docs/backlog.md` line saying how to bring it
  back. `publish --dry-run` lists it as `− retire`. Generic engine features (a probe kind, a datasource source) stay.
