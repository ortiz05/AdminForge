---
name: onboard
description: Use when a new engineer says "onboard", "set me up", "get my machine ready" or "check my setup", or when hooks, skills, the after-edit hook, Corepack/pnpm, Chrome for Playwright or the generated schemas seem missing or broken in their checkout.
---

# Onboarding an engineer

## Overview

`node tooling/onboard.mjs` (`pnpm onboard` once pnpm works) gets a checkout ready and proves it: the pinned Node and
pnpm, `pnpm install`, git running `.githooks` (guard tests before every commit, the commit-message rules), the
generated content schemas and design tokens, Google Chrome for Playwright, PowerShell 7 (optional), Claude Code's
project setup — `.claude/settings.json` and its after-edit hook, every skill in `.claude/skills/` and reviewer agent in
`.claude/agents/` with valid front matter, `CLAUDE.md` — the env file's permissions when there is one, and finally
`pnpm guard`. It never prints a configuration value. Your job: run it, fix what it reports, and show the engineer
where to go next.

## When not to use

- Connecting a checkout to a Microsoft tenant (app registrations, provisioning, the validation user) →
  `validating-against-a-tenant` and `docs/onboarding/01-setup.md` › Give yourself a local database.
- Deploying (Kubernetes, this host) — code owners only, `portal/deploy/kubernetes/README.md`.

## Steps

1. **Run it:** `node tooling/onboard.mjs` from the repository root (built-ins only: it works before `pnpm install`).
   Every line is ✓ (fine), ✓ … (set up now), ! (optional — says why) or ✗ (to fix — with the fix on the next line).
2. **Fix each ✗ the way its line says**, in order — later checks depend on earlier ones:
   - Node: `nvm install && nvm use` (`.nvmrc`), then run it again in the new shell.
   - pnpm: `npm install --global --ignore-scripts corepack@0.36.0 && corepack enable` — never install another pnpm.
   - Git hooks: `git config core.hooksPath .githooks` (`pnpm install` sets it). **Never** suggest `--no-verify`.
   - Chrome: install Google Chrome system-wide (Playwright uses `channel: 'chrome'` and never downloads a browser).
   - Skills, agents, settings: a broken front matter or a missing hook script is a repository problem — fix the file
     (`name:` = its folder or file name, `description:` = when to use it) and say so; don't work around it.
     Run it again until there's no ✗. Use `--check` to look without changing anything, `--quick` to skip the guard tests.
3. **Confirm Claude Code loaded it.** The project skills appear in your available skills (the `adding-…` set, `onboard`,
   `add-news-feed`, `validating-against-a-tenant`, …) and the reviewer agents (`content-reviewer`,
   `security-reviewer`, `design-reviewer`) in your agent types. The after-edit hook runs after every Write/Edit
   ("AdminForge checks"); `/hooks` shows it. If skills or hooks are missing, the engineer opened Claude Code outside the
   repository root or hasn't trusted the project — ask them to restart it from the root.
4. **Show the way in:** `docs/onboarding/README.md` (reading order), mock mode
   (`ADMINFORGE_ENV_FILE=/dev/null PUBLIC_BASE_URL=http://localhost:5173 AUTH_MODE=mock DATA_MODE=fixtures pnpm dev`),
   `CLAUDE.md` (the non-negotiables) and `docs/extending.md` (which skill for which change). Offer `pnpm test` as the
   full proof (`docs/onboarding/01-setup.md` › Prove everything works).

## Done when

- [ ] `node tooling/onboard.mjs` ends with "Ready." (no ✗; ! lines explained)
- [ ] The project skills, reviewer agents and the after-edit hook are loaded in Claude Code
- [ ] The engineer knows where to read next and how to run mock mode

## Common mistakes

| Mistake                                     | Fix                                                                |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `npm install -g pnpm` or a second pnpm      | Corepack only: the version is pinned in `packageManager`           |
| `git commit --no-verify` to get past a hook | Never: fix what the hook reports                                   |
| `npx playwright install`                    | Not needed: system Chrome (`channel: 'chrome'`)                    |
| Printing the env file to "check" it         | `pnpm adminforge env check` — key names and states only            |
| Claude Code started in a subfolder          | Start it at the repository root so `.claude/` and `CLAUDE.md` load |

## See also

- `tooling/onboard.mjs` (the checks), `docs/onboarding/01-setup.md`, `docs/onboarding/12-claude-code.md`
- `.claude/hooks/README.md` (the after-edit hook), `.githooks/README.md`
