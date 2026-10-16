# shellcheck shell=bash
# Deploy defaults for the shell scripts in portal/deploy. Source it (bash), then call af_load_deploy_defaults:
#
#   . "$DEPLOY_DIR/lib/defaults.sh" && af_load_deploy_defaults
#
# Exports each KEY=value of portal/deploy/defaults.env unless the environment already sets
# that key to a non-empty value, so `AF_PG_CONTAINER=other script.sh` still wins. Comments, blank lines and anything
# that isn't an upper-case KEY=value are skipped; values are taken literally (no quotes, no expansion). Prints nothing.

af_load_deploy_defaults() {
  local file key value
  file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/defaults.env"
  [ -r "$file" ] || { echo "✗ deploy defaults not found: $file" >&2; return 1; }
  while IFS='=' read -r key value || [ -n "$key" ]; do
    [[ "$key" =~ ^[[:space:]]*(#|$) ]] && continue
    # Only the deploy constants: anything else (DOCKER_HOST, BASH_ENV, …) would reach the backup's child processes.
    [[ "$key" =~ ^AF_PG_[A-Z0-9_]+$ ]] || { echo "✗ $file: unexpected key ${key%%[^A-Za-z0-9_]*} (only AF_PG_* belongs here)" >&2; return 1; }
    [ -n "${!key:-}" ] || export "$key=$value"
  done <"$file"
}
