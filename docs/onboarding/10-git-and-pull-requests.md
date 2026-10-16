# 10. Git and pull requests

One history everyone can read: short-lived branches, Conventional Commits with our types and scopes, small reviewed
pull requests, squash merges. Commit messages are checked by the `commit-msg` hook and pull request titles by the
`pr-title` workflow, both with `tooling/git/commit-message.mjs`.

## Branches

- `main` is always releasable. Nobody pushes to it directly — every change arrives through a pull request with at least
  one approval from someone other than the author. If branch protection isn't switched on for the repository, behave
  as if it were.
- Work on a short-lived branch named `<type>/<short-topic>`: `feat/reports-catalogue`, `fix/schedule-cron-limit`,
  `docs/onboarding`. Keep it alive for days, not weeks.
- Rebase on `main` to stay current (`git pull --rebase origin main`); don't merge `main` into your branch.
- Never rewrite `main`'s history, and never force-push someone else's branch.

## Commit messages

```text
<type>(<scope>[,<scope>]): <summary>          ← header, ≤ 100 characters (aim for 72)
                                              ← blank line
<body: why the change was needed and what changes for people; wrap at ~100 columns>
                                              ← blank line
<trailers: Refs: …, Co-Authored-By: …, BREAKING CHANGE: …>
```

From the repository root, `git config commit.template docs/onboarding/templates/commit-message.txt` puts this reminder
in your editor (unset it if you check out an older branch without the file).

### Types

