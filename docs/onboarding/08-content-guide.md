# 8. Content guide

Most of AdminForge is **content**: YAML definitions in `portal/content`, validated against schemas, reviewed in git,
published to the database, and rendered or executed by the generic engine (ADR-005). This is where most contributions
happen. Each kind has a Claude Code skill with the detailed rules — this page is the common ground.

## The kinds

| Kind       | Folder                                                                       | What it is                                                                              | Skill                        |
| ---------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------- |
| page       | `pages/<section>/`                                                           | A list, entity view or tool page rendered at `/p/<id>`                                  | `adding-a-page-or-report`    |
| dashboard  | `dashboards/<section>/` (section overviews flat)                             | KPIs and charts                                                                         | `adding-a-page-or-report`    |
| report     | `reports/<section>/`                                                         | An exportable page; appears in the Reports catalogue automatically                      | `adding-a-page-or-report`    |
| playbook   | `playbooks/<section>/`                                                       | A change: inputs → dry-run preview → confirm → steps (read and write)                   | `adding-a-playbook`          |
| runbook    | `runbooks/<section>/`                                                        | A guided procedure of playbooks and manual steps                                        | `adding-a-playbook`          |
| schedule   | `schedules/<job group>/` (`reports/`, `probes/`, `maintenance/`, `billing/`) | Something that runs unattended as the automation identity                               | `adding-a-schedule-or-probe` |
| probe      | `probes/`                                                                    | A synthetic check or KQL configuration check, run by schedules                          | `adding-a-schedule-or-probe` |
| connection | `connections/`                                                               | Your own Entra-secured API or Azure Function AdminForge may call (not Microsoft's APIs) | `adding-a-service-connector` |
| feed       | `feeds/`                                                                     | A source for News and changes                                                           | `add-news-feed`              |
| navigation | `navigation.yaml`                                                            | Section order, labels, icons and coded items of the navigation rail                     | —                            |

PowerShell scripts (`scripts/<service>/*.ps1`) live in content too, but they are files the runner pins by SHA-256,
not YAML definitions (`adding-a-runner-script`).

## Sections

The navigation rail's parent sections (`navigation.yaml`) are `overview`, `identity`, `m365`, `exchange`,
`sharepoint`, `teams`, `endpoint`, `security`, `azure`, `avd`, `billing`, `automation`, `reports` and `admin`. A
definition joins one with `nav.section`; a report's catalogue area is its id's first segment or `area:`; a probe's
service is `group:` (a section key, or `platform` for AdminForge itself). Folders follow the id, not the section: the
Exchange, SharePoint and Teams pages kept their `m365.*` ids (and `pages/m365/`) when they moved to their own
sections, so links, schedules and saved views kept working. `adminforge validate` enforces it (folder = id prefix;
the exceptions and the full taxonomy are in [`portal/content/README.md`](../../portal/content/README.md)), and
`adminforge list --section <key>` finds a section's content wherever it is filed. A new section for a service or team
follows the pattern in [`docs/extending.md`](../extending.md#extension-points) (navigation entry, overview dashboard,
reports area, probes with a group: the section's row then shows their status and links to `/monitoring?group=<key>`).

## Every definition

```yaml
$schema: ../../../packages/schemas/generated/report.schema.json # keep it: VS Code autocompletes and validates
kind: report
id: identity.inactive-users # <section>.<name>, lower kebab (see the repository map's naming table)
version: 1.0.0 # semver — see "Versions" below
title: Inactive users # what people see; sentence case
summary: >- # one or two sentences: what it shows and why it matters
  Enabled member accounts with no sign-in for the chosen number of days…
owner: identity-team # the team that answers for it
tags: [identity, users, hygiene, report] # lower-case; they drive search and the catalogue filters
nav: { section: reports, label: Inactive users, icon: clock-user, order: 12 }
requires:
  portalRoles: [Portal.Reader] # every listed role is required
  scopes: { graph: [User.Read.All, AuditLog.Read.All] } # exact Microsoft permissions the requests need
  entraRoles: [Reports Reader] # the least directory role that can do it (guidance shown to people)
  licences: [signInLogs] # licences are data, not blockers: the UI explains instead of failing
```

- **Scaffold, don't copy-paste:** `pnpm adminforge new <kind> <section>/<name>` (kinds: page, dashboard, report,
  playbook, runbook, connection, probe, schedule, feed; pages also take
  `--template list-detail|dashboard|report|entity`) writes the file, a fixture stub and the right `$schema` line.
  Scripts are added by hand with their skill (`adding-a-runner-script`).
- **Reuse first:** `pnpm adminforge list --section <section>` (or `--kind`, `--search`, `--status`) and
  `rg -l "<topic>" portal/content`; extend an existing definition before adding a near-duplicate.
- **Installation values** are `${ env.X }` with the key documented in `config/example.env` — never literal tenant
  values. Expressions can read only non-secret `AF_*` keys.
- **Requirements:** `requires` can also name `azureRoles`. Licences: declare them and record anything new in
  `docs/licensing-review.md`.
- **Columns:** `kind: status` only for values that are fine or not (a tone); a category is `kind: enum` with a `map`
  of labels (`map: { AzureAd: Entra joined }`), shown as plain text with a facet filter ([widgets](../widgets.md)).
- **Entity pages** declare `entity:` (`user`, `group`, `device`, `app` or `resource`) and take an `id` param; the
  command palette opens that kind of search result there, so `validate` allows one active page per kind.
- **Patterns** (`pattern:` on params and inputs) always match the whole value — they run as `^(?:…)$` with the `u`
  flag — and `validate` refuses one that can backtrack without bound: nested or side-by-side repetition of the same
  characters, backreferences, inline flags.
- The JSON schemas behind `$schema` are generated (`pnpm --filter @adminforge/schemas build`), not committed.

## Versions and status

- Any change to a published definition **bumps `version`**: patch for fixes and wording, minor for additions (a
  column, a filter, an optional input), major for anything that changes what an existing input, schedule or saved
  view relies on.
- `publish` refuses a version that is already published with different content ("Bump the version"), and published
  versions only move forward.
- `status`: `draft` (out of navigation and unattended use while you work), `active` (default), `deprecated` (still
  works, steer people elsewhere), `retired` (gone from use). Retire with `status: retired`, a version bump and a
  `summary` that starts `Retired — <why, or replaced by Title (id)>.` — what people who open it are shown — because
  deleting the file leaves the old version live in the database. Retire everything that belongs together (pages,
  reports, their schedules — also `enabled: false` — playbooks, runbooks, probes, connections), remove links to them
  from active content (`tests/content/retired-content.test.ts` fails otherwise) and say in `docs/backlog.md` how to
  bring them back. A retired definition must still pass `validate`.
- **Preview:** a definition not yet confirmed to work against a live tenant (checked only on fixtures, or with a known
  live problem) carries `preview: true` plus a version bump: pages show a quiet "Preview" badge and
  `adminforge validate` lists them. It changes nothing about how it runs; remove it (version bump) once it works live.
  Don't use `status: preview`.
- Approvals cover a fingerprint of the definition: a new version of a playbook that a write-capable schedule runs
  switches that schedule off until a second person approves again. That is intended.
- A schema change that isn't backward-compatible bumps `CONTENT_SCHEMA_VERSION`
  (`portal/packages/schemas/src/schema-version.ts`) in the same change; `publish --dry-run` then lists the rows
  published under an older version.

## Writing queries safely

- Filter at the source (`$filter`, `$select`, `$top`, KQL `where`); transforms have a 250 ms budget.
- Untrusted values: `$odata()` / `$odataSearch()` in Graph filters and searches, `$kql()` in KQL, `$encode()` in path
  segments, `$guid()` for ids. Advanced filters are compiled server-side: declare `filters.advanced.fields` and use
  `${ advanced }`. `validate` follows user data — params (except enum params), inputs, rows, `ds.<name>` per field —
  through functions, variables and lambdas, so wrapping a value doesn't hide it; write
  `name eq ${ $odata(params.q) }` and `| where name == ${ $kql(params.q) }` (never inside your own quotes) and
  `"displayName:${ $odataSearch(params.q) }"` (inside them). A whole path may be a guid or entity param as it is; a
  whole KQL query from a param needs `${ /* adminforge: user-query */ params.kql }`.
- **Resource Graph limits:** `validate` refuses the queries Azure refuses ([CLAUDE.md](../../CLAUDE.md) rule 14;
  `adding-a-page-or-report` has the detail). Rows that already join another table (patch assessments, Recovery
  Services, Defender assessments) get subscription names from a small `resourcecontainers` datasource joined with
  `$attach` in the rows' transform (`azure.vms-without-backup`: `subs`) — the only transform such a list has.
- **Scale:** lists that can reach thousands of rows page in Resource Graph or Graph with no per-row transform; numbers
  come from a separate `summarize` query. A transform over a big list uses the native helpers and gets a
  `tests/content/content-at-scale-*.scale.test.ts` case at the list's largest size under the real 250 ms budget.
- Run every new request once against the validation tenant, read-only — fixtures can't tell you Microsoft rejects a
  query. The skills list the Graph and Resource Graph quirks people trip over. What you couldn't check live goes in
  `docs/licensing-review.md` (what each request relies on) and `docs/backlog.md` (the check still to do).

## Write safety (playbooks and runbooks)

The schema refuses most mistakes; know the rules so you design for them (`adding-a-playbook` has the detail):

- A definition that writes declares top-level `mode: write`, and its `requires.portalRoles` includes
  `Portal.Operator`. Steps that `PUT`/`PATCH`/`DELETE` must be `mode: write`; a `POST` must say `mode: read` or
  `mode: write`; every write step has a `describe` shown in the dry-run plan.
- `risk`: `high` needs a `confirm` block (`click` or `typed`); `critical` needs `confirm` **and**
  `approval: { required: true }`. Approvals exclude the people a change grants access to (`approval.excludes`), and
  nobody approves their own request.
- Secrets a step produces (temporary access passes, passwords, app secrets) are listed in `secretOutputs` — shown once,
  never stored in run outputs or the audit log. Inputs that are sensitive are `redact: true`.
- Make steps safe to re-run or undo: `assert` preconditions, `compensate` where a change can be reversed, and mark
  non-idempotent steps `idempotent: false` — it matters on every restart, not only a crash: a step still in flight
  ten seconds after a stop is sent again unless it says `idempotent: false` (then the run ends `needs_review`). A
  `compensate` block runs only when a **later** step fails — it isn't an undo button, so don't promise one for a
  playbook whose last step is the write.
- **Act on what the person saw.** When the target's id can be reused or change hands (AVD session ids are Windows
  session numbers; a list can be minutes old), pass what the row showed (`expectedUser`) and `assert` the looked-up
  target still matches before writing (`avd.log-off-user-session`).
