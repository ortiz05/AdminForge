# Content

AdminForge's pages, dashboards, reports, playbooks, runbooks, schedules, probes, connections, feeds and navigation:
one YAML definition per file, validated against `portal/packages/schemas`, reviewed in git and published to the
database with `pnpm adminforge publish`. How to write one is in the
[content guide](../../docs/onboarding/08-content-guide.md) and the skills in `.claude/skills/`. This page says where
each definition goes and how to find what exists.

## Find before you add

Search what exists, then extend it and bump its `version` rather than add a near-duplicate (CLAUDE.md rule 4):

```bash
pnpm adminforge list --section exchange            # everything that shows in Exchange, wherever it is filed
pnpm adminforge list --kind report --search "inactive users"
pnpm adminforge list --kind playbook --section identity
pnpm adminforge list --status retired              # retired files stay in place: revive or extend before rewriting
rg -l "<topic>" portal/content                     # full text
```

`list` prints `id · kind · section · status · file`, sorted by section; `--json` adds title, owner, version and tags.
`--section` matches the section a definition shows in, its id prefix (its folder) or one of its tags, so the
Exchange playbooks, which have no navigation entry and keep `m365.*` ids, turn up under `exchange` too. All options:
[`portal/tools/cli/README.md`](../tools/cli/README.md) (`list`).

## Folders follow ids

A definition with the id `<prefix>.<name>` is the file `<kind folder>/<prefix>/<name>.<kind>.yaml`:
`identity.inactive-users` is `reports/identity/inactive-users.report.yaml`. When the prefix is the kind folder's own
name, the file sits in the kind folder itself: `probes.dns-mx` is `probes/dns-mx.probe.yaml`. `pnpm adminforge new
<kind> <prefix>/<name>` writes the file there, and `pnpm adminforge validate` (so also `publish`) refuses a definition
anywhere else and names the folder it belongs in. The file name is normally the rest of the id; a few older files
differ (`identity.health` is `dashboards/identity-health.dashboard.yaml`).

| Kind       | Folder                  | File                                                                                |
| ---------- | ----------------------- | ----------------------------------------------------------------------------------- |
| page       | `pages/<prefix>/`       | `<name>.page.yaml`                                                                  |
| dashboard  | `dashboards/<prefix>/`  | `<name>.dashboard.yaml`                                                             |
| report     | `reports/<prefix>/`     | `<name>.report.yaml`                                                                |
| playbook   | `playbooks/<prefix>/`   | `<name>.playbook.yaml`                                                              |
| runbook    | `runbooks/<prefix>/`    | `<name>.runbook.yaml`                                                               |
| schedule   | `schedules/<prefix>/`   | `<name>.schedule.yaml`                                                              |
| probe      | `probes/` (`probes.*`)  | `<name>.probe.yaml`                                                                 |
| connection | `connections/<prefix>/` | `<name>.connection.yaml`                                                            |
| feed       | `feeds/` (`feeds.*`)    | `<name>.feed.yaml`                                                                  |
| navigation | the content root        | `navigation.yaml` (`portal.navigation`)                                             |
| —          | `scripts/<service>/`    | PowerShell the runner pins by sha256, not definitions: [scripts](scripts/README.md) |

The suffix must match `kind:` (the loader refuses `x.page.yaml` with `kind: report`).

**Ids never change once published**: saved views, schedules, runs, approvals, links and the audit log key on them.
So a folder says where a definition was filed, not where it shows. When Exchange, SharePoint and Teams got their own
navigation sections, their pages and reports kept their `m365.*` ids and stayed in `pages/m365/` and
`reports/m365/`; `nav.section` and `area` moved them. Look things up by section with `adminforge list --section`, not
by folder, and choose a new definition's prefix by the section it belongs to.

### Exceptions

Three folders predate the rule and also hold the ids below (`FOLDER_EXCEPTIONS` in
`portal/tools/cli/src/content/check.ts`; a test fails when one no longer holds a file). Nothing else is accepted.

| Folder               | Also holds                                      | What                                                                                                                        |
| -------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `dashboards/` (flat) | `<section>.*` whose prefix is its `nav.section` | Section overviews (`exchange.dashboard.yaml` is `exchange.overview`); a new one follows the rule, as `billing.overview` did |
| `schedules/probes/`  | `sweep.*`                                       | The probe sweeps (below)                                                                                                    |
| `connections/`       | `integrations.*`                                | `integrations.hr-sync`; a new connection goes in `connections/<prefix>/`                                                    |

## Sections: where a definition shows

The navigation sections are declared in `navigation.yaml` (`identity`, `m365`, `exchange`, `sharepoint`, `teams`,
`endpoint`, `security`, `azure`, `avd`, `billing`, `automation`, …). Each kind joins one its own way; `adminforge
list` shows the result in its section column:

| Kind                               | Section                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| page, dashboard, playbook, runbook | `nav.section`; without one (entity pages, most playbooks) the id prefix                                  |
| report                             | `area` (its Reports catalogue area), else the id prefix. Its `nav.section` is usually `reports`          |
| probe                              | `group` (a section key, or `platform` for AdminForge itself): its service's "Service checks" list        |
| schedule                           | the section of the report, playbook or probe it runs (`job.ref`); a sweep or housekeeping job: id prefix |
| connection, feed, navigation       | the id prefix                                                                                            |

## Probes and schedules

- **Probes** are `probes.<name>`, flat in `probes/`; `group:` says which section's checks list them, and a tag
  (`sweep-15m`, `sweep-1h`, `sweep-6h`, `config-check`, `synthetic-transaction`) says which sweep runs them.
  `pnpm adminforge new probe probes/<name>` and Query Studio's _Save as probe_ write them there. (`new probe
  <section>/<name>` makes `probes/<section>/<name>.probe.yaml`, id `<section>.<name>`, which the rule also accepts.)
- **Schedules** are filed by job, and the job group is the id prefix: `schedules/reports/` holds report deliveries
  (`reports.<report>-<cadence>`), `schedules/probes/` the probe sweeps (`sweep.<cadence>`: tag a probe to join one
  before adding a schedule), `schedules/maintenance/` the platform's own jobs (`maintenance.content-health`,
  `maintenance.news-refresh-hourly`) and `schedules/billing/` the billing jobs (`billing.*`). Report schedules an
  Operator makes in the portal live only in the database (`portal.*`, a reserved prefix).

## Retired definitions

Retire with `status: retired` plus a version bump; never delete or move the file (deleting it leaves the last
version live in the database). Retired files stay beside the active ones, still pass `validate`, and are listed with
`adminforge list --status retired`. `tests/content/retired-content.test.ts` fails while active content links to one.
