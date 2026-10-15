# ADR-002: Separate Read and Write app registrations

Status: accepted (2026-10-15)

## Context
Entra access tokens carry every consented scope for a resource, so one app cannot mint a genuinely read-only token.

## Decision
Two delegated apps; write requires a step-up sign-in to the Write app (assignment required).

## Consequences
Two consent sets to manage; hard read/write boundary; separate Conditional Access targeting.
