#!/usr/bin/env bash
# Runs AdminForge's services as dedicated system accounts instead of the owner's login account, which is in the
# docker/sudo/adm/lxd groups — any process running as it can `docker exec` into Postgres as the superuser
# (SECURITY.md, Postgres finding C1). Postgres stays in Docker; the services keep connecting over TCP as adminforge_app.
#   adminforge         api, worker, scheduler — reads /etc/adminforge (group), writes /var/lib/adminforge
#   adminforge-runner  the PowerShell runner — gets only its own env file (read by systemd), can't see /etc/adminforge
# The proxy (Caddy) and the backup stay user units of the owner.
#
#   portal/deploy/install-service-account.sh [mode] [options]          (read the dry run first; never via NOPASSWD sudo)
#
#   --dry-run       (default) print the whole plan; change nothing; root not needed
#   --apply         first installation (root): accounts, runtime, release, config, state, units, tmpfiles
#   --release       later deploys (root): a new release of the checkout, config re-synced, units re-rendered, `current`
#                   switched and the services restarted; the last 3 releases are kept
#   --rollback      (root) point `current` at the previous release and restart (code only; configuration stays)
#   --sync-config   (root) copy the configuration again (after editing ~/.config/adminforge or rotating a secret) and
#                   restart — no new release
#   --firewall      with --dry-run: print the loopback firewall; with --apply/--release: load it (nftables)
#   --print-units   print the rendered system units and exit
#   --checkout DIR  the built, committed checkout to release (default: the one holding this script)
#   --owner USER    whose ~/.config/adminforge and user units to read (default: $SUDO_USER, else $USER)
#   --env NAME      the environment (default: $ADMINFORGE_ENV, else dev)
#   --node PATH     the node binary to copy (default: from the owner's api unit PATH, else `command -v node`)
#
# Configuration copied to /etc/adminforge: keys documented in config/example.env only — never provisioner,
# test-account or database-owner keys, base keys the overlay replaces are dropped, the runner's file keeps RUNNER_*
# keys (and LOG_LEVEL and its two directories) only — and never a *.admin.env or *.owner.env file. Values are never printed. Owner-controlled files are read as
# the owner (runuser), never through a symlink. After --apply, nothing runs yet: the switch-over, a verification
# checklist and the rollback are printed. Tested in tests/unit/deploy/service-account.test.ts.
set -euo pipefail
umask 022

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES="$DEPLOY_DIR/systemd/system"
CHECKOUT="$(cd "$DEPLOY_DIR/../.." && pwd)"
MODE=dry-run
FIREWALL=0
OWNER="${SUDO_USER:-${USER:-}}"
ENV_NAME="${ADMINFORGE_ENV:-dev}"
NODE_BIN=""
SERVICE_ACCOUNT=adminforge
RUNNER_ACCOUNT=adminforge-runner
KEEP_RELEASES=3

# Real paths written into the units. AF_SA_PREFIX (tests only, never as root) roots the files this script writes and
# turns off what needs root (accounts, ownership, systemctl, nft).
OPT=/opt/adminforge
ETC=/etc/adminforge
VARLIB=/var/lib/adminforge
RUNNER_STATE=/var/lib/adminforge-runner
UNIT_DIR=/etc/systemd/system
TMPFILES=/etc/tmpfiles.d/adminforge.conf
P="${AF_SA_PREFIX:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry-run ;;
    --apply) MODE=apply ;;
    --release) MODE=release ;;
    --rollback) MODE=rollback ;;
    --sync-config) MODE=sync-config ;;
    --firewall) FIREWALL=1 ;;
    --print-units) MODE=print-units ;;
    --checkout)
      CHECKOUT="${2:?--checkout needs a directory}"
      shift
      ;;
    --owner)
      OWNER="${2:?--owner needs a user name}"
      shift
      ;;
    --env)
      ENV_NAME="${2:?--env needs a name}"
      shift
      ;;
    --node)
      NODE_BIN="${2:?--node needs a path}"
      shift
      ;;
    -h | --help)
      sed -n '2,29p' "${BASH_SOURCE[0]}" | sed -E 's/^# ?//'
      exit 0
      ;;
    *)
      echo "✗ unknown option $1 (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done
[[ "$ENV_NAME" =~ ^[a-z0-9-]{1,32}$ ]] || {
  echo "✗ --env must be lower-case letters, digits and dashes" >&2
  exit 2
}

UID_NOW="$(id -u)"
TEST=0
if [ -n "$P" ] || [ -n "${AF_SA_OWNER_HOME:-}" ]; then
  if [ "$UID_NOW" = 0 ]; then
    echo "✗ AF_SA_PREFIX and AF_SA_OWNER_HOME are for the test suite only; refusing them as root" >&2
    exit 1
  fi
  TEST=1
fi
CHANGING=0
case "$MODE" in apply | release | rollback | sync-config) CHANGING=1 ;; esac
if [ "$CHANGING" = 1 ] && [ "$TEST" = 0 ] && [ "$UID_NOW" != 0 ]; then
  echo "✗ --$MODE changes system accounts, /opt, /etc and systemd: run it with sudo (see --dry-run first)" >&2
  exit 1
fi

PROBLEMS=()
problem() { PROBLEMS+=("$1"); }
say() { printf '%s\n' "$*"; }
plan() { if [ "$MODE" = dry-run ]; then say "  would $*"; else say "  will $*"; fi; }
# as_owner CMD…: owner-controlled files and code run with the owner's rights, never root's.
as_owner() { if [ "$UID_NOW" = 0 ]; then runuser -u "$OWNER" -- env HOME="$OWNER_HOME" "$@"; else "$@"; fi; }
# Values must be one plain token: no whitespace, quotes, %, backslash or $ (systemd and dotenv treat them specially).
PLAIN_RE='^[^[:space:]"'"'"'%\$]*$'
plain_value() { [[ "$1" =~ $PLAIN_RE ]]; }

# ── Units ────────────────────────────────────────────────────────────────────────────────────────────────────────
API_PORT=3300
RUNNER_PORT=3101

