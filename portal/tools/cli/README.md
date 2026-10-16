# `adminforge` CLI

Administrator tooling for AdminForge: checks the local configuration, provisions the Entra ID and Azure objects an
environment needs, validates, tests and publishes `portal/content`, scaffolds new definitions and records synthetic
fixtures. Run it from the repository root as `pnpm adminforge <command>` (`tsx portal/tools/cli/src/index.ts`).

Configuration comes from the env files outside the repository (CLAUDE.md non-negotiable 1), read by
`@adminforge/config` `loadEnv` in layers: `~/.config/adminforge/<env>.env` (or `$ADMINFORGE_ENV_FILE`), then
`<env>.admin.env` (provisioner and live-test credentials — the CLI is the only reader besides the live tests), then
`<env>.$ADMINFORGE_ENV_OVERLAY.env` if set; the process environment wins over all files. The CLI never prints secrets,
ids or UPNs from the configuration or the tenant: output names keys, objects and states (provisioning headers also
show the environment label and redirect origin), and the secrets it creates go straight into the env files.

## Command reference

Every command exits 0 on success and 1 when it finds a problem or fails. A thrown error prints one line (`✗ …`): a
`ConfigError` names the key or option to fix; set `ADMINFORGE_DEBUG=1` to also print the stack. **Safe** means it
changes nothing in the tenant or in a database.

Keys every command reads from the process environment: `ADMINFORGE_ENV` (which `<env>.env`; `--env <name>` sets it),
`ADMINFORGE_ENV_FILE` (an explicit file), `ADMINFORGE_ENV_OVERLAY` (a third layer, e.g. `host`), `ADMINFORGE_DEBUG`.
Every configuration key is documented in `config/example.env`.

### `env check [--for <purposes>]`

- **Does:** compares the layered env files with `config/example.env` and prints each key's name and state (set,
  default, missing, invalid), keys `example.env` doesn't know (typos), admin keys sitting in the runtime file, and
  readiness for each purpose: `provision`, `portal`, `schedules`, `validation`.
- **Options:** `--for` — comma-separated purposes, or `all` (default), that decide the exit code.
- **Reads:** every key in `config/example.env`. Never prints a value.
- **Changes:** nothing. **Safe:** yes. **Exit 1:** a selected purpose is not ready.

### `provision entra [--dry-run]`

- **Does:** creates or updates the Read, Write and Automation app registrations and service principals, their local
  credentials (client secrets; the automation certificate when `AF_AUTOMATION_CERT_PATH` is set), one security group
  per portal role, delegated consent, application permissions — the catalog baseline plus every content
  `requires.scopes`, under the permission ceilings — and the automation identity's Azure Reader role. Prints the plan,
  then applies it.
- **Options:** `--dry-run` — print the plan only.
- **Reads:** `AF_TENANT_ID`, `AF_ENV_LABEL`, `PUBLIC_BASE_URL`, `AF_REDIRECT_BASE_URLS`, `AF_SUBSCRIPTION_ID`,
  `AF_PRIMARY_DOMAIN`, `AF_PROVISIONER_CLIENT_ID` / `_SECRET` (admin file), `AF_READ_` / `AF_WRITE_` /
  `AF_AUTOMATION_CLIENT_ID` and `_SECRET`, `AF_AUTOMATION_CERT_PATH`, the ceiling opt-ins
  (`AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS`, `AF_ALLOW_PRIVILEGED_WRITE_SCOPES`, `AF_AUTOMATION_ALLOW_SENSITIVE_READS`,
  `AF_MAIL_SENDER`; on only when exactly `true`), and `portal/content`.
- **Changes:** Entra ID and the subscription's role assignments, as the provisioner; writes the three apps' client
  ids and secrets to the env file. **Safe:** only with `--dry-run`.

### `provision test-identities [--dry-run | --enable | --disable]`

- **Does:** test environments only (`AF_ENV_LABEL` listed in `AF_TEST_IDENTITY_LABELS`, default `dev,test`). Creates
  the validation user the live suite signs in as — disabled, in the portal role groups, with the directory roles the
  suite needs, excluded from the MFA registration campaign — and the write-test targets AF-Test-User-01…03 and
  AF-Test-Group-01. Refuses to touch an account at `AF_TEST_USER_UPN` that provisioning did not create.
  `--enable` / `--disable` only turn the validation user's sign-in on before a live run and off afterwards
  (`--disable` also revokes its sessions; enabling only in test environments).
