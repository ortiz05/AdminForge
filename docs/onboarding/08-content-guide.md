# 8. Content guide

Most of AdminForge is **content**: YAML definitions in `portal/content`, validated against schemas, reviewed in git,
published to Postgres, and rendered or executed by the generic engine (ADR-005). This is where most contributions
happen. Each kind has a Claude Code skill with the detailed rules — this page is the common ground.

## The kinds

| Kind       | Folder                                                           | What it is                                                                              | Skill                        |
| ---------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------- |
| page       | `pages/<section>/`                                               | A list, entity view or tool page rendered at `/p/<id>`                                  | `adding-a-page-or-report`    |
| dashboard  | `dashboards/`                                                    | KPIs and charts                                                                         | `adding-a-page-or-report`    |
| report     | `reports/<section>/`                                             | An exportable page; appears in the Reports catalogue automatically                      | `adding-a-page-or-report`    |
| playbook   | `playbooks/<section>/`                                           | A change: inputs → dry-run preview → confirm → steps (read and write)                   | `adding-a-playbook`          |
| runbook    | `runbooks/<section>/`                                            | A guided procedure of playbooks and manual steps                                        | `adding-a-playbook`          |
| schedule   | `schedules/<job group>/` (`reports/`, `probes/`, `maintenance/`) | Something that runs on the host as the automation identity                              | `adding-a-schedule-or-probe` |
| probe      | `probes/`                                                        | A synthetic check or KQL configuration check, run by schedules                          | `adding-a-schedule-or-probe` |
| connection | `connections/`                                                   | Your own Entra-secured API or Azure Function AdminForge may call (not Microsoft's APIs) | `adding-a-service-connector` |
| feed       | `feeds/`                                                         | A source for News and changes                                                           | `add-news-feed`              |
| navigation | `navigation.yaml`                                                | Section order, labels, icons and coded items of the navigation rail                     | —                            |

PowerShell scripts (`scripts/<service>/*.ps1`) live in content too, but they are files the runner pins by SHA-256,
not YAML definitions (`adding-a-runner-script`).

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
  playbook, runbook, connection, probe, schedule; pages also take `--template list-detail|dashboard|report|entity`)
  writes the file, a fixture stub and the right `$schema` line. Feeds and scripts are added by hand with their skills.
- **Reuse first:** search (`rg -l "<topic>" portal/content`) and extend an existing definition before adding a
  near-duplicate.
- **Installation values** are `${ env.X }` with the key documented in `config/example.env` — never literal tenant
  values. Expressions can read only non-secret `AF_*` keys.
- **Requirements:** `requires` can also name `azureRoles`. Licences: declare them and record anything new in
  `docs/licensing-review.md`.
- The JSON schemas behind `$schema` are generated (`pnpm --filter @adminforge/schemas build`), not committed.

## Versions and status

- Any change to a published definition **bumps `version`**: patch for fixes and wording, minor for additions (a
  column, a filter, an optional input), major for anything that changes what an existing input, schedule or saved
  view relies on.
- `publish` refuses a version that is already published with different content ("Bump the version"), and published
  versions only move forward.
- `status`: `draft` (out of navigation and unattended use while you work), `preview`, `active` (default),
  `deprecated` (still works, steer people elsewhere), `retired` (gone from use). Retire with `status: retired` plus a
  version bump — deleting the file leaves the old version live in the database.
- Approvals cover a fingerprint of the definition: a new version of a playbook that a write-capable schedule runs
  switches that schedule off until a second person approves again. That is intended.

## Writing queries safely

- Filter at the source (`$filter`, `$select`, `$top`, KQL `where`); transforms have a 250 ms budget.
- Untrusted values: `$odata()` / `$odataSearch()` in Graph filters and searches, `$kql()` in KQL, `$encode()` in path
  segments, `$guid()` for ids. Advanced filters are compiled server-side: declare `filters.advanced.fields` and use
  `${ advanced }`.
- Run every new request once against the validation tenant, read-only — fixtures can't tell you Microsoft rejects a
  query. The skills list the Graph and Resource Graph quirks people trip over.

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
  non-idempotent steps `idempotent: false`.
- Bulk actions are a page's `bulkActions` with `forEach.inputs`, `concurrency` and `maxItems`.
- Privileged Write scopes (role management, app credentials, consent) are only granted with an explicit installation
  opt-in (`AF_ALLOW_PRIVILEGED_WRITE_SCOPES`) — design so you don't need them.
- Playbooks carry `tests:` (dry runs with mocked step outputs) run by `pnpm adminforge test`.
- AdminForge refuses writes to its own apps, its role groups and protected accounts centrally; don't try to route
  around that in content.

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
- Report schedules can also be created in the portal by Operators (stored in the database, ids starting with
  `portal.`, which content may not use). Use content when the schedule should be reviewed and versioned.

## Fixtures

Every datasource needs a synthetic fixture so mock mode, e2e and the content tests render it:
`tests/fixtures/<service>/…` following the naming scheme at the top of
`portal/packages/connectors/src/fixtures.ts`. Resource Graph and Log Analytics queries start with a
`// af:<id>` comment so their fixture can match it. `Example Org`, `example.com`, generated GUIDs only.
`pnpm adminforge fixtures record <page>` reads a page live as the automation identity (read-only) and writes
sanitised fixtures — review every file before committing.

## The loop

```bash
pnpm adminforge validate              # every definition: schema, references, expressions, query lint, env keys
pnpm adminforge validate --scopes     # + compare scopes with the app registrations (provisioner credentials)
pnpm adminforge test [pattern]        # playbook and runbook tests
pnpm --filter @adminforge/tests exec vitest run --project content
pnpm guard
# then look at it in mock mode: /p/<id>
```

Content reaches the running services only through `pnpm adminforge publish`, run by a code owner from a reviewed commit
on `main` ([Releases and operations](13-releases-and-operations.md)).

## Before you open the PR

- [ ] Searched for an existing definition; extended it if one fits
- [ ] `version` bumped on every changed definition; `status` right
- [ ] `requires` complete: roles, exact scopes, Entra/Azure role guidance, licences
- [ ] Untrusted values quoted; filters at the source; new requests checked live (read-only)
- [ ] Writes: `mode`, `describe`, `risk` with `confirm`/`approval`, `secretOutputs`, `redact`, `assert`/`compensate`;
      playbook `tests:` added
- [ ] Fixtures for every datasource; looks right in mock mode
- [ ] `content-reviewer` agent run; `validate`, `test`, content tests and guards clean

## Read next

[Testing](09-testing.md).
