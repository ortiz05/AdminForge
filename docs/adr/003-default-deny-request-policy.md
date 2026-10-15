# ADR-003: Default-deny outbound request policy

Status: accepted (2026-10-15)

## Context

ARM, Exchange, and some APIs have coarse scopes.

## Decision

In read mode only allowlisted operations leave the API; in write mode only operations declared by published content.

## Consequences

Free-form write proxying is impossible by design.
