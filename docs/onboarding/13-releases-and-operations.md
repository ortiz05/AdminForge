# 13. Releases and operations

How a merged change reaches the running AdminForge, who does it, and what contributors never do to the deployment.
The procedures themselves are in [`portal/deploy/kubernetes/README.md`](../../portal/deploy/kubernetes/README.md) and
[`docs/operations.md`](../operations.md).

## Merging is not deploying

A merge to `main` changes nothing that is running. AdminForge runs as one Kubernetes pod from two images (ADR-017),
and each kind of change goes live through its own deliberate step, done by a **code owner** (or, for configuration,
whoever administers the cluster):

| What changed               | How it goes live                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content (`portal/content`) | Content ships in the app image: build and deploy it (below), then `kubectl -n adminforge exec deploy/adminforge -c api -- adminforge publish` (try `--dry-run` first); no restart  |
| Code (apps, packages)      | An upgrade: build and push the images, put the new tags or digests in the overlay, `kubectl apply -k` ([Kubernetes → Upgrade](../../portal/deploy/kubernetes/README.md#5-upgrade)) |
| Permissions                | `pnpm adminforge validate --scopes`, then `pnpm adminforge provision entra` (changes the tenant)                                                                                   |
| Runner modules             | Installed into the runner image from `portal/apps/runner/modules.lock.json` when it is built: rebuild and deploy                                                                   |
| Configuration keys         | Set in the `adminforge-env` Secret, made from the env file outside the repository (keys documented in `config/example.env`), then `kubectl rollout restart deploy/adminforge`      |

A full deploy of a reviewed commit, in order ([Kubernetes → Upgrade](../../portal/deploy/kubernetes/README.md#5-upgrade)
has the commands): push to `origin/main` → `git fetch` and check out that commit → `build-images.sh --registry … --push`
(it records whether the content is reviewed) → a volume snapshot or `adminforge db backup` when the release changes the
schema → the new tags or digests in the overlay → `kubectl apply -k` (`Recreate` stops the old pod; the new one
migrates the database and starts) → `adminforge publish --dry-run` in the pod, read it, then `publish` → `/readyz`
answers `ok` for `db`, `worker` and `scheduler`, no new errors in the container log. Retired definitions show as
`− retire` in the dry run; check that's what the change meant.

On your machine the CLI talks to your **dev** database file. The cluster's database is on a volume only the pod can
mount, so anything aimed at it runs in the pod with `kubectl exec`. `publish` re-runs `validate` and the playbook tests
and refuses unreviewed content — in the pod, an image `build-images.sh` didn't record as built from a commit merged to
`origin/main` (as last fetched) with clean content. `--allow-unreviewed` exists for emergencies only; it is audited and must be followed
by the reviewed change.

An installation that ran a Postgres release moves its data once with `adminforge db import-postgres`
([Kubernetes → Moving the data](../../portal/deploy/kubernetes/README.md#moving-the-data-from-the-postgres-host-once)).
A service that runs from a checkout — an interim installation on a single machine, say — serves that checkout's build:
never build, install or run `pnpm dev` there ([CLAUDE.md › Commands](../../CLAUDE.md#commands)), and leave it and its
services alone unless a code owner asks.

## What your PR must tell the person deploying it

In the PR's **Risk and rollout** section (and the commit body):

- a **migration** (and that it only adds — the API applies it at start, and a rollback runs the previous image on the
  newer schema);
- **new configuration keys** and their safe defaults;
- **new permissions** (Graph/ARM scopes, app roles) and whether provisioning must run;
- whether content must be **published**, the runner image rebuilt, or the pod restarted;
- anything that switches something off by design (e.g. a new version of a playbook a write-capable schedule runs needs
  a second approval again);
- how to undo it.

## Versions and releases

- The changelog's `## Unreleased` collects entries as PRs merge. A code owner cuts a release by renaming it to
  `## <version> — <date>` (Semantic Versioning: minor for features, patch for fixes, major for breaking changes) and
  tagging that commit `v<version>`. (Releases so far were recorded only in the changelog; tag from the next release on.)
- Build the images from a reviewed commit — ideally a tag — never from a working copy someone is editing: the app image
  carries the built web app, the server code and the content, so what is in the image is what runs and what
  `publish` can publish. `build-images.sh` builds from `git archive`, so your working tree's `dist/` never reaches an
  image.
- **Rolling back code:** put the previous release's image tags or digests back in the overlay and `kubectl apply -k`.
  Migrations only add, so older code runs on the newer schema.
- **Rolling back content:** published versions only move forward — an older version can't be republished. Revert the
  change in git, bump the version, review, and publish; or retire the definition (`status: retired`).

## Production safety rails you should know about

- **Emergency stop:** Admin → Settings → Emergency stop pauses all changes and/or all automation, audited; Approvers and
  Admins can pause, only Admins resume ([operations → Emergency](../operations.md#emergency-switch-adminforge-off)).
- **Audit:** every state change is in a hash-chained, append-only log; `adminforge audit verify` checks the chain (for
  the cluster, in the pod: `kubectl -n adminforge exec deploy/adminforge -c api -- adminforge audit verify`).
- **Self-monitoring:** `/readyz` reports degraded when the run worker or the scheduler (both in the API process) goes
  quiet; schedule failures alert the configured recipients.

## What contributors never do

- Point `DATABASE_PATH` (for `pnpm dev`, tests or the CLI) at a **deployment's** database file, or copy one to your
  machine.
- `kubectl exec` into the pod, restart, scale or re-apply the Deployment, change its Secrets or overlay, push images,
  or touch its volume, snapshots or backups — unless a code owner asked for that specific action.
- Run `pnpm adminforge provision entra` or `publish` against a shared environment on your own initiative.
- Read, copy or print the installation's configuration (the env file, the `adminforge-env` Secret).
  `adminforge env check` prints names and states only — use that.

If you think production needs any of these, ask a code owner and say why; include the run or error **reference**.

## You're done

That's the path. Keep the [checklists](checklists.md) open while you work, use the [glossary](glossary.md) when a term
is unfamiliar, and improve this guide in the same PR whenever it let you down.
