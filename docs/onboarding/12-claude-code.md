# 12. Working with Claude Code

AdminForge is designed to be extended with Claude Code (ADR-012). The repository carries what Claude needs to make the
same kind of change every engineer would: the rules, one skill per extension point, reviewer agents and hooks. Used
well, it is the fastest way to a consistent change; you still own every line it writes. The user-facing guide is
[`docs/extending.md`](../extending.md).

## What's in the repository

| Piece           | Where                            | What it does                                                                                                                                                                                                          |
| --------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules           | `CLAUDE.md`                      | Layout, non-negotiables, commands, "before you say done" — loaded into every session                                                                                                                                  |
| Skills          | `.claude/skills/<name>/SKILL.md` | Step-by-step recipes per extension point, picked automatically from your request                                                                                                                                      |
| Reviewer agents | `.claude/agents/*.md`            | `content-reviewer`, `security-reviewer`, `design-reviewer` — review-only (they don't edit files); they read your uncommitted changes                                                                                  |
| After-edit hook | `.claude/hooks/after-edit.mjs`   | On each file Claude writes, by type: Prettier (code and docs), `adminforge validate` (content YAML), token checks (UI code), stale script pins (runner scripts). It doesn't run the guards — the pre-commit hook does |
| Settings        | `.claude/settings.json`          | Registers the hook (shared with the team); personal settings go in the git-ignored `.claude/settings.local.json`                                                                                                      |

### Skills

| Skill                         | Use it when you want…                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `adding-a-page-or-report`     | a page, dashboard, entity view, list or exportable report; columns, filters, actions |
| `adding-a-playbook`           | an action, playbook, runbook, row or bulk action — any change to tenant objects      |
| `adding-a-schedule-or-probe`  | something on a schedule, monitoring, a configuration check, unattended KQL           |
| `adding-a-service-connector`  | a Microsoft API or your own Entra-secured API AdminForge doesn't call yet            |
| `adding-a-runner-script`      | PowerShell: Exchange Online, distribution lists, Teams, SharePoint/PnP               |
| `adding-a-widget`             | a visualisation or interaction the existing widgets can't express                    |
| `adding-an-api-route`         | backend behaviour content can't express                                              |
| `add-news-feed`               | a source in News and changes                                                         |
| `changing-the-design-system`  | colours, fonts, spacing, radius, density, a component's style, a theme               |
| `validating-against-a-tenant` | checking a change live: sign-in, data, a real write on `AF-Test-*`, 401/403/licences |

## How to work with it

1. **Describe the outcome**, not the implementation: "Add a report of guests who haven't signed in for 90 days,
   exportable, emailed every Monday." Name a skill if you want to be sure ("use the adding-a-playbook skill").
2. **Let it search first.** A good session starts by finding existing content and code to extend; push back if it
   jumps straight to new files.
3. **Review the plan for big changes** before it writes code (ask it to plan first), especially for API, security or
   schema changes.
4. **Run the reviewer agents** before you commit — they review `git diff HEAD` — or ask them to review
   `origin/main...HEAD` ("run the security-reviewer on origin/main...HEAD"). Fix or answer every finding.
5. **Read the diff yourself.** You are the author of record. Claude's output goes through the same review, tests and
   checklists as yours.

## Rules for sessions

- Everything in [Security for contributors](04-security.md) applies to what you ask Claude to do. Don't paste secrets,
  env file contents or tenant output into the conversation; ask for counts and statuses when it works against a tenant.
- Don't ask Claude to bypass a hook, a guard or a failing test (`--no-verify`, skipping tests, loosening a rule to get
  green). If a rule is wrong, change the rule in its own reviewed PR.
- Don't let a session run provisioning, `adminforge publish` to a shared database, deploys, restarts or anything on
  the AdminForge host unless a code owner asked for that specific action.
- Commits from a session follow the [commit convention](10-git-and-pull-requests.md#commit-messages) like any other
  (the hook checks them). Keep a `Co-Authored-By` trailer when Claude wrote a substantial part.
- Long-running work can use worktrees (`.claude/worktrees/` is git-ignored); clean them up when done.

## Keeping the kit working

When you change **how** something is extended — a new schema field, CLI command, widget option, convention — update the
matching skill and `docs/extending.md` in the same PR. Skills are tested like code: give a fresh session a realistic
request with the skill and check it follows the rules; when it doesn't, fix the skill's wording, not just the output.
Changes to `.claude/` are reviewed by a code owner (they shape every future change).

## Read next

[Releases and operations](13-releases-and-operations.md).
