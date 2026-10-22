#!/usr/bin/env bash
# Builds the two images of the AdminForge pod (ADR-017) from this checkout's HEAD commit — the app (API + web + CLI +
# content) and the PowerShell runner — tagged with the commit, and records in the app image whether that commit is
# reviewed: merged to origin's main as fetched now (`git fetch origin main`, read-only — it never pushes or changes a
# branch), with the fetched commit and origin's URL (no credentials). `adminforge publish` in the pod accepts that
# record instead of git (portal/tools/cli/src/content/review-state.ts). An image built from unreviewed content still
# works; publishing from it then needs --allow-unreviewed, which the audit log records. If origin can't be fetched,
# nothing is built.
#
#   portal/deploy/kubernetes/build-images.sh [--registry <host/path>] [--push] [--dry-run]
#
# Tags: <registry>/adminforge:<commit> and <registry>/adminforge-runner:<commit> (registry default: none, local
# names). --push pushes both. Put the tags (or, better, the pushed digests) in your overlay's `images:`. --dry-run
# fetches and prints the build record (BUILD.json) without building anything.
# Prints image names and the review state only — never configuration (none is baked in).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REGISTRY=""
PUSH=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --registry) REGISTRY="${2:?--registry needs a value}/"; shift 2 ;;
    --push) PUSH=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "✗ unknown option: $1" >&2; exit 2 ;;
  esac
done

# origin's URL for the record: user name, password or token, query and fragment removed; empty when it has characters
# a remote URL never needs (the same rules as safeRemote in review-state.ts).
safe_remote() {
  local url="$1"
  case "$url" in
    [A-Za-z]*://*) url="$(printf '%s' "$url" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@#\1#; s#[?#].*$##')" ;;
    *) url="$(printf '%s' "$url" | sed -E 's#^[^/]*@##')" ;;
  esac
  case "$url" in
    *[[:space:]]*|*[[:cntrl:]]*|*\"*|*\'*|*\\*) url="" ;;
  esac
  [ "${#url}" -le 500 ] || url=""
  printf '%s' "$url"
}

cd "$ROOT"
# Local replace refs and grafts could make any commit look merged to main: the review ignores them (as publish does).
export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null GIT_TERMINAL_PROMPT=0
COMMIT="$(git rev-parse --short=12 HEAD)"
# The images are built from the commit itself (`git archive HEAD`): uncommitted, untracked and git-ignored files never
# reach them, so BUILD.json's commit is exactly what the image holds.
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "⚠ uncommitted changes are not in the images: they are built from $COMMIT as committed." >&2
fi
if ! ORIGIN_URL="$(git remote get-url origin 2>/dev/null)"; then
  echo "✗ this checkout has no origin remote: the review record needs origin's main branch." >&2
  exit 1
fi
REMOTE="$(safe_remote "$ORIGIN_URL")"
# Review against origin's main branch as it is now, never a stale or hand-set origin/main — and never a tag that
# happens to be called main (a bare `main` would prefer refs/tags/main).
if ! git fetch --quiet origin refs/heads/main; then
  echo "✗ git fetch origin main failed: the review record needs origin's main as it is now. Check the network and your access to origin, then build again." >&2
  exit 1
fi
MAIN="$(git rev-parse --verify --quiet 'FETCH_HEAD^{commit}')" || {
  echo "✗ git fetch origin main returned no commit." >&2
  exit 1
}
REVIEWED=true
if ! git merge-base --is-ancestor HEAD "$MAIN"; then
  REVIEWED=false
  echo "⚠ HEAD ($COMMIT) is not on origin/main (${MAIN:0:12}): publishing from this image will need --allow-unreviewed." >&2
fi

if [ "$DRY_RUN" = 1 ]; then
  printf '{"commit":"%s","reviewed":%s,"mainCommit":"%s","remote":"%s","contentDir":"portal/content"}\n' \
    "$COMMIT" "$REVIEWED" "$MAIN" "$REMOTE"
  exit 0
fi

APP="${REGISTRY}adminforge:${COMMIT}"
RUNNER="${REGISTRY}adminforge-runner:${COMMIT}"
git archive --format=tar HEAD | docker build -f portal/deploy/kubernetes/Dockerfile \
  --build-arg "ADMINFORGE_COMMIT=$COMMIT" --build-arg "ADMINFORGE_REVIEWED=$REVIEWED" \
  --build-arg "ADMINFORGE_MAIN_COMMIT=$MAIN" --build-arg "ADMINFORGE_REMOTE=$REMOTE" \
  -t "$APP" -
# The day: the runner's Ubuntu layer is rebuilt with that day's security updates once per day, not kept from the first
# build this machine's cache holds (portal/apps/runner/Dockerfile, the os stage).
git archive --format=tar HEAD | docker build -f portal/apps/runner/Dockerfile \
  --build-arg "UBUNTU_UPDATES=$(date -u +%Y-%m-%d)" -t "$RUNNER" -
echo "✓ built $APP (content reviewed: $REVIEWED against origin/main ${MAIN:0:12}) and $RUNNER"
if [ "$PUSH" = 1 ]; then
  docker push "$APP"
  docker push "$RUNNER"
  echo "✓ pushed; pin the digests in your overlay (docker inspect --format '{{index .RepoDigests 0}}' <image>)"
fi
