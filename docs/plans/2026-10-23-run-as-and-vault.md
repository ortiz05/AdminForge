# Run-as accounts and credentials from Vault — design and implementation plan

> **Status:** in progress (2026-10-23). Design agreed with the owner the same day; built on `feat/run-as-vault` in
> two parts (run-as first, then Vault). No Vault instance exists yet: Part 2 is tested against a stand-in server.

**Goal:** the installation chooses which account reports and automations run as — a default per kind of job and a
per-schedule choice in the portal — and those accounts' credentials can come from HashiCorp Vault instead of the env
file.

**Decisions (owner, 2026-10-23):** accounts are Entra **app registrations** (client id + secret or certificate; no
user accounts with passwords); the account is chosen by an **installation default plus a per-schedule override in the
portal**; **AdminForge reads Vault itself** (Kubernetes auth or AppRole, KV v2), off until `AF_VAULT_ADDR` is set.

**Today (ADR-014):** a schedule runs as the automation identity unless its definition names a named app identity
(`identity: { app: <name> }`, `AF_SCHEDULE_IDENTITIES`) or, for read-only portal schedules, its creator. Each
identity's client id and secret or certificate path are env keys (`AF_AUTOMATION_*`, `AF_IDENTITY_<NAME>_*`), turned
into token providers by `createAppIdentityRegistry` (`portal/apps/api/src/auth/automation.ts`). The run's identity is
chosen in `ScheduleIdentities.prepare` (`portal/apps/api/src/schedules/grants.ts`).

---

## Part 1 — Which account a schedule runs as

### Rules

1. **Effective identity** of a schedule, first that applies:
   1. its **override** (set in the portal; content schedules only — portal schedules change theirs in the editor);
   2. the identity its **definition** names (`identity:`);
   3. the installation **default for its kind**, for read-only jobs that aren't probe sweeps
      (`AF_SCHEDULE_DEFAULT_IDENTITY_REPORTS`, else `AF_SCHEDULE_DEFAULT_IDENTITY`; the security review found that
      sweeps of synthetic transactions change test objects, so `…_PROBES` was dropped);
   4. the **automation identity**.

   News and content-health jobs always run as the automation identity (as today). A write-capable job (`isWriteCapable`)
   never takes a default: a deploy must not move it to another account without approval.
2. **Overrides** name `automation` or a configured app identity (`AF_SCHEDULE_IDENTITIES`); "clear" goes back to the
   definition/default. Operators (`Portal.Operator`) set them; each change is audited (`schedule.run_as_changed`, old
   and new identity, source).
   - **Read-only schedule:** takes effect at the next run.
   - **Write-capable schedule:** the schedule is **disabled** when its override changes; enabling it again goes through
     the existing two-person approval, whose message names the effective identity, and whose policy binds it
     (`policy.identity`) — an approval for another identity no longer applies.
