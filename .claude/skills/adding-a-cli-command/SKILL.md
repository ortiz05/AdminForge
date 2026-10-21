---
name: adding-a-cli-command
description: Use when the adminforge CLI (portal/tools/cli) needs a new command or option — provisioning, content tooling (validate, test, publish, new, fixtures), database or audit commands.
---

# Adding a CLI command

## Overview

`pnpm adminforge <command>` runs `portal/tools/cli/src/index.ts` (commander); the app image carries a bundle of it for
the commands that act on the cluster's database. The recipe lives with the code:
`portal/tools/cli/README.md` › Adding a command (and › Module layout, › The provisioning pattern). This skill is the
checklist around it.

## When not to use

- A one-off script for a live check → `tests/live/scripts/` (`validating-against-a-tenant`), not a command.
- Behaviour the portal needs at run time → the API (`adding-an-api-route`); the CLI reaches the API's code only
  through `@adminforge/api/tooling`, never `@adminforge/api/src/…`.
- A new content rule → `portal/tools/cli/src/content/lint.ts` or the schema, run by the existing `validate` (and so by
  `publish`), not a new command.

## Steps

1. **Reuse first:** read the command reference in `portal/tools/cli/README.md`; an option on an existing command is
   often enough.
2. Logic in `src/commands/<name>.ts` with the header comment the README asks for (command line, what it reads, what
   it changes, exit code); take a context (`CliContext`, `ContentCliContext` or `Out`) instead of `process.env`,
   `console` or `fetch`. Pure rules go in `content/`, `env/` or `provision/`; anything the person fixes in the env file
   or on the command line throws `ConfigError` naming the key or option.
3. Wire it in `src/index.ts` (`--env` via `useEnv`, `process.exitCode = 1` on failure). Only `provision …` and
   `validate --scopes` may read `<env>.admin.env`; output names keys, objects and states — never secrets, ids or UPNs.
4. A command that changes the tenant follows desired → plan → apply → status with `--dry-run`; one that touches a
   database audits what it did (as `db backup` does).
5. New keys: `adding-a-configuration-key`. Tests under `tests/unit/cli/` (database commands in `tests/api/*-db.test.ts`
   on a temporary SQLite file); a row in the README's command reference; `CLAUDE.md` › Commands when engineers will
   use it daily.
6. Check: `pnpm --filter @adminforge/cli typecheck`, `pnpm --filter @adminforge/tests exec vitest run --project unit
unit/cli`, `pnpm guard`, `pnpm lint`; `security-reviewer` when it provisions, publishes or touches the database.

## Done when

- [ ] The command's module has its header comment, takes a context and returns a value the exit code comes from
- [ ] Tests under `tests/unit/cli/` (or `tests/api/*-db.test.ts`) cover success, each `ConfigError` and `--dry-run`
- [ ] `portal/tools/cli/README.md` lists it in the command reference
- [ ] Typecheck, the unit project, `pnpm guard` and `pnpm lint` pass; nothing it prints holds a secret or tenant value

## Common mistakes

| Mistake                                               | Fix                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| Reading `process.env` or calling `fetch` in a command | Take the context; inject stand-ins in tests                       |
| Printing an id, UPN or secret to "help"               | Key names, object names and states only                           |
| Reading the admin file from a content or db command   | Only `provision …` and `validate --scopes` read `<env>.admin.env` |
| Importing `@adminforge/api/src/…`                     | `@adminforge/api/tooling` (a guard refuses runtime deep imports)  |

## See also

- `portal/tools/cli/README.md` (command reference, module layout, provisioning pattern, tests)
- `adding-a-configuration-key`, `validating-against-a-tenant`
