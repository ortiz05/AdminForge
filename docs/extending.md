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

Claude picks the matching skill automatically (or name it: "use the adding-a-playbook skill").

## Extension points

| You want…                                                                                                                   | Skill                         | Usually touches                                                          |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| A page, dashboard, entity view, list, report; new columns, filters, KPIs, row/bulk actions                                  | `adding-a-page-or-report`     | `portal/content/{pages,dashboards,reports}`, `tests/fixtures`            |
| Query-builder filters on a list (Graph → `odata`, KQL → `kql`, PowerShell/static rows → `rows`)                             | `adding-a-page-or-report`     | the page's `filters.advanced`                                            |
| An action or guided procedure (disable user, reset MFA, restart app, runbook)                                               | `adding-a-playbook`           | `portal/content/{playbooks,runbooks}`                                    |
| Something that runs on a schedule on this host; monitoring; a configuration/compliance check; KQL at scale                  | `adding-a-schedule-or-probe`  | `portal/content/{schedules,probes}`                                      |
| A recurring delivery of an existing report (file, email or Teams), at most hourly — no change to the repository             | none: in the portal           | Reports → the report → Schedule (Operator; stored in the database)       |
| A source in News and changes (Microsoft blog, roadmap, update/security feed, Learn what's-new page, module releases)        | `add-news-feed`               | `portal/content/feeds`, `tests/fixtures/hosts`, `docs/news.md`           |
| A visualisation or interaction the widgets can't express                                                                    | `adding-a-widget`             | `portal/packages/widgets`, `docs/widgets.md`                             |
| A new Microsoft API, your own Entra-secured API/Function, a blocked read-only POST                                          | `adding-a-service-connector`  | `portal/content/connections`, `portal/packages/connectors`, provisioning |
| PowerShell (Exchange, distribution lists, Teams, SharePoint); write scripts take the object ids of the accounts they change | `adding-a-runner-script`      | `portal/content/scripts`, `tests/runner`                                 |
| Backend behaviour content can't express                                                                                     | `adding-an-api-route`         | `portal/apps/api`, `portal/packages/schemas`                             |
| The look and feel                                                                                                           | `changing-the-design-system`  | `portal/packages/design-tokens`, `portal/packages/ui/src/recipes`        |
| Checking it against a real tenant                                                                                           | `validating-against-a-tenant` | `tests/live`, `~/.config/adminforge/*.env`                               |

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
  parameters another datasource is `ds.<name>` (a bare name is undefined there).
- **In provisioning** (`adminforge provision entra`): tier-0 Write scopes, application write permissions and
  sensitive application reads are only granted with their opt-ins (`docs/access.md`); `provision status` fails on
  privilege it didn't grant.
- **Fixtures can't catch what Microsoft rejects:** run every new Graph request, Resource Graph or KQL query once
  against a real tenant, read-only (the page and schedule skills show how).

## Reviewers

Ask Claude to run a reviewer before you open a PR:

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
