# Group and user views — Implementation Plan

> **Status:** in progress (2026-10-22). Phase 1 (Tasks 0–10) is built on `feat/directory-views`: the views, the two
> generic additions, live checks (app-only, `docs/licensing/findings/2026-10-22-group-and-user-views.md`), fleet-size
> fixes (`CHANGELOG.md` › Group and user views) and the browser tests. Phase 2 (Task 11) waits on D1: this
> installation has no Log Analytics workspace (`docs/backlog.md`).

**Goal:** New built-in views on the existing **Groups** (`identity.groups`) and **Users** (`identity.users`) pages —
"No owners", "Fewer than 5 members", "Not renewed in a year", "Inactive 90 days", … — picked from the page's Views menu
or its facets. No new page.

**Architecture:** Each view is a saved-view preset (`savedViews.presets`) that sets the page's facet params. Where Graph
can filter on the property (owner count, dates, invitation state), the view is one more `$filter` clause on the page's
existing datasource — same query, same paging. Where Graph can't (member count; sign-in activity combined with other
filters), the view switches to a second datasource that reads the whole collection once, filters it natively
(`$applyAdvanced`) and feeds a second table — the pattern the Users page already uses for its MFA view. Two small
generic additions make that work: a `$withItemCount` expression helper (count a list per row, natively) and exports that
follow the table the view shows.

**Tech stack:** page YAML (`portal/content/pages/identity/`), JSONata expressions with native helpers
(`portal/packages/expressions/src/helpers.ts`), Microsoft Graph v1.0 advanced queries, vitest (`unit`, `content`,
`scale`, `api`, `component` projects), Playwright (e2e screenshots).

---

## The views

| Page   | View (preset name)                         | Params set                               | How it is read                                                                                       |
| ------ | ------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Groups | No owners                                  | `owners: None`                           | Graph: `owners/$count eq 0` on the existing `groups` datasource (already an advanced query)           |
| Groups | One owner                                  | `owners: One`                            | Graph: `owners/$count eq 1`                                                                          |
| Groups | No members                                 | `members: None`                          | Every group read once with `$expand=members($select=id)`, counted natively (`$withItemCount`), table 2 |
| Groups | Fewer than 5 members                       | `members: UnderFive`                     | Same read, `memberCount lt 5`                                                                        |
| Groups | Created in the last 30 days                | `created: Last30Days`                    | Graph: `createdDateTime ge …`                                                                        |
| Groups | Created over a year ago                    | `created: OverAYear`                     | Graph: `createdDateTime le …`                                                                        |
| Groups | Paused dynamic rules                       | `membership: Paused`                     | Graph: dynamic and `membershipRuleProcessingState eq 'Paused'`                                       |
| Groups | Microsoft 365 groups expiring in 30 days   | `lifecycle: Expiring`                    | Graph: `expirationDateTime le …` (as `identity.group-lifecycle` does)                                |
| Groups | Microsoft 365 groups not renewed in a year | `lifecycle: NotRenewed`                  | Graph: Unified and `renewedDateTime le …`                                                            |
| Groups | Not changed in a year                      | `changed: NotInAYear`                    | **Phase 2, decision D1** — Log Analytics `AuditLogs`                                                 |
| Users  | Pending guest invitations                  | `userType: Guest`, `invitation: Pending` | Graph: `externalUserState eq 'PendingAcceptance'`                                                    |
| Users  | Blocked but licensed                       | `enabled: Disabled`, `licensed: Licensed` | Existing facets — preset only                                                                       |
| Users  | New in the last 30 days                    | `created: Last30Days`                    | Graph: `createdDateTime ge …`                                                                        |
| Users  | Members inactive 90 days                   | `userType: Member`, `enabled: Enabled`, `activity: Inactive90` | Graph filters sign-in alone (it can't combine); the other facets run natively, table 2 |
| Users  | No sign-in for a year                      | `activity: Inactive365`                  | Same, 365 days                                                                                       |

Facets combine: "Security groups" + "No owners" is one query; "Synced from AD" + "Fewer than 5 members" is the member
read filtered natively by source.

### What Graph and Entra can't answer (read before building)

- **Member count:** Graph can't filter on it (`identity.groups-without-owners` notes this; `$expand` is also not
  allowed with an advanced query, which the Groups page always is). So the member views read every group with its
  members expanded — Graph expands **at most 20** members a group, which makes counts exact below 20 (the views stop at
  5) — up to 50,000 groups (≈ 50 requests, cached 15 minutes), only while a member view is selected.
- **Owners:** `owners/$count` counts apps (service principals) as owners. A group owned only by a provisioning app
  shows as "One owner", not "No owners". The view's note links to **Groups without owners**, which tells them apart.
- **Sign-in activity:** a `$filter` on `signInActivity` can't be combined with any other filter, and it never matches
  accounts with no recorded successful sign-in (`identity.inactive-users` explains). The inactive views say so and link
  to **Inactive users** for never-signed-in accounts.
