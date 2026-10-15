#!/usr/bin/env bash
# AdminForge backup: the services' database (pg_dump, custom format), the configuration directory (env files incl.
# TOKEN_CACHE_KEY and client secrets) and data (report files, Caddy's CA). Run by adminforge-backup.timer.
# Prints file names and sizes only — never contents. Backups hold secrets: they stay mode 600 in a 700 directory.
set -euo pipefail
umask 077

DEST_ROOT="${AF_BACKUP_DIR:-$HOME/adminforge-backups}"
CONTAINER="${AF_BACKUP_PG_CONTAINER:-adminforge-dev-postgres-1}"
DATABASE="${AF_BACKUP_DATABASE:-adminforge}"
KEEP_DAYS="${AF_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DEST="$DEST_ROOT/$STAMP"

install -d -m 700 "$DEST_ROOT" "$DEST"
docker exec "$CONTAINER" pg_dump -U adminforge -Fc "$DATABASE" > "$DEST/$DATABASE.dump"
tar -C "$HOME/.config" -czf "$DEST/config.tgz" adminforge
data=()
for d in adminforge caddy; do [ -d "$HOME/.local/share/$d" ] && data+=("$d"); done
[ ${#data[@]} -gt 0 ] && tar -C "$HOME/.local/share" -czf "$DEST/data.tgz" "${data[@]}"
chmod 600 "$DEST"/*

# Sanity: the dump must list the audit table, or it isn't a usable backup.
if ! docker exec -i "$CONTAINER" pg_restore --list < "$DEST/$DATABASE.dump" | grep -q 'TABLE DATA public audit_events'; then
  echo "✗ $DEST/$DATABASE.dump does not contain audit_events: backup is not usable" >&2
  exit 1
fi

find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
echo "✓ backup $STAMP: $(du -sh "$DEST" | cut -f1) in $DEST (kept ${KEEP_DAYS} days)"
