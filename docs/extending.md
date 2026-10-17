# Extending AdminForge with Claude Code

AdminForge is built to be extended by engineers working in **Claude Code** (ADR-012). The repository carries everything
Claude needs to make a consistent change: the rules (`CLAUDE.md`), a skill per extension point, reviewer agents, and
hooks that validate as files are written. You describe what you want; Claude follows the same path every time.

## How to ask

Open Claude Code in the repo and describe the outcome, e.g.:

- "Add a report of guests who haven't signed in for 90 days, exportable, and email it every Monday."
- "Add a configuration check that flags storage accounts with public blob access and run it every 6 hours."
- "Add a bulk action on the groups page to remove the selected members."
- "Show Arc machines that haven't reported in 24 hours on the Azure dashboard."
- "Add the Defender for Cloud what's-new page to News and changes."
- "Give Azure Virtual Desktop its own section: host pools, session host health and a check for pools near capacity."
- "We don't use Function Apps any more — retire their pages, reports and checks."

Claude picks the matching skill automatically (or name it: "use the adding-a-playbook skill").

## Extension points

| You want…                                                                                                                       | Skill                         | Usually touches                                                          |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| A page, dashboard, entity view, list, report; new columns, filters, KPIs, row/bulk actions                                      | `adding-a-page-or-report`     | `portal/content/{pages,dashboards,reports}`, `tests/fixtures`            |
| Query-builder filters on a list (Graph → `odata`, KQL → `kql`, PowerShell/static rows → `rows`)                                 | `adding-a-page-or-report`     | the page's `filters.advanced`                                            |
| An action or guided procedure (disable user, reset MFA, restart app, runbook)                                                   | `adding-a-playbook`           | `portal/content/{playbooks,runbooks}`                                    |
| Something that runs on a schedule on this host; monitoring; a configuration/compliance check; KQL at scale                      | `adding-a-schedule-or-probe`  | `portal/content/{schedules,probes}`                                      |
| A service check on Synthetic monitoring (endpoint, incidents, sign-ins; mail flow, file or meeting transaction on test objects) | `adding-a-schedule-or-probe`  | `portal/content/probes` (`group:`, `remedy:`, `link:`)                   |
| A new parent section for a service or team (Azure Virtual Desktop, Azure Billing, Exchange Online)                              | `adding-a-page-or-report`     | `navigation.yaml`, an overview dashboard, `probes` and `reports` (below) |
| Retiring content nobody needs any more (pages, reports, schedules, playbooks, probes)                                           | the kind's skill              | `status: retired` + version bump on each; links to it removed            |
| A recurring delivery of an existing report (file, email or Teams), at most hourly — no change to the repository                 | none: in the portal           | Reports → the report → Schedule (Operator; stored in the database)       |
| A source in News and changes (Microsoft blog, roadmap, update/security feed, Learn what's-new page, module releases)            | `add-news-feed`               | `portal/content/feeds`, `tests/fixtures/hosts`, `docs/news.md`           |
| A visualisation or interaction the widgets can't express                                                                        | `adding-a-widget`             | `portal/packages/widgets`, `docs/widgets.md`                             |
| A new Microsoft API, your own Entra-secured API/Function, a blocked read-only POST                                              | `adding-a-service-connector`  | `portal/content/connections`, `portal/packages/connectors`, provisioning |
| PowerShell (Exchange, distribution lists, Teams, SharePoint); write scripts take the object ids of the accounts they change     | `adding-a-runner-script`      | `portal/content/scripts`, `tests/runner`                                 |
| Backend behaviour content can't express                                                                                         | `adding-an-api-route`         | `portal/apps/api`, `portal/packages/schemas`                             |
| The look and feel                                                                                                               | `changing-the-design-system`  | `portal/packages/design-tokens`, `portal/packages/ui/src/recipes`        |
| Checking it against a real tenant                                                                                               | `validating-against-a-tenant` | `tests/live`, `~/.config/adminforge/*.env`                               |

A new **parent section** is consistent when it has: a `navigation.yaml` section (key, label, icon, order); its pages
and overview dashboard under `nav.section: <key>`; its reports in the catalogue area `<key>` (an id starting `<key>.`,
or `area: <key>`), with a "… reports" item pointing at `/reports?area=<key>` when the section is mostly reports; and,
when it has checks, probes with `group: <key>` (each with a `remedy` and a `link`), a "Service checks" item pointing
at `/monitoring?group=<key>` and a `probeStatus` widget with `group: <key>` on the overview. `avd` is the full
example; `billing` is a reports-only section (`tests/content/m365-workload-sections.test.ts` checks Exchange,
SharePoint and Teams).

**Retiring** keeps history: `status: retired` with a version bump on every related definition (a schedule also
`enabled: false`), nothing active may link to, embed, run or schedule it (`tests/content/retired-content.test.ts`),
`publish --dry-run` lists it as `− retire`, and `docs/backlog.md` says how to bring it back. Never delete the files.

## Guardrails that run automatically

- **On every file Claude writes** (`.claude/hooks/after-edit.mjs`): code and docs (`.ts`, `.tsx`, `.js`, `.mjs`,
  `.json`, `.css`, `.md`, outside `portal/content`, `tests/fixtures` and `docs/plans`) → Prettier; content YAML →
  `adminforge validate`; UI code → no raw colours / arbitrary Tailwind values; runner scripts → lists content whose
  pinned sha256 is now stale.
- **On every commit** (`.githooks/pre-commit`, enabled by `pnpm install` or `git config core.hooksPath .githooks`):
  guard tests — no secrets, no tenant-specific values, tokens-only UI.
- **In CI** (`.github/workflows/ci.yml`): dependency audit, guards, lint, `format:check`, typecheck, database
  migrations, the unit / component / api / content tests, a production build with the initial-load budget, e2e +
  visual in mock mode, and a production-build smoke test (`pnpm test:e2e:prod`).
- **In `adminforge validate`** (content rules people trip over): Resource Graph queries may not start with `union`;
  user data in a request `path`/`url` needs `$encode()`; email recipients are `${ env.AF_…RECIPIENTS }`-style keys
  only; a playbook that starts a confirmed or high-risk child needs its own `confirm`; `$eval` is unavailable; a news
  feed's URL must be on the feed-host allow-list and its links on Microsoft domains; schedule ids starting with
  `portal.` are reserved for report schedules created in the portal; inside a datasource's `when`, request or runner
  parameters another datasource is `ds.<name>` (a bare name is undefined there); a Resource Graph query has at most
  three `join`/`union` operations and one join to another table unless all are `resources` ↔ `resourcecontainers`
  (Azure refuses the rest — read subscription names in their own datasource and `$attach` them); a probe's `link` is
  an in-app path whose `/p/<key>` exists, or an https URL (no `//host`).
- **In the content tests:** every active probe has a `remedy` (`tests/content/probe-remedies.test.ts`); nothing
  active points at retired content (`tests/content/retired-content.test.ts`); probe groups name a navigation section.
- **In the production-build smoke test** (`tests/e2e/prod/csp-no-eval.spec.ts`): a page loaded under the API's
  `script-src 'self'` policy must cause no Content-Security-Policy violation — no `eval`, `new Function` or inline
  script in the bundle (`SECURITY.md` › Host and network).
- **In provisioning** (`adminforge provision entra`): tier-0 Write scopes, application write permissions and
  sensitive application reads are only granted with their opt-ins (`docs/access.md`); `provision status` fails on
  privilege it didn't grant.
- **Not caught by `validate` yet:** widget, header and action expressions (`when`, `href`, `text`) run in the
  browser, which has no `env` — `env.X` there is always empty. Read configuration in a `source: static` datasource
  and use its answer (the page skill shows how).
- **Fixtures can't catch what Microsoft rejects:** run every new Graph request, Resource Graph or KQL query once
  against a real tenant, read-only (the page and schedule skills show how).
- **Fixtures can't catch scale either:** `pnpm test:perf` (`tests/perf`, not part of `pnpm test`) runs every
  datasource against a synthetic 100k-user tenant with budgets in `tests/perf/budgets.json`. Transforms over big lists
  use the native helpers (`$applyAdvanced`, `$withFields`, `$take`, and for joins and per-item rows `$pluck`,
  `$unnest`, `$attach`, `$pick`, `$withCount`, `$idsWhere`, `$flagIn`, `$tableRows` (columnar answers such as
  Cost Management), `$withShare`, and the `containsAny`-style operators); a derived
  datasource passes on the `truncated`
  flag of what it reads and says when the data is partial; a capped table exports the whole list — the page skill has
  the rules.

## Reviewers

Ask Claude to run a reviewer before you commit (they read uncommitted changes) or open a PR:

- `content-reviewer` — reuse, write safety, query quoting, declarations, fixtures for content changes.
- `security-reviewer` — tokens, read/write enforcement, injection, secrets, audit for code changes.
- `design-reviewer` — design-system compliance, accessibility, and a screenshot critique for UI changes.

## Keeping this working

Tool references: `portal/tools/cli/README.md` (every `adminforge` command), `tooling/README.md`, `portal/apps/runner/README.md`
and `portal/content/scripts/README.md` (runner scripts), `tests/README.md` (test projects and shared helpers).

When you change _how_ something is extended (a new schema field, a new CLI command, a new widget convention), update the
matching skill in `.claude/skills/` and this page in the same change. Skills are tested like code: run a fresh agent
through a realistic request with the skill and check it follows the rules (see the writing-skills approach in the
plan's R7).
