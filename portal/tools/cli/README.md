# `adminforge` CLI

Administrator tooling for AdminForge: checks the local configuration, provisions the Entra ID and Azure objects an
environment needs, validates, tests and publishes `portal/content`, scaffolds new definitions and records synthetic
fixtures. Run it from the repository root as `pnpm adminforge <command>` (`tsx portal/tools/cli/src/index.ts`). The
app image carries a bundle of it (`dist/adminforge.js`, built by `tsup`) as `adminforge`, for the commands that act on
the cluster's database: `kubectl -n adminforge exec deploy/adminforge -c api -- adminforge <command>`.

Configuration comes from the env files outside the repository (CLAUDE.md non-negotiable 1), read by
`@adminforge/config` `loadEnv` in layers: `~/.config/adminforge/<env>.env` (or `$ADMINFORGE_ENV_FILE`), then
`<env>.admin.env` (provisioner and live-test credentials, read only by the commands that act as the provisioner —
`provision …` and `validate --scopes` — and the live tests), then `<env>.$ADMINFORGE_ENV_OVERLAY.env` if set; the
process environment wins over all files (in the pod it is the only source: the `adminforge-env` Secret and the
ConfigMap). An env file other users of the machine may read (any group or world permission) is refused with the fix,
`chmod 600 <file>`. The CLI never prints secrets,
ids or UPNs from the configuration or the tenant: output names keys, objects and states (provisioning headers also
show the environment label and redirect origin), and the secrets it creates go straight into the env files.

## Command reference

Every command exits 0 on success and 1 when it finds a problem or fails. A thrown error prints one line (`✗ …`): a
`ConfigError` names the key or option to fix; set `ADMINFORGE_DEBUG=1` to also print the stack. **Safe** means it
changes nothing in the tenant or in a database.

Keys every command reads from the process environment: `ADMINFORGE_ENV` (which `<env>.env`; `--env <name>` sets it),
`ADMINFORGE_ENV_FILE` (an explicit file), `ADMINFORGE_ENV_OVERLAY` (a third layer of per-deployment overrides),
`ADMINFORGE_DEBUG`.
Every configuration key is documented in `config/example.env`.

### `env check [--for <purposes>]`

- **Does:** compares the layered env files with `config/example.env` and prints each key's name and state (set,
  default, missing, invalid), keys `example.env` doesn't know (typos), admin keys sitting in the runtime file, keys
  of the Postgres releases that are still set (`DATABASE_URL`, `RUN_WORKER_IN_PROCESS`, …: nothing reads them, remove
  them), and readiness for each purpose: `provision`, `portal`, `schedules`, `validation`.
- **Options:** `--for` — comma-separated purposes, or `all` (default), that decide the exit code.
- **Reads:** every key in `config/example.env`. Never prints a value.
- **Changes:** nothing. **Safe:** yes. **Exit 1:** a selected purpose is not ready.

### `provision entra [--dry-run] [--prune]`

- **Does:** creates or updates the Read, Write and Automation app registrations and service principals, their local
  credentials (client secrets; the automation certificate when `AF_AUTOMATION_CERT_PATH` is set), one security group
  per portal role, delegated consent, application permissions — the catalog baseline plus every content
  `requires.scopes`, under the permission ceilings — and the automation identity's Azure Reader role. Prints the plan,
  then applies it. Delegated consent is converged both ways (scopes no longer wanted are dropped); application
  permissions are only added unless `--prune` is given — without it, the plan ends with one ⚠ line counting the
  application permissions provisioning doesn't grant.
- **Options:** `--dry-run` — print the plan only. `--prune` — also remove the application permissions (app-role
  assignments) on the three apps that provisioning doesn't grant: left over from retired content or a dropped baseline
  permission, withheld by a ceiling (a permission a ceiling withholds is removed even when someone granted it by
  hand), or added by hand. Only roles on the resources provisioning knows (Microsoft Graph, Exchange Online, …) are
  touched; anything else stays and `provision status` keeps flagging it. Run `--dry-run --prune` first.
