# ADR-011: Unattended schedules use an automation identity

Status: accepted (2026-10-15)

## Context

Scheduled reports, probes, and actions must run without a signed-in engineer.

## Decision

A separate app registration with application permissions (certificate preferred) executes schedules on this host. Each schedule declares the permissions it needs; write-capable schedules need two-person approval; runs are audited as 'scheduled by X, executed as automation identity'.

## Consequences

Amends ADR-010 for schedules only; interactive work stays delegated.
