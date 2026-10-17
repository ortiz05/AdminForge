#!/usr/bin/env bash
# `pnpm db:up` / `pnpm db:down`: docker compose for the local Postgres (docker-compose.dev.yml) with its interpolation
# files, lowest first — portal/deploy/defaults.env, your env file ($ADMINFORGE_ENV_FILE, default
# ~/.config/adminforge/dev.env) and, when it exists, that env file's owner file (<env>.owner.env: POSTGRES_PASSWORD,
# read by compose only when it creates a new cluster). The services never read the owner file.
#
#   portal/deploy/db/compose.sh up -d --wait
#   portal/deploy/db/compose.sh down
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ADMINFORGE_ENV_FILE:-$HOME/.config/adminforge/dev.env}"
OWNER_FILE="${ENV_FILE%.env}.owner.env"
args=(--env-file "$DEPLOY_DIR/defaults.env" --env-file "$ENV_FILE")
[ -f "$OWNER_FILE" ] && args+=(--env-file "$OWNER_FILE")
exec docker compose "${args[@]}" -f "$DEPLOY_DIR/docker-compose.dev.yml" "$@"
