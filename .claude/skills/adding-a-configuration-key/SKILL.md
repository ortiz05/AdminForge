---
name: adding-a-configuration-key
description: Use when AdminForge needs a new setting — an environment/configuration key for the API, runner, scheduler or CLI, an installation value content reads as ${ env.AF_… }, a feature switch, a limit, a recipient list or webhook, or when renaming or retiring a key.
---

# Adding a configuration key

## Overview

Every setting is an environment key documented in `config/example.env` (the template; real values live in
`~/.config/adminforge/<env>.env`, mode 600, and in the cluster in the `adminforge-env` Secret made from it). The API
reads keys through the zod schema in `portal/apps/api/src/config.ts`, the runner through
`portal/apps/runner/src/config.ts`; `@adminforge/config` (`loadEnv`) layers the files. Content reads installation
values as `${ env.AF_… }`. Conventions: `docs/onboarding/05-coding-standards.md` › Configuration.

## When not to use

- A value that is the same for every installation → a constant in code or a field in content, not a key.
- A tenant id, domain, UPN or secret in content, fixtures or docs → never literal: a key, read as `${ env.X }`
  (`CLAUDE.md` non-negotiable 1).
- How the pod is laid out (paths, ports, `NODE_ENV`) → the base ConfigMap in
  `portal/deploy/kubernetes/base/kustomization.yaml`, which wins over the env file; a code owner's change.

## Steps

1. **Reuse first.** `rg "^[A-Z0-9_]+=" config/example.env` — extend an existing key's meaning only if nothing that
   reads it changes behaviour.
2. **Name it** `UPPER_SNAKE`. A key content may read starts with `AF_`. A key that holds a secret has a name content
   never sees: it contains `SECRET`, `PASSWORD`, `TOKEN`, `WEBHOOK`, `CERT`, `TOTP` or `PRIVATE`, or ends in `_KEY`
   (`portal/apps/api/src/datasources/env.ts`; `AF_TEST_*` and `AF_PROVISIONER_*` are hidden too). Report recipients
   end in `RECIPIENTS`, `EMAIL` or `ALERTS` (`${ env.AF_REPORT_RECIPIENTS }`); a Teams webhook is an `${ env.X }`
   reference, never a URL in content.
3. **Document it** in `config/example.env` in the right section, with a comment that says what it does, its unit and
   its default, and a safe empty or default value — never a real one. A key only the CLI and live tests need goes in
   the "admin file" block (`<env>.admin.env`, read only by `provision …`, `validate --scopes` and the live tests).
4. **Read it** in the schema of the process that uses it (`portal/apps/api/src/config.ts` — the API is also the run
   worker and the scheduler — or `portal/apps/runner/src/config.ts`), with a default that is safe: a missing optional
   key turns a feature off with a `*_not_configured` error written for an administrator (the env key and the fix are
   allowed there), never on. Production-only rules go in the schema's production checks. Pass the value through the
   module's options from `AppContext`, not by reading `process.env` in a feature.
5. **Content-readable keys** (`AF_*`, not secret-looking) are visible to expressions only because `example.env`
   declares them: `adminforge validate` refuses `${ env.X }` for an undeclared or hidden key. They are read on the
   server only — widget, header and action expressions run in the browser, where `env` is empty
   (`docs/content-recipes.md` › Configuration in browser expressions).
6. **Readiness:** if a purpose can't work without it, add it to `REQUIRED` in `portal/tools/cli/src/env/env-check.ts`
   so `pnpm adminforge env check --for <purpose>` reports it (names and states only, never values). A key that
   replaces another goes in `RETIRED_KEYS` there, so env check names the old one.
7. **Tenant data:** if its values are tenant data (ids, domains, names) the no-tenant-data guard already treats them
   as such; only local settings or public catalogue names need an exemption in
   `portal/packages/config/src/tenant-values.ts`, with a test.
8. **Deployment:** an installation setting reaches the pod through the `adminforge-env` Secret (from the env file); say
   in `docs/operations.md` (or `portal/deploy/kubernetes/README.md` for cluster settings) when an operator must set
   or change it. A permission or provisioning effect goes in `docs/access.md`.
9. **Tests:** a case in `tests/unit/api/config*.test.ts` (or the runner's) for the default, a bad value and any
   production rule; `tests/unit/cli/env-check.test.ts` holds that every required key is documented.
10. **Check:** `pnpm --filter @adminforge/api typecheck`, the unit project, `pnpm guard`; `pnpm adminforge env check`
    on your own env file prints the new key's state, never its value.

## Done when

- [ ] `config/example.env` documents the key (comment, unit, safe default) and the process's config schema reads it
      with a safe default
- [ ] A missing value turns the feature off with a clear `*_not_configured` message, or the default is safe to run
- [ ] Content that reads it uses `${ env.AF_… }` server-side only, and `adminforge validate` is clean
- [ ] `env check` knows whether a purpose needs it; config tests cover default, bad value and production rules
- [ ] `docs/operations.md` (or the deployment README) says when an operator sets it; nothing printed or committed holds
      a real value

## Common mistakes

| Mistake                                                  | Fix                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| A key read in code but missing from `config/example.env` | Document it there; content can't read an undeclared key at all           |
| A secret named like a plain setting (`AF_ROUTER_PASS`)   | A hidden name: `…_SECRET`, `…_PASSWORD`, `…_TOKEN`, `…_KEY`, `…_WEBHOOK` |
| A default that turns a risky feature on                  | Off by default; an explicit opt-in key (`…_ALLOW_…=true`)                |
| Printing the value in a log, error or `env check`        | Key names and states only                                                |
| `env.AF_X` in a widget, header or action expression      | Read it in a `source: static` datasource and pass on the answer          |
| Putting provisioner credentials in `<env>.env`           | `<env>.admin.env`; `env check` flags them in the runtime file            |

## See also

- `config/example.env`, `docs/onboarding/05-coding-standards.md` › Configuration, `docs/operations.md`
- `portal/deploy/kubernetes/README.md` (the Secret and the ConfigMap), `SECURITY.md` › Deployment, storage and network
- `adding-an-api-route`, `adding-a-cli-command`, `adding-a-service-connector`
