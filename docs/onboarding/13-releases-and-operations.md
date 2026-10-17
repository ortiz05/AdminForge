# 13. Releases and operations

How a merged change reaches the running AdminForge, who does it, and what contributors never do on the host.
The procedures themselves are in [`docs/operations.md`](../operations.md) and
[`portal/deploy/README.md`](../../portal/deploy/README.md).

## Merging is not deploying

A merge to `main` changes nothing that is running. Each kind of change goes live through its own deliberate step, done
by a **code owner** (or, for configuration, whoever administers the host):

| What changed               | How it goes live                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content (`portal/content`) | `git fetch` and a clean checkout of `origin/main`, then `ADMINFORGE_ENV_OVERLAY=host pnpm adminforge publish` (try `--dry-run` first); services pick it up in seconds (`NOTIFY`) |
| Code (apps, packages)      | An upgrade: install with the frozen lockfile, build, migrate, publish, restart the units ([operations → Upgrade](../operations.md#upgrade))                                      |
| Permissions                | `pnpm adminforge validate --scopes`, then `pnpm adminforge provision entra` (changes the tenant)                                                                                 |
| Runner modules             | `pnpm --filter @adminforge/runner modules:install` when `portal/apps/runner/modules.lock.json` changed                                                                           |
| Configuration keys         | Set in the host's env file outside the repository (documented in `config/example.env`), then restart the affected units                                                          |

A full deploy of a reviewed commit, in order ([operations → Upgrade](../operations.md#upgrade) has the commands):
push to `origin/main` → `git pull` on the host → `pnpm install --frozen-lockfile` → `pnpm build` → migrate the dev
**and** the services' database (`ADMINFORGE_ENV_OVERLAY=host`) → `publish --dry-run`, read it, then `publish` →
restart the four units → `/readyz` 200 on the loopback and LAN addresses, no new errors in the journal. Retired
definitions show as `− retire` in the dry run; check that's what the change meant.

The CLI talks to your **dev** environment unless told otherwise: anything aimed at the host's database needs
`ADMINFORGE_ENV_OVERLAY=host`. `publish` re-runs `validate` and the playbook tests and refuses content that isn't
committed and on `origin/main` as last fetched — it never fetches for you. `--allow-unreviewed` exists for emergencies
only; it is audited and must be followed by the reviewed change.

## What your PR must tell the person deploying it

In the PR's **Risk and rollout** section (and the commit body):

- a **migration** (and that it only adds — migrations must be safe to apply before the old processes restart);
- **new configuration keys** and their safe defaults;
- **new permissions** (Graph/ARM scopes, app roles) and whether provisioning must run;
- whether content must be **published**, the runner's modules reinstalled, or a unit restarted;
- anything that switches something off by design (e.g. a new version of a playbook a write-capable schedule runs needs
  a second approval again);
- how to undo it.

## Versions and releases

- The changelog's `## Unreleased` collects entries as PRs merge. A code owner cuts a release by renaming it to
  `## <version> — <date>` (Semantic Versioning: minor for features, patch for fixes, major for breaking changes) and
  tagging that commit `v<version>`. (Releases so far were recorded only in the changelog; tag from the next release on.)
- Deploy from a reviewed commit — ideally a tag — in a checkout the services can't write to, never from a working copy
  someone is editing: the API serves the web app from that checkout's `portal/apps/web/dist` on every request (a build
  is live at once), and the units run the `dist/` they find in their working directory (live at the next restart).
- **Rolling back code:** check out the previous release, `pnpm install --frozen-lockfile`, build, reinstall runner
  modules if the lock file differs, restart. Migrations only add, so older code runs on the newer schema.
- **Rolling back content:** published versions only move forward — an older version can't be republished. Revert the
  change in git, bump the version, review, and publish; or retire the definition (`status: retired`).

## Production safety rails you should know about

- **Emergency stop:** Admin → Settings → Emergency stop pauses all changes and/or all automation, audited; Approvers and
  Admins can pause, only Admins resume ([operations → Emergency](../operations.md#emergency-switch-adminforge-off)).
- **Audit:** every state change is in a hash-chained, append-only log; `pnpm adminforge audit verify` checks the chain
  (with `ADMINFORGE_ENV_OVERLAY=host` for the host's database).
- **Self-monitoring:** `/readyz` reports degraded when the worker or scheduler goes quiet; schedule failures alert the
  configured recipients.

## What contributors never do

- Run `pnpm dev`, tests or builds against the **host services' database** or env overlay.
- Run `pnpm build` (or the root `pnpm typecheck`) inside the checkout the services run from — the web app it builds
  is served to everyone immediately, and the server code goes live at the next restart. That includes building to
  run `pnpm test:e2e:prod`: do that in your own checkout.
- Restart, stop or reconfigure the host's units, edit its env files or Caddyfile, prune its Docker images, or touch its
  backups — unless a code owner asked for that specific action.
- Run `pnpm adminforge provision entra` or `publish` against a shared environment on your own initiative.
- Read, copy or print the host's configuration files. `pnpm adminforge env check` prints names and states only — use
  that.

If you think production needs any of these, ask a code owner and say why; include the run or error **reference**.

## You're done

That's the path. Keep the [checklists](checklists.md) open while you work, use the [glossary](glossary.md) when a term
is unfamiliar, and improve this guide in the same PR whenever it let you down.