- **Reads:** `AF_TENANT_ID`, `AF_ENV_LABEL`, `PUBLIC_BASE_URL`, `AF_REDIRECT_BASE_URLS`, `AF_SUBSCRIPTION_ID`,
  `AF_PRIMARY_DOMAIN`, `AF_PROVISIONER_CLIENT_ID` / `_SECRET` (admin file), `AF_READ_` / `AF_WRITE_` /
  `AF_AUTOMATION_CLIENT_ID` and `_SECRET`, `AF_AUTOMATION_CERT_PATH`, the ceiling opt-ins
  (`AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS`, `AF_ALLOW_PRIVILEGED_WRITE_SCOPES`, `AF_AUTOMATION_ALLOW_SENSITIVE_READS`,
  `AF_MAIL_SENDER`; on only when exactly `true`), and `portal/content`.
- **Changes:** Entra ID and the subscription's role assignments, as the provisioner; writes the three apps' client
  ids and secrets to the env file. **Safe:** only with `--dry-run`.

### `provision test-identities [--dry-run | --enable [--approver] | --disable | --remove-fixtures]`

- **Does:** test environments only (`AF_ENV_LABEL` listed in `AF_TEST_IDENTITY_LABELS`, default `dev,test`). Creates
  the validation user the live suite signs in as — disabled, in the portal role groups, with the directory roles the
  suite needs, excluded from the MFA registration campaign — and the write-test targets AF-Test-User-01…03 and
  AF-Test-Group-01. Refuses to touch an account at `AF_TEST_USER_UPN` that provisioning did not create.
  `--enable` / `--disable` only turn the validation user's sign-in on before a live run and off afterwards
  (`--disable` also revokes its sessions; enabling only in test environments).
- **Licensed test fixtures (opt-in):** with `AF_TEST_LICENCE_SKU` (a SKU part number such as `SPE_E5`) and/or
  `AF_TEST_FIXTURES` (`pim`, `named-location`, `intune`, `approver`, `ca-audit`, `directory`, `guest`, `apps`,
  `auth-methods`, `intune-more`, `sign-ins`) in the admin file, the same run also provisions
  — after the identities — a licence for the validation user and AF-Test-User-01…03, PIM eligibility (AF-Test-User-01:
  Reports Reader; the validation user: Message Center Reader; never active), the named location `AF-Test-Location`
  (192.0.2.0/24, not trusted), an `AF-Test` Intune compliance policy and configuration profile assigned to
  AF-Test-Group-01 only, and the approver account "AF Tester 2" (Portal.Reader and Playbook.Approver, its own
  marker, created disabled; refused where `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true` or when its UPN is the
  validation user's), and 14 example Conditional Access policies `AF-Audit: …` that are only ever **report-only**
  (device-dependent and location examples on AF-Test-Group-01 only — refused while it has other members or dynamic
  membership — the rest on all users / admin roles / guests minus `AF_PROTECTED_USER_IDS` and the sync accounts;
  catalogue in `provision/ca-audit-catalog.ts`; updates are checked before each attempt and read back), and the
  enterprise fixtures — AF-Test-User-04…12 with attributes and a manager chain, dynamic / nested / Microsoft 365 /
  empty / group-licensing groups and an administrative unit (`directory`), a never-redeemed guest (`guest`), app
  registrations with expiring, long-lived and many credentials, a risky and an ownerless one and a SAML app, never
  granted anything (`apps`), an SMS method and a Temporary Access Pass (`auth-methods`), more Intune policies
  (`intune-more`) and two accounts that only sign in (`sign-ins`, for `tests/live/scripts/generate-sign-ins.ts`) —
  see tests/live/README.md → Licensed test fixtures. Only objects
  provisioning created are changed (markers, provisioning's names, the exact range; for Conditional Access, a catalogue
  name on a policy that is report-only); same-named others are refused. `--enable` enables the validation user only, `--enable --approver` also the
  approver; `--disable` always disables both and the sign-in accounts (each attempted, each reported). `--remove-fixtures` removes what the
  opted-in fixtures created, the enterprise fixtures' marked objects and a marked approver in any case (and exits 1
  when a fixture couldn't be read), in any environment label (with `--dry-run`: the plan
  only). A fixture Graph refuses prints `✗` with the permission the provisioner needs (Graph's own reason and the
  permission it names, when its message names one), the others go on, and the run exits 1. Without the opt-in nothing changes (a leftover approver is still flagged).
