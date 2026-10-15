# ADR-009: Configuration outside the repo; secretless in Azure

Status: accepted (2026-10-15)

## Context

No tenant-specific data in git.

## Decision

Env files in ~/.config/adminforge; managed identity + federated credentials when hosted in Azure.

## Consequences

Guard tests block accidental commits.