3. **Permissions:** an override may only name an identity that already holds the application permissions the job
   declares (checked live through Graph as content health does, `contentHealth` scopes). Otherwise the API refuses
   with the permissions missing and the fix ("name the identity on the schedule in content, or make it the default for
   reports, then `adminforge provision entra`"). Provisioning and `validate --scopes` take the env defaults into account
   (they read the env file); content health checks every schedule against its effective identity, overrides included.

### Tasks

1. **Config** (`adding-a-configuration-key`): `AF_SCHEDULE_DEFAULT_IDENTITY`, `AF_SCHEDULE_DEFAULT_IDENTITY_REPORTS`
   in `config/example.env` (Named app identities section), the API config schema
   (a name in `AF_SCHEDULE_IDENTITIES` or `automation`; problems name keys only), `adminforge env check`.
2. **Resolver** (`portal/packages/schemas/src/schedule.ts`, shared by API and CLI): `effectiveIdentity(def,
   { override, defaults })` → `{ identity, source: 'override' | 'definition' | 'default' | 'automation' }`, with the rules
   above. Unit tests for every rule.
3. **Store:** a `schedule_run_as` table (schedule key PK, identity text, set_by, set_at) — Drizzle schema +
   generated migration (`pnpm --filter @adminforge/api db:generate`); memory and SQLite stores.
4. **API:** `PUT /api/schedules/:key/run-as` `{ identity: 'automation' | '<app>' | null }` (`adding-an-api-route`):
   role check, content schedules only, news/contentHealth refused, live permission check, write-capable → disable,
   audit; schedule items carry `runAs: { identity, source }`; `ScheduleIdentities.prepare` and content health use the
   effective identity; the enable approval's message and policy carry it. Contract in `@adminforge/schemas`
   (`api.ts`), documented in `docs/api.md`.
5. **Provisioning and validate:** the CLI resolves each content schedule's identity with the env defaults when it
   computes an identity's permissions (`provision entra`, `validate --scopes`).
6. **Web** (`adding-a-coded-screen`): the schedule page's "Run as" field (Operators; content schedules) with its
   source ("default for reports", "set here", "from content"), the write-capable warning ("turns the schedule off; a
   second person approves turning it on"), errors from the permission check; the schedules list shows the effective
   identity.
7. **Tests:** resolver unit tests; API tests (roles, refusals, permission check, write-capable disable + approval
   binding, audit, content health with overrides); CLI tests (defaults in provisioning); component tests for the field
   (axe, keyboard); an e2e screenshot of the field in steel and daylight.
8. **Docs:** ADR-014 addendum (defaults and overrides), `docs/operations.md` (choosing accounts), `docs/access.md`,
   `SECURITY.md` (who can re-point a schedule, why write-capable needs approval), `CHANGELOG.md`, the skills that
   describe schedule identities (`adding-a-schedule-or-probe`).

---

## Part 2 — Credentials from Vault

### Shape

- **Configuration** (all optional; Vault is off unless `AF_VAULT_ADDR` is set):
  `AF_VAULT_ADDR` (https), `AF_VAULT_AUTH` (`kubernetes` default | `approle` | `token`), `AF_VAULT_AUTH_MOUNT`
  (default `kubernetes` / `approle`), `AF_VAULT_ROLE` (Kubernetes auth role), `AF_VAULT_ROLE_ID` +
  `AF_VAULT_SECRET_ID_FILE` (AppRole), `AF_VAULT_TOKEN_FILE` (token), `AF_VAULT_K8S_TOKEN_FILE` (default the pod's
  service-account token), `AF_VAULT_NAMESPACE` (Vault Enterprise), `AF_VAULT_CA_FILE`, `AF_VAULT_KV_MOUNT` (default
  `secret`), `AF_VAULT_PATH` (default `adminforge/<AF_ENV_LABEL>`), `AF_VAULT_REFRESH_SECONDS` (default 300).
- **Secrets:** one KV v2 secret per identity at `<AF_VAULT_PATH>/identities/<name>` (`automation` for the automation
  identity): `client_id`, and `client_secret` or `certificate_pem` (certificate + private key). With Vault on, the env
  keys for those identities' credentials must be empty (`env check` and start-up say which), so there is one source.
- **Runtime** (`portal/apps/api/src/auth/vault.ts`): log in (Kubernetes JWT, AppRole or token file), read each
  identity's secret, keep it in memory; refresh every `AF_VAULT_REFRESH_SECONDS`, and at once when Microsoft rejects a
  credential (`invalid_client`); renew or log in again before the Vault token expires. If Vault is unreachable the last
  good credentials stay in use and the platform probe says so; an identity that never loaded fails its runs with
  `credential_unavailable` (message and hint name the Vault path, never a value). Values are never logged, put in errors,
  audit details or run outputs.
- **Wiring:** `createAppIdentityRegistry` takes a credential source (`env` today, `vault`); `createAppTokenProvider`
  takes a credential getter and rebuilds its MSAL client when the credential changes.
- **Visibility:** `adminforge env check` (keys and states) and a `platform` probe "Credentials from Vault" with a remedy.
  `provision status` doesn't read Vault (it runs on an operator's machine, which has no Vault login): the probe shows
  each identity's state.
- **Deployment:** the Kubernetes README (Vault section: policy, auth role bound to the AdminForge service account,
  NetworkPolicy egress to Vault, moving today's credentials in with `vault kv put`), `docs/operations.md`
  (rotation), ADR-018 (credentials from Vault), `SECURITY.md` (token custody).

### Tasks

1. Config keys + validation + `env check` (`adding-a-configuration-key`).
2. A stand-in Vault for tests (`tests/support/vault/fake-vault.ts`: Kubernetes and AppRole login, token TTL and renew,
   KV v2 read, 403/404/503) and the Vault client with its tests (login per method, namespace header, CA, refresh, renew,
   unreachable → last good, never a value in an error).
3. The credential source and the token provider changes (rotation without restart) with tests.
4. Probe, docs, ADR-018.

---

## Checks before merging (each part)

`pnpm guard`, `pnpm lint`, `pnpm typecheck`, `rtk proxy pnpm format:check`, `pnpm test`, the touched e2e specs (look at
the screenshots), `adminforge validate`; reviewer agents: `security-reviewer` (identities, approvals, Vault),
`design-reviewer` (the Run as field). GitHub Actions can't start jobs on this account (billing): merge on the local
gate.
