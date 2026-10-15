# ADR-009: Configuration outside the repo; secretless in Azure

Status: accepted (2026-10-15); partially implemented

> **Implementation status:** the "configuration outside the repo" half is in place: env files in `~/.config/adminforge`
> (mode 0600, written by `init:local` and provisioning), `${env.X}` references in content, guard tests and the
> pre-commit hook. The "secretless in Azure" half is not: there is no managed identity or federated credential support.
> The Read, Write, provisioner and automation app registrations authenticate with client secrets kept in the env files
> (`AF_*_CLIENT_SECRET`); the automation identity can use a certificate instead (`AF_AUTOMATION_CERT_PATH`, PEM).

## Context

No tenant-specific data in git.

## Decision

Env files in ~/.config/adminforge; managed identity + federated credentials when hosted in Azure.

## Consequences

Guard tests block accidental commits.
