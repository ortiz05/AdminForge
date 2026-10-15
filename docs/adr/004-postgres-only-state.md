# ADR-004: PostgreSQL is the only stateful dependency

Status: accepted (2026-10-15)

## Context

Fewer moving parts on a single host.

## Decision

Sessions, token cache, definitions, runs, audit, queues (pg-boss), LISTEN/NOTIFY for live updates.

## Consequences

Postgres holds all application state, but a restore also needs what lives outside it. Back up together:

- the PostgreSQL database (pg_dump or volume snapshots);
- the env files in `~/.config/adminforge/` (`<env>.env` and its `<env>.*.env` siblings) — they hold the app
  credentials and `TOKEN_CACHE_KEY`, without which the sealed token cache in Postgres can't be decrypted and everyone
  has to sign in again;
- `ADMINFORGE_ARTIFACTS_DIR` (scheduled report files; default `~/.local/share/adminforge/artifacts`) — Postgres only
  records their paths;
- the automation certificate (`AF_AUTOMATION_CERT_PATH`), if one is used;
- Caddy's local CA (`~/.local/share/caddy/pki/authorities/local/`), if Caddy fronts the portal for LAN access — a new CA
  means re-trusting its root on every client.
