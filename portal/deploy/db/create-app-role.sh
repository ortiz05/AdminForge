#!/usr/bin/env bash
# Least-privilege database role for the host services (adminforge_app): row access only, no DDL, never a superuser,
# and INSERT/SELECT only on the audit log — so a compromised service can't drop the append-only triggers or rewrite
# history. Migrations keep using the owner through DATABASE_MIGRATION_URL, which lives in the env file's owner file
# (<env-file minus .env>.owner.env, e.g. dev.host.owner.env) — a file the services never read.
#
#   portal/deploy/db/create-app-role.sh [env-file]          # default ~/.config/adminforge/dev.host.env
#   portal/deploy/db/create-app-role.sh [env-file] --rotate # new password for adminforge_app
#
# Idempotent. Rewrites DATABASE_URL (→ adminforge_app) in the env file and DATABASE_MIGRATION_URL (→ the owner) in the
# owner file (removing an older copy from the env file), and prints key names only — never values. Restart the services
# afterwards. Then run `pnpm db:harden` (portal/deploy/db/harden-postgres.ts): it moves ownership to the non-superuser
# owner role and gives this role its limits.
#
# The owner (user, database, host:port) comes from the owner file's DATABASE_MIGRATION_URL, else the env file's
# DATABASE_MIGRATION_URL (older layout), else its DATABASE_URL. SQL runs through `docker exec` in the Postgres container
# (AF_DB_CONTAINER, else AF_PG_CONTAINER from portal/deploy/defaults.env) as its bootstrap superuser (AF_PG_USER) over
# the local socket; the owner named in the URL gets the default privileges. Passwords go to psql on stdin, never on a
# command line. Tested against a fake docker in tests/unit/deploy/create-app-role.test.ts.
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
OWNER_FILE="${ENV_FILE%.env}.owner.env"
get() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }
get_owner() { [ -f "$OWNER_FILE" ] && grep -m1 "^$1=" "$OWNER_FILE" | cut -d= -f2- || true; }

OWNER_URL="$(get_owner DATABASE_MIGRATION_URL)"
[ -n "$OWNER_URL" ] || OWNER_URL="$(get DATABASE_MIGRATION_URL)"
[ -n "$OWNER_URL" ] || OWNER_URL="$(get DATABASE_URL)"
[ -n "$OWNER_URL" ] || { echo "✗ $ENV_FILE has no DATABASE_URL" >&2; exit 1; }
# postgres://user:pass@host:port/db
OWNER_USER="$(sed -E 's#^[a-z]+://([^:@/]+).*#\1#' <<<"$OWNER_URL")"
DB_NAME="$(sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#' <<<"$OWNER_URL")"
HOSTPART="$(sed -E 's#^[a-z]+://[^@]+@([^/]+)/.*#\1#' <<<"$OWNER_URL")"
[ "$OWNER_USER" != "$APP_ROLE" ] || { echo "✗ DATABASE_MIGRATION_URL must use the owner, not $APP_ROLE" >&2; exit 1; }

# As the container's bootstrap superuser over its local socket (AF_PG_USER): the owner is not a superuser once
# `pnpm db:harden` ran, and only a superuser (or CREATEROLE) can create the role.
psql_owner() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -q -U "$AF_PG_USER" -d "$DB_NAME" "$@"; }

# Setting a password never reaches the server log (log_statement=ddl would print the statement): the session turns
# statement logging off, and the statement carries a SCRAM-SHA-256 verifier computed here (scram.mjs, password on
# stdin), never the password itself.
NO_LOG="SET log_statement = 'none'; SET log_min_duration_statement = -1; SET log_min_error_statement = panic;"
LOCKS="SET lock_timeout = '10s';"

# Rewrite the keys in place (values never printed): the services' URL in the env file, the owner's in the owner file.
save_urls() {
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  grep -v -E '^(DATABASE_URL|DATABASE_MIGRATION_URL)=' "$ENV_FILE" > "$tmp" || true
  printf 'DATABASE_URL=%s\n' "$APP_URL" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  tmp="$(mktemp "$OWNER_FILE.XXXXXX")"
  { [ -f "$OWNER_FILE" ] && grep -v -E '^DATABASE_MIGRATION_URL=' "$OWNER_FILE" || true; } > "$tmp"
  printf 'DATABASE_MIGRATION_URL=%s\n' "$OWNER_URL" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$OWNER_FILE"
}

exists="$(psql_owner -Atc "select 1 from pg_roles where rolname = '$APP_ROLE'")"
CURRENT_APP_URL="$(get DATABASE_URL)"
if [ "$exists" != "1" ] || [ "$ROTATE" = "--rotate" ] || [[ "$CURRENT_APP_URL" != *"//$APP_ROLE:"* ]]; then
  PASSWORD="$(openssl rand -hex 32)"
  VERIFIER="$(printf '%s' "$PASSWORD" | node "$DEPLOY_DIR/db/scram.mjs")"
  verb="CREATE"
  [ "$exists" = "1" ] && verb="ALTER"
  # On stdin, not -c: a command line is visible to other processes.
  printf "%s %s\n%s ROLE %s WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" \
    "$LOCKS" "$NO_LOG" "$verb" "$APP_ROLE" "$VERIFIER" | psql_owner -1 >/dev/null
  APP_URL="postgres://$APP_ROLE:$PASSWORD@$HOSTPART/$DB_NAME"
  # Saved at once: the role has this password now, whatever fails next.
  save_urls
else
  APP_URL="$CURRENT_APP_URL"
  save_urls
fi

{ echo "$LOCKS"; sed -e "s/{{APP_ROLE}}/$APP_ROLE/g" -e "s/{{OWNER}}/$OWNER_USER/g" -e "s/{{DB}}/$DB_NAME/g" -e "s/{{QUEUE_SCHEMA}}/pgboss/g" \
  "$(dirname "$0")/app-role-grants.sql"; } | psql_owner -1 >/dev/null

echo "✓ $APP_ROLE ready on $DB_NAME (row access, audit log insert/select only); $ENV_FILE: DATABASE_URL → $APP_ROLE; $OWNER_FILE: DATABASE_MIGRATION_URL → owner"
