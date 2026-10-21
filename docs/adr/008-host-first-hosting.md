# ADR-008: Run on this host first; Azure optional

Status: superseded by ADR-017 (2026-10-20) — was accepted 2026-10-15; partially implemented

> **Implementation status:** AdminForge runs on one host as systemd **user** units (`portal/deploy/systemd`: api,
> worker, scheduler, runner, plus `adminforge-proxy`, Caddy with `tls internal` for LAN TLS), built with `pnpm build`
> and configured from `~/.config/adminforge/<env>.env` (`portal/deploy/README.md`). Docker Compose is used only for
> PostgreSQL (`portal/deploy/docker-compose.dev.yml` via `pnpm db:up`, which the deploy guide also uses for the host
> services); the only container image is the runner's (`portal/apps/runner/Dockerfile`), and the deploy guide runs the
> runner as a user unit instead. There are no API/web/scheduler images and no Azure Container Apps deployment yet.

## Context

The owner wants schedules and the portal on this host.

## Decision

Docker Compose + systemd on the host; same images can run on Azure Container Apps.

## Consequences

Simple operations; TLS via Caddy when exposed.
