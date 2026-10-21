# 11. Documentation

Docs are part of the change, reviewed with it. A pull request that changes behaviour without the docs that describe
it isn't finished (CLAUDE.md rule 11). This page says which docs each kind of change touches, and how we write them.

## The map

Which document owns what, who reads it and what change must update it is in the
[documentation index](../README.md), one row per document. A new document gets its row there in the same PR.

## What to update for each kind of change

| Change                                           | Update                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| New or changed API endpoint                      | `docs/api.md` (index + section + rate-limit row + roles table if access changed); new codes in `docs/troubleshooting.md`                      |
| New error code anywhere                          | `docs/troubleshooting.md` (meaning, cause, what to do)                                                                                        |
| New configuration key                            | `config/example.env` (comment + safe default); `docs/operations.md` if operators must set it                                                  |
| New permission, role use or licence need         | `docs/access.md`; `docs/licensing-review.md`; provisioning catalog if the automation identity needs it                                        |
| Security-relevant behaviour                      | `SECURITY.md` (the section, plus a threats row or known-gaps entry)                                                                           |
| New widget or widget option                      | `docs/widgets.md` and the widget schema                                                                                                       |
| Changed how something is extended                | The matching `.claude/skills/<skill>/SKILL.md` and `docs/extending.md`                                                                        |
| New process, unit, table or data flow            | `docs/architecture.md`                                                                                                                        |
| Anything an operator does differently            | `docs/operations.md` (and the upgrade notes in the PR's "Risk and rollout")                                                                   |
| A decision someone could undo by accident        | An ADR (big, architectural) or a line in `docs/decisions.md` (smaller)                                                                        |
| Something you're deliberately not doing now      | `docs/backlog.md`                                                                                                                             |
| A query or request checked against fixtures only | `docs/licensing-review.md` (what it relies on, with Microsoft's docs) and `docs/backlog.md` (the live check still to do)                      |
| A new navigation section, or retired content     | `docs/onboarding/08-content-guide.md` (sections), `docs/operations.md` (what it needs), `docs/backlog.md` (how to bring retired content back) |
| Anything a user or operator would notice         | `CHANGELOG.md` → `## Unreleased` → Added / Changed / Fixed / Security                                                                         |
| How we work (commits, review, conventions)       | `docs/onboarding/` and, if it's a rule, `CLAUDE.md`                                                                                           |
| A new document                                   | Its row in `docs/README.md` (what it owns, audience, when to update)                                                                          |

## Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with [Semantic
Versioning](https://semver.org/spec/v2.0.0.html). Add your entry under `## Unreleased` in the right section —
**Added**, **Changed**, **Fixed**, **Security** (and **Removed** / **Deprecated** when they apply). Write it
for the reader of the release notes: lead with the outcome in bold, then the details that matter (new routes,
codes, keys, permissions). Code owners turn `Unreleased` into a version when they release.

## Decisions

- **ADR** (`docs/adr/NNN-<slug>.md`, next free number, [template](templates/adr.md)) for decisions that shape the
  architecture or security model: identities, trust boundaries, storage, a new class of outbound traffic. Status,
  context, options considered, decision, consequences. An accepted ADR's decision is never edited; a later ADR
  supersedes it. Context and consequences may be added later in a dated note (ADR-001, for one).
- **Decisions log** (`docs/decisions.md`) for smaller choices, with a date — and who decided, when that matters
  ("report schedules can be created in the portal — 2026-10-16, product owner").
- Link the decision from the code that depends on it (`// ADR-011`) so the next person finds the why.

## How we write

- **For the reader in front of the task.** Start with what they're trying to do; put background after the steps.
- **Plain, direct, sentence case.** Short sentences, active voice, real names of things in the UI and the code.
- **Concrete:** exact commands, paths, keys and codes in backticks; examples with `Example Org`, `example.com`,
  `avery@example.com` and placeholder GUIDs — never a real tenant.
- **One source of truth.** Link instead of copying; when you must repeat a fact, say where the source is.
- **Tables for reference, prose for reasoning, numbered steps for procedures.** Mermaid for diagrams.
- **No installation-specific remarks in repo docs** (an installation's quirks, a tenant's state). They belong in operator
  notes outside the repository.
- Docs are Markdown formatted by Prettier (`pnpm format`); keep lines under the 110-column print width.

## Read next

[Working with Claude Code](12-claude-code.md).