- **Options:** `--dry-run` (plan only), `--enable`, `--disable` (mutually exclusive; not with `--dry-run`),
  `--approver` (with `--enable` only), `--remove-fixtures` (not with `--enable`/`--disable`).
- **Reads:** `AF_TENANT_ID`, `AF_ENV_LABEL`, `AF_PRIMARY_DOMAIN`, `AF_TEST_IDENTITY_LABELS`, the provisioner
  credentials, and from the admin file `AF_TEST_USER_UPN`, `AF_TEST_USER_PASSWORD`, `AF_TEST_SERVICE_ADMIN_ROLES`
  (Exchange/SharePoint admin roles for the validation user; off unless `true`), `AF_TEST_LICENCE_SKU`,
  `AF_TEST_FIXTURES`, `AF_TEST_APPROVER_UPN`, `AF_TEST_APPROVER_PASSWORD`, `AF_TEST_SIGNIN_<n>_UPN` /
  `_PASSWORD` (presence only); with `ca-audit`, `AF_PROTECTED_USER_IDS` (excluded from the audit policies).
- **Changes:** Entra ID users, group memberships, directory roles and the registration campaign's exclusions; with
  the fixtures, licences, PIM eligibility, a named location, Intune policies and report-only Conditional Access
  policies; writes `AF_TEST_USER_UPN`,
  `AF_TEST_USER_PASSWORD` (and `AF_TEST_APPROVER_UPN`, `AF_TEST_APPROVER_PASSWORD`, `AF_TEST_SIGNIN_<n>_UPN`,
  `AF_TEST_SIGNIN_<n>_PASSWORD`) to `<env>.admin.env`. **Safe:**
  only with `--dry-run`.
- **Provisioner permissions for the fixtures** (Microsoft Graph application permissions with admin consent — its
  directory role does not cover these APIs app-only; the plan prints a hint for each one its token lacks; they outlive
  the directory role and several are tier-0, so remove them between runs — `provision status` warns while they're
  held):

  | Fixture          | Permission                                                                                                              |
  | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
  | licences         | `LicenseAssignment.ReadWrite.All`                                                                                       |
  | `pim`            | `RoleEligibilitySchedule.ReadWrite.Directory`                                                                           |
  | `named-location` | `Policy.Read.All` and `Policy.ReadWrite.ConditionalAccess`                                                              |
  | `intune`         | `DeviceManagementConfiguration.ReadWrite.All`                                                                           |
  | `approver`       | none beyond the validation user's (its directory role covers it)                                                        |
  | `ca-audit`       | `Policy.Read.All`, `Policy.ReadWrite.ConditionalAccess` and `Application.Read.All` (for the application condition)      |
  | `directory`      | `LicenseAssignment.ReadWrite.All` (its licences); users, groups and the administrative unit: the directory role         |
  | `guest`          | none beyond the directory role; `User.Invite.All` to invite (optional: a refused invitation creates the guest directly) |
  | `apps`           | none beyond its directory role                                                                                          |
  | `auth-methods`   | `UserAuthenticationMethod.ReadWrite.All` where its directory role doesn't cover it                                      |
  | `intune-more`    | `DeviceManagementConfiguration.ReadWrite.All` and `DeviceManagementApps.ReadWrite.All`                                  |
  | `sign-ins`       | none beyond its directory role                                                                                          |

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

- **Does:** runs the `validate` and `test` checks; requires reviewed content — committed, and the commit on origin's
  `main` as origin has it now (`git ls-remote origin refs/heads/main`; origin out of reach counts as unreviewed); in
  the app image, where there is no checkout, the record `build-images.sh` wrote (`/app/BUILD.json`, checked against a
  freshly fetched `main`) — unless `--allow-unreviewed` (recorded in the audit event); then brings the database
  file's schema up to date, writes new definition versions stamped with the content schema version (idempotent by
  sha256, all-or-nothing), sends the `definitions_changed` signal (the running API drops those cache entries) and
  appends a `content.published` audit event with the content commit, the `main` commit it was checked against and
  origin's URL (without credentials).
