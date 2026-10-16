# 1. Set up your machine

By the end of this page AdminForge runs on your machine on synthetic data, the tests pass, and git runs the same
checks on your commits as CI does. You don't need a Microsoft tenant for any of it.

## Install the tools

| Tool                  | Version                         | Why                                                                                   |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| Node.js               | 24 (`.nvmrc`)                   | Everything in `portal/` and `tests/`. `nvm use` or `fnm use` picks it up.             |
| pnpm                  | 11.10.0 (`packageManager`)      | The workspace. `corepack enable` installs the pinned version — don't install another. |
| Docker with Compose   | current                         | The dev Postgres (`pnpm db:up`) and the DB-backed API tests                           |
| Google Chrome         | current, installed system-wide  | Playwright uses `channel: 'chrome'` and never downloads a browser                     |
| PowerShell (`pwsh`)   | 7.4+                            | Only if you work on the PowerShell runner (Exchange, Teams, SharePoint) or its tests  |
| VS Code (recommended) | with the Red Hat YAML extension | `.vscode/settings.json` maps content files to their JSON schemas (autocomplete)       |
| Claude Code           | current                         | How most extensions are made here ([guide 12](12-claude-code.md))                     |

The JSON schemas the editor uses are generated, not committed: run `pnpm --filter @adminforge/schemas build` once
(and after schema changes) to create `portal/packages/schemas/generated/`.

## Get the code and the hooks

```bash
git clone <repository URL> adminforge && cd adminforge
corepack enable
pnpm install                       # also runs `git config core.hooksPath .githooks`
git config core.hooksPath          # must print .githooks
git config commit.template docs/onboarding/templates/commit-message.txt   # optional: the format as a reminder
```

`.githooks/` holds two hooks, and both must run on every commit — **never** use `--no-verify`:

- `pre-commit` runs the guard tests: no secrets, no tenant-specific values, design tokens only in UI code. Only your
  machine knows your tenant's values (from your env file), so this hook is the **one** place they are checked against
  what you commit — CI has no tenant configuration and can't.
- `commit-msg` checks the message format ([guide 10](10-git-and-pull-requests.md)).

## Run it with no tenant (mock mode)

```bash
ADMINFORGE_ENV_FILE=/dev/null PUBLIC_BASE_URL=http://localhost:5173 AUTH_MODE=mock DATA_MODE=fixtures pnpm dev
```

Open <http://localhost:5173>. You're signed in as a mock engineer; every page renders from the synthetic fixtures in
`tests/fixtures/`, and state lives in memory. The **dev toolbar** (mock mode only) switches your portal roles and arms
or disarms write access, so you can see what a Reader, an Operator or an Approver sees.

Mock mode ignores your env file on purpose, so it can't touch a shared database or a tenant. Use it for almost all UI
and content work.

## Give yourself a local database

The DB-backed API tests and `pnpm dev` against a tenant need Postgres. Configuration lives **outside** the repository:

```bash
install -d -m 700 ~/.config/adminforge
cp config/example.env ~/.config/adminforge/dev.env && chmod 600 ~/.config/adminforge/dev.env
pnpm --filter @adminforge/api init:local   # fills missing keys and replaces the CHANGE_ME placeholders: DB password,
                                           # token-cache key, local defaults (never prints values)
pnpm db:up                                 # Postgres 18 in Docker on 127.0.0.1:55432
pnpm --filter @adminforge/api db:migrate
pnpm adminforge env check                  # key names and states only — it never prints values
```

The API tests create and migrate their own `adminforge_test` database next to the one in your env file, so test rows
never mix with your dev data. When Postgres isn't running, those suites **skip silently** — start it (`pnpm db:up`)
before you rely on an API test run.

## Prove everything works

```bash
pnpm guard                          # guard tests (the pre-commit hook)
pnpm lint && pnpm format:check
pnpm typecheck                      # every package (as CI runs it)
pnpm test                           # unit, component, api, content, guards
pnpm test:e2e                       # Playwright in mock mode, including the visual baselines
pnpm adminforge validate            # every content definition
pnpm adminforge test                # playbook and runbook tests
```

All of it should pass on a fresh clone of `main`. If something fails, it's either your setup (see below) or a real
bug — say so in the team channel rather than working around it.

`pnpm typecheck` and `pnpm build` go through turbo and (re)build packages' `dist/` folders. That's fine on your
machine; on a machine where AdminForge services run from the same checkout, use `pnpm -r run typecheck` instead and
never build there ([Releases and operations](13-releases-and-operations.md)).

## Working against a real tenant (later)

You'll only need this for live validation, and only once a code owner has given you access to the **validation
tenant** (never production) and a portal role there ([`docs/access.md`](../access.md)).

- Your tenant settings go in `~/.config/adminforge/dev.env` (mode 600). Provisioner and live-test credentials, if
  you're given any, go in `dev.admin.env` and are used only by the CLI and the live tests. Nothing from either file is
  ever pasted into chat, issues, commits, prompts or logs.
- `pnpm adminforge provision status` shows what is provisioned. Provisioning itself (`provision entra`) changes the
  tenant — only code owners run it.
- Against a tenant, playbook runs and schedules in `pnpm dev` need `RUN_WORKER_IN_PROCESS=true` and
  `SCHEDULER_IN_PROCESS=true` in your env file.
- **Never** point `pnpm dev` at the host services' database (the `host` overlay); the two would consume each other's
  runs.
- Live writes happen only on the `AF-Test-*` objects that `pnpm adminforge provision test-identities` created, in the
  order dry run → run → compensating playbook → check `/audit`. See [`tests/live/README.md`](../../tests/live/README.md)
  and the `validating-against-a-tenant` skill.

## When setup fails

| Symptom                                                  | Fix                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm` says the version doesn't match `packageManager`   | `corepack enable`, then open a new shell                                        |
| Commits go through without the guard tests running       | `git config core.hooksPath .githooks`                                           |
| Playwright can't find a browser                          | Install Google Chrome system-wide; Playwright doesn't download one here         |
| `pnpm db:up` fails on the env file                       | Create `~/.config/adminforge/dev.env` and run `init:local` (above)              |
| `env check` says DATABASE_URL still contains `CHANGE_ME` | Run `pnpm --filter @adminforge/api init:local` again                            |
| `PUBLIC_BASE_URL` error on `pnpm dev`                    | It has no default — pass it as in the mock-mode one-liner                       |
| A page is blank in mock mode                             | Its datasource has no fixture; see [Testing → fixtures](09-testing.md#fixtures) |
| No autocomplete in content YAML                          | `pnpm --filter @adminforge/schemas build` (the schemas are generated)           |
| Anything else                                            | [`docs/troubleshooting.md`](../troubleshooting.md), then the team channel       |
