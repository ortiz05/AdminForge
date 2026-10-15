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

Claude picks the matching skill automatically (or name it: "use the adding-a-playbook skill").

## Extension points

| You want… | Skill | Usually touches |
|---|---|---|
| A page, dashboard, entity view, list, report; new columns, filters, KPIs, row/bulk actions | `adding-a-page-or-report` | `portal/content/{pages,dashboards,reports}`, `tests/fixtures` |
| An action or guided procedure (disable user, reset MFA, restart app, runbook) | `adding-a-playbook` | `portal/content/{playbooks,runbooks}` |
| Something that runs on a schedule on this host; monitoring; a configuration/compliance check; KQL at scale | `adding-a-schedule-or-probe` | `portal/content/{schedules,probes}` |
| A visualisation or interaction the widgets can't express | `adding-a-widget` | `portal/packages/widgets`, `docs/widgets.md` |
| A new Microsoft API, your own Entra-secured API/Function, a blocked read-only POST | `adding-a-service-connector` | `portal/content/connections`, `portal/packages/connectors`, provisioning |
| PowerShell (Exchange, distribution lists, Teams, SharePoint) | `adding-a-runner-script` | `portal/content/scripts`, `tests/runner` |
| Backend behaviour content can't express | `adding-an-api-route` | `portal/apps/api`, `portal/packages/schemas` |
| The look and feel | `changing-the-design-system` | `portal/packages/design-tokens`, `packages/ui/src/recipes` |
| Checking it against a real tenant | `validating-against-a-tenant` | `tests/live`, `~/.config/adminforge/*.env` |

## Guardrails that run automatically

- **On every file Claude writes** (`.claude/hooks/after-edit.mjs`): content YAML → `adminforge validate`; UI code → no
  raw colours / arbitrary Tailwind values; runner scripts → lists content whose pinned sha256 is now stale.
- **On every commit** (`.githooks/pre-commit`): guard tests — no secrets, no tenant-specific values, tokens-only UI.
- **In CI**: lint, typecheck, all test projects, build, e2e in mock mode.

## Reviewers

Ask Claude to run a reviewer before you open a PR:

- `content-reviewer` — reuse, write safety, query quoting, declarations, fixtures for content changes.
- `security-reviewer` — tokens, read/write enforcement, injection, secrets, audit for code changes.
- `design-reviewer` — design-system compliance, accessibility, and a screenshot critique for UI changes.

## Keeping this working

When you change *how* something is extended (a new schema field, a new CLI command, a new widget convention), update the
matching skill in `.claude/skills/` and this page in the same change. Skills are tested like code: run a fresh agent
through a realistic request with the skill and check it follows the rules (see the writing-skills approach in the
plan's R7).