- Bulk actions are a page's `bulkActions` with `forEach.inputs`, `concurrency` and `maxItems` (the browser's limit;
  the API takes at most 1,000 items). For `high` risk prefer `confirm: { type: typed, … }` — in bulk it asks for the
  number of items. The bulk run's audit event records the inputs every item shares (a reason), redacted like a
  single run's.
- Privileged Write scopes (role management, app credentials, consent) are only granted with an explicit installation
  opt-in (`AF_ALLOW_PRIVILEGED_WRITE_SCOPES`) — design so you don't need them.
- Playbooks carry `tests:` (dry runs with mocked step outputs) run by `pnpm adminforge test`.
- AdminForge refuses writes to its own apps, its role groups and protected accounts centrally; don't try to route
  around that in content. Because it matches by object id, a write names a user by id: the segment after `/users/` —
  in the path, a `$id` query or an `@odata.id` / `…@odata.bind` reference — is `$guid(…)`, even for an id an earlier
  step returned; look a sign-in name up in a `mode: read` step first (`user_not_by_id` otherwise). Don't set
  `Authorization`, `Cookie`, `Host` or the client-request-id headers.

## Unattended work (schedules and probes)

- Schedules run as the automation identity. Read-only jobs (probes, reports, content health) can start enabled;
  anything that writes needs a second person's approval in the portal before it runs.
