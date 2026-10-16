#!/usr/bin/env bash
# AdminForge backup: the services' database (pg_dump, custom format), the services' configuration (env files incl.
# TOKEN_CACHE_KEY and client secrets) and data (report files, Caddy's CA certificate). Run by adminforge-backup.timer.
# Prints file names and sizes only — never contents. Backups hold secrets: they stay mode 600 in a 700 directory.
#
# Never backed up: <env>.admin.env (provisioner and test-user credentials — recreate or re-issue them instead) and
# stray copies (*.bak*). Caddy's private keys (local CA, site certificate) are included only when the backup is encrypted
# (AF_BACKUP_GPG_RECIPIENT = a GPG key id/fingerprint whose private key is NOT on this host); unencrypted, a restore
# issues a new local CA and browsers must trust it again.
# The rows of the transient credential tables (signed-in sessions, sign-in round trips, the sealed MSAL token cache with
# the engineers' refresh tokens) are never dumped, only their definitions: a stolen backup plus TOKEN_CACHE_KEY can't
# yield refresh tokens, and after a restore everyone simply signs in again.
set -euo pipefail
umask 077

DEST_ROOT="${AF_BACKUP_DIR:-$HOME/adminforge-backups}"
CONTAINER="${AF_BACKUP_PG_CONTAINER:-adminforge-dev-postgres-1}"
DATABASE="${AF_BACKUP_DATABASE:-adminforge}"
KEEP_DAYS="${AF_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DEST="$DEST_ROOT/$STAMP"

install -d -m 700 "$DEST_ROOT" "$DEST"
# Tables whose rows are credentials, not history (portal/apps/api/src/db/schema.ts): schema only.
TRANSIENT_TABLES=(public.sessions public.preauth public.token_cache)
exclude=()
for t in "${TRANSIENT_TABLES[@]}"; do exclude+=("--exclude-table-data=$t"); done
docker exec "$CONTAINER" pg_dump -U adminforge -Fc "${exclude[@]}" "$DATABASE" > "$DEST/$DATABASE.dump"
# Sanity (before any encryption): the dump must list the audit table's rows, or it isn't a usable backup, and must not
# hold rows of the credential tables.
listing="$(docker exec -i "$CONTAINER" pg_restore --list < "$DEST/$DATABASE.dump")"
if ! grep -Eq 'TABLE DATA public audit_events( |$)' <<<"$listing"; then
  echo "✗ $DEST/$DATABASE.dump does not contain audit_events: backup is not usable" >&2
  exit 1
fi
for t in "${TRANSIENT_TABLES[@]}"; do
  if grep -Eq "TABLE DATA ${t%%.*} ${t#*.}( |\$)" <<<"$listing"; then
    shred -u "$DEST/$DATABASE.dump"
    echo "✗ the dump held rows of $t (credentials): deleted it, backup failed" >&2
    exit 1
  fi
done

RECIPIENT="${AF_BACKUP_GPG_RECIPIENT:-}"
tar -C "$HOME/.config" --exclude='*.admin.env' --exclude='*.bak*' -czf "$DEST/config.tgz" adminforge
data=()
for d in adminforge caddy; do [ -d "$HOME/.local/share/$d" ] && data+=("$d"); done
if [ ${#data[@]} -gt 0 ]; then
  if [ -n "$RECIPIENT" ]; then
    tar -C "$HOME/.local/share" -czf "$DEST/data.tgz" "${data[@]}"
  else
    tar -C "$HOME/.local/share" --exclude='caddy/*.key' -czf "$DEST/data.tgz" "${data[@]}"
  fi
fi
if [ -n "$RECIPIENT" ]; then
  for f in "$DEST/$DATABASE.dump" "$DEST/config.tgz" "$DEST/data.tgz"; do
    [ -f "$f" ] || continue
    gpg --batch --yes --trust-model always --recipient "$RECIPIENT" --output "$f.gpg" --encrypt "$f"
    shred -u "$f"
  done
fi
chmod 600 "$DEST"/*

find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
echo "✓ backup $STAMP: $(du -sh "$DEST" | cut -f1) in $DEST (kept ${KEEP_DAYS} days, $([ -n "$RECIPIENT" ] && echo "encrypted to $RECIPIENT" || echo "not encrypted: set AF_BACKUP_GPG_RECIPIENT"))"