- **Options:** `--dry-run` (plan only), `--enable`, `--disable` (mutually exclusive; not with `--dry-run`).
- **Reads:** `AF_TENANT_ID`, `AF_ENV_LABEL`, `AF_PRIMARY_DOMAIN`, `AF_TEST_IDENTITY_LABELS`, the provisioner
  credentials, and from the admin file `AF_TEST_USER_UPN`, `AF_TEST_USER_PASSWORD`, `AF_TEST_SERVICE_ADMIN_ROLES`
  (Exchange/SharePoint admin roles for the validation user; off unless `true`).
- **Changes:** Entra ID users, group memberships, directory roles and the registration campaign's exclusions; writes
  `AF_TEST_USER_UPN` and `AF_TEST_USER_PASSWORD` to `<env>.admin.env`. **Safe:** only with `--dry-run`.

### `provision azure-test [--dry-run] [--no-verify] | --destroy [--yes]`

- **Does:** the Azure side of live KQL validation: resource group `AF-Test-<label>`, a Log Analytics workspace capped
  at 0.1 GB a day, the subscription activity log exported to it, and Log Analytics Reader for the automation identity
  and the validation user; then checks that the automation identity can query the workspace. `--destroy` deletes the
  resource group, the diagnostic setting and the validation user's subscription Reader assignment, after you type
  the resource group's name (or with `--yes`).
- **Options:** `--dry-run`, `--no-verify` (skip the query check), `--destroy`, `--yes`.
- **Reads:** `AF_TENANT_ID`, `AF_SUBSCRIPTION_ID`, `AF_ENV_LABEL`, `AF_TEST_LOCATION`, `AF_LOG_ANALYTICS_WORKSPACE_ID`,
  `AF_AUTOMATION_CLIENT_ID` with `AF_AUTOMATION_CERT_PATH` or `_SECRET`, `AF_TEST_USER_UPN`, the provisioner
  credentials.
- **Changes:** resources and role assignments in the subscription; writes `AF_LOG_ANALYTICS_WORKSPACE_ID` and
  `AF_TEST_LOCATION` (`--destroy` clears the workspace id). **Safe:** only with `--dry-run`. **Exit 1:** the query
  check failed.

### `provision status`

- **Does:** shows the `provision entra` and `test-identities` plans as a ✓/✗ checklist, privilege nobody provisioned
  (extra assignments, permissions, grants, owners, credentials, Azure roles), live token checks for the three apps,
  the Read app's authorize URL, the Azure test environment and Security Defaults.
- **Reads:** everything `provision entra`, `test-identities` and `azure-test` read.
- **Changes:** nothing (reads as the provisioner; requests app-only tokens for the apps). **Safe:** yes. **Exit 1:**
  anything not in the desired state, or unexpected privilege.

### `validate [--scopes] [--env <name>]`

- **Does:** checks `portal/content` offline: schema, references, expressions, injection lint (OData, KQL, paths),
  datasource rules, runner script sha256 pins (every `script` reference must pin the sha256 of its file under
  `portal/content/scripts`) and `env.X` keys. `--scopes` also compares the declared `requires.scopes` with what Entra
  granted the Read and Write apps and the automation identity.
- **Reads:** content and `config/example.env`; with `--scopes` also `AF_TENANT_ID`, the provisioner credentials,
  `AF_READ_CLIENT_ID`, `AF_WRITE_CLIENT_ID`, `AF_AUTOMATION_CLIENT_ID` and the ceiling opt-ins.