- The automation identity's permissions come from content `requires.scopes` plus the provisioning catalogue
  (`portal/tools/cli/src/provision/catalog.ts`); write and sensitive-read permissions need installation opt-ins
  (`AF_AUTOMATION_ALLOW_*`). A change to scopes needs `pnpm adminforge validate --scopes` and a provisioning run by a
  code owner.
- PowerShell jobs (`job.kind: script`) aren't supported yet (`script_not_supported`): the runner can't sign in as the
  automation identity.
- Recipients and webhooks are configuration keys (`${ env.AF_…_RECIPIENTS }`), never addresses in content.
- **Probes explain themselves:** `group:` (the service), `remedy:` (plain sentences: likely causes, the first step,
  what "not configured" and "forbidden" mean for this check) and `link:` (`/p/<key>?<filter>=…` — validated to exist —
  or a Microsoft admin centre over https). Keep detail rows (`fields`, `detailsLimit`) to the columns that say which
  item and why, name first. Rows are shown to Operators only and never go into the message. Probes are swept by tag:
  `sweep-15m`, `sweep-1h`, `sweep-6h`, `config-check` (Resource Graph configuration checks — add the id to
  `CONFIG_CHECKS` in `tests/content/probes-schedules.test.ts`; health-type KQL probes that need a faster sweep go in
  its `OPERATIONAL` map).