- **"Not changed in the last year" (decision D1):** Entra stores **no last-modified time for a group**. The Graph audit
  log keeps 30 days. `renewedDateTime` exists only for Microsoft 365 groups (renewal, not change). Synced groups' AD
  `whenChanged` isn't synced to Entra, and AdminForge doesn't read on-premises AD. The one source that covers a year is
  **the audit log in Log Analytics** (`AuditLogs`, category `GroupManagement`), and only if Entra's diagnostic settings
  send it to the workspace in `AF_LOG_ANALYTICS_WORKSPACE_ID` **and** the workspace keeps it ≥ 365 days.
  - **Recommended:** build phase 1 now (every other view, including "not renewed" and "created over a year ago"). Run
    the read-only check in Task 0. If the workspace holds a year, build phase 2 (Task 11). If it holds less, the view
    still works and says "not changed in N days". If there is no workspace, record the gap in `docs/backlog.md` and
    stop there.

### Decisions taken by default (change before starting if wrong)

- Thresholds are fixed per view (5 members, 30/365 days, 90/365 days inactive), not free numbers — a preset is one
  click, and fixed values keep the cache keys few.
- Member views list the first 10,000 matching groups (the export has every match), like `m365.sharepoint-sharing`.
- In the member and inactivity views, search matches **part of the name** (native, case ignored) instead of Graph's
  word-start search, and the query builder (`adv`, OData) doesn't apply. The view's note says both.
- No new KPIs.

---

## Task 0: Live, read-only checks (before writing content)

Rule 14: run each new query once against the validation tenant, read-only. Use the `validating-against-a-tenant` skill.

**Step 1:** In Graph Explorer or `tests/live` (read-only, delegated), confirm each returns 200:

```
GET /groups?$filter=owners/$count eq 0&$count=true&$top=5&$select=id           (ConsistencyLevel: eventual)
GET /groups?$filter=owners/$count eq 0 and securityEnabled eq true and mailEnabled eq false&$search="displayName:a"&$count=true   (eventual)
GET /groups?$filter=groupTypes/any(c:c eq 'Unified') and renewedDateTime le 2025-10-22T00:00:00Z&$count=true   (eventual)
GET /groups?$filter=groupTypes/any(c:c eq 'DynamicMembership') and membershipRuleProcessingState eq 'Paused'&$count=true   (eventual)
GET /groups?$select=id,displayName&$expand=members($select=id)&$top=999
GET /users?$filter=externalUserState eq 'PendingAcceptance'&$count=true&$top=5   (eventual)
GET /users?$filter=signInActivity/lastSuccessfulSignInDateTime le 2026-07-24T00:00:00Z&$select=id,signInActivity&$top=120
```

**Step 2 (D1):** if `pnpm adminforge env check` shows `AF_LOG_ANALYTICS_WORKSPACE_ID` set, run in the workspace
(read-only):

```kql
AuditLogs | where Category == "GroupManagement" | summarize oldest = min(TimeGenerated), events = count()
```

**Step 3:** Record in `docs/licensing-review.md` (one finding) what answered and what didn't. A query Graph refuses
drops its view from this plan, and gets a backlog row.

---

## Task 1: `$withItemCount` expression helper — done

Generic: "how many items this row holds at a path", natively — `$count(members)` per row in JSONata costs ~15 µs a row
(50,000 groups ≈ 750 ms, over the 250 ms budget). Built per `.claude/skills/adding-an-expression-helper/SKILL.md`.

- Named `$withItemCount(rows, path, as)`, not `$withItemCount` as first planned: `$withCount(rows, path, as)` already
  exists and counts the **rows that share a value**; this one counts **within each row**, with the same argument
  order. A list's non-blank items count (paths read through lists, as in `$applyAdvanced`), a single value counts 1,
  missing / null / '' count 0.
- `portal/packages/expressions/src/helpers.ts` (beside `withCount`; `HELPER_NAMES`; `registerHelpers`, `'<xss:a>'`,
  `budgetOf(this)`). Taint: default (the result is rows).
- Tests: `tests/unit/expressions/with-item-count.test.ts` (6) and `with-item-count.scale.test.ts` (50,000 groups with up
  to 20 members, counted and filtered within 250 ms).
- Docs: `docs/content-recipes.md` › Labelling, capping and joining.
- Commit: `feat(expressions): $withItemCount counts the items each row holds at a path, natively`

## Task 2: Exports follow the table the view shows — done