- **Options:** `--env` (default `dev`), `--dry-run` (show what would be published and whether it would be refused,
  and list published versions stamped with an older content schema version and whether they still pass),
  `--allow-unreviewed`.
- **Reads:** `DATABASE_PATH`, content, git state and origin (or `BUILD.json`).
- **Changes:** the definitions and audit tables of the file at `DATABASE_PATH` — on a workstation your dev database; a
  deployment's only from inside its pod (`kubectl -n adminforge exec deploy/adminforge -c api -- adminforge
publish`). **Safe:** only with `--dry-run` (which may still migrate the schema). **Exit 1:** nothing could be
  published, or a version was refused.

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

- **Does:** re-walks the audit log's hash chain in the database file at `DATABASE_PATH`, opened read-only. For a
  deployment, run it in the pod (`kubectl -n adminforge exec deploy/adminforge -c api -- adminforge audit verify`) and
  compare its tail with the `audit chain checkpoint` lines in the logs you forward off the cluster. `--env` defaults
  to `dev`.
- **Reads:** `DATABASE_PATH`.
- **Changes:** nothing. **Safe:** yes. **Exit 1:** the chain is broken.

### `db backup <-|file --plaintext> [--env <name>]`

- **Does:** a consistent copy of the database (SQLite's online backup; the API keeps working) without credential rows
  (sessions, sign-in round trips, the token cache, leases, signals), rebuilt so nothing deleted survives, checked
  (integrity, audit chain) and written mode 600. `-` writes the copy to stdout and messages to stderr, so it can leave
  the pod and be encrypted on the operator's machine:
  `kubectl -n adminforge exec deploy/adminforge -c api -- adminforge db backup - | gpg --encrypt --recipient <key> > …`.
  The copy is not encrypted, so writing it to a file needs `--plaintext` (it refuses otherwise). After a restore from it
  everyone signs in again, and creators consent again to schedules that run with their access. The copy is the whole
  history, so it is recorded in it: before the copy leaves, one `database.backup` audit event (account and machine,
  stdout or file — never the path —, plaintext, bytes, the copy's audit tail) goes to the live database; if it can't be
  written, nothing leaves (a file copy takes its name only then). A copy that fails its checks is recorded as a
  failure.
- **Reads:** `DATABASE_PATH`.
- **Changes:** writes the new file and that audit event. **Safe:** yes. **Exit 1:** a file without `--plaintext`, no
  database, the copy failed its checks, or the audit event could not be written (the database must be writable for
  you).

### `db sign-out-everyone --yes [--schedule-grants] [--env <name>]`

- **Does:** the emergency step that ends every session at once (docs/operations.md → Emergency): deletes every
  session, pending sign-in and session token, and records one `sessions.signed_out_everyone` audit event with the
  counts. The running API reads sessions from the database on every request, so open pages show "signed out" at their
  next request — no restart. `--schedule-grants` also deletes the sealed tokens of schedules that run with their
  creator's access (their creators consent again). In the pod:
  `kubectl -n adminforge exec deploy/adminforge -c api -- adminforge db sign-out-everyone --yes`.
- **Reads:** `DATABASE_PATH`.
- **Changes:** the sessions, sign-in round trips and token cache tables; nothing in the tenant. **Safe:** no — it
  signs everyone out (hence `--yes`). **Exit 1:** no `--yes`, or no database.

### `db import-postgres [--to <file>] [--from-env <KEY>] [--dry-run] [--env <name>]`

- **Does:** the one-time move from the Postgres releases: reads the old database in one read-only snapshot and copies
  settings, preferences, saved views, definitions, schedules and their grants, runs with steps and events, approvals,
  schedule history, probe results, News and changes, and the audit log into a new SQLite file; re-verifies the audit
  chain and checks its tail equals Postgres'. Not copied: signed-in sessions and sign-in round trips (everyone signs
  in again) and session token partitions; schedules' sealed grant tokens are kept, so keep the same
  `TOKEN_CACHE_KEY`. Refuses a target that already holds data, and a database older than the last Postgres release.
  The steps around it (stop the old services, put the file on the volume) are in
  `portal/deploy/kubernetes/README.md` → Moving the data from the Postgres host.
- **Options:** `--to` (the new file, default `DATABASE_PATH`), `--from-env` (the variable that holds the Postgres URL,
  default `DATABASE_URL` — read from the env files or the environment, never typed on the command line),
  `--dry-run` (check the source and print the row counts, write nothing).
- **Reads:** the Postgres URL key, `DATABASE_PATH`.
- **Changes:** the new SQLite file only; nothing in Postgres or the tenant. **Safe:** yes for Postgres and the tenant.
  **Exit 1:** the source can't be read, the target holds data, or the copied chain doesn't match.

## Module layout

Each layer imports only from the layers below it, so there are no import cycles.

```
src/
  index.ts            commander wiring; builds the contexts from the env files; error → one line + exit code
  commands/           one module per command — option handling, output, and the order of steps
    env.ts  validate.ts  test.ts  publish.ts  new.ts  fixtures.ts  audit.ts
    db.ts             db backup · db sign-out-everyone · db import-postgres (the only module that may use the pg driver)
    provision.ts      provision entra · test-identities · status
    test-fixtures.ts  the opt-in licensed test fixtures within test-identities and status; --remove-fixtures
    azure-test.ts     provision azure-test (and its block in provision status)
  content/            content-side logic the commands share
    context.ts        ContentCliContext: directories, env, output, injectable stand-ins
    check.ts          the offline validate check (also the publish gate)
    lint.ts           pure rules: bare datasource names, declaration order, script sha256 pins
    playbook-tests.ts runs playbook/runbook tests: blocks through the engine
    review-state.ts   git: is the content committed and on origin/main? (in the image: BUILD.json)
    scopes.ts         declared vs. granted vs. provisioned permissions (validate --scopes)
    scaffold.ts       YAML templates for `new`
    sanitize.ts       fixture sanitizer for `fixtures record`
    api-bridge.ts     the API modules the CLI reuses (database, migrations, definition store, audit writer, backup)
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
    fixtures-model.ts  fixtures-plan.ts  fixtures-io.ts     its licensed test fixtures (licences, PIM, location, Intune)
    approver-plan.ts  approver-io.ts                        … and the approver account (AF Tester 2)
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
  (`fake-cloud.ts`; `azure-test-fake.ts` adds Log Analytics, `fixtures-fake.ts` the fixtures' endpoints):
  `provision.test.ts`, `test-identities-*.test.ts`, `test-fixtures-provision.test.ts`,
  `unexpected-privilege.test.ts`, `automation-certificate.test.ts`, `azure-test.test.ts`. The pure planners have their
  own tests (`entra-plan`, `identities-plan`, `test-fixtures-plan`, `azure-test-plan`, `privilege-ceilings`,
  `automation-ceiling`, …).
- **Content commands** run against temporary content directories with injected stores, engines, git state and fetch
  (`content.test.ts`, `publish-*.test.ts`, `news-feeds.test.ts`, `script-pins.test.ts`, the lint rule tests).
- **Configuration and plumbing**: `env-check*.test.ts` (`env-check-retired-keys` for the Postgres keys),
  `env-command.test.ts` (temporary env files only — never `~/.config`), `redirect-origins.test.ts`,
  `audit-verify.test.ts`, `review-state-image.test.ts`, `describe-failure.test.ts`.
- **Database commands** run against temporary SQLite files in the `api` project: `tests/api/db-backup-db.test.ts`
  and `tests/api/import-postgres.test.ts` (the only test that needs a Postgres — `TEST_POSTGRES_URL`, or the
  `DATABASE_URL` an older env file still has; it skips without one).

No test reaches the network, the tenant or a shared database; fixtures are synthetic (`example.com`, generated GUIDs).
