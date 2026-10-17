#!/usr/bin/env bash
# `pnpm db:harden [--dry-run] [--rotate] [--rotate-superuser]` — see harden-postgres.ts (what it changes, where the
# credentials go). Run --dry-run first; it only reads the cluster's catalog.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
exec pnpm exec tsx portal/deploy/db/harden-postgres.ts "$@"