- Report schedules can also be created in the portal by Operators (stored in the database, ids starting with
  `portal.`, which content may not use). Use content when the schedule should be reviewed and versioned.

## Fixtures

Every datasource needs a synthetic fixture so mock mode, e2e and the content tests render it:
`tests/fixtures/<service>/…` following the naming scheme at the top of
`portal/packages/connectors/src/fixtures.ts`. Resource Graph and Log Analytics queries — KQL probes included — start
with a `// af:<id>` comment so their fixture can match it (`tests/content/fixtures-complete.test.ts` fails without
one). An HTTP, DNS or certificate probe needs a `hosts/`, `dns/` or `tls/` fixture (see
[Testing → Fixtures](09-testing.md#fixtures)). `Example Org`, `example.com`, generated GUIDs only.
`pnpm adminforge fixtures record <page>` reads a page live as the automation identity (read-only) and writes
sanitised fixtures — review every file before committing.

## The loop

```bash
pnpm adminforge validate              # every definition: schema, references, expressions, query lint, env keys
pnpm adminforge validate --scopes     # + compare scopes with the app registrations (provisioner credentials)
pnpm adminforge test [pattern]        # playbook and runbook tests
pnpm --filter @adminforge/tests exec vitest run --project content
pnpm --filter @adminforge/tests exec vitest run --project scale   # wall-clock budgets at enterprise size (files named *.scale.test.ts)
pnpm guard
# then look at it in mock mode: /p/<id>
```

Content reaches the running portal only through `adminforge publish`, run by a code owner in the pod from an image built
from a reviewed commit on `main` ([Releases and operations](13-releases-and-operations.md)).

## Before you open the PR

- [ ] Searched for an existing definition (`pnpm adminforge list`); extended it if one fits
- [ ] `version` bumped on every changed definition; `status` right
- [ ] `requires` complete: roles, exact scopes, Entra/Azure role guidance, licences
- [ ] Untrusted values quoted (`$kql()`, not character stripping); filters at the source; Resource Graph join limits;
      new requests checked live (read-only), or listed as unchecked in `docs/licensing-review.md`
- [ ] Probes: `group`, `remedy`, `link`, detail rows that name the item; sweep tag (and `CONFIG_CHECKS`)
- [ ] Retiring: `status: retired` + version bump on everything related; no active links left; backlog note
- [ ] Writes: `mode`, `describe`, `risk` with `confirm`/`approval`, `secretOutputs`, `redact`, `assert`/`compensate`;
      stale targets asserted; playbook `tests:` added (including the refusal cases)
- [ ] Fixtures for every datasource; looks right in mock mode
- [ ] `content-reviewer` agent run; `validate`, `test`, content tests and guards clean

## Read next

[Testing](09-testing.md).