- **Changes:** nothing (`--scopes` reads Entra as the provisioner). **Safe:** yes. **Exit 1:** any error, or with
  `--scopes` a missing scope or an app without a service principal (warnings and unused scopes don't fail).

### `test [pattern]`

- **Does:** runs every playbook and runbook `tests:` block (dry run with mocked step outputs); `pattern` keeps
  definitions whose id or file contains it.
- **Changes:** nothing. **Safe:** yes. **Exit 1:** a test failed.

### `publish [--env <name>] [--dry-run] [--allow-unreviewed]`

- **Does:** runs the `validate` and `test` checks; requires reviewed content — committed, and the commit on
  `origin/main` as last fetched — unless `--allow-unreviewed` (recorded in the audit event); then writes new
  definition versions to Postgres (idempotent by sha256, all-or-nothing), sends `NOTIFY definitions_changed` and
  appends a `content.published` audit event.
- **Options:** `--env` (default `dev`), `--dry-run` (show what would be published and whether it would be refused),
  `--allow-unreviewed`.
- **Reads:** `DATABASE_URL`, content, git state.
- **Changes:** the definitions and audit tables of `DATABASE_URL` — use the dev database, never the services' `host`
  overlay. **Safe:** only with `--dry-run`. **Exit 1:** nothing could be published, or a version was refused.

### `new <kind> <section>/<name> [--template <template>] [--owner <team>] [--force]`

- **Does:** scaffolds a definition that validates as written (`page`, `dashboard`, `report`, `playbook`, `runbook`,
  `connection`, `probe`, `schedule`; page templates `list-detail`, `dashboard`, `report`, `entity`) with `$schema`
  for editor autocomplete, plus a synthetic fixture stub.
- **Options:** `--template`, `--owner` (default `<section>-team`), `--force` (overwrite the definition).
- **Reads:** `CONTENT_DIR`, `ADMINFORGE_FIXTURES_DIR` (defaults `portal/content`, `tests/fixtures`).
- **Changes:** local files only. **Safe:** yes.

### `fixtures record <page> [--datasource <name>] [--param k=v]… [--env <name>] [--force] [--dry-run]`

- **Does:** reads one page's datasources live as the automation identity in read mode (the same requests the portal
  makes), sanitizes every response (GUIDs, UPNs, domains, names, IPs, paging tokens) and writes fixtures for
  `DATA_MODE=fixtures`. Refuses any file that would still contain a local configuration value — the no-tenant-data
  guard's rule (`@adminforge/config` `tenantValues`).
- **Options:** `--datasource` (only this one), `--param` (page parameter, repeatable), `--force` (overwrite existing
  fixtures), `--dry-run` (record and sanitize, write nothing).
- **Reads:** `AF_TENANT_ID`, `AF_AUTOMATION_CLIENT_ID` with `AF_AUTOMATION_CERT_PATH` or `_SECRET`,
  `AF_SPO_TENANT_NAME`, `AF_PRIMARY_DOMAIN`, the non-secret `AF_*` keys content uses.
- **Changes:** local files under `tests/fixtures`; reads the tenant only. **Safe:** yes for the tenant — review the
  files before committing. **Exit 1:** a datasource failed or a file was refused.

### `audit verify [--env <name>]`

- **Does:** re-walks the audit log's hash chain in `DATABASE_URL` (`ADMINFORGE_ENV_OVERLAY=host` checks the services'
  database). `--env` defaults to `dev`.
- **Reads:** `DATABASE_URL`.
- **Changes:** nothing. **Safe:** yes. **Exit 1:** the chain is broken.

## Module layout

Each layer imports only from the layers below it, so there are no import cycles.

```
src/
  index.ts            commander wiring; builds the contexts from the env files; error → one line + exit code
  commands/           one module per command — option handling, output, and the order of steps
    env.ts  validate.ts  test.ts  publish.ts  new.ts  fixtures.ts  audit.ts
    provision.ts      provision entra · test-identities · status
    azure-test.ts     provision azure-test (and its block in provision status)
  content/            content-side logic the commands share
    context.ts        ContentCliContext: directories, env, output, injectable stand-ins
    check.ts          the offline validate check (also the publish gate)
    lint.ts           pure rules: bare datasource names, declaration order, script sha256 pins
    playbook-tests.ts runs playbook/runbook tests: blocks through the engine
    review-state.ts   git: is the content committed and on origin/main?
    scopes.ts         declared vs. granted vs. provisioned permissions (validate --scopes)
    scaffold.ts       YAML templates for `new`
    sanitize.ts       fixture sanitizer for `fixtures record`
    api-bridge.ts     the API modules the CLI reuses (definition store, datasource runner, audit writer)
  env/
    env-check.ts      pure rules behind `env check`
  provision/          provisioning: settings, clients, catalog, and desired → plan → apply per area
    settings.ts       env → validated ProvisionSettings (ConfigError names the key)
    clients.ts        CliContext; Graph/ARM clients for the provisioner and AdminForge's own apps
    catalog.ts        Microsoft-published ids and AdminForge's permission baselines
    privilege.ts      permission ceilings (tier-0, sensitive reads, write-capable scopes)
    model.ts          settings, Graph/ARM shapes, desired/fetched state, operations (types)
    entra-desired.ts  entra-io.ts  entra-plan.ts            provision entra
    identities-plan.ts  identities-io.ts                    provision test-identities
    azure-test-plan.ts  azure-test-io.ts                    provision azure-test
    unexpected.ts     privilege nobody provisioned (provision status)
    auth.ts  certificate.ts  ids.ts  password.ts  retry.ts  token, certificate, id, password and retry helpers
  shared/
    errors.ts         ConfigError, describeFailure
    output.ts         Out; plan and status renderers
```

