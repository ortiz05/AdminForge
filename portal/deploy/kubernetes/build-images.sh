#!/usr/bin/env bash
# Builds the two images of the AdminForge pod (ADR-017) from this checkout's HEAD commit — the app (API + web + CLI +
# content) and the PowerShell runner — tagged with the commit, and records in the app image whether that commit is
# reviewed (merged to origin/main as last fetched): `adminforge publish` in the pod accepts that record instead of git
# (portal/tools/cli/src/content/review-state.ts). An image built from unreviewed content still works; publishing
# from it then needs --allow-unreviewed, which the audit log records.
#
#   portal/deploy/kubernetes/build-images.sh [--registry <host/path>] [--push]
#
# Tags: <registry>/adminforge:<commit> and <registry>/adminforge-runner:<commit> (registry default: none, local
# names). --push pushes both. Put the tags (or, better, the pushed digests) in your overlay's `images:`.
# Prints image names and the review state only — never configuration (none is baked in).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REGISTRY=""
PUSH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --registry) REGISTRY="${2:?--registry needs a value}/"; shift 2 ;;
    --push) PUSH=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "✗ unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$ROOT"
COMMIT="$(git rev-parse --short=12 HEAD)"
# The images are built from the commit itself (`git archive HEAD`): uncommitted, untracked and git-ignored files never
# reach them, so BUILD.json's commit is exactly what the image holds.
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "⚠ uncommitted changes are not in the images: they are built from $COMMIT as committed." >&2
fi
REVIEWED=true
if ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  REVIEWED=false
  echo "⚠ HEAD ($COMMIT) is not on origin/main (git fetch?): publishing from this image will need --allow-unreviewed." >&2
fi

APP="${REGISTRY}adminforge:${COMMIT}"
RUNNER="${REGISTRY}adminforge-runner:${COMMIT}"
git archive --format=tar HEAD | docker build -f portal/deploy/kubernetes/Dockerfile \
  --build-arg "ADMINFORGE_COMMIT=$COMMIT" --build-arg "ADMINFORGE_REVIEWED=$REVIEWED" \
  -t "$APP" -
git archive --format=tar HEAD | docker build -f portal/apps/runner/Dockerfile -t "$RUNNER" -
echo "✓ built $APP (content reviewed: $REVIEWED) and $RUNNER"
if [ "$PUSH" = 1 ]; then
  docker push "$APP"
  docker push "$RUNNER"
  echo "✓ pushed; pin the digests in your overlay (docker inspect --format '{{index .RepoDigests 0}}' <image>)"
fi