| Type       | Use it for                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------- |
| `feat`     | Something new a user, operator or content author can do                                     |
| `fix`      | Something that behaved wrongly now behaves rightly (including security fixes)               |
| `docs`     | Documentation only                                                                          |
| `test`     | Tests only (new coverage, a flaky test fixed, baselines)                                    |
| `refactor` | Code changes that don't change behaviour                                                    |
| `perf`     | Faster or lighter, same behaviour                                                           |
| `chore`    | Housekeeping: formatting, renames, dependency bumps (`chore(deps): …`, Dependabot's prefix) |
| `ci`       | `.github/workflows`, CI helpers (Dependabot's Actions updates use `ci(deps): …`)            |
| `build`    | Build tooling, packaging, bundling                                                          |
| `revert`   | Reverting an earlier change                                                                 |

`git revert` writes `Revert "<header>"`, and GitHub's Revert button uses the same as the pull request title; both pass
the checks as long as the reverted header is valid.

### Scopes

Optional; one or more, comma-separated with no spaces (`fix(security,ux): …`). Use the area a reader would look for:

- **Apps and packages:** `api`, `web`, `scheduler`, `runner`, `cli`, `ui`, `widgets`, `engine`, `connectors`,
  `schemas`, `expressions`, `design-tokens`, `config`
- **Content and features:** `content`, `news`, `reports`, `schedules`, `runs`, `query`, `audit`
- **Cross-cutting:** `auth`, `security`, `ux`, `deploy`, `dev`, `deps`, `docs`, `plan`, `tests`, `e2e`, `live`

A new area needs a new scope: add it to `SCOPES` in `tooling/git/commit-message.mjs`, to this list and to
`templates/commit-message.txt` in the same PR.

### Summary and body

- The summary says what changes, without a full stop: `fix(scheduler): skip deleted portal schedules`,
  `feat(reports): schedule a report from the catalogue`. Start in lower case (reviewers check this; the hook doesn't).
  An imperative verb or a short outcome phrase are both fine; "updates", "changes", "wip" and file names are not.
- The body explains **why** and what a person will notice. Mention migrations, new configuration keys, new
  permissions and anything an operator must do. Wrap at about 100 columns.
- A breaking change gets `!` after the type/scope (`refactor(engine)!: …`) and a `BREAKING CHANGE:` trailer saying
  what breaks and how to adapt.
- Trailers: `Refs: <issue or backlog item>`; `Co-Authored-By: Name <email>` for pairing — including Claude Code when
  it wrote a substantial part of the change.
- No tenant names, ids, UPNs or customer details in messages — git history is forever.

### Examples

```text
✓ feat(reports): reports catalogue with in-app report schedules
✓ fix(security,ux): login CSRF binding and readable sign-in errors
✓ test(api): purge test used the database clock with a fixed date
✓ docs: engineer onboarding guide

✗ Updated stuff                         (no type; says nothing)
✗ feature(web): add page                (unknown type)
✗ feat(Reports): Add catalogue.         (unknown scope — scopes are lower case; full stop)
✗ fix(api, web): …                      (space in the scope list)
```

### Granularity

- One logical change per commit, and each commit should build and pass its tests — reviewers and `git bisect` rely on
  it.
- Don't mix formatting or renames with behaviour changes; commit them separately (`chore: …`).
- Generated files are committed only when the repo already does (lockfile, screenshot baselines, migrations). Never
  commit build output, source maps, caches, `test-results/` or anything from `~/.config/adminforge`.
- Autosquash is welcome while a PR is open (`git commit --fixup`, `git rebase -i --autosquash`); the hook lets
  `fixup!`/`squash!`/`amend!` commits through, and the squash merge cleans up anyway.

## Hooks

`pnpm install` points git at `.githooks/`:

- `pre-commit` — the guard tests (secrets, tenant values, design tokens).
- `commit-msg` — the message format above.

If a hook fails, fix the cause. **Never use `--no-verify`**, and never disable `core.hooksPath`. CI repeats most checks
— but not all: CI has no tenant configuration, so the check of your tenant's values against what you commit runs
**only** in your `pre-commit` hook, and no guard can read images. A bypass can put tenant data in git history that no
later check catches.

## Pull requests

### Size and scope

- One topic per PR, small enough to review properly in one sitting: aim for under ~400 changed lines of hand-written
  code (fixtures, screenshots and lockfiles don't count). Split large work into steps that each ship complete.
- A PR ships complete: content/code + tests + fixtures + docs + changelog ([Documentation](11-documentation.md)).
- Open a **draft** early for anything non-trivial, so design questions surface before the code is done.

### Title and description

- The **title is a commit header**: with squash merging it becomes the commit on `main`. The `pr-title` workflow checks
  it whenever the PR is opened, updated or retitled.
- Fill in the template (`.github/pull_request_template.md`): what and why, how it was checked (commands and results;
  screenshots in steel and daylight for UI), the checklist, risk and rollout (migration, config key, publish, restart,
  provisioning), and anything left for later (with a `docs/backlog.md` entry).
- Live-tenant evidence is counts and statuses, never names, UPNs or ids.

### Before requesting review

1. Rebase on `main`; `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm guard` and the projects you touched pass;
   content: `pnpm adminforge validate` and `pnpm adminforge test`.
2. Run the reviewer agents that apply — `content-reviewer`, `security-reviewer`, `design-reviewer` — **before you
   commit** (they review uncommitted changes) or point them at `origin/main...HEAD` ([Claude Code](12-claude-code.md)).
   Fix what they find or explain in the PR why not.
3. Read your own diff top to bottom as if you were the reviewer.

### Reviewing

- Review against the [reviewer checklist](checklists.md#reviewing-a-pull-request): correctness, the non-negotiables,
  tests, docs, naming and fit with the surrounding code.
- Label comments so the author knows what blocks: **blocking**, **suggestion**, **nit**, **question**.
- Approve only what you understood. The author never approves their own PR. Two-person review is the control the whole
  security model leans on.
- Code owners: `.github/CODEOWNERS` lists the security-sensitive paths. GitHub requires a code owner's approval on them
  only once branch protection with "Require review from Code Owners" is on, and today one person owns every path — so
  that person's own PRs need another engineer's review by agreement until more owners are added (a known gap in
  `SECURITY.md`). Add owners to CODEOWNERS as the team grows.
- Respond within one working day; if a PR is too big to review, say so and ask for a split.

### Merging

- **Squash and merge** with the PR title as the header and a short body summarising the change (edit GitHub's default
  list of commit titles into prose). Delete the branch afterwards. The repository should allow squash merging only,
  with the PR title as the default commit message.
- CI and `pr-title` must be green. Don't merge your own PR without the required approval, even when you have the
  rights.
- Merging doesn't deploy anything: content reaches the services with `adminforge publish`, code with an upgrade — both
  done by a code owner ([Releases and operations](13-releases-and-operations.md)).

## Read next

[Documentation](11-documentation.md).