render() {
  local template="$TEMPLATES/adminforge-$1.service" hardening line out=""
  hardening="$(grep -v '^#' "$TEMPLATES/hardening.conf")"
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = "@HARDENING@" ]; then
      out+="$hardening"$'\n'
      continue
    fi
    line="${line//@OPT@/$OPT}"
    line="${line//@ETC@/$ETC}"
    line="${line//@VARLIB@/$VARLIB}"
    line="${line//@RUNNER_STATE@/$RUNNER_STATE}"
    line="${line//@ENV@/$ENV_NAME}"
    line="${line//@API_PORT@/$API_PORT}"
    line="${line//@RUNNER_PORT@/$RUNNER_PORT}"
    out+="$line"$'\n'
  done <"$template"
  printf '%s' "$out"
}
render_tmpfiles() {
  say "# AdminForge state (portal/deploy/install-service-account.sh). systemd-tmpfiles creates these safely at boot."
  say "d $VARLIB 0750 $SERVICE_ACCOUNT $SERVICE_ACCOUNT -"
  say "d $VARLIB/artifacts 0750 $SERVICE_ACCOUNT $SERVICE_ACCOUNT -"
  say "d $VARLIB/home 0750 $SERVICE_ACCOUNT $SERVICE_ACCOUNT -"
  say "d $RUNNER_STATE 0750 $RUNNER_ACCOUNT $RUNNER_ACCOUNT -"
}
SERVICES=(api worker scheduler runner)
UNITS_LIST="adminforge-runner adminforge-api adminforge-worker adminforge-scheduler"

if [ "$MODE" = print-units ]; then
  for s in "${SERVICES[@]}"; do
    say "### adminforge-$s.service"
    render "$s"
  done
  say "### tmpfiles"
  render_tmpfiles
  exit 0
fi

# ── Releases (rollback needs nothing else) ──────────────────────────────────────────────────────────────────────
REL_RE='^[0-9a-f]{12}\.[0-9]{10}$'
# releases_newest_first: release directories named <sha>.<epoch seconds>, newest first by that time.
releases_newest_first() {
  [ -d "$P$OPT/releases" ] || return 0
  find "$P$OPT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E "$REL_RE" |
    sort -t. -k2,2nr || true
}
current_release() { if [ -L "$P$OPT/current" ]; then basename "$(readlink "$P$OPT/current")"; fi; }
switch_current() {
  [[ "$1" =~ $REL_RE ]] || return 1
  ln -sfn "releases/$1" "$P$OPT/current.tmp"
  mv -Tf "$P$OPT/current.tmp" "$P$OPT/current"
}
restart_services() {
  if [ "$TEST" = 1 ]; then
    say "  (test: would systemctl daemon-reload and try-restart $UNITS_LIST)"
    return
  fi
  systemctl daemon-reload
  # shellcheck disable=SC2086
  systemctl try-restart $UNITS_LIST
  say "  ✓ restarted the running services ($UNITS_LIST)"
}

