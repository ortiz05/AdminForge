# ADR-004: PostgreSQL is the only stateful dependency

Status: accepted (2026-10-15)

## Context

Fewer moving parts on a single host.

## Decision

Sessions, token cache, definitions, runs, audit, queues (pg-boss), LISTEN/NOTIFY for live updates.

## Consequences

Postgres backups cover everything.