Rules (from `docs/onboarding/05-coding-standards.md`): every module starts with a block comment saying what it is and
why; decisions are pure exported functions; I/O sits at the edges behind an injected context; time comes from
`ctx.now`.

## The provisioning pattern: desired → plan → apply → status

Every `provision` area is split the same way, so each step can be tested on its own and `status` can never disagree
with `apply`:

1. **settings** (`provision/settings.ts`): env values → `ProvisionSettings`, or a `ConfigError` naming the key.
2. **desired** (`*-desired.ts` / `build*` in `*-plan.ts`): what should exist — pure, from settings, the catalog and
   content's `requires.scopes`, after the permission ceilings.
3. **fetch** (`*-io.ts` `fetch*State`): what exists, read as the provisioner. Read-only.
4. **plan** (`plan*` in `*-plan.ts`): desired + fetched → ordered operations (`create`, `update` with what differs,
   `delete`, `noop`, `skip` with why). Pure.
5. **apply** (`*-io.ts` `apply*Ops`): executes the non-noop operations in order with replication retries; new ids and
   secrets go to the env file through `ctx.writeEnv`. Skipped by `--dry-run`.
6. **status** (`provision status`): the same plan rendered as a checklist (`shared/output.ts` `renderStatus`): green
   means apply would do nothing. Extra checks (unexpected privilege, token checks) are reported next to it.

## Adding a command

1. Put the logic in `src/commands/<name>.ts`, starting with a header comment: the command line, what it reads (env
   keys, files), what it changes (tenant, database, local files) and its exit code. Take a context (`CliContext` from
   `provision/clients.ts`, `ContentCliContext` from `content/context.ts`, or just `Out`) instead of reaching for
   `process.env`, `console` or `fetch` directly; return a value the exit code can be decided from.
2. Pure rules it needs go in the matching layer (`content/`, `env/`, `provision/`) as exported functions; output
   helpers in `shared/`. Throw `ConfigError` for anything the person fixes in the env file or on the command line.
3. Wire it in `src/index.ts` (options, `--env` via `useEnv`, `process.exitCode = 1` on failure).
4. Add tests under `tests/unit/cli/` (below), a row in the command reference above, and the keys it reads to
   `config/example.env` if they are new.

## Tests

All tests live in `tests/unit/cli/` (vitest project `unit`; tenant-value rules in `tests/guards/tenant-values.test.ts`):

```bash
pnpm --filter @adminforge/tests exec vitest run --project unit unit/cli
```

- **Provisioning** runs end to end against in-memory fakes of the Entra token endpoint, Graph and ARM
  (`fake-cloud.ts`; `azure-test-fake.ts` adds Log Analytics): `provision.test.ts`, `test-identities-*.test.ts`,
  `unexpected-privilege.test.ts`, `automation-certificate.test.ts`, `azure-test.test.ts`. The pure planners have their
  own tests (`entra-plan`, `identities-plan`, `azure-test-plan`, `privilege-ceilings`, `automation-ceiling`, …).
- **Content commands** run against temporary content directories with injected stores, engines, git state and fetch
  (`content.test.ts`, `publish-*.test.ts`, `news-feeds.test.ts`, `script-pins.test.ts`, the lint rule tests).
- **Configuration and plumbing**: `env-check*.test.ts`, `env-command.test.ts` (temporary env files only — never
  `~/.config`), `redirect-origins.test.ts`, `audit-verify.test.ts`, `describe-failure.test.ts`.

No test reaches the network, the tenant or a shared database; fixtures are synthetic (`example.com`, generated GUIDs).
