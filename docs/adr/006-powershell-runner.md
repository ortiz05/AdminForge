# ADR-006: PowerShell runner with single-use workers

Status: accepted (2026-10-15)

## Context
Exchange/Teams/SharePoint admin is PowerShell-first.

## Decision
Node supervisor + pre-forked single-use pwsh workers; tokens passed over stdin per job.

## Consequences
Isolation between users; no long-lived sessions.
