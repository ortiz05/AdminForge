#!/usr/bin/env bash
# AdminForge backup: the services' database (pg_dump, custom format), the services' configuration (env files incl.
# TOKEN_CACHE_KEY and client secrets) and data (report files, Caddy's CA certificate). Run by adminforge-backup.timer.
# When the services run as the adminforge system account (install-service-account.sh), their report files live in
# /var/lib/adminforge/artifacts and this user reads them through the adminforge group; if it can't, everything else is
# backed up and the run fails, naming the fix.
# Prints file names and sizes only — never contents. Backups hold secrets: they stay mode 600 in a 700 directory.
#
# Never backed up: <env>.admin.env (provisioner and test-user credentials — recreate or re-issue them instead), the
# database owner's credentials (<env>.owner.env files, and DATABASE_MIGRATION_URL / POSTGRES_PASSWORD wherever an older
# layout still keeps them — re-issue with `pnpm db:harden --rotate` after a restore) and stray copies (*.bak*). Caddy's
# private keys (local CA, site certificate) are included only when the backup is encrypted.
#
# Encrypted by default: AF_BACKUP_GPG_RECIPIENT = a GPG key id/fingerprint whose private key is NOT on this host. Without
# it the backup refuses to run, unless AF_BACKUP_ALLOW_PLAINTEXT=1 says plaintext is acceptable here (the files still
# hold TOKEN_CACHE_KEY and the apps' client secrets); unencrypted, a restore issues a new local CA and browsers must
# trust it again. Copy the backup folder off this host (docs/operations.md → Backups): a backup on the same disk as the
# database doesn't survive the disk.
# The rows of the transient credential tables (signed-in sessions, sign-in round trips, the sealed MSAL token cache with
# the engineers' refresh tokens) are never dumped, only their definitions: a stolen backup plus TOKEN_CACHE_KEY can't
# yield refresh tokens, and after a restore everyone simply signs in again.
#
# Settings (environment, e.g. the backup unit's Environment= lines): AF_BACKUP_DIR (default ~/adminforge-backups),
# AF_BACKUP_KEEP_DAYS (14), AF_BACKUP_GPG_RECIPIENT, AF_BACKUP_PG_CONTAINER, AF_BACKUP_DATABASE and
# AF_BACKUP_STATE_DIR (the service account's state, default /var/lib/adminforge). The container,
# database and owner role default to portal/deploy/defaults.env (AF_PG_CONTAINER, AF_PG_DATABASE, AF_PG_USER).
# Tested against a fake docker in tests/unit/deploy/backup-script.test.ts.
set -euo pipefail
umask 077

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../lib/defaults.sh
. "$DEPLOY_DIR/lib/defaults.sh"
af_load_deploy_defaults

DEST_ROOT="${AF_BACKUP_DIR:-$HOME/adminforge-backups}"
CONTAINER="${AF_BACKUP_PG_CONTAINER:-$AF_PG_CONTAINER}"
DATABASE="${AF_BACKUP_DATABASE:-$AF_PG_DATABASE}"
KEEP_DAYS="${AF_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DEST="$DEST_ROOT/$STAMP"
RECIPIENT="${AF_BACKUP_GPG_RECIPIENT:-}"
if [ -z "$RECIPIENT" ] && [ "${AF_BACKUP_ALLOW_PLAINTEXT:-}" != "1" ]; then
  echo "✗ backups are encrypted: set AF_BACKUP_GPG_RECIPIENT (a key whose private half is not on this host), or AF_BACKUP_ALLOW_PLAINTEXT=1 to accept a plaintext backup" >&2
  exit 1
fi

install -d -m 700 "$DEST_ROOT" "$DEST"
# Tables whose rows are credentials, not history (portal/apps/api/src/db/schema.ts): schema only.
TRANSIENT_TABLES=(public.sessions public.preauth public.token_cache)
exclude=()
for t in "${TRANSIENT_TABLES[@]}"; do exclude+=("--exclude-table-data=$t"); done
docker exec "$CONTAINER" pg_dump -U "$AF_PG_USER" -Fc "${exclude[@]}" "$DATABASE" > "$DEST/$DATABASE.dump"
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

# The configuration — the whole directory (subdirectories and dotfiles too) — without the admin and owner files
# (including half-written copies such as dev.host.owner.env.Ab12Cd from create-app-role.sh) and stray backups, and
# without owner keys in any text file an older layout still keeps them in. Staged in a private directory inside the
# backup, archived, then removed (also when the script stops early).
stage="$DEST/.config-stage"
trap 'rm -rf "$stage"' EXIT
install -d -m 700 "$stage"
cp -a "$HOME/.config/adminforge" "$stage/adminforge"
find "$stage/adminforge" \( -name '*.admin.env*' -o -name '*.owner.env*' -o -name '*.bak*' \) -exec rm -rf {} +
OWNER_KEYS='^[[:space:]]*(export[[:space:]]+)?(DATABASE_MIGRATION_URL|POSTGRES_PASSWORD)[[:space:]]*='
while IFS= read -r -d '' f; do
  if grep -Iq -E "$OWNER_KEYS" "$f"; then sed -i -E "/$OWNER_KEYS/d" "$f"; fi
done < <(find "$stage/adminforge" -type f -print0)
tar -C "$stage" -czf "$DEST/config.tgz" adminforge
rm -rf "$stage"
trap - EXIT
data=()
for d in adminforge caddy; do [ -d "$HOME/.local/share/$d" ] && data+=("$d"); done
if [ ${#data[@]} -gt 0 ]; then
  if [ -n "$RECIPIENT" ]; then
    tar -C "$HOME/.local/share" -czf "$DEST/data.tgz" "${data[@]}"
  else
    tar -C "$HOME/.local/share" --exclude='caddy/*.key' -czf "$DEST/data.tgz" "${data[@]}"
  fi
fi
STATE_DIR="${AF_BACKUP_STATE_DIR:-/var/lib/adminforge}"
STATE_GAP=""
if [ -d "$STATE_DIR" ]; then
  if [ -r "$STATE_DIR" ] && [ -x "$STATE_DIR" ] &&
    { [ ! -e "$STATE_DIR/artifacts" ] || [ -z "$(find "$STATE_DIR/artifacts" ! -readable -print -quit 2>/dev/null)" ]; }; then
    [ -d "$STATE_DIR/artifacts" ] && tar -C "$STATE_DIR" -czf "$DEST/state.tgz" artifacts
  else
    me="$(id -un)"
    STATE_GAP="the report files in $STATE_DIR/artifacts were not backed up: $me can't read them — sudo usermod -aG adminforge $me, then log out and in (or reboot) so the backup's user manager has the group"
  fi
fi
if [ -n "$RECIPIENT" ]; then
  for f in "$DEST/$DATABASE.dump" "$DEST/config.tgz" "$DEST/data.tgz" "$DEST/state.tgz"; do
    [ -f "$f" ] || continue
    gpg --batch --yes --trust-model always --recipient "$RECIPIENT" --output "$f.gpg" --encrypt "$f"
    shred -u "$f"
  done
fi
chmod 600 "$DEST"/*

find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
echo "✓ backup $STAMP: $(du -sh "$DEST" | cut -f1) in $DEST (kept ${KEEP_DAYS} days, $([ -n "$RECIPIENT" ] && echo "encrypted to $RECIPIENT" || echo "NOT encrypted (AF_BACKUP_ALLOW_PLAINTEXT=1): set AF_BACKUP_GPG_RECIPIENT"))"
if [ -n "$STATE_GAP" ]; then
  echo "✗ $STATE_GAP" >&2
  exit 1
fi
