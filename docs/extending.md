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
| Something that runs on a schedule, unattended; monitoring; a configuration/compliance check; KQL at scale                       | `adding-a-schedule-or-probe`  | `portal/content/{schedules,probes}`                                      |
| A service check on Synthetic monitoring (endpoint, incidents, sign-ins; mail flow, file or meeting transaction on test objects) | `adding-a-schedule-or-probe`  | `portal/content/probes` (`group:`, `remedy:`, `link:`)                   |
| A new parent section for a service or team (Azure Virtual Desktop, Azure Billing, Exchange Online)                              | `adding-a-page-or-report`     | `navigation.yaml`, an overview dashboard, `probes` and `reports` (below) |
| Retiring content nobody needs any more (pages, reports, schedules, playbooks, probes)                                           | the kind's skill              | `status: retired` + version bump on each; links to it removed            |
| A recurring delivery of an existing report (file, email or Teams), at most hourly — no change to the repository                 | none: in the portal           | Reports → the report → Schedule (Operator; stored in the database)       |
| A source in News and changes (Microsoft blog, roadmap, update/security feed, Learn what's-new page, module releases)            | `add-news-feed`               | `portal/content/feeds`, `tests/fixtures/hosts`, `docs/news.md`           |
| A visualisation or interaction the widgets can't express                                                                        | `adding-a-widget`             | `portal/packages/widgets`, `docs/widgets.md`                             |
| A screen the content renderer can't express (runs, schedules, Query Studio, settings)                                           | `adding-a-coded-screen`       | `portal/apps/web/src/{routes,<feature>}`, `tests/{component,e2e}`        |
| A new Microsoft API, your own Entra-secured API/Function, a blocked read-only POST                                              | `adding-a-service-connector`  | `portal/content/connections`, `portal/packages/connectors`, provisioning |
| PowerShell (Exchange, distribution lists, Teams, SharePoint); write scripts take the object ids of the accounts they change     | `adding-a-runner-script`      | `portal/content/scripts`, `tests/runner`                                 |
| Backend behaviour content can't express                                                                                         | `adding-an-api-route`         | `portal/apps/api`, `portal/packages/schemas`                             |
| A new setting: a configuration key, an installation value content reads, a feature switch or limit                              | `adding-a-configuration-key`  | `config/example.env`, `portal/apps/api/src/config.ts`                    |
| A new `$function` for content expressions (a native row helper, a date or id helper)                                            | `adding-an-expression-helper` | `portal/packages/expressions`, `docs/content-recipes.md`                 |
| A new `adminforge` command or option                                                                                            | `adding-a-cli-command`        | `portal/tools/cli`, its `README.md`                                      |
| A decision others must not undo by accident                                                                                     | `adding-an-adr`               | `docs/adr`, `docs/decisions.md`                                          |
| The look and feel                                                                                                               | `changing-the-design-system`  | `portal/packages/design-tokens`, `portal/packages/ui/src/recipes`        |
| Checking it against a real tenant                                                                                               | `validating-against-a-tenant` | `tests/live`, `~/.config/adminforge/*.env`                               |

Every skill has the same shape — Overview, When not to use, Steps, Done when, Common mistakes, See also — so you can
check a session against its "Done when" list. The how-to reference the content skills share (quoting user data, the
expression helpers, JSONata habits, Graph / Resource Graph / ARM quirks, fixtures, versions and retiring) is
`docs/content-recipes.md`.

A new **parent section** is consistent when it has: a `navigation.yaml` section (key, label, icon, order); its pages
and overview dashboard under `nav.section: <key>`; its reports in the catalogue area `<key>` (an id starting `<key>.`,
or `area: <key>`), with a "… reports" item pointing at `/reports?area=<key>` when the section is mostly reports; and,
when it has checks, probes with `group: <key>` (each with a `remedy` and a `link`): the section's row in the
navigation then shows their status and links to `/monitoring?group=<key>` (no navigation item for them); and a
`probeStatus` widget with `group: <key>` on the overview. `avd` is the full example; `billing` is a reports-only
section (`tests/content/m365-workload-sections.test.ts` checks Exchange, SharePoint and Teams).

**Retiring** keeps history: `status: retired` with a version bump on every related definition and a summary that
starts `Retired — <why, or replaced by Title (id)>.` (the sentence people see when they open it); nothing active may
point at it (`tests/content/retired-content.test.ts`). Never delete the files. **Preview** (`preview: true` plus a
version bump) marks new content not yet confirmed to work against a live tenant: pages show a quiet "Preview" badge
and `adminforge validate` lists them; remove it once it works live. The full procedure for both:
`docs/content-recipes.md` › Versions, previews and retiring.

## Guardrails that run automatically

- **On every file Claude writes** (`.claude/hooks/after-edit.mjs`): code and docs (`.ts`, `.tsx`, `.js`, `.mjs`,
  `.json`, `.css`, `.md`, outside `portal/content`, `tests/fixtures` and `docs/plans`) → Prettier; content YAML →
  `adminforge validate`; UI code → no raw colours / arbitrary Tailwind values; runner scripts → lists content whose
  pinned sha256 is now stale.
- **On every commit** (`.githooks/pre-commit`, enabled by `pnpm install` or `git config core.hooksPath .githooks`):
  guard tests — no secrets, no tenant-specific values, tokens-only UI, test file names, no runtime deep imports.
- **In CI** (`.github/workflows/ci.yml`): dependency audit, guards, lint, `format:check`, typecheck, database
  migrations, the unit / component / api / content tests, a production build with the initial-load budget, e2e +
  visual in mock mode, and a production-build smoke test (`pnpm test:e2e:prod`).
- **In `adminforge validate`** (content rules people trip over): user data, however wrapped (`$lowercase`, `$trim`,
  `$map`, a variable), needs `$encode()` in a `path`/`url`, `$odata()` (outside quotes) in `$filter`/`$orderby`/
  `$expand`, `$odataSearch()` (inside `"…"`) in `$search` and `$kql()` (outside quotes) in KQL; a whole path may be a
  guid/entity param as it is; a whole KQL query from a param needs `/* adminforge: user-query */`; `$x := …` only as a
  block statement; a write's `/users/` segment (path, `$id`, `@odata.id` / `…@odata.bind`) needs `$guid()`; request
  headers AdminForge owns (`Authorization`, `Cookie`, `Host`, the client-request-id headers) are refused; email
  recipients are `${ env.AF_…RECIPIENTS }`-style keys only; a playbook that starts a confirmed or high-risk child needs
  its own `confirm`; an approval can't have `onError: continue`; `$eval` is unavailable; a news feed's URL must be on
  the feed-host allow-list and its links on Microsoft domains; schedule ids starting with `portal.` are reserved for
  report schedules created in the portal; inside a datasource's `when`, request or runner parameters another datasource
  is `ds.<name>` (a bare name is undefined there); Resource Graph queries must stay within the join limits Azure
  enforces (`CLAUDE.md`, non-negotiable 14); a probe's `link` is an in-app path whose `/p/<key>` exists, or an https URL
  (no `//host`); `pattern:`s that can backtrack without bound are refused. It also lists the definitions flagged
  `preview: true`. The details: `docs/content-recipes.md` › Quoting user data.
- **In the content tests:** every active probe has a `remedy` (`tests/content/probe-remedies.test.ts`); nothing
  active points at retired content (`tests/content/retired-content.test.ts`); probe groups name a navigation section;
  every active page, dashboard and report renders from the fixtures and every KQL probe has its `af:` fixture variant
  (`tests/content/fixtures-complete.test.ts`); `status` columns carry a tone that says fine or not, categories are
  `enum` (`tests/content/status-tones.test.ts`).
- **In the browser:** every widget renders inside its own error boundary, so a block that can't be shown says so
  with a reference and the rest of the page keeps working; links templated from data open only safe addresses
  (`safeUrl`) and otherwise stay text.
- **In the production-build smoke test** (`tests/e2e/prod/csp-no-eval.spec.ts`): a page loaded under the API's
  `script-src 'self'` policy must cause no Content-Security-Policy violation — no `eval`, `new Function` or inline
  script in the bundle (`SECURITY.md` › Deployment, storage and network).
- **In provisioning** (`adminforge provision entra`): tier-0 Write scopes, application write permissions and
  sensitive application reads are only granted with their opt-ins (`docs/access.md`); `provision status` fails on
  privilege it didn't grant.
- **At run time:** a restart (every deploy) lets each run finish the step it is on; a step still in flight 10 s after
  a stop is retried after the restart unless it says `idempotent: false` (then the run ends `needs_review`) — declare
  it on every write whose repeat would hurt: a write in flight at a stop may have taken effect. A run that continues
  after any pause (an approval, input, write access, a sign-in, a `wait`, a restart) runs its asserts and the reads
  they use again before its next write, while a branch `if` or a forEach's `items` stays as decided — put guards in
  `assert` steps.
- **Not caught by `validate` yet:** widget, header and action expressions (`when`, `href`, `text`) run in the
  browser, which has no `env` — `env.X` there is always empty. Read configuration in a `source: static` datasource
  and use its answer (`docs/content-recipes.md` › Configuration in browser expressions).
- **Fixtures can't catch what Microsoft rejects:** run every new Graph request, Resource Graph or KQL query once
  against a real tenant, read-only (`validating-against-a-tenant`).
- **Fixtures can't catch scale either:** `pnpm test:perf` (`tests/perf`, not part of `pnpm test`) runs every
  datasource against a synthetic 100k-user tenant with budgets in `tests/perf/budgets.json`. Transforms over big lists
  use the native helpers, a derived datasource passes on the `truncated` flag of what it reads, and a capped table
  exports the whole list (`docs/content-recipes.md` › Big lists, exports and partial data).

## Reviewers

Ask Claude to run a reviewer before you commit (they read uncommitted changes) or open a PR:

- `content-reviewer` — reuse, write safety, query quoting, declarations, fixtures and lifecycle for content changes.
- `security-reviewer` — tokens, read/write enforcement, injection, secrets, audit for code changes.
- `design-reviewer` — design-system compliance, accessibility, and a screenshot critique for UI changes.

## Keeping this working

Tool references: `portal/tools/cli/README.md` (every `adminforge` command), `tooling/README.md`, `portal/apps/runner/README.md`
and `portal/content/scripts/README.md` (runner scripts), `tests/README.md` (test projects and shared helpers),
`portal/content/README.md` (where content goes: folder = id prefix, sections, `adminforge list`),
`docs/content-recipes.md` (content how-to).

When you change _how_ something is extended (a new schema field, a new CLI command, a new widget convention), update the
matching skill in `.claude/skills/` and this page in the same change. A content schema change that isn't
backward-compatible (a field removed, renamed, narrowed or made required) also bumps `CONTENT_SCHEMA_VERSION`
(`portal/packages/schemas/src/schema-version.ts`) in the same change; additive, optional fields don't.
`tests/unit/docs/skills-shape.test.ts` keeps every skill in the shared shape and every path a skill or agent cites
real. Skills are tested like code (ADR-012): run a fresh agent through a realistic request with the skill and check it
follows the rules; when it doesn't, fix the skill's wording, not just the output.
