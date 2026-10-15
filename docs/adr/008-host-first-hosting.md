# ADR-008: Run on this host first; Azure optional

Status: accepted (2026-10-15)

## Context
The owner wants schedules and the portal on this host.

## Decision
Docker Compose + systemd on the host; same images can run on Azure Container Apps.

## Consequences
Simple operations; TLS via Caddy when exposed.
