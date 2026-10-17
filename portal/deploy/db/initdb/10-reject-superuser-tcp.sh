#!/bin/sh
# The bootstrap superuser (POSTGRES_USER) may sign in only over the container's local socket — `docker exec … psql` —
# never over TCP, so its password (needed once, to create the cluster) opens nothing from the host. Inserts
# `host all <superuser> all reject` (and the same for replication) before the first `host` rule of pg_hba.conf.
#
# Run by the postgres image on a NEW cluster (docker-compose.dev.yml mounts this directory as
# /docker-entrypoint-initdb.d) and by portal/deploy/db/harden-postgres.ts on an existing one (then followed by
# pg_reload_conf()). Idempotent; POSIX sh (the alpine image has no bash). Prints nothing.
set -eu
hba="${PGDATA:?PGDATA is not set}/pg_hba.conf"
su="${POSTGRES_USER:?POSTGRES_USER is not set}"
if grep -Eq "^host[[:space:]]+all[[:space:]]+${su}[[:space:]]+all[[:space:]]+reject" "$hba"; then
  exit 0
fi
tmp="$hba.af-tmp"
awk -v su="$su" '
  !done && /^host/ { print "host all " su " all reject"; print "host replication " su " all reject"; done = 1 }
  { print }
  END { if (!done) { print "host all " su " all reject"; print "host replication " su " all reject" } }
' "$hba" > "$tmp"
# cat > keeps the file's owner and mode.
cat "$tmp" > "$hba"
rm -f "$tmp"
