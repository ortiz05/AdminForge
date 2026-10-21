# Repository tooling

The checks that keep the repository consistent, run the same way on an engineer's machine, in git hooks, in Claude Code
and in CI. Each tool is a small Node module with a header comment saying what it does and how it's run, and has tests
under `tests/unit/tooling/` (they import the module through its `.d.mts` types).

| Tool                             | What it checks                                                           | Locally                                      | Git / Claude Code / CI                                        |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------- |
| `lint/eslint.config.js`          | TypeScript and React hooks rules; design tokens only in UI code          | `pnpm lint`                                  | CI `pnpm lint`                                                |
| `lint/design-token-patterns.mjs` | The one definition of UI code, raw colours and arbitrary Tailwind values | (used by the three checks below)             | ESLint, `tests/guards/design-tokens.test.ts`, after-edit hook |
| `git/commit-message.mjs`         | Conventional Commits header with our types and scopes                    | `node tooling/git/commit-message.mjs <file>` | `.githooks/commit-msg`; CI `pr-title.yml` (`--title`)         |
| `ci/check-bundle.mjs`            | The web app's initial JavaScript ≤ 250 KB gzip                           | `pnpm build && pnpm check:bundle`            | CI after the production build                                 |

## `lint/` — ESLint

Its own package (`@adminforge/lint`) because typescript-eslint needs TypeScript 6's classic compiler API while the
workspace uses TypeScript 7. `pnpm lint` (root) runs this package's `lint` script, which lints the whole repository
from the root (`cd ../.. && eslint --config tooling/lint/eslint.config.js .` — ESLint resolves `files` globs against
the working directory when given `--config`, so it must run from the root). One file:
`tooling/lint/node_modules/.bin/eslint --config tooling/lint/eslint.config.js <path>` from the root.

The design-token rule is enforced three times from `design-token-patterns.mjs`: ESLint on string literals and template
text in UI TypeScript, the guard test on every committable UI line (TS and CSS), and the Claude Code after-edit hook on
the file just written. `tests/unit/tooling/design-token-patterns.test.ts` runs the same samples through all three and
checks they cover the same files. Change a pattern only there, and keep the sources free of `/` (ESLint embeds them in
selector regex literals).

## `git/` — commit messages

`commit-message.mjs` exports `TYPES`, `SCOPES` and `checkCommitMessage`; run directly it checks a message file (the
`commit-msg` hook) or `--title "<text>"` (the pull-request title, which becomes the squash commit). A new scope goes into
`SCOPES`, `docs/onboarding/10-git-and-pull-requests.md` and `docs/onboarding/templates/commit-message.txt` in the same
change — `tests/unit/tooling/commit-scopes-sync.test.ts` fails otherwise.

## `ci/` — CI helpers

`check-bundle.mjs [distDir] [budgetKB]` measures the gzip size of the scripts `index.html` loads up front (entry module,
modulepreloads, classic scripts — not lazy chunks) and fails over the budget the web guide sets
(`docs/onboarding/07-web-guide.md`). Defaults: `portal/apps/web/dist`, 250 KB.

## Where the rest of the automation lives

| Path                                             | What                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json` (root) scripts                    | The entry points: `lint`, `format`, `typecheck`, `test`, `guard`, `check:bundle`, `test:e2e`, `test:live`, `build`, `adminforge`, `live:*` |
| `.githooks/`                                     | `pre-commit` (`pnpm guard`) and `commit-msg`; `pnpm install` sets `core.hooksPath` (see its README)                                        |
| `.claude/hooks/after-edit.mjs`                   | Claude Code after-edit feedback: Prettier, `adminforge validate`, design tokens (see `.claude/hooks/README.md`)                            |
| `.github/workflows/ci.yml`                       | CI: audit, `pnpm guard`, lint, format, typecheck, tests, build, `pnpm check:bundle`, e2e                                                   |
| `.github/workflows/pr-title.yml`                 | The pull-request title check                                                                                                               |
| `.github/dependabot.yml`                         | Weekly dependency PRs: npm (`chore(deps)`), Actions (`ci(deps)`), the runner's Docker images (`chore(runner)`)                             |
| `.github/CODEOWNERS`, `pull_request_template.md` | Required reviewers (two-person review) and the PR checklist                                                                                |
| `portal/tools/cli`                               | The `adminforge` CLI (validate, test, publish, provision, …)                                                                               |

The live-tenant helpers have aliases too: `pnpm live:verify-api`, `pnpm live:check-pages <page…>`,
`pnpm live:run-playbook`, `pnpm live:run-schedule-once`, `pnpm live:check-mail-sender` (scripts in
`tests/live/scripts`, see `tests/live/README.md`).

## Conventions for a new tool

- An `.mjs` module with a header comment (what, why, how it's run, inputs/outputs) and its decisions in exported pure
  functions; running the file directly is the command (`if (import.meta.url === pathToFileURL(process.argv[1]).href)`).
- A `.d.mts` next to it with the exported types, and a test in `tests/unit/tooling/` that uses fakes or temporary
  directories — never the real network, database or `~/.config`.
- A root `package.json` script when engineers or CI run it, and a line in the table above.
