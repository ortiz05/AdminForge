# ADR-012: Extend AdminForge with Claude Code, not an in-app AI assistant

Status: accepted (2026-10-15) — supersedes the "Forge assistant" idea in plan R7 v1

## Context

The owner's key development principle: engineers must be able to extend AdminForge consistently by using
Claude Code. An in-app AI drafting feature would add an external dependency, a new data path for tenant
data, and a second, divergent way of authoring content.

## Decision

The repository itself is the extension surface: `CLAUDE.md`, project skills in `.claude/skills/` for every
extension point, reviewer subagents in `.claude/agents/`, validation hooks in `.claude/settings.json`,
and the `adminforge` CLI scaffolds/validators those skills call. No Claude API key or AI feature ships in
the portal.

## Consequences

New pages, reports, playbooks, schedules, probes, widgets, and connectors follow one documented path with
the same validation as CI. Skills are maintained alongside the code they describe and are tested by
running an agent through the task.
