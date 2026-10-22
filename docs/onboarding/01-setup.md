# 1. Set up your machine

By the end of this page AdminForge runs on your machine on synthetic data, the tests pass, and git runs the same
checks on your commits as CI does. You don't need a Microsoft tenant for any of it.

## Install the tools

| Tool                  | Version                         | Why                                                                                  |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| Node.js               | 26 (`.nvmrc`)                   | Everything in `portal/` and `tests/`. `nvm use` or `fnm use` picks it up.            |
| pnpm                  | 11.10.0 (`packageManager`)      | The workspace. Corepack installs the pinned version — don't install another.         |
| Google Chrome         | current, installed system-wide  | Playwright uses `channel: 'chrome'` and never downloads a browser                    |
| PowerShell (`pwsh`)   | 7.4+                            | Only if you work on the PowerShell runner (Exchange, Teams, SharePoint) or its tests |
| VS Code (recommended) | with the Red Hat YAML extension | `.vscode/settings.json` maps content files to their JSON schemas (autocomplete)      |
| Claude Code           | current                         | How most extensions are made here ([guide 12](12-claude-code.md))                    |

The JSON schemas the editor uses are generated, not committed: run `pnpm --filter @adminforge/schemas build` once
(and after schema changes) to create `portal/packages/schemas/generated/`.

## Get the code and the hooks

```bash
git clone <repository URL> adminforge && cd adminforge
npm install --global corepack      # Node 25 and later no longer bundle Corepack
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

Write playbooks run end to end: arm with the dev toolbar, and a write with no fixture is accepted — nothing changes,
there is no tenant. Probes and Teams delivery answer from fixtures too, so mock mode never reaches the internet.

Mock mode ignores your env file on purpose, so it can't touch a shared database or a tenant. Use it for almost all UI
and content work.

## Give yourself a local database

`pnpm dev` against a tenant keeps its state in a SQLite file of your own — no Docker, no database server.
Configuration lives **outside** the repository:

```bash
install -d -m 700 ~/.config/adminforge
cp config/example.env ~/.config/adminforge/dev.env && chmod 600 ~/.config/adminforge/dev.env
pnpm --filter @adminforge/api init:local   # fills missing keys and replaces the CHANGE_ME placeholders: your dev database
                                           # file (DATABASE_PATH=~/.local/share/adminforge/dev.db), token-cache key,
                                           # local defaults (never prints values)
pnpm adminforge env check                  # key names and states only — it never prints values
```

The API creates the file (mode 600, in a 700 directory) and applies the migrations when it starts;
`pnpm --filter @adminforge/api db:migrate` does the same by hand. The DB-backed API tests don't use it: each suite makes
a migrated file of its own in a temporary directory, so they run everywhere and never skip ([Testing](09-testing.md)).

## Prove everything works

```bash
pnpm guard                          # guard tests (the pre-commit hook)
pnpm lint && pnpm format:check
pnpm typecheck                      # every package (as CI runs it)
pnpm test                           # unit, component, api, content, guards, pwsh; then scale
pnpm test:e2e                       # Playwright in mock mode, including the visual baselines
pnpm adminforge validate            # every content definition
pnpm adminforge test                # playbook and runbook tests
```

All of it should pass on a fresh clone of `main`. If something fails, it's either your setup (see below) or a real
bug — say so in the team channel rather than working around it.

`pnpm typecheck` only type-checks: it writes no `dist/` (it regenerates the git-ignored web route tree). `pnpm build`
(re)builds the `dist/` folders — never in a checkout a running service serves
([CLAUDE.md › Commands](../../CLAUDE.md#commands)).

## Working against a real tenant (later)

You'll only need this for live validation, and only once a code owner has given you access to the **validation
tenant** (never production) and a portal role there ([`docs/access.md`](../access.md)).

- Your tenant settings go in `~/.config/adminforge/dev.env` (mode 600 — the API and the CLI's commands refuse a file
  other users can read, and print the `chmod`; `env check` doesn't check modes yet). Provisioner and live-test
  credentials, if you're given any, go in `dev.admin.env` and are used only by `provision …`, `validate --scopes`,
  `env check` (key states only) and the live tests. Nothing from either file is ever pasted into chat, issues,
  commits, prompts or logs.
- `pnpm adminforge provision status` shows what is provisioned. Provisioning itself (`provision entra`) changes the
  tenant — only code owners run it.
- Against a tenant, `pnpm dev` runs playbooks and schedules itself: the API is also the run worker and the scheduler.
  It stays on your machine: with Entra sign-in the API refuses to start outside `NODE_ENV=production` when it listens
  beyond loopback or `PUBLIC_BASE_URL` names another host.
- **Never** point `DATABASE_PATH` at a deployment's database file; yours is `~/.local/share/adminforge/dev.db`.
- Live writes happen only on the `AF-Test-*` objects that `pnpm adminforge provision test-identities` created, in the
  order dry run → run → compensating playbook → check `/audit`. See [`tests/live/README.md`](../../tests/live/README.md)
  and the `validating-against-a-tenant` skill.

## When setup fails

| Symptom                                                | Fix                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `pnpm` says the version doesn't match `packageManager` | `npm install --global corepack`, `corepack enable`, then open a new shell                              |
| Commits go through without the guard tests running     | `git config core.hooksPath .githooks`                                                                  |
| Playwright can't find a browser                        | Install Google Chrome system-wide; Playwright doesn't download one here                                |
| `env check` says DATABASE_PATH contains `CHANGE_ME`    | Run `pnpm --filter @adminforge/api init:local` again                                                   |
| `env check` names `DATABASE_URL` and other old keys    | Keys of the Postgres releases: remove them once the one-time `db import-postgres` has run              |
| An env file "is open to other users of this machine"   | `chmod 600` the file the message names                                                                 |
| `PUBLIC_BASE_URL` error on `pnpm dev`                  | It has no default — pass it as in the mock-mode one-liner; on your machine it is a `localhost` address |
| A blank page or "no synthetic data" in mock mode       | A fixture is missing; the API log names it ([Testing → fixtures](09-testing.md#fixtures))              |
| No autocomplete in content YAML                        | `pnpm --filter @adminforge/schemas build` (the schemas are generated)                                  |
| Anything else                                          | [`docs/troubleshooting.md`](../troubleshooting.md), then the team channel                              |
