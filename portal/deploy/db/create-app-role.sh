#!/usr/bin/env bash
# Least-privilege database role for the host services (adminforge_app): row access only, no DDL, never a superuser,
# and INSERT/SELECT only on the audit log — so a compromised service can't drop the append-only triggers or rewrite
# history. Migrations keep using the owner through DATABASE_MIGRATION_URL.
#
#   portal/deploy/db/create-app-role.sh [env-file]          # default ~/.config/adminforge/dev.host.env
#   portal/deploy/db/create-app-role.sh [env-file] --rotate # new password for adminforge_app
#
# Idempotent. Rewrites DATABASE_URL (→ adminforge_app) and DATABASE_MIGRATION_URL (→ the owner) in the env file and
# prints key names only — never values. Restart the services afterwards.
#
# The owner (user, database, host:port) comes from the env file's DATABASE_MIGRATION_URL, else its DATABASE_URL. SQL
# runs through `docker exec` in the Postgres container: AF_DB_CONTAINER, else AF_PG_CONTAINER from
# portal/deploy/defaults.env. Passwords go to psql on stdin, never on a command line. Tested against a fake docker in
# tests/unit/deploy/create-app-role.test.ts.
set -euo pipefail
umask 077

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../lib/defaults.sh
. "$DEPLOY_DIR/lib/defaults.sh"
af_load_deploy_defaults

ENV_FILE="${1:-$HOME/.config/adminforge/dev.host.env}"
ROTATE="${2:-}"
CONTAINER="${AF_DB_CONTAINER:-$AF_PG_CONTAINER}"
APP_ROLE="adminforge_app"

[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE not found" >&2; exit 1; }
get() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }

OWNER_URL="$(get DATABASE_MIGRATION_URL)"
[ -n "$OWNER_URL" ] || OWNER_URL="$(get DATABASE_URL)"
[ -n "$OWNER_URL" ] || { echo "✗ $ENV_FILE has no DATABASE_URL" >&2; exit 1; }
# postgres://user:pass@host:port/db
OWNER_USER="$(sed -E 's#^[a-z]+://([^:@/]+).*#\1#' <<<"$OWNER_URL")"
DB_NAME="$(sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#' <<<"$OWNER_URL")"
HOSTPART="$(sed -E 's#^[a-z]+://[^@]+@([^/]+)/.*#\1#' <<<"$OWNER_URL")"
[ "$OWNER_USER" != "$APP_ROLE" ] || { echo "✗ DATABASE_MIGRATION_URL must use the owner, not $APP_ROLE" >&2; exit 1; }

psql_owner() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -q -U "$OWNER_USER" -d "$DB_NAME" "$@"; }

exists="$(psql_owner -Atc "select 1 from pg_roles where rolname = '$APP_ROLE'")"
CURRENT_APP_URL="$(get DATABASE_URL)"
if [ "$exists" != "1" ] || [ "$ROTATE" = "--rotate" ] || [[ "$CURRENT_APP_URL" != *"//$APP_ROLE:"* ]]; then
  PASSWORD="$(openssl rand -hex 32)"
  if [ "$exists" = "1" ]; then
    # On stdin, not -c: a command line is visible to other processes.
    printf "ALTER ROLE %s WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" \
      "$APP_ROLE" "$PASSWORD" | psql_owner >/dev/null
  else
    # On stdin, not -c: a command line is visible to other processes.
    printf "CREATE ROLE %s WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" \
      "$APP_ROLE" "$PASSWORD" | psql_owner >/dev/null
  fi
  APP_URL="postgres://$APP_ROLE:$PASSWORD@$HOSTPART/$DB_NAME"
else
  APP_URL="$CURRENT_APP_URL"
fi

sed -e "s/{{APP_ROLE}}/$APP_ROLE/g" -e "s/{{OWNER}}/$OWNER_USER/g" -e "s/{{DB}}/$DB_NAME/g" -e "s/{{QUEUE_SCHEMA}}/pgboss/g" \
  "$(dirname "$0")/app-role-grants.sql" | psql_owner >/dev/null

# Rewrite the two keys in place (values never printed).
tmp="$(mktemp "$ENV_FILE.XXXXXX")"
grep -v -E '^(DATABASE_URL|DATABASE_MIGRATION_URL)=' "$ENV_FILE" > "$tmp" || true
printf 'DATABASE_URL=%s\nDATABASE_MIGRATION_URL=%s\n' "$APP_URL" "$OWNER_URL" >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"

echo "✓ $APP_ROLE ready on $DB_NAME (row access, audit log insert/select only); $ENV_FILE: DATABASE_URL → $APP_ROLE, DATABASE_MIGRATION_URL → owner"