Built differently from the first draft (which evaluated each table's `when` — the browser's `when` sees datasource
values, the server only params, so the two could disagree): **`export.data` may be a `${ … }` template over params**
that names the path to export, rendered alike by the server (`planExport`) and the browser (`useTemplate` in
`PageView`), and the export takes its columns from `exportTable` (`portal/packages/schemas/src/path.ts`, shared): the
table bound to that path, else the table bound to a `source: static` view of it (the "capped table that exports every
row" recipe — before, that case fell back to the first table's columns). `validate` checks each quoted path's
datasource (`exportDataSources`, `page.ts`).

- Tests: `tests/api/export-follows-view.test.ts` (end to end, both views; validation), `tests/unit/web/export-table.test.ts`.
- Docs: `docs/content-recipes.md` (Views that switch tables), `adding-a-page-or-report` skill, the schema comment.
- The Groups and Users pages use it in Tasks 4 and 6 (`export.data` templates naming `memberMatches.rows` /
  `inactiveMatches.rows` / `registrations.value`).
- Commit: `feat(api,web): an export can follow the table the selected view shows`

## Task 3: Groups — the views Graph filters

**Files:** Modify `portal/content/pages/identity/groups.page.yaml` (version `1.2.0` → `1.3.0`).

**Step 1: Failing content test** `tests/content/groups-views.test.ts`. Render the `groups` datasource's `$filter`
template for each view and assert the clause (pattern: `tests/content/sharepoint-sharing-sites.test.ts`, `run()`
over `request.query.$filter`):

```ts
const filter = (params: Record<string, unknown>) =>
  renderString(GROUPS.datasources.groups.request.query.$filter, { ...scope, params: { ...defaults, ...params } });

it.each([
  [{ owners: 'None' }, 'owners/$count eq 0'],
  [{ owners: 'One' }, 'owners/$count eq 1'],
  [{ created: 'Last30Days' }, 'createdDateTime ge 2026-09-22'],
  [{ created: 'OverAYear' }, 'createdDateTime le 2025-10-22'],
  [{ membership: 'Paused' }, "groupTypes/any(c:c eq 'DynamicMembership') and membershipRuleProcessingState eq 'Paused'"],
  [{ lifecycle: 'Expiring' }, 'expirationDateTime le 2026-11-21'],
  [{ lifecycle: 'NotRenewed' }, "groupTypes/any(c:c eq 'Unified') and renewedDateTime le 2025-10-22"],
])('%o filters on %s', async (params, clause) => expect(await filter(params)).toContain(clause));

it('combines views with the other facets', async () =>
  expect(await filter({ kind: 'Security', owners: 'None' })).toBe(
    'securityEnabled eq true and mailEnabled eq false and owners/$count eq 0'));

it('ships a preset for every view, each naming only declared params and values', () => { /* loop over presets */ });
```

(`scope.now = '2026-10-22T12:00:00Z'`; check what `$daysAgo` returns and match its format.)

**Step 2:** run — FAIL.

**Step 3: Implement.**

Params (after `roleAssignable`):

```yaml
  owners:
    type: enum
    label: Owners
    facet: true
    default: Any
    description: Graph counts apps as owners — Groups without owners tells people from apps.
    values:
      - { value: Any, label: Any number }
      - { value: None, label: No owners }
      - { value: One, label: One owner }
  members:
    type: enum
    label: Members
    facet: true
    default: Any
    description: Direct members (a nested group counts as one). Reads every group, so it takes longer.
    values:
      - { value: Any, label: Any number }
      - { value: None, label: No members }
      - { value: UnderFive, label: Fewer than 5 }
  created:
    type: enum
    label: Created
    facet: true
    default: Any
    values:
      - { value: Any, label: Any time }
      - { value: Last30Days, label: In the last 30 days }
      - { value: OverAYear, label: More than a year ago }
  lifecycle:
    type: enum
    label: Renewal
    facet: true
    default: Any
    description: Microsoft 365 groups under an expiration policy are renewed automatically while they are in use.
    values:
      - { value: Any, label: Any }
      - { value: Expiring, label: Expires in 30 days }
      - { value: NotRenewed, label: Not renewed in a year }
```

Add `{ value: Paused, label: Dynamic, rule paused }` to `membership.values`. Add the four params to `filters.facets`.

`$filter` clauses (before `advanced`):

```
               params.membership = 'Paused' ? "groupTypes/any(c:c eq 'DynamicMembership') and membershipRuleProcessingState eq 'Paused'",
               params.owners = 'None' ? "owners/$count eq 0",
               params.owners = 'One' ? "owners/$count eq 1",
               params.created = 'Last30Days' ? "createdDateTime ge " & $daysAgo(30),
               params.created = 'OverAYear' ? "createdDateTime le " & $daysAgo(365),
               params.lifecycle = 'Expiring' ? "expirationDateTime le " & $daysAgo(-30),
               params.lifecycle = 'NotRenewed' ? "groupTypes/any(c:c eq 'Unified') and renewedDateTime le " & $daysAgo(365),
```

Add `renewedDateTime,expirationDateTime` to `$select`, and hidden columns
`{ field: renewedDateTime, label: Renewed, kind: date, hidden: true }` and
`{ field: expirationDateTime, label: Expires, kind: date, hidden: true }`.

Presets (after the existing four):

```yaml
    - { name: No owners, params: { owners: None } }
    - { name: One owner, params: { owners: One } }
    - { name: Created in the last 30 days, params: { created: Last30Days } }
    - { name: Created over a year ago, params: { created: OverAYear } }
    - { name: Paused dynamic rules, params: { membership: Paused } }
    - { name: Microsoft 365 groups expiring in 30 days, params: { lifecycle: Expiring }, columns: [displayName, kind, expirationDateTime, renewedDateTime] }
    - { name: Microsoft 365 groups not renewed in a year, params: { lifecycle: NotRenewed }, columns: [displayName, kind, renewedDateTime, createdDateTime] }
```

**Step 4: Fixtures.** Run the page in mock mode (`AUTH_MODE=mock DATA_MODE=fixtures pnpm dev`), pick each view, and
create the fixture each 404 names under `tests/fixtures/graph/v1.0/groups/` (synthetic: `Example Org`, `example.com`,
generated GUIDs), so every view shows rows in mock mode and e2e.

**Step 5:** run the content test, then `pnpm adminforge validate` — PASS.

---

## Task 4: Groups — the member views (second table)

**Files:** `groups.page.yaml` (same version bump), `tests/content/groups-views.test.ts`,
new `tests/content/content-at-scale-groups-views.scale.test.ts`.

**Step 1: Failing tests** (content): feed `groupList` a synthetic `everyGroup` answer and assert:

- `members: UnderFive` keeps groups with 0–4 members, drops 5+ (`memberCount` on each row).
- `members: None` keeps only 0.
- Each facet narrows natively the same way Graph would: kind (4 kinds), membership (Assigned / Dynamic / Paused), source,
  role-assignable, created, lifecycle; `owners: None|One` keeps ids in `ownerIds`; `q` matches part of the name, case
  ignored, and a 300-character search doesn't fail the view (`containsAny` takes ≤ 256 characters).
- Labels `kind`, `membership`, `sourceLabel` match the main transform's for the same raw rows (compare the two
  datasources' output for one fixture row of each kind).
- More than 10,000 matches → `rows` has 10,000, `matched` the total, `listCapped: true`; a truncated read →
  `partial: true`.
- The browser never fetches `everyGroup` or `ownerIds` (`neededDatasources`, as in the SharePoint test), and doesn't
  fetch `groups` while a member view is on.

Scale (`*.scale.test.ts`, pattern `content-at-scale-sharepoint-sharing.scale.test.ts`): 50,000 groups with 0–20
members each → the `groupList` transform under the real 250 ms budget for `UnderFive`, `None`, and `UnderFive` + every
facet.

**Step 2:** run — FAIL.

**Step 3: Implement** — datasources:

```yaml
  # Every group with its first 20 direct members, only for the member views: Graph can't filter on member count, and
  # $expand isn't allowed in an advanced query (the `groups` read is one). One relationship per request; 20 at most per
  # group, so counts are exact below 20.
  everyGroup:
    source: graph
    when: ${ params.members in ['None', 'UnderFive'] }
    request:
      path: /groups
      query:
        $select: id,displayName,description,mail,mailEnabled,securityEnabled,groupTypes,membershipRule,membershipRuleProcessingState,onPremisesSyncEnabled,onPremisesLastSyncDateTime,createdDateTime,renewedDateTime,expirationDateTime,visibility,isAssignableToRole
        $expand: members($select=id)
        $top: 999
    paging: all
    maxItems: 50000
    cache: { ttl: 900 }
  # The owner views over the member read: Graph's owner count, as ids.
  ownerIds:
    source: graph
    when: ${ params.members in ['None', 'UnderFive'] and params.owners in ['None', 'One'] }
    request:
      path: /groups
      headers: { ConsistencyLevel: eventual }
      query:
        $filter: "${ params.owners = 'One' ? 'owners/$count eq 1' : 'owners/$count eq 0' }"
        $count: true
        $select: id
        $top: 999
    paging: all
    maxItems: 50000
    cache: { ttl: 900 }
  # What the browser gets in a member view: the page's facets applied natively, the first 10,000 matches labelled.
  # Labels are added by partition ($applyAdvanced + $withFields) — no JSONata per group.
  groupList:
    source: static
    when: ${ params.members in ['None', 'UnderFive'] }
    data: >-
      ${ { "rows": ds.everyGroup.value, "owners": ds.ownerIds.value.id,
           "partial": ds.everyGroup.truncated = true or ds.ownerIds.truncated = true } }
    transform: >-
      ${ (
        $p := params;
        $c := function($path, $type, $op, $v) { { "path": $path, "type": $type, "op": $op, "value": $v } };
        $f := function($rows, $cl) { $applyAdvanced($rows, { "join": "and", "clauses": $cl }) };
        $unified := $c('groupTypes', 'string', 'eq', 'Unified');
        $notUnified := $c('groupTypes', 'string', 'ne', 'Unified');
        $dynamic := $c('groupTypes', 'string', 'eq', 'DynamicMembership');
        $assigned := $c('groupTypes', 'string', 'ne', 'DynamicMembership');
        $synced := $c('onPremisesSyncEnabled', 'boolean', 'eq', true);
        $cloud := $c('onPremisesSyncEnabled', 'boolean', 'ne', true);
        $clauses := [
          $p.members = 'None' ? $c('memberCount', 'number', 'eq', 0),
          $p.members = 'UnderFive' ? $c('memberCount', 'number', 'lt', 5),
          $p.kind = 'Microsoft365' ? $unified,
          $p.kind in ['Security', 'MailSecurity'] ? $c('securityEnabled', 'boolean', 'eq', true),
          $p.kind = 'Security' ? $c('mailEnabled', 'boolean', 'ne', true),
          $p.kind in ['MailSecurity', 'Distribution'] ? $c('mailEnabled', 'boolean', 'eq', true),
          $p.kind in ['MailSecurity', 'Distribution'] ? $notUnified,
          $p.kind = 'Distribution' ? $c('securityEnabled', 'boolean', 'ne', true),
          $p.membership in ['Dynamic', 'Paused'] ? $dynamic,
          $p.membership = 'Paused' ? $c('membershipRuleProcessingState', 'string', 'eq', 'Paused'),
          $p.membership = 'Assigned' ? $assigned,
          $p.source = 'Synced' ? $synced,
          $p.source = 'Cloud' ? $cloud,
          $p.roleAssignable = 'Yes' ? $c('isAssignableToRole', 'boolean', 'eq', true),
          $p.roleAssignable = 'No' ? $c('isAssignableToRole', 'boolean', 'ne', true),
          $p.created = 'Last30Days' ? $c('createdDateTime', 'date', 'ge', $daysAgo(30)),
          $p.created = 'OverAYear' ? $c('createdDateTime', 'date', 'le', $daysAgo(365)),
          $p.lifecycle = 'Expiring' ? $c('expirationDateTime', 'date', 'le', $daysAgo(-30)),
          $p.lifecycle = 'NotRenewed' ? $unified,
          $p.lifecycle = 'NotRenewed' ? $c('renewedDateTime', 'date', 'le', $daysAgo(365)),
          $p.owners in ['None', 'One'] ? $c('id', 'guid', 'in', value.owners),
          $p.q ? $c('displayName', 'string', 'containsAny', [$substring($p.q, 0, 256)])
        ];
        $matched := $f($withItemCount(value.rows, 'members', 'memberCount'), $clauses);
        $list := $take($matched, 10000);
        $kinds := $append($append($append(
          $withFields($f($list, [$unified]), { "kind": "Microsoft 365" }),
          $withFields($f($list, [$notUnified, $c('securityEnabled', 'boolean', 'eq', true), $c('mailEnabled', 'boolean', 'eq', true)]), { "kind": "Mail-enabled security" })),
          $withFields($f($list, [$notUnified, $c('securityEnabled', 'boolean', 'eq', true), $c('mailEnabled', 'boolean', 'ne', true)]), { "kind": "Security" })),
          $withFields($f($list, [$notUnified, $c('securityEnabled', 'boolean', 'ne', true)]), { "kind": "Distribution" }));
        $byMembership := $append(
          $withFields($f($kinds, [$dynamic]), { "membership": "Dynamic" }),
          $withFields($f($kinds, [$assigned]), { "membership": "Assigned" }));
        {
          "rows": $append(
            $withFields($f($byMembership, [$synced]), { "sourceLabel": "Synced" }),
            $withFields($f($byMembership, [$cloud]), { "sourceLabel": "Cloud" })),
          "matched": $count($matched),
          "listCapped": $count($matched) > 10000,
          "partial": value.partial = true
        }
      ) }
```

The expanded `members` lists stay on the server: the browser reads only `groupList`. If the scale test shows the rows
are heavy, drop `members` after counting (check whether `$withFields` with `"members": null` is cheaper than leaving
them), and assert the byte size in the perf budget (Task 7).

Layout: give the existing `groups` datasource and `groups` table `when: ${ $not(params.members in ['None', 'UnderFive']) }`,
then add after the table:

```yaml
  - widget: markdown
    id: membersNote
    span: 12
    when: ${ params.members in ['None', 'UnderFive'] }
    text: >-
      **Direct members**: a nested group counts as one member, and dynamic groups count the members their rule has added
      so far. This view reads every group, so it takes longer to open. Search matches part of the name, and the advanced
      filter doesn't apply here.${ groupList.listCapped = true ? ' The first 10,000 of ' & $formatNumber(groupList.matched, '#,##0') & ' groups are listed; the export has every one.' : '' }
      Graph counts apps as owners: [Groups without owners](/p/identity.groups-without-owners) tells people from apps.
  - widget: table
    id: groupList
    span: 12
    data: groupList.rows
    when: ${ params.members in ['None', 'UnderFive'] }
    rowKey: id
    selection: multi
    columns: # the `groups` table's columns, plus:
      - { field: memberCount, label: Direct members, kind: number, sortable: true }   # second column
    inspect: # as the `groups` table
    rowActions: # as the `groups` table, but "Add members" uses
      #   when: ${ row.membership = 'Assigned' and row.sourceLabel = 'Cloud' and row.kind in ['Security', 'Microsoft 365'] }
      # (the `graphManaged` rule, written out: this list has no per-row transform)
    empty:
      title: No groups match these filters
      body: Every group in scope has more members, or clear a facet or the search.
```

Presets:

```yaml
    - { name: No members, params: { members: None } }
    - { name: Fewer than 5 members, params: { members: UnderFive } }
```

(No `columns` on these presets: preset columns apply to the first table only, `PageView.tsx:307`. Set the second
table's defaults with `hidden:` instead.)

Export: remove `export.data` (Task 2 makes the export follow the table shown).

**Step 4:** run the content and scale tests — PASS. `pnpm adminforge validate` and `pnpm adminforge test` — clean.

**Step 5: Commit** (Tasks 3 + 4) — `feat(content): Groups views for owners, members, age and renewal`

---

## Task 5: Users — the views Graph filters

**Files:** `portal/content/pages/identity/users.page.yaml` (version `1.3.0` → `1.4.0`), new
`tests/content/users-views.test.ts`.

**Step 1: Failing test** — as in Task 3: `invitation: Pending` → `externalUserState eq 'PendingAcceptance'`;
`created: Last30Days` → `createdDateTime ge 2026-09-22…`; "Blocked but licensed" → `accountEnabled eq false and
assignedLicenses/$count ne 0`; every preset names declared params and values.

**Step 2:** run — FAIL.

**Step 3: Implement.**

```yaml
  invitation:
    type: enum
    label: Invitation
    facet: true
    default: Any
    values:
      - { value: Any, label: Any }
      - { value: Pending, label: Not yet accepted }
  created:
    type: enum
    label: Created
    facet: true
    default: Any
    values:
      - { value: Any, label: Any time }
      - { value: Last30Days, label: In the last 30 days }
```

Clauses before `advanced`:

```
               params.invitation = 'Pending' ? "externalUserState eq 'PendingAcceptance'",
               params.created = 'Last30Days' ? "createdDateTime ge " & $daysAgo(30),
```

Facets: add `invitation, created`. Presets:

```yaml
    - { name: Pending guest invitations, params: { userType: Guest, invitation: Pending }, columns: [displayName, userType, externalUserState, createdDateTime] }
    - { name: Blocked but licensed, params: { enabled: Disabled, licensed: Licensed } }
    - { name: New in the last 30 days, params: { created: Last30Days }, columns: [displayName, userType, sourceLabel, createdDateTime, department] }
```

Fixtures for each new query, as in Task 3 Step 4.

**Step 4:** run — PASS.

---

## Task 6: Users — the inactivity views (second table)

**Files:** `users.page.yaml`, `tests/content/users-views.test.ts`,
new `tests/content/content-at-scale-users-views.scale.test.ts`.

**Step 1: Failing tests** — `userList` over a synthetic `inactive` answer applies type, sign-in, licences, source,
department, invitation and created natively; `q` matches part of the display name or sign-in name (no duplicates);
labels `licenceState` and `sourceLabel` match the main transform; caps at 10,000 with `matched` and `listCapped`; a
truncated read → `partial`. The `inactive` request's `$filter` is the sign-in clause **alone** for any facet values
(Graph refuses it combined). The MFA view wins over the inactivity view (both set → registrations table only). Scale:
50,000 inactive users (the read's cap) under 250 ms with every facet set.

**Step 2:** run — FAIL.

**Step 3: Implement.**

```yaml
  activity:
    type: enum
    label: Last sign-in
    facet: true
    default: Any
    description: >-
      Successful sign-ins (Entra ID P1). Accounts with no recorded sign-in aren't listed here — the Inactive users
      report includes them.
    values:
      - { value: Any, label: Any time }
      - { value: Inactive90, label: Over 90 days ago }
      - { value: Inactive365, label: Over a year ago }
```

Datasources: `users` gets `when: ${ $not(params.mfa in ['Registered', 'NotRegistered']) and params.activity = 'Any' }`
(and the `users` table the same). New:

```yaml
  # The inactivity views: Graph's sign-in filter can't be combined with any other, so it runs alone (as in
  # identity.inactive-users) and the page's other facets run natively in userList.
  inactive:
    source: graph
    requires: { licences: [signInLogs] }
    when: ${ params.activity in ['Inactive90', 'Inactive365'] and $not(params.mfa in ['Registered', 'NotRegistered']) }
    request:
      path: /users
      query:
        $filter: "${ 'signInActivity/lastSuccessfulSignInDateTime le ' & $daysAgo(params.activity = 'Inactive365' ? 365 : 90) }"
        $select: <the users datasource's $select>
        $top: 120
    paging: all
    maxItems: 50000
    cache: { ttl: 3600 }
  userList:
    source: static
    when: ${ params.activity in ['Inactive90', 'Inactive365'] and $not(params.mfa in ['Registered', 'NotRegistered']) }
    data: '${ { "rows": ds.inactive.value, "partial": ds.inactive.truncated = true } }'
    transform: >-
      ${ (
        $p := params;
        $c := function($path, $type, $op, $v) { { "path": $path, "type": $type, "op": $op, "value": $v } };
        $f := function($rows, $cl) { $applyAdvanced($rows, { "join": "and", "clauses": $cl }) };
        $licensed := { "path": "assignedLicenses", "type": "string", "op": "notEmpty", "value": null };
        $unlicensed := { "path": "assignedLicenses", "type": "string", "op": "isEmpty", "value": null };
        $synced := $c('onPremisesSyncEnabled', 'boolean', 'eq', true);
        $cloud := $c('onPremisesSyncEnabled', 'boolean', 'ne', true);
        $clauses := [
          $p.userType in ['Member', 'Guest'] ? $c('userType', 'string', 'eq', $p.userType),
          $p.enabled = 'Enabled' ? $c('accountEnabled', 'boolean', 'eq', true),
          $p.enabled = 'Disabled' ? $c('accountEnabled', 'boolean', 'eq', false),
          $p.licensed = 'Licensed' ? $licensed,
          $p.licensed = 'Unlicensed' ? $unlicensed,
          $p.source = 'Synced' ? $synced,
          $p.source = 'Cloud' ? $cloud,
          $p.department ? $c('department', 'string', 'containsAny', [$p.department]),
          $p.invitation = 'Pending' ? $c('externalUserState', 'string', 'eq', 'PendingAcceptance'),
          $p.created = 'Last30Days' ? $c('createdDateTime', 'date', 'ge', $daysAgo(30))
        ];
        $scoped := $f(value.rows, $clauses);
        $q := $substring($p.q, 0, 256);  /* containsAny takes texts of ≤ 256 characters */
        $byName := $p.q ? $f($scoped, [$c('displayName', 'string', 'containsAny', [$q])]) : $scoped;
        $matched := $p.q
          ? $append($byName, $f($scoped, [$c('userPrincipalName', 'string', 'containsAny', [$q]), $c('id', 'guid', 'notIn', $byName.id)]))
          : $scoped;
        $list := $take($matched, 10000);
        $lic := $append(
          $withFields($f($list, [$licensed]), { "licenceState": "Licensed" }),
          $withFields($f($list, [$unlicensed]), { "licenceState": "Unlicensed" }));
        {
          "rows": $append(
            $withFields($f($lic, [$synced]), { "sourceLabel": "Synced" }),
            $withFields($f($lic, [$cloud]), { "sourceLabel": "Cloud" })),
          "matched": $count($matched),
          "listCapped": $count($matched) > 10000,
          "partial": value.partial = true
        }
      ) }
```

(Department is "contains, case ignored" here, `eq` in Graph — the note says the inactivity view matches part of it.
Check in the test that `$byName.id` on an empty or one-row list still gives a list to `notIn`; wrap it in
`$append([], …)` as `identity.groups-without-owners` does if not.)

Layout: a `markdown` note (`when` as `userList`) — "**Last successful sign-in over 90 days ago / a year ago.** Accounts
with no recorded sign-in aren't listed — see [Inactive users](/p/identity.inactive-users). Search matches part of the
name or sign-in name; the advanced filter doesn't apply here." plus the 10,000 sentence as in Task 4. Then the
`userList` table: the `users` table's columns, inspect, rowActions and bulkActions, `data: userList.rows`, `when` as
`userList`, `signInActivity.lastSuccessfulSignInDateTime` shown as "Last successful sign-in" (visible, second column).

Presets:

```yaml
    - { name: Members inactive 90 days, params: { userType: Member, enabled: Enabled, activity: Inactive90 } }
    - { name: No sign-in for a year, params: { activity: Inactive365 } }
```

Export: remove `export.data` (Task 2).

**Step 4:** run content, scale, `validate`, `adminforge test` — PASS.

**Step 5: Commit** (Tasks 5 + 6) — `feat(content): Users views for invitations, new accounts and inactivity`

---

## Task 7: Perf harness budgets

**Step 1:** `pnpm test:perf`. It surveys every page datasource at fleet size and fails on new ones without a budget.
**Step 2:** add `tests/perf/budgets.json` entries for `identity.groups#everyGroup`, `identity.groups#ownerIds` and
`identity.users#inactive`: `knownSlow` (why: "every group with members expanded, 999 a page, up to 50,000, only in the
member views" / "sign-in filter alone, 120 a page, up to 50,000"), plus the measured `maxRequests` and `maxBytes`.
**Step 3:** rerun — PASS.

---

## Task 8: Screenshots and e2e

**Step 1:** `pnpm test:e2e`. `renderer-users-{steel,daylight}.png` change (two more facets in the filter bar). Open the
diffs and confirm **only** the filter bar changed, then update those two baselines (`--update-snapshots` for
`tests/e2e/renderer.spec.ts`).
**Step 2:** new `tests/e2e/directory-views.spec.ts`: on `/p/identity.groups`, pick **Fewer than 5 members** from the
Views menu → the member table shows the "Direct members" column and the note; pick **No owners** → the main table with
the owner filter (the fixture's call is made). On `/p/identity.users`, pick **No sign-in for a year** → the inactivity
table and its note. Screenshot each view in steel and daylight, and **look at the images** (CLAUDE.md › Before you say
"done").
**Step 3:** the Web dependencies didn't change, so `pnpm test:e2e:prod` runs in CI. Don't build in the `host-release`
worktree: it serves the live portal.

---

## Task 9: Docs

- `CHANGELOG.md` › Unreleased: a "Group and user views (2026-10-2x)" section (the views, the two generic additions, the
  limits: 20-member expansion, app owners, never-signed-in accounts).
- `docs/backlog.md`: a row for D1's outcome if phase 2 isn't built, and one for the Graph refusals from Task 0, if any.
- `docs/licensing-review.md`: the Task 0 finding.
- `docs/content-recipes.md`: `$withItemCount` (Task 1); "Views Graph can't filter: a second datasource and table behind
  `when`" (a short recipe naming `identity.groups` and `identity.users`).
- `docs/widgets.md` and the `adding-a-page-or-report` skill: the export default (Task 2).
- `docs/extending.md`: only if Task 2 changes how a page is extended.

---

## Task 10: Reviews and the gate

**Step 1:** `pnpm guard`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check` (through `rtk proxy`), `pnpm test`,
`pnpm adminforge validate`, `pnpm adminforge test`.
**Step 2:** reviewer agents: `content-reviewer` (both pages), `security-reviewer` (Task 2 touches
`portal/apps/api` and `portal/apps/web`; user input in native filters), `design-reviewer` (filter bar, the second
tables, the notes — steel and daylight). Fix or answer every finding.
**Step 3:** branch `feat/directory-views`, a pull request, merge after CI.

---

## Phase 2 — Task 11: "Not changed in a year" (only after D1 says the workspace holds the audit log)

**Files:** `groups.page.yaml` (minor bump), tests, a Log Analytics fixture
(`tests/fixtures/logAnalytics/<synthetic workspace id>/POST.json` variant matching `af:identity.groups#changed`).

- Param `changed: Any | NotInAYear` ("Changed: Not in a year"), facet and preset **Not changed in a year**.
- `everyGroup`, `groupList` and the second table also turn on for `params.changed = 'NotInAYear'`.
- Datasources:

```yaml
  changedIds:
    source: logAnalytics
    optional: true
    when: ${ params.changed = 'NotInAYear' and $boolean(env.AF_LOG_ANALYTICS_WORKSPACE_ID) = true }
    workspace: ${ env.AF_LOG_ANALYTICS_WORKSPACE_ID }
    timespan: P365D
    query: |
      // af:identity.groups#changed
      AuditLogs
      | where Category == "GroupManagement"
      | mv-expand Target = TargetResources
      | where tostring(Target.type) == "Group"
      | distinct groupId = tostring(Target.id)
    cache: { ttl: 3600 }
  auditDepth:
    source: logAnalytics
    optional: true
    when: ${ params.changed = 'NotInAYear' and $boolean(env.AF_LOG_ANALYTICS_WORKSPACE_ID) = true }
    workspace: ${ env.AF_LOG_ANALYTICS_WORKSPACE_ID }
    timespan: P365D
    query: |
      // af:identity.groups#auditdepth
      AuditLogs | where Category == "GroupManagement" | summarize oldest = min(TimeGenerated)
    cache: { ttl: 3600 }
```

- `groupList` adds `$p.changed = 'NotInAYear' ? $c('id', 'guid', 'notIn', value.changed)` (`changed` = the
  `changedIds` rows' `groupId`), and `createdDateTime le $daysAgo(365)` (a group created this year has changed).
- The note: "No change in the audit log (members, owners, settings) for 365 days." If `oldest` is less than 365 days
  back, the note says "The workspace holds N days of audit events; these groups haven't changed in N days." With no
  workspace, the facet value is hidden, or the view says what to configure (`AF_LOG_ANALYTICS_WORKSPACE_ID`, Entra
  diagnostic settings → AuditLogs, retention ≥ 365 days) — an administrator setup message, per CLAUDE.md rule 10.
- `requires`: engineers need read access to the workspace (Log Analytics Reader). Record it in
  `docs/licensing-review.md`.
- Tests: `changedIds` ids drop out; the depth sentence; no workspace → no Log Analytics call, the setup message.
  Scale: 50,000 groups with 40,000 changed ids under 250 ms (`notIn` is a set lookup).
- Commit: `feat(content): Groups view for groups not changed in a year, from the audit log`
