#!/usr/bin/env bash
# Installs AdminForge's systemd user units (portal/deploy/systemd) into ~/.config/systemd/user, pointed at a checkout.
#
#   portal/deploy/install-units.sh [--dry-run] [--checkout DIR] [--target DIR] [unit ...]
#
#   unit        api worker scheduler runner proxy backup   (default: api worker scheduler runner)
#               backup also installs adminforge-backup.timer
#   --checkout  the repository the units run from (default: the checkout holding this script). Every
#               "%h/AdminForge" in a unit (WorkingDirectory, ExecStart) becomes this absolute path.
#   --target    the user unit directory (default: ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user)
#   --dry-run   print what would change and write nothing
#
# Each service also gets hardening.conf as its drop-in (adminforge-<unit>.service.d/hardening.conf). Idempotent: a file
# is written only when its content differs, and every file gets one line — installed, updated or unchanged. Your own
# drop-ins (override.conf) are never touched. It never reloads, enables or restarts anything: it prints the systemctl
# commands to run next. Tested in tests/unit/deploy/install-units.test.ts.
set -euo pipefail
umask 022

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="$DEPLOY_DIR/systemd"
CHECKOUT="$(cd "$DEPLOY_DIR/../.." && pwd)"
TARGET="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DRY_RUN=0
ALL_UNITS=(api worker scheduler runner proxy backup)
UNITS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --checkout)
      CHECKOUT="${2:?--checkout needs a directory}"
      shift
      ;;
    --target)
      TARGET="${2:?--target needs a directory}"
      shift
      ;;
    -h | --help)
      sed -n '2,17p' "${BASH_SOURCE[0]}" | sed -E 's/^# ?//'
      exit 0
      ;;
    -*)
      echo "✗ unknown option $1 (see --help)" >&2
      exit 2
      ;;
    *) UNITS+=("$1") ;;
  esac
  shift
done
[ ${#UNITS[@]} -gt 0 ] || UNITS=(api worker scheduler runner)
for u in "${UNITS[@]}"; do
  case " ${ALL_UNITS[*]} " in
    *" $u "*) ;;
    *)
      echo "✗ unknown unit $u (one of: ${ALL_UNITS[*]})" >&2
      exit 2
      ;;
  esac
done
[ -d "$CHECKOUT/portal/apps" ] || {
  echo "✗ $CHECKOUT is not an AdminForge checkout (no portal/apps)" >&2
  exit 1
}
CHECKOUT="$(cd "$CHECKOUT" && pwd)"
# The path is written into ExecStart=/WorkingDirectory=: whitespace, % (systemd specifiers) or newlines would change
# the unit's meaning, so only plain path characters are accepted.
[[ "$CHECKOUT" =~ ^/[A-Za-z0-9._/+-]+$ ]] || {
  echo "✗ $CHECKOUT contains characters that aren't safe in a systemd unit (use a path of letters, digits, . _ / + -)" >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CHANGED=0

# render <source> <out>: the unit with %h/AdminForge replaced by the checkout (quoted, so "&" and "#" stay literal).
render() {
  local text
  text="$(cat "$1"; printf x)"
  text="${text%x}"
  printf '%s' "${text//'%h/AdminForge'/"$CHECKOUT"}" >"$2"
}

# place <rendered file> <destination>: write it when it differs, and say what happened.
place() {
  local src="$1" dest="$2" rel="${2#"$TARGET"/}" verb=install
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    printf '%-16s %s\n' unchanged "$rel"
    return
  fi
  [ -f "$dest" ] && verb=update
  CHANGED=1
  if [ "$DRY_RUN" = 1 ]; then
    printf '%-16s %s\n' "would ${verb}" "$rel"
    return
  fi
  install -D -m 644 "$src" "$dest"
  printf '%-16s %s\n' "${verb%e}ed" "$rel"
}

services=()
for u in "${UNITS[@]}"; do
  name="adminforge-$u"
  render "$UNIT_DIR/$name.service" "$WORK/$name.service"
  place "$WORK/$name.service" "$TARGET/$name.service"
  place "$UNIT_DIR/hardening.conf" "$TARGET/$name.service.d/hardening.conf"
  if [ "$u" = backup ]; then
    render "$UNIT_DIR/$name.timer" "$WORK/$name.timer"
    place "$WORK/$name.timer" "$TARGET/$name.timer"
  else
    services+=("$name")
  fi
done

if [ "$CHANGED" = 0 ]; then
  echo "Nothing to change in $TARGET."
  exit 0
fi
[ "$DRY_RUN" = 1 ] && echo "Dry run: nothing was written."
echo "Next:"
echo "  systemctl --user daemon-reload"
[ ${#services[@]} -gt 0 ] && echo "  systemctl --user enable --now ${services[*]}   # or restart them if they already run"
case " ${UNITS[*]} " in *" backup "*) echo "  systemctl --user enable --now adminforge-backup.timer" ;; esac
echo "  loginctl enable-linger \"\$USER\"   # keep them running when you are not logged in"