# Later modes run the root-owned copy of this script (/opt/adminforge/current/portal/deploy), not the owner's: root
# never runs code the owner's account could have changed after the first --apply.
if [ "$TEST" = 0 ] && [ "$UID_NOW" = 0 ] && [ "$CHANGING" = 1 ] && [ "$MODE" != apply ]; then
  read -r script_owner script_mode < <(stat -Lc '%U %a' "${BASH_SOURCE[0]}")
  if [ "$script_owner" != root ] || [ $((8#$script_mode & 8#022)) != 0 ]; then
    echo "✗ run --$MODE from the released copy: sudo $OPT/current/portal/deploy/install-service-account.sh --$MODE --checkout <checkout>" >&2
    exit 1
  fi
fi

if [ "$MODE" = rollback ]; then
  cur="$(current_release)"
  mapfile -t all < <(releases_newest_first)
  prev=""
  seen=0
  for r in "${all[@]}"; do
    if [ "$seen" = 1 ]; then
      prev="$r"
      break
    fi
    [ "$r" = "$cur" ] && seen=1
  done
  if [ -z "$cur" ] || [ -z "$prev" ]; then
    echo "✗ no earlier release to go back to (current: ${cur:-none})" >&2
    exit 1
  fi
  switch_current "$prev"
  say "✓ $OPT/current → releases/$prev (was $cur)"
  restart_services
  say "Check: curl -fsS http://127.0.0.1:$API_PORT/healthz && curl -fsS http://127.0.0.1:$API_PORT/readyz"
  exit 0
fi

# ── Owner ───────────────────────────────────────────────────────────────────────────────────────────────────────
if [ -z "$OWNER" ] || ! [[ "$OWNER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "✗ --owner must name the account whose ~/.config/adminforge holds the configuration" >&2
  exit 2
fi
case "$OWNER" in "$SERVICE_ACCOUNT" | "$RUNNER_ACCOUNT" | root)
  echo "✗ --owner is the person who administers AdminForge, not $OWNER" >&2
  exit 2
  ;;
esac
OWNER_HOME="${AF_SA_OWNER_HOME:-$(getent passwd "$OWNER" | cut -d: -f6)}"
if [ -z "$OWNER_HOME" ] || [ ! -d "$OWNER_HOME" ]; then
  echo "✗ no home directory for $OWNER" >&2
  exit 1
fi
OWNER_HOME="$(cd "$OWNER_HOME" && pwd -P)"
CONFIG_DIR="$OWNER_HOME/.config/adminforge"
USER_UNITS="$OWNER_HOME/.config/systemd/user"
# under <path> <root>: the path's real location is inside root (owner symlinks can't point elsewhere).
under() {
  local real
  real="$(realpath -e -- "$1" 2>/dev/null)" || return 1
  [[ "$real" == "$2" || "$real" == "$2"/* ]]
}

# ── Settings carried from the owner's user-unit drop-ins (names printed, values never) ─────────────────────────
CARRY='^(NODE_ENV|API_HOST|API_PORT|PUBLIC_BASE_URL|CONTENT_SOURCE|RUN_WORKER_IN_PROCESS|SCHEDULER_IN_PROCESS|ADMINFORGE_ENV_OVERLAY|LOG_LEVEL|TRUST_PROXY|OUTBOUND_[A-Z_]+|DATABASE_POOL_MAX)$'
REWRITTEN='^(PATH|PWSH_PATH|NODE_EXTRA_CA_CERTS|HOME|ADMINFORGE_ENV_FILE|ADMINFORGE_ARTIFACTS_DIR|RUNNER_PRELOAD_MODULES)$'
declare -A CARRIED NOT_CARRIED
OVERLAY=host
CA_SOURCE=""
API_PATH_VALUE=""
RUNNER_PWSH_VALUE=""
PUBLIC_PORT=""
expand_home() { local v="${1//%h/$OWNER_HOME}"; printf '%s' "${v/#\~/$OWNER_HOME}"; }
for s in "${SERVICES[@]}"; do
  CARRIED[$s]=""
  NOT_CARRIED[$s]=""
  dir="$USER_UNITS/adminforge-$s.service.d"
  [ -d "$dir" ] || continue
  for conf in "$dir"/*.conf; do
    if [ ! -f "$conf" ] || [ "$(basename "$conf")" = hardening.conf ]; then continue; fi
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        Environment=*)
          kv="${line#Environment=}"
          key="${kv%%=*}"
          value="${kv#*=}"
          if [[ "$key" =~ $CARRY ]] && [ "$s" != runner ]; then
            if ! plain_value "$value" || [[ "$value" == *"$OWNER_HOME"* || "$value" == \~* || "$value" == /home/* ]]; then
              NOT_CARRIED[$s]+="$key "
            else
              CARRIED[$s]+="$key=$value"$'\n'
              case "$key" in
                ADMINFORGE_ENV_OVERLAY) OVERLAY="$value" ;;
                API_PORT) [ "$s" = api ] && [[ "$value" =~ ^[0-9]{1,5}$ ]] && API_PORT="$value" ;;
                PUBLIC_BASE_URL) [[ "$value" =~ ^https?://[^/:]+:([0-9]{1,5})(/|$) ]] && PUBLIC_PORT="${BASH_REMATCH[1]}" ;;
              esac
            fi
          elif [[ "$key" =~ $REWRITTEN ]]; then
            [ "$key" = NODE_EXTRA_CA_CERTS ] && [ "$s" = api ] && CA_SOURCE="$(expand_home "$value")"
            [ "$key" = PATH ] && [ "$s" = api ] && API_PATH_VALUE="$(expand_home "$value")"
            [ "$key" = PWSH_PATH ] && RUNNER_PWSH_VALUE="$(expand_home "$value")"
          else
            NOT_CARRIED[$s]+="$key "
          fi
          ;;
        EnvironmentFile=*) [ "$s" = runner ] || NOT_CARRIED[$s]+="EnvironmentFile " ;;
      esac
    done <"$conf"
  done
done
[[ "$OVERLAY" =~ ^[a-z0-9-]{1,32}$ ]] || problem "ADMINFORGE_ENV_OVERLAY in the owner's units isn't a plain overlay name"

# ── Configuration: allow-listed keys only ───────────────────────────────────────────────────────────────────────
BASE_FILE="$ENV_NAME.env"
OVERLAY_FILE="$ENV_NAME.$OVERLAY.env"
RUNNER_FILE="$ENV_NAME.runner.env"
for f in "$BASE_FILE" "$OVERLAY_FILE" "$RUNNER_FILE"; do
  case "$f" in *.admin.env | *.owner.env) problem "refusing to copy $f (admin and owner files stay with the owner)" ;; esac
  if [ -L "$CONFIG_DIR/$f" ]; then
    problem "$f is a symlink — the configuration is copied from regular files only"
  elif [ ! -f "$CONFIG_DIR/$f" ]; then
    problem "missing $CONFIG_DIR/$f"
  fi
done
# Keys AdminForge documents (config/example.env), minus what only the CLI, provisioning or migrations use.
mapfile -t DOCUMENTED < <(as_owner cat -- "$CHECKOUT/config/example.env" 2>/dev/null | grep -oE '^[A-Z][A-Z0-9_]*=' | tr -d '=' | sort -u)
NEVER='^(AF_PROVISIONER_[A-Z0-9_]+|AF_TEST_[A-Z0-9_]+|DATABASE_MIGRATION_URL|POSTGRES_PASSWORD)$'
# Documented as patterns (config/example.env → named app identities); their ALLOW_* opt-ins live in the admin file.
PATTERN_KEYS='^AF_IDENTITY_[A-Z0-9_]+_(CLIENT_ID|CLIENT_SECRET|CERT_PATH)$'
CERT_KEYS='^(AF_AUTOMATION_CERT_PATH|AF_IDENTITY_[A-Z0-9_]+_CERT_PATH)$'
PATH_KEYS='^(AF_AUTOMATION_CERT_PATH|AF_IDENTITY_[A-Z0-9_]+_CERT_PATH|CONTENT_DIR|WEB_DIST_DIR|ADMINFORGE_[A-Z_]*DIR|NODE_EXTRA_CA_CERTS)$'
# The runner reads process.env only: its shared key and settings, nothing of the API's.
RUNNER_KEYS='^(RUNNER_[A-Z0-9_]+|LOG_LEVEL|ADMINFORGE_RUNNER_MODULES_DIR|ADMINFORGE_SCRIPTS_DIR)$'
declare -A ALLOWED
for k in "${DOCUMENTED[@]}"; do [[ "$k" =~ $NEVER ]] || ALLOWED[$k]=1; done
[ ${#ALLOWED[@]} -gt 0 ] || problem "config/example.env lists no keys (wrong --checkout?)"
# read_env FILE: KEY<TAB>value lines (dotenv as the loader reads it: comments, blank lines and a BOM ignored).
read_env() {
  as_owner cat -- "$1" | sed '1s/^\xEF\xBB\xBF//' | while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    printf '%s\t%s\n' "${BASH_REMATCH[1]}" "$(sed -E 's/[[:space:]]+$//' <<<"${BASH_REMATCH[2]}")"
  done
}
declare -A OVERLAY_KEYS CERTS
# cert_name KEY: the file name a certificate gets in /etc/adminforge (automation.pem, identity-<name>.pem).
cert_name() {
  if [ "$1" = AF_AUTOMATION_CERT_PATH ]; then
    echo automation.pem
  else
    local n="${1#AF_IDENTITY_}"
    n="${n%_CERT_PATH}"
    n="${n//_/-}"
    echo "identity-${n,,}.pem"
  fi
}
DROPPED=()
# filter_env <file> <kind: base|overlay|runner> <out|-> : the allowed lines; names of what was left out in DROPPED.
filter_env() {
  local file="$1" kind="$2" out="$3" key value v keep
  DROPPED=()
  [ "$out" = - ] || : >"$out"
  while IFS=$'\t' read -r key value; do
    keep=1
    if [ "$kind" = runner ]; then
      [[ "$key" =~ $RUNNER_KEYS ]] || keep=0
    elif [ -z "${ALLOWED[$key]:-}" ] && ! [[ "$key" =~ $PATTERN_KEYS ]]; then
      keep=0
    elif [ "$kind" = base ] && [ -n "${OVERLAY_KEYS[$key]:-}" ]; then
      keep=0
    fi
    if [ "$keep" = 1 ] && [[ "$key" =~ $PATH_KEYS ]]; then
      v="${value%\"}"
      v="${v#\"}"
      v="${v%\'}"
      v="${v#\'}"
      if [[ "$key" =~ $CERT_KEYS ]] && [[ "$v" == \~* || "$v" == "$OWNER_HOME"* || "$v" == /home/* ]]; then
        # The certificate moves with the configuration (0640 root:adminforge); the services can't read /home.
        CERTS[$(cert_name "$key")]="$(expand_home "$v")"
        value="$ETC/$(cert_name "$key")"
      elif [[ "$v" == \~* || "$v" == "$OWNER_HOME"* || "$v" == /home/* ]]; then
        problem "$key in $(basename "$file") points into a home directory the services can't read — set it to a path under /opt, /etc or /var/lib, or remove it"
      fi
    fi
    if [ "$keep" = 1 ]; then
      [ "$out" = - ] || printf '%s=%s\n' "$key" "$value" >>"$out"
    else
      DROPPED+=("$key")
    fi
  done < <(read_env "$file")
}
if [ -f "$CONFIG_DIR/$OVERLAY_FILE" ] && [ ! -L "$CONFIG_DIR/$OVERLAY_FILE" ]; then
  while IFS=$'\t' read -r key _; do OVERLAY_KEYS[$key]=1; done < <(read_env "$CONFIG_DIR/$OVERLAY_FILE")
fi
if [ -f "$CONFIG_DIR/$RUNNER_FILE" ] && [ ! -L "$CONFIG_DIR/$RUNNER_FILE" ]; then
  port="$(read_env "$CONFIG_DIR/$RUNNER_FILE" | awk -F'\t' '$1 == "RUNNER_PORT" { print $2 }' | tail -1)"
  [[ "$port" =~ ^[0-9]{1,5}$ ]] && RUNNER_PORT="$port"
fi
# The services connect as their least-privilege role from the overlay — never the base file's (owner) DATABASE_URL.
if [ -f "$CONFIG_DIR/$OVERLAY_FILE" ] && [ ! -L "$CONFIG_DIR/$OVERLAY_FILE" ]; then
  if [ -z "${OVERLAY_KEYS[DATABASE_URL]:-}" ]; then
    problem "$OVERLAY_FILE doesn't set DATABASE_URL: the services would connect with the base file's — point the overlay at adminforge_app (portal/deploy/db/create-app-role.sh)"
  else
    db_role="$(read_env "$CONFIG_DIR/$OVERLAY_FILE" | awk -F'\t' '$1 == "DATABASE_URL" { print $2 }' | tail -1 |
      sed -E 's#^["'"'"']?[a-z]+://([^:@/]*).*#\1#')"
    owners=" $(grep -E '^AF_PG_(USER|OWNER|DEV_USER)=' "$DEPLOY_DIR/defaults.env" 2>/dev/null | cut -d= -f2 | tr '\n' ' ') postgres "
    case "$owners" in *" $db_role "*) problem "DATABASE_URL in $OVERLAY_FILE connects as an owner role — point it at adminforge_app (portal/deploy/db/create-app-role.sh)" ;; esac
  fi
fi
# One pass over the three files now: what each leaves out, and the paths they name (checked below).
declare -A DROPPED_BY
for pair in "base:$BASE_FILE" "overlay:$OVERLAY_FILE" "runner:$RUNNER_FILE"; do
  kind="${pair%%:*}"
  f="${pair#*:}"
  if [ ! -f "$CONFIG_DIR/$f" ] || [ -L "$CONFIG_DIR/$f" ]; then continue; fi
  filter_env "$CONFIG_DIR/$f" "$kind" -
  DROPPED_BY[$kind]="${DROPPED[*]}"
done
if [ -n "$CA_SOURCE" ]; then
  if [ -L "$CA_SOURCE" ] || ! under "$CA_SOURCE" "$OWNER_HOME" || [ ! -f "$CA_SOURCE" ]; then
    problem "NODE_EXTRA_CA_CERTS must name a regular file in $OWNER's home (not a symlink)"
  fi
fi

# ── Checkout: committed, built, no absolute links ───────────────────────────────────────────────────────────────
NEED_CHECKOUT=1
[ "$MODE" = sync-config ] && NEED_CHECKOUT=0
if [ ! -d "$CHECKOUT/portal/apps" ]; then
  echo "✗ $CHECKOUT is not an AdminForge checkout (no portal/apps)" >&2
  exit 1
fi
CHECKOUT="$(cd "$CHECKOUT" && pwd -P)"
[[ "$CHECKOUT" =~ ^/[A-Za-z0-9._/+-]+$ ]] || {
  echo "✗ $CHECKOUT contains characters this script won't pass to rsync (use letters, digits, . _ / + -)" >&2
  exit 1
}
git_() { as_owner git -c safe.directory="$CHECKOUT" -C "$CHECKOUT" "$@"; }
SHA="$(git_ rev-parse --short=12 HEAD 2>/dev/null || true)"
[[ "$SHA" =~ ^[0-9a-f]{12}$ ]] || {
  echo "✗ $CHECKOUT has no git commit to name the release after" >&2
  exit 1
}
if [ "$NEED_CHECKOUT" = 1 ]; then
  [ -z "$(git_ status --porcelain 2>/dev/null)" ] ||
    problem "the checkout has uncommitted changes — release a committed state (commit or stash, then pnpm build)"
  workspace_dir() {
    if [ -d "$CHECKOUT/portal/packages/$1" ]; then echo "portal/packages/$1"; elif [ -d "$CHECKOUT/portal/apps/$1" ]; then echo "portal/apps/$1"; fi
  }
  # inputs_of <built file>: its app, every workspace package it depends on (transitively) and the lockfile. Turbo
  # restores unchanged outputs with their original times, so each app is judged on its own inputs.
  inputs_of() {
    local todo seen=" " dir name d
    todo="$(cut -d/ -f1-3 <<<"$1")"
    while [ -n "$todo" ]; do
      dir="${todo%% *}"
      todo="$(sed -E 's/^[^ ]+ ?//' <<<"$todo")"
      case "$seen" in *" $dir "*) continue ;; esac
      seen+="$dir "
      for name in $(grep -oE '"@adminforge/[a-z0-9-]+"' "$CHECKOUT/$dir/package.json" 2>/dev/null | tr -d '"' | sed 's#@adminforge/##' | sort -u); do
        d="$(workspace_dir "$name")"
        [ -n "$d" ] && todo="${todo:+$todo }$d"
      done
    done
    echo "${seen# } pnpm-lock.yaml"
  }
  for f in portal/apps/api/dist/main.js portal/apps/api/dist/worker.js portal/apps/scheduler/dist/main.js \
    portal/apps/runner/dist/main.js portal/apps/web/dist/index.html node_modules; do
    if [ ! -e "$CHECKOUT/$f" ]; then
      problem "not built: $f is missing (run pnpm install --frozen-lockfile && pnpm build)"
      continue
    fi
    [ "$f" = node_modules ] && continue
    # shellcheck disable=SC2046
    changed_at="$(git_ log -1 --format=%ct -- $(inputs_of "$f"))"
    if [ -n "$changed_at" ] && [ "$(stat -c %Y "$CHECKOUT/$f")" -lt "$changed_at" ]; then
      problem "stale build: $f is older than the last change to its sources (run pnpm build)"
    fi
  done
  # pnpm links are relative; an absolute one would point outside the release (and into the owner's home).
  if [ -n "$(find "$CHECKOUT" -path "$CHECKOUT/.git" -prune -o -type l -lname '/*' -print -quit 2>/dev/null)" ]; then
    problem "the checkout holds absolute symlinks (they would point outside the release): reinstall with pnpm"
  fi
fi

# ── Runtime: node and PowerShell out of the owner's home (the units can't read /home) ───────────────────────────
if [ -z "$NODE_BIN" ]; then
  IFS=':' read -r -a dirs <<<"${API_PATH_VALUE:-}"
  for d in "${dirs[@]}"; do [ -x "$d/node" ] && NODE_BIN="$d/node" && break; done
  [ -n "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
fi
NODE_VERSION=""
if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
  NODE_BIN="$(realpath -e -- "$NODE_BIN")"
  NODE_VERSION="$(as_owner "$NODE_BIN" --version 2>/dev/null || true)"
fi
[[ "$NODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || problem "no usable node binary (pass --node /path/to/node)"
if [ -n "$NODE_BIN" ] && ! under "$NODE_BIN" "$OWNER_HOME" && ! under "$NODE_BIN" /usr && ! under "$NODE_BIN" /opt; then
  problem "node resolves outside $OWNER's home, /usr and /opt"
fi
PWSH_SOURCE="${RUNNER_PWSH_VALUE:-$OWNER_HOME/.local/bin/pwsh}"
PWSH_DIR=""
PWSH_VERSION=""
if [ -e "$PWSH_SOURCE" ]; then
  PWSH_DIR="$(dirname "$(realpath -e -- "$PWSH_SOURCE")")"
  PWSH_VERSION="$(basename "$PWSH_DIR")"
  [[ "$PWSH_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || PWSH_VERSION=current
  if ! under "$PWSH_DIR" "$OWNER_HOME" && ! under "$PWSH_DIR" /opt/microsoft && ! under "$PWSH_DIR" /usr; then
    problem "PowerShell resolves outside $OWNER's home, /opt/microsoft and /usr"
  elif [ ! -f "$PWSH_DIR/pwsh" ] || [ ! -f "$PWSH_DIR/pwsh.dll" ]; then
    problem "$PWSH_DIR doesn't look like a PowerShell installation (pwsh and pwsh.dll expected)"
  fi
else
  problem "PowerShell not found at the runner's PWSH_PATH (install pwsh, or the runner can't start)"
fi
for c in "${!CERTS[@]}"; do
  src="${CERTS[$c]}"
  if [ -L "$src" ] || [ ! -f "$src" ] || ! under "$src" "$OWNER_HOME"; then
    problem "the certificate for $ETC/$c must be a regular file in $OWNER's home (not a symlink)"
  fi
done
ARTIFACTS_SOURCE="$OWNER_HOME/.local/share/adminforge/artifacts"
if [ -e "$ARTIFACTS_SOURCE" ] && { [ -L "$ARTIFACTS_SOURCE" ] || ! under "$ARTIFACTS_SOURCE" "$OWNER_HOME"; }; then
  problem "$ARTIFACTS_SOURCE must be a directory in $OWNER's home (not a symlink) to import the report files"
fi

# ── Accounts ────────────────────────────────────────────────────────────────────────────────────────────────────
PRIVILEGED_GROUPS="docker sudo adm lxd wheel root disk shadow kvm libvirt incus-admin systemd-journal"
declare -A ACCOUNT_STATE
for a in "$SERVICE_ACCOUNT" "$RUNNER_ACCOUNT"; do
  ACCOUNT_STATE[$a]=new
  entry="$(getent passwd "$a" 2>/dev/null || true)"
  [ -n "$entry" ] || continue
  ACCOUNT_STATE[$a]=existing
  [ "$(cut -d: -f3 <<<"$entry")" != 0 ] || problem "user $a exists with uid 0"
  case "$(cut -d: -f7 <<<"$entry")" in */nologin | */false) ;; *) problem "user $a exists with a login shell" ;; esac
  groups=" $(id -nG "$a" 2>/dev/null || true) "
  for g in $PRIVILEGED_GROUPS; do
    case "$groups" in *" $g "*) problem "user $a exists and is in the $g group — remove it from that group first" ;; esac
  done
done
members="$( (getent group "$SERVICE_ACCOUNT" 2>/dev/null || true) | cut -d: -f4 | tr ',' ' ')"
for m in $members; do
  [ "$m" = "$OWNER" ] || problem "group $SERVICE_ACCOUNT has an unexpected member ($m): it would read the services' configuration"
done
if [ -L "$P$VARLIB" ] || [ -L "$P$RUNNER_STATE" ] || [ -L "$P$OPT" ] || [ -L "$P$ETC" ]; then
  problem "$OPT, $ETC, $VARLIB or $RUNNER_STATE is a symlink — refusing to write through it"
fi
if [ "$FIREWALL" = 1 ] && [ "$TEST" = 0 ] && [ "$MODE" != dry-run ] && ! command -v nft >/dev/null; then
  problem "--firewall needs nftables (apt install nftables)"
fi

# Disk: a full release, the runtime and 1 GiB to spare (hard links to the current release make it less in practice).
RSYNC_EXCLUDES=(--exclude=/.git/ --exclude=/tests/ --exclude=/docs/ --exclude=/.claude/ --exclude=/tooling/
  --exclude=/.github/ --exclude=/.githooks/ --exclude='*.env' --exclude='.env*' --exclude='*.pem' --exclude='*.key'
  --exclude='*.pfx' --exclude='*.p12' --exclude=.npmrc --exclude=.local/ --exclude='*.log' --exclude=.turbo/
  --exclude=coverage/ --exclude=node_modules/.cache/ --exclude=test-results/ --exclude=playwright-report/)
if [ "$NEED_CHECKOUT" = 1 ]; then
  need_kb=$(du -sk --exclude=.git --exclude=tests --exclude=docs --exclude=.claude --exclude=tooling --exclude=.turbo \
    --exclude=coverage --exclude=.cache "$CHECKOUT" 2>/dev/null | cut -f1)
  [ -n "$PWSH_DIR" ] && need_kb=$((need_kb + $(du -sk "$PWSH_DIR" | cut -f1)))
  [ -n "$NODE_VERSION" ] && need_kb=$((need_kb + $(du -sk "$NODE_BIN" | cut -f1)))
  probe="$P$OPT"
  while [ ! -d "$probe" ]; do probe="$(dirname "$probe")"; done
  free_kb=$(df -Pk "$probe" | awk 'NR==2 {print $4}')
  [ "$free_kb" -gt $((need_kb + 1048576)) ] ||
    problem "not enough space under $OPT: about $((need_kb / 1024)) MiB needed + 1 GiB spare, $((free_kb / 1024)) MiB free"
fi

# Loopback firewall: the service accounts may reach only Postgres, the runner, the API itself, the proxy and DNS.
PG_PORT="$(grep -oE '^AF_PG_PORT=[0-9]{1,5}$' "$DEPLOY_DIR/defaults.env" 2>/dev/null | cut -d= -f2 || true)"
PG_PORT="${PG_PORT:-55432}"
render_firewall() {
  local ports="$PG_PORT, $RUNNER_PORT, $API_PORT${PUBLIC_PORT:+, $PUBLIC_PORT}"
  cat <<EOF
# AdminForge loopback policy (portal/deploy/install-service-account.sh --firewall): on the loopback interface the
# service accounts reach Postgres, the runner, the API, the proxy and the stub resolver — nothing else on this host.
table inet adminforge_loopback
delete table inet adminforge_loopback
table inet adminforge_loopback {
  chain output {
    type filter hook output priority 0; policy accept;
    oif "lo" ct state established,related accept
    oif "lo" meta skuid "$SERVICE_ACCOUNT" tcp dport { $ports } accept
    oif "lo" meta skuid { "$SERVICE_ACCOUNT", "$RUNNER_ACCOUNT" } ip daddr 127.0.0.53 meta l4proto { tcp, udp } th dport 53 accept
    oif "lo" meta skuid { "$SERVICE_ACCOUNT", "$RUNNER_ACCOUNT" } counter reject
  }
}
EOF
}

# ── The plan ────────────────────────────────────────────────────────────────────────────────────────────────────
say "AdminForge service accounts — $MODE$([ "$MODE" = dry-run ] && printf ' (nothing changes)')"
say "  checkout $CHECKOUT @ $SHA · owner $OWNER · env $ENV_NAME (overlay $OVERLAY)"
if [ "$MODE" = apply ] || [ "$MODE" = dry-run ]; then
  say "1. Accounts (no login shell, no other groups)"
  for a in "$SERVICE_ACCOUNT" "$RUNNER_ACCOUNT"; do
    if [ "${ACCOUNT_STATE[$a]}" = new ]; then plan "create system user $a (group $a, shell /usr/sbin/nologin)"; else say "  ✓ user $a exists"; fi
  done
  plan "add $OWNER to group $SERVICE_ACCOUNT (the owner's backup reads the report files)"
fi
if [ "$NEED_CHECKOUT" = 1 ]; then
  say "2. Runtime and release ($OPT, root-owned, readable by both accounts; no secrets in it)"
  [ -n "$NODE_VERSION" ] && plan "copy node $NODE_VERSION → $OPT/runtime/node-$NODE_VERSION/bin/node"
  [ -n "$PWSH_DIR" ] && plan "copy PowerShell $PWSH_VERSION → $OPT/runtime/powershell-$PWSH_VERSION"
  plan "rsync the checkout → $OPT/releases/$SHA.<time> (about $((need_kb / 1024)) MiB; no .git, tests, docs, *.env, keys)"
  plan "point $OPT/current at it; keep the newest $KEEP_RELEASES releases"
fi
say "3. Configuration ($ETC 0750 root:$SERVICE_ACCOUNT; values not shown)"
for pair in "base:$BASE_FILE" "overlay:$OVERLAY_FILE" "runner:$RUNNER_FILE"; do
  kind="${pair%%:*}"
  f="${pair#*:}"
  if [ ! -f "$CONFIG_DIR/$f" ] || [ -L "$CONFIG_DIR/$f" ]; then continue; fi
  if [ "$kind" = runner ]; then dest="0600 root:root, read by systemd for the runner"; else dest="0640 root:$SERVICE_ACCOUNT"; fi
  left="${DROPPED_BY[$kind]:-}"
  plan "copy $f ($dest)${left:+ — leaving out: $left}"
done
say "  never copied: $ENV_NAME.admin.env, $ENV_NAME.owner.env, $ENV_NAME.$OVERLAY.owner.env"
[ -n "$CA_SOURCE" ] && plan "copy the CA certificate named by NODE_EXTRA_CA_CERTS → $ETC/ca.crt"
for c in "${!CERTS[@]}"; do plan "copy the certificate named by its *_CERT_PATH key → $ETC/$c (0640 root:$SERVICE_ACCOUNT)"; done
if [ "$MODE" = apply ] || [ "$MODE" = dry-run ]; then
  say "4. State (created once; systemd manages it afterwards — StateDirectory and $TMPFILES)"
  if [ -e "$P$VARLIB" ]; then
    say "  ✓ $VARLIB exists — left alone (nothing re-imported)"
  else
    n=0
    [ -d "$ARTIFACTS_SOURCE" ] && n="$(find "$ARTIFACTS_SOURCE" -type f | wc -l | tr -d ' ')"
    plan "create $VARLIB/{artifacts,home} ($SERVICE_ACCOUNT, 0750) with $n report file(s) imported from $ARTIFACTS_SOURCE"
  fi
  plan "create $RUNNER_STATE ($RUNNER_ACCOUNT, 0750) through systemd-tmpfiles"
fi
say "5. System units ($UNIT_DIR, sandboxed)"
for s in "${SERVICES[@]}"; do
  if [ "$s" = runner ]; then acct="$RUNNER_ACCOUNT"; else acct="$SERVICE_ACCOUNT"; fi
  carried_names="$(printf '%s' "${CARRIED[$s]}" | cut -d= -f1 | tr '\n' ' ')"
  [ -n "$CA_SOURCE" ] && [ "$s" != runner ] && carried_names+="NODE_EXTRA_CA_CERTS "
  plan "install adminforge-$s.service (User=$acct)${carried_names:+ + 10-carried.conf: ${carried_names% }}"
  [ -n "${NOT_CARRIED[$s]}" ] && say "    not carried from the user unit: ${NOT_CARRIED[$s]% } — set it in $UNIT_DIR/adminforge-$s.service.d/override.conf if still needed"
done
say "  unchanged: adminforge-proxy (Caddy) and adminforge-backup stay user units of $OWNER (the backup needs Docker)."
if [ "$FIREWALL" = 1 ]; then
  say "6. Loopback firewall (nftables)"
  if [ "$MODE" = dry-run ]; then render_firewall | sed 's/^/    /'; else plan "load $ETC/loopback.nft"; fi
fi

if [ ${#PROBLEMS[@]} -gt 0 ]; then
  say ""
  for p in "${PROBLEMS[@]}"; do say "✗ $p"; done
  say "Nothing was changed."
  exit 1
fi
if [ "$MODE" = dry-run ]; then
  say ""
  say "Dry run: nothing was changed. Run it with sudo and --apply$([ "$FIREWALL" = 1 ] && printf ' --firewall')."
  exit 0
fi

# ── Changes ─────────────────────────────────────────────────────────────────────────────────────────────────────
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# own <owner:group> <mode> <path…>: ownership needs root; the test suite (AF_SA_PREFIX) only sets modes.
own() {
  local who="$1" mode="$2"
  shift 2
  [ "$TEST" = 1 ] || chown -h "$who" "$@"
  chmod "$mode" "$@"
}
RSYNC_OWN=()
[ "$TEST" = 1 ] || RSYNC_OWN=(--chown=root:root)

if [ "$MODE" = apply ] && [ "$TEST" = 0 ]; then
  for a in "$SERVICE_ACCOUNT" "$RUNNER_ACCOUNT"; do
    [ "${ACCOUNT_STATE[$a]}" = new ] || continue
    home="$VARLIB"
    [ "$a" = "$RUNNER_ACCOUNT" ] && home="$RUNNER_STATE"
    useradd --system --user-group --home-dir "$home" --no-create-home --shell /usr/sbin/nologin "$a"
  done
  usermod -aG "$SERVICE_ACCOUNT" "$OWNER"
fi

if [ "$NEED_CHECKOUT" = 1 ]; then
  mkdir -p "$P$OPT/runtime" "$P$OPT/releases"
  own root:root 0755 "$P$OPT" "$P$OPT/runtime" "$P$OPT/releases"
  as_owner cat -- "$NODE_BIN" >"$STAGE/node"
  install -D -m 0755 "$STAGE/node" "$P$OPT/runtime/node-$NODE_VERSION/bin/node"
  ln -sfn "node-$NODE_VERSION" "$P$OPT/runtime/node.tmp" && mv -Tf "$P$OPT/runtime/node.tmp" "$P$OPT/runtime/node"
  if [ -n "$PWSH_DIR" ]; then
    rsync -a --delete --safe-links "${RSYNC_OWN[@]}" --chmod=Da+rx,Dgo-w,Fa+r,Fgo-w "$PWSH_DIR/" \
      "$P$OPT/runtime/powershell-$PWSH_VERSION/"
    ln -sfn "powershell-$PWSH_VERSION" "$P$OPT/runtime/powershell.tmp" &&
      mv -Tf "$P$OPT/runtime/powershell.tmp" "$P$OPT/runtime/powershell"
  fi
  # A new release directory every time (re-releasing a commit never touches the live tree), hard-linked to the
  # current release where files are unchanged, owned and moded as it is copied (no window).
  # Named <sha>.<seconds>, the seconds strictly after the newest release so the order never ties (clock changes too).
  stamp="$(date +%s)"
  newest="$(releases_newest_first | head -1 | cut -d. -f2)"
  if [ -n "$newest" ] && [ "$stamp" -le "$newest" ]; then stamp=$((newest + 1)); fi
  REL="$SHA.$stamp"
  LINK_DEST=()
  cur="$(current_release)"
  [ -n "$cur" ] && [ -d "$P$OPT/releases/$cur" ] && LINK_DEST=(--link-dest="../$cur")
  rsync -a --safe-links "${RSYNC_OWN[@]}" --chmod=Da+rx,Dgo-w,Fa+r,Fgo-w "${LINK_DEST[@]}" "${RSYNC_EXCLUDES[@]}" \
    "$CHECKOUT/" "$P$OPT/releases/$REL/"
  say "  ✓ release $REL in $OPT/releases"
  # The units come from the release being installed (root-owned), not from the copy of this script that is running.
  [ -f "$P$OPT/releases/$REL/portal/deploy/systemd/system/hardening.conf" ] &&
    TEMPLATES="$P$OPT/releases/$REL/portal/deploy/systemd/system"
fi

# Configuration.
mkdir -p "$P$ETC"
own "root:$SERVICE_ACCOUNT" 0750 "$P$ETC"
filter_env "$CONFIG_DIR/$BASE_FILE" base "$STAGE/base"
filter_env "$CONFIG_DIR/$OVERLAY_FILE" overlay "$STAGE/overlay"
filter_env "$CONFIG_DIR/$RUNNER_FILE" runner "$STAGE/runner"
[ ${#PROBLEMS[@]} = 0 ] || {
  for p in "${PROBLEMS[@]}"; do say "✗ $p"; done
  exit 1
}
install -m 0640 "$STAGE/base" "$P$ETC/$BASE_FILE"
install -m 0640 "$STAGE/overlay" "$P$ETC/$OVERLAY_FILE"
install -m 0600 "$STAGE/runner" "$P$ETC/$RUNNER_FILE"
own "root:$SERVICE_ACCOUNT" 0640 "$P$ETC/$BASE_FILE" "$P$ETC/$OVERLAY_FILE"
own root:root 0600 "$P$ETC/$RUNNER_FILE"
if [ -n "$CA_SOURCE" ]; then
  as_owner cat -- "$CA_SOURCE" >"$STAGE/ca.crt"
  install -m 0644 "$STAGE/ca.crt" "$P$ETC/ca.crt"
  own root:root 0644 "$P$ETC/ca.crt"
fi
for c in "${!CERTS[@]}"; do
  as_owner cat -- "${CERTS[$c]}" >"$STAGE/$c"
  install -m 0640 "$STAGE/$c" "$P$ETC/$c"
  own "root:$SERVICE_ACCOUNT" 0640 "$P$ETC/$c"
done
say "  ✓ configuration in $ETC"

# State: imported once into a fresh, root-created directory that is then renamed into place; never touched again.
if [ "$MODE" = apply ] && [ ! -e "$P$VARLIB" ]; then
  mkdir -p "$(dirname "$P$VARLIB")"
  import="$(mktemp -d "$(dirname "$P$VARLIB")/.adminforge-import.XXXXXX")"
  mkdir "$import/artifacts" "$import/home"
  if [ -d "$ARTIFACTS_SOURCE" ]; then
    owner_flag=()
    [ "$TEST" = 1 ] || owner_flag=(--chown="$SERVICE_ACCOUNT:$SERVICE_ACCOUNT")
    rsync -r --no-links --times "${owner_flag[@]}" --chmod=D0750,F0640 "$ARTIFACTS_SOURCE/" "$import/artifacts/"
  fi
  own "$SERVICE_ACCOUNT:$SERVICE_ACCOUNT" 0750 "$import" "$import/artifacts" "$import/home"
  mv -T "$import" "$P$VARLIB"
  say "  ✓ $VARLIB created"
fi

# Units, carried settings and tmpfiles.
for s in "${SERVICES[@]}"; do
  render "$s" >"$STAGE/adminforge-$s.service"
  install -D -m 0644 "$STAGE/adminforge-$s.service" "$P$UNIT_DIR/adminforge-$s.service"
  {
    say "# Carried from $OWNER's user unit by install-service-account.sh (rewritten on every --apply/--release)."
    say "[Service]"
    printf '%s' "${CARRIED[$s]}" | sed -E 's/^/Environment=/'
    [ -n "$CA_SOURCE" ] && [ "$s" != runner ] && say "Environment=NODE_EXTRA_CA_CERTS=$ETC/ca.crt"
  } >"$STAGE/10-carried.conf"
  install -D -m 0644 "$STAGE/10-carried.conf" "$P$UNIT_DIR/adminforge-$s.service.d/10-carried.conf"
done
render_tmpfiles >"$STAGE/tmpfiles"
install -D -m 0644 "$STAGE/tmpfiles" "$P$TMPFILES"
[ "$TEST" = 1 ] || systemd-tmpfiles --create "$TMPFILES"
say "  ✓ system units in $UNIT_DIR, $TMPFILES"

if [ "$FIREWALL" = 1 ]; then
  render_firewall >"$STAGE/loopback.nft"
  install -m 0644 "$STAGE/loopback.nft" "$P$ETC/loopback.nft"
  if [ "$TEST" = 0 ]; then
    nft -f "$ETC/loopback.nft"
    say "  ✓ loopback firewall loaded — make it survive a reboot: include \"$ETC/loopback.nft\" in /etc/nftables.conf and enable nftables.service"
  fi
fi

if [ "$NEED_CHECKOUT" = 1 ]; then
  prev="$(current_release)"
  switch_current "$REL"
  say "  ✓ $OPT/current → releases/$REL"
  # Keep the newest releases by their time (current and the one before it always stay).
  mapfile -t all < <(releases_newest_first)
  i=0
  for r in "${all[@]}"; do
    i=$((i + 1))
    [ "$i" -le "$KEEP_RELEASES" ] && continue
    [ "$r" = "$REL" ] || [ "$r" = "$prev" ] && continue
    rm -rf -- "$P$OPT/releases/$r"
    say "  ✓ removed old release $r"
  done
fi

if [ "$MODE" = release ] || [ "$MODE" = sync-config ]; then
  restart_services
  say "Check: curl -fsS http://127.0.0.1:$API_PORT/healthz && curl -fsS http://127.0.0.1:$API_PORT/readyz"
  [ "$MODE" = release ] && [ -n "${prev:-}" ] && say "Bad release? sudo $OPT/current/portal/deploy/install-service-account.sh --rollback   # back to $prev"
  exit 0
fi

OWNER_UID="$(id -u "$OWNER")"
cat <<EOF

Installed. Nothing runs as $SERVICE_ACCOUNT yet. Switch over (the API's port is free only once the user units stop):

  sudo -u $OWNER XDG_RUNTIME_DIR=/run/user/$OWNER_UID systemctl --user disable --now $UNITS_LIST
  sudo systemctl daemon-reload
  sudo systemctl enable --now $UNITS_LIST

Verify:
  systemctl status $UNITS_LIST --no-pager
  curl -fsS http://127.0.0.1:$API_PORT/healthz && curl -fsS http://127.0.0.1:$API_PORT/readyz
  id $SERVICE_ACCOUNT; id $RUNNER_ACCOUNT    # their own group only — no docker, sudo, adm, lxd
  docker exec adminforge-dev-postgres-1 psql -U adminforge -d postgres -Atc \\
    "select usename, application_name from pg_stat_activity where datname = 'adminforge'"   # adminforge_app only
  journalctl -u adminforge-api -u adminforge-scheduler -u adminforge-worker -u adminforge-runner -p warning --since -5min
  (log out and back in once: $OWNER's backup reads the report files through the $SERVICE_ACCOUNT group)

Rollback (the user units run whatever is built in $CHECKOUT — build the release's commit first):
  sudo systemctl disable --now $UNITS_LIST
  sudo rsync -a $VARLIB/artifacts/ $ARTIFACTS_SOURCE/ && sudo chown -R $OWNER: $ARTIFACTS_SOURCE
  sudo -u $OWNER XDG_RUNTIME_DIR=/run/user/$OWNER_UID systemctl --user enable --now $UNITS_LIST
  sudo rm -rf $ETC          # the copies of the configuration (the originals stay in $CONFIG_DIR)

Later deploys (build, migrate and publish as $OWNER first):
  sudo $OPT/current/portal/deploy/install-service-account.sh --release --checkout $CHECKOUT
After editing $CONFIG_DIR or rotating a secret:
  sudo $OPT/current/portal/deploy/install-service-account.sh --sync-config --checkout $CHECKOUT
EOF
