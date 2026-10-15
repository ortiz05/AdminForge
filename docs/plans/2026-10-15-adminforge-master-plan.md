# AdminForge — Master Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> UI work also uses frontend-design:frontend-design and dataviz — but the visual direction is **already decided in §6**. Follow it; do not re-invent it per page.
> Steps marked 🔑 need the user's tenant access. Never ask the user to paste passwords or secrets into chat — they sign in interactively (`! az login …`) and secrets go to Key Vault or `.env.local` (git-ignored).

**Goal:** A web portal where enterprise systems engineers sign in with their own Entra ID SSO identity and administer Entra ID, Microsoft 365, and Azure (including Azure Functions) entirely through **delegated** permissions — read-only by default, with explicit, time-boxed write access — and where pages, dashboards, reports, playbooks, and runbooks are declarative content that can be added or changed without redeploying.

**Architecture:** A React SPA served by a Node.js backend-for-frontend (BFF) that owns the OIDC session and keeps every token server-side. Two Entra app registrations split read and write at the token level, and the BFF applies a default-deny request policy on top. A definition registry (YAML in Git → PostgreSQL, hot-reloaded) drives a widget renderer and a playbook engine. PowerShell-only workloads (Exchange Online, Teams, SharePoint admin) run in an isolated pwsh runner using the user's forwarded delegated tokens. Every visual attribute comes from one design-token source compiled to CSS variables, with audited runtime overrides.

**Tech Stack:** TypeScript on Node 24 · pnpm workspaces + Turborepo · React 19, Vite, TanStack Router / Query / Table / Virtual, Radix primitives, Tailwind CSS v4 (token-only theme), tailwind-variants, Apache ECharts, cmdk, Phosphor icons, Monaco · Fastify 5, @azure/msal-node, Drizzle ORM + PostgreSQL 17, pg-boss, JSONata, zod · PowerShell 7 runner (Microsoft.Graph, ExchangeOnlineManagement, MicrosoftTeams, PnP.PowerShell, Az) · Azure Container Apps, Azure Database for PostgreSQL Flexible Server, Key Vault, Azure Container Registry, Log Analytics + Application Insights via OpenTelemetry · Bicep + Microsoft Graph Bicep extension for Entra objects · GitHub Actions with OIDC · Vitest, Testing Library, axe-core, Playwright (system Chrome).

---

## Revision 2 (2026-10-15) — overrides everything below where they conflict

Requested by the owner after v1 of this plan. Where a section below disagrees with this block, **this block wins**.

### R1. Name and identity
- Product name **AdminForge**. npm scope `@adminforge/*`, CSS prefix `--af-*`, CLI `adminforge`, cookie `__Host-adminforge` (`adminforge-dev` locally), header `X-AdminForge-CSRF`.
- Repo: `https://github.com/ortiz05/AdminForge` (origin). Branch `main`; feature branches per phase.

### R2. Nothing tenant- or app-specific is committed
- Tenant ID, client IDs, secrets, domains, subscription IDs, group IDs, host names: **configuration only**, read from env files outside git (default `~/.config/adminforge/<env>.env`, override with `ADMINFORGE_ENV_FILE`). The repo ships `config/example.env` with every key documented and empty.
- Content YAML never contains tenant values; it may reference `${env.X}` keys declared in `config/example.env`.
- Fixtures are synthetic or sanitised (`Example Org`, `example.com`, generated GUIDs).
- Guard test `tests/guards/no-tenant-data.test.ts` fails CI if any committed file contains a GUID or domain from the local env file (when present) or any secret-looking string; a pre-commit hook runs the same check.
- Entra objects are created by an idempotent **provisioning command** (`adminforge provision entra`) that reads config and writes the resulting IDs back to the local env file — not by committed parameter files. (Bicep for Azure resources stays optional; the Graph-Bicep route is dropped because it needs an ARM deployment scope.)

### R3. Repository split: runtime vs. tests
```
AdminForge/
├─ portal/                 everything needed to run AdminForge (no test dependencies anywhere in here)
│  ├─ apps/                web · api (+worker) · scheduler · runner
│  ├─ packages/            design-tokens · ui · widgets · schemas · expressions · connectors · engine
│  ├─ content/             pages · dashboards · reports · playbooks · runbooks · schedules · probes · scripts · navigation
│  ├─ tools/cli/           adminforge CLI (provision, new, validate, publish, schedule, …)
│  ├─ deploy/              docker-compose (host), systemd units, Caddy (TLS), Dockerfiles
│  └─ infra/               optional Azure Bicep
├─ tests/                  every test and every test-only dependency (its own package.json)
│  ├─ unit/<package>/      vitest
│  ├─ component/           vitest + Testing Library + axe
│  ├─ api/                 Fastify inject + test Postgres
│  ├─ content/             schema/expression/playbook tests over portal/content
│  ├─ e2e/ visual/         Playwright (system Chrome)
│  ├─ live/                opt-in smoke tests against a real tenant (config-driven)
│  ├─ guards/              no-tenant-data, no-secrets, token guardrails
│  └─ fixtures/            synthetic data for mock mode and tests
├─ config/example.env
└─ docs/                   plans · adr · decisions · licensing-review · runbooks
```
Paths below written as `apps/…`, `packages/…`, `content/…`, `tools/…`, `infra/…` live under `portal/`. Test files written next to packages (e.g. `packages/ui/test/x.test.tsx`) live under `tests/unit/<package>/` or `tests/component/` instead. Mock mode reads fixtures from `ADMINFORGE_FIXTURES_DIR` (default `tests/fixtures`); a production build never needs `tests/`.

### R4. Colour, renamed for the forge
The concept: **cold steel while reading, hot iron when armed.** The neutrals are steel greys, the accent is *temper blue* (the oxide blue tempered steel takes), and write mode glows *ember*. Status colours take forge names (patina, straw, cinder). Values were contrast-checked (Steel `fg`/`canvas` 13.9:1, `fg-3`/`raised` 4.99:1, accent/`raised` 6.78:1, `armed`/`canvas` 6.59:1; Daylight `fg`/`canvas` 15.2:1, `armed`/`canvas` 5.15:1); chart palette re-validated on the new surface (all checks PASS).

| Token | Steel (dark, default) | Daylight (light) |
|---|---|---|
| canvas / panel / raised / sunken | `#12171B` / `#161C21` / `#1B2228` / `#0D1114` | `#EEF1F3` / `#FFFFFF` / `#F7F8F9` / `#E2E6EA` |
| line / line-strong | `#283139` / `#343F49` | `#E2E6EA` / `#CBD3DA` |
| fg / fg-2 / fg-3 | `#DDE3E8` / `#AAB5BF` / `#84919D` | `#161C21` / `#3D4954` / `#57636E` |
| accent (temper) / accent-strong | `#82A9EE` / `#A9C4F5` | `#2E5FA8` / `#234B86` |
| armed (ember) / on-armed | `#F47A2E` / `#0D1114` | `#A8480B` / `#FFFFFF` |
| ok (patina) · warn (straw) · crit (cinder) | `#5DC2A2` · `#E6C36A` · `#F27474` | `#1E6E58` · `#86650F` · `#B03030` |

Themes: **Steel**, **Daylight**, **High contrast**. Wordmark: "Admin" in `fg-2` weight 500 + "Forge" in `fg` weight 700, Archivo `wdth 118`; mark = a minimal anvil glyph in temper blue. Ember stays reserved for the armed state — it never appears in the logo, charts, or status.

### R5. Hosting: this host first
Primary runtime is **this Linux host**: `portal/deploy/docker-compose.yml` runs postgres, api, worker, scheduler, runner; optional Caddy for TLS; systemd unit to keep it up. Azure Container Apps (§11) remains an optional target with the same images. `PUBLIC_BASE_URL` is configuration.

### R6. Schedules on this host (supersedes the "no unattended automation" scope line and amends ADR-010)
- New service `portal/apps/scheduler` (pg-boss cron, time-zone aware) runs **on this host**.
- Job kinds: **report** (generate → file / email / Teams), **playbook action**, **synthetic test** (probes: Graph and ARM reachability/latency, token acquisition, sign-in health via sign-in logs, HTTP endpoint checks, TLS certificate and domain expiry, Function App health, app-credential expiry, licence-seat thresholds), **runner script**, **content health** (definitions still valid against current permissions).
- **Identity (ADR-011):** interactive work stays delegated. Unattended schedules run as a configured **automation identity** — a separate app registration with application permissions, certificate preferred (secret supported), credentials in local config only. Each schedule declares the permissions it needs; `adminforge validate --scopes` checks them against the automation identity. Write-capable schedules need two-person approval to enable, and every run is audited as "scheduled by <user>, executed as <automation identity>".
- UI: Schedules page (list, calendar/next runs, enable/disable, run now, history, last result, failure alerts), schedule editor (cron builder with plain-language preview, time zone, retry policy, notifications).

### R7. Extending AdminForge with Claude Code (key development principle)
There is **no AI feature inside the portal**. Instead, the repository is built so any engineer can extend AdminForge consistently by working in **Claude Code**:
- `CLAUDE.md` (repo root) — architecture map, non-negotiable rules (config-only tenant data, tests under `tests/`, tokens-only UI, content-first, delegated vs automation identity, read/write policy), and the verification commands.
- Project skills in `.claude/skills/` for every extension point: adding a page/dashboard, report, playbook, runbook, schedule, probe, widget, connector/service, runner script, API route, and design-token change. Each skill names the files to touch, the schema to follow, the scaffold command, and the exact validation/test commands. Skills are written test-first (baseline agent run without the skill → skill → re-run).
- Reviewer subagents in `.claude/agents/` (content reviewer, security reviewer, design-system reviewer) that check new work against the rules.
- Hooks in `.claude/settings.json` that validate as work is written (content YAML validated on save, guard tests before commit).
- `docs/extending.md` — the human-readable guide to the same workflows.
The scheduler's "quick ways to build new scheduled tasks" are therefore the `adding-a-schedule` / `adding-a-probe` skills plus `adminforge new schedule|probe`, not an in-app assistant.

### R8. Expanded management surface (adds to Appendix A)
Entra ID: users, **groups (security, M365, dynamic) and membership**, **directory roles & PIM**, **app registrations and enterprise apps** (credentials, owners, consent grants, assignments), **Conditional Access** (view, what-if, manage via approved playbooks), **Entra devices** (Azure AD joined/registered/hybrid), auth methods, sign-in and audit logs, named locations. Exchange Online: mailboxes, **distribution lists** and mail-enabled security groups, shared mailboxes, permissions, forwarding, mail flow. Teams, SharePoint/OneDrive. Intune: devices, compliance, configuration, apps, actions. Defender: incidents, alerts, Secure Score, vulnerability (as licensed), Defender for Cloud recommendations/alerts. Azure: subscriptions, resource groups, resources, **Azure Arc** servers/K8s (Resource Graph `microsoft.hybridcompute/machines`, extensions, connectivity), **monitoring** (Azure Monitor alerts, metrics, Log Analytics), Function Apps, RBAC. Plus portal-level: dashboards, reports, schedules, synthetic monitoring, audit.

### R9. Admin-grade data handling everywhere
Every list view gets: column filters + faceted filters + free-text search, a query builder for advanced filters (compiled to OData/KQL server-side), sortable/reorderable/hideable columns, density toggle, **multi-select with bulk actions** (bulk actions are playbooks with `forEach`), saved views (personal/shared), export (CSV/XLSX), deep-linkable state, keyboard navigation — benchmarked against the Entra/Intune admin centers, CIPP, and ManageEngine-style tools.

### R10. Licensing realities are captured, not blocking
`docs/licensing-review.md` lists every feature whose live validation is blocked by tenant licensing or permissions, what was built anyway (fixture-backed, UI shows "Requires <licence>" state with the exact SKU/service plan), and what the owner needs to enable. Work continues on everything else.

### R12. KQL at scale for monitoring, schedules, and configuration checks
Where per-object Graph calls (even `$batch`, 20 requests per call) are too slow for tenant-wide questions, AdminForge queries in **KQL**:
- **Azure Resource Graph** (`resourceGraph` datasource) — inventory, configuration and policy state across every subscription in one query (`resources`, `resourcecontainers`, `securityresources`, `policyresources`, `alertsmanagementresources`, `advisorresources`, Arc `microsoft.hybridcompute/*`).
- **Log Analytics / Azure Monitor Logs** (`logAnalytics`) — sign-in and audit logs exported from Entra (diagnostic settings; needs Entra ID P1 for sign-in logs), `AzureActivity`, function/app telemetry, and AdminForge's own probe history if exported.
- **Microsoft Defender advanced hunting** (Graph `POST /security/runHuntingQuery`, allowed in read mode) — device, identity, email and cloud-app tables (Defender licences).
Consequences:
1. **Configuration checks**: a probe check kind `kql` (`source: resourceGraph | logAnalytics | advancedHunting`, `query`, `metric: rowCount | column:<name>`, warn/crit thresholds, `details` = the offending rows, capped) — e.g. storage accounts allowing public blob access, NSG rules open to the internet, disconnected Arc machines, non-compliant policy states, sign-in failure spikes, risky OAuth consents. Results land in `probe_results` with the violating rows for drill-down.
2. **Schedules** run KQL reports and checks unattended as the automation identity (Reader on the subscription; `Data.Read` on workspaces; `ThreatHunting.Read.All` app permission for advanced hunting when licensed).
3. **Query Studio** page (`/query`): Monaco KQL editor with source picker, results as table/chart, row-count and timing, history, and "Save as report / probe / schedule" which scaffolds valid YAML (the same files `adminforge new` creates) for review.
4. `$kql(s)` expression helper for safe KQL string literals; the content linter flags user input concatenated into KQL without it.
5. Config: `AF_LOG_ANALYTICS_WORKSPACE_ID` (default workspace); provisioning grants the automation identity `Log Analytics Reader` on that workspace.

### R11. Validation identity in the test tenant
The owner granted Global Administrator in the test tenant for setup and validation. Bootstrap uses the provided app credential (config only). For delegated end-to-end tests, provisioning creates a dedicated test user (password in local config only) with least-privilege roles, used by Playwright to sign in. Live write tests target only `AF-Test-*` objects that provisioning creates.

---

## Contents

1. How this plan is used
2. Scope and principles
3. Architecture decisions (ADR index) and open decisions
4. System architecture and key flows
5. Identity, permissions, and security model
6. Design system and UI (central control)
7. Content framework: pages, dashboards, reports, playbooks, runbooks
8. Data model
9. API surface
10. Repository layout
11. Infrastructure and environments
12. Observability
13. Testing and the validation loop
14. Roadmap and gates
15. Phase 0 tasks — tooling and tenant discovery (bite-sized)
16. Phase 1 tasks — foundations (bite-sized)
17. Phases 2–8 task breakdowns
18. What I need from you
19. Risks and mitigations
20. Appendix A — starter catalog · Appendix B — permission matrix

---

## 1. How this plan is used

- **Phases end in gates.** Each gate (G0…G8) is a demo plus a checklist you approve before the next phase starts. Gates are where you review the portal and screenshots and redirect if needed.
- **Detail level.** Phases 0–1 are written as bite-sized TDD tasks with complete code. Phases 2–8 are task lists with files, interfaces, and acceptance criteria; each one is expanded into a bite-sized plan file (`docs/plans/<date>-phase-N-<name>.md`) at the start of that phase, because tenant discovery and Phase 1 learnings will change details. That's intentional, not a gap.
- **The iteration loop** (used in every phase):
  1. Build against **mock mode** (fixtures, no tenant needed) → unit/component tests green.
  2. Playwright screenshots in all themes × densities → visual review (by Claude, then by you at gates).
  3. 🔑 **Live validation** against your tenant, read-only first (smoke suite + you clicking through the dev environment).
  4. 🔑 Write paths validated **only on designated test objects** (test users, test groups, a test resource group), dry-run first.
  5. Fix → record learnings in `docs/decisions.md` → gate.
- **Work never blocks on credentials.** Everything up to the 🔑 steps in Phase 1 can be built and tested in mock mode while access is arranged.

---

## 2. Scope and principles

### In scope
- SSO sign-in with Entra ID; all admin operations run as the signed-in engineer (delegated).
- Read-only by default; **write mode** ("Arm") is a separate, time-boxed, step-up-authenticated session.
- Administration surfaces: Entra ID (users, groups, roles/PIM, auth methods, apps, sign-in/audit logs, CA read), Intune devices, Microsoft 365 (service health, message center, licensing, usage, Exchange Online, Teams, SharePoint), Defender/security signals, Azure (subscriptions, Resource Graph inventory, Function Apps and functions, metrics/logs), and calls to **your own Entra-secured Azure Functions**.
- Declarative, hot-reloadable **pages, dashboards, reports, playbooks, runbooks**, with scaffolding, validation, tests, versioning, and two-person publishing for write-capable content.
- One centrally controlled design system (tokens → components → templates) with runtime appearance overrides.
- Full audit trail of every write and every run.

### Out of scope (for now — noted so nobody is surprised)
- **Unattended/scheduled automation.** Delegated-only means something only runs while a signed-in person's session is alive. Scheduled reports or nightly jobs would need app-only permissions — a deliberate, separately approved addition later (see ADR-010).
- Multi-tenant / GDAP / partner scenarios (design keeps `tenantId` explicit so this stays possible).
- Replacing the Azure or M365 admin portals wholesale; deep links out to them where we don't add value.
- Mobile-first layouts (responsive down to tablet; phone is "usable", not optimized).

### Principles
1. **Delegated only.** No app-only Graph permissions. The portal can never do more than the engineer could do themselves.
2. **Read by default, write on purpose.** Write access is explicit, step-up authenticated, time-boxed, visibly signalled, and audited.
3. **Tokens never reach the browser.**
4. **Content over code.** A new page, report, or playbook should be a YAML file and a review — not a release.
5. **Show provenance.** Every number on screen can tell you which API, which endpoint, how fresh, and how long it took.
6. **One visual source of truth.** No page styles itself; everything flows from tokens and recipes.
7. **Least privilege, verified.** Scopes are declared by content and checked against what the app registrations actually hold.

---

## 3. Architecture decisions (ADR index)

Full ADRs live in `docs/adr/NNN-*.md` (written in Task 1.1). Summary:

| ADR | Decision | Why | Rejected alternative |
|---|---|---|---|
| 001 | **BFF holds all tokens**; SPA uses an HttpOnly session cookie. | Admin-grade scopes (e.g. `User.ReadWrite.All`) must not be stealable by XSS. The IETF OAuth browser-based-apps guidance favours a BFF for exactly this risk profile. | SPA + MSAL.js with tokens in browser storage. |
| 002 | **Two app registrations: Portal-Read and Portal-Write.** | An Entra access token carries every scope consented for that resource, not only the ones requested — so a single app cannot mint a genuinely read-only token once write scopes are consented. Two apps give a hard boundary, separate Conditional Access policies, and "assignment required" on Write. | One app with incremental consent. |
| 003 | **BFF default-deny request policy** for resources with coarse scopes (ARM `user_impersonation`, Exchange `Exchange.Manage`, Function APIs). | Those scopes can't express read-only; the BFF allowlists safe operations in read sessions (e.g. ARM `GET` + Resource Graph query; Exchange `Get-*` cmdlets only). | Trust RBAC alone. |
| 004 | **PostgreSQL is the only stateful dependency**: sessions, encrypted token cache, definitions, runs, audit, job queue (pg-boss); LISTEN/NOTIFY for hot reload and live run streaming. | One thing to secure, back up, and reason about. | Cosmos DB + Redis + Service Bus. |
| 005 | **Declarative content** (YAML validated by zod; JSON Schema emitted for editor autocomplete) with **JSONata** expressions; coded React pages as the escape hatch. | Fast authoring by systems engineers; safe, side-effect-free expressions; reviewable diffs. | Code-only pages; arbitrary JS in definitions. |
| 006 | **PowerShell runner = Container App** (Node supervisor + single-use, pre-forked pwsh workers); BFF forwards the user's delegated tokens per job. | Exchange/Teams/SPO admin is PowerShell-first. Single-use workers isolate users' tokens; pre-forking hides module import time; no 230 s HTTP limit; tokens never sit in a queue. Read/write separation is preserved because the BFF picks the Read or Write app's tokens. | Azure Functions PowerShell (230 s HTTP response limit, cold module loads, tokens in queue messages); OBO with extra app registrations. |
| 007 | **Design tokens in TypeScript → CSS variables** (`--af-*`), Tailwind v4 with its default palette and scales removed, tailwind-variants recipes, runtime overrides stored in settings. | Typed, testable (contrast is unit-tested), one file to change the whole look; Tailwind can only express token values. | Fluent UI theme (would look like the Azure portal); CSS-in-JS. |
| 008 | **Azure Container Apps** hosts BFF, workers, and runner in one environment with internal ingress for the runner. | Revisions, scale rules, internal networking, jobs. | App Service; Static Web Apps (its auth can't hold multi-resource tokens). |
| 009 | **Secretless in Azure**: managed identities; app registrations trust the BFF's managed identity via federated credential (certificate in Key Vault as fallback); Entra auth to Postgres; GitHub Actions OIDC. Client secret only for local dev, in `.env.local`. | No secrets to rotate or leak. | Client secrets in app settings. |
| 010 | **Runs need a live identity.** Background steps use the initiator's session token cache; steps after an approval gate run as the **approver** (who must be armed). Logout or disarm pauses runs at the next step that needs that identity/mode. | Keeps "delegated only" honest and gives four-eyes execution. | Stored service-account refresh tokens (that's app-only by another name). |

### Open decisions (defaults chosen; change any at G0)

| # | Decision | Default | Why it matters |
|---|---|---|---|
| D1 | Git host | GitHub (private repo; `gh` is installed) | CI/CD + content publishing pipeline |
| D2 | Network exposure of dev/prod | Dev: public ingress + Conditional Access (compliant device, MFA). Prod: decide at Phase 8 (private + VPN/ExpressRoute, or Front Door + WAF). | Attack surface |
| D3 | Azure region | One region close to your engineers (e.g. `eastus2`) | Latency, data residency |
| D4 | Naming prefix | `adminforge` | Resource and app names |
| D5 | CA authentication context for write mode | `c1` = "Admin write operations" requiring phishing-resistant MFA + sign-in frequency *every time* | Step-up strength (needs Entra ID P1) |
| D6 | Write session length | 60 min, max 240, extendable once | Blast radius vs friction |
| D7 | Portal role groups | New groups `SG-AdminForge-Readers/Operators/Authors/Approvers/Admins` | Who can do what in the portal |
| D8 | Device-code login for dev live tests | Allowed **only** for the dev app (CA exclusion) — otherwise you click through the deployed dev portal yourself | How Claude can run live smoke tests |
| D9 | Content source of truth | Git (`content/`) for managed content; portal-authored content lives in DB under a `local.` namespace (Phase 7) | Governance |

---

## 4. System architecture and key flows

### 4.1 Diagram

```
                    ┌───────────────────────────────── Microsoft Entra ID ───────────────────────────────────┐
                    │  AdminForge (Read)        AdminForge (Write)           AdminForge Runner API        │
                    │  delegated read scopes        delegated write scopes            app role Runner.Execute  │
                    │  app roles = portal roles     assignment required (Operators)   (BFF managed identity)   │
                    │  CA: baseline MFA             CA: auth context c1 (phish-resistant MFA, every time)      │
                    └───────▲──────────────────────────────▲──────────────────────────────────────────────────┘
                            │ OIDC auth code + PKCE        │ step-up ("Arm")
┌────────────────┐  cookie  │                              │
│  Browser SPA   │◄────────►┌──────────────────────────────────────────────────┐   delegated tokens  ┌──────────────────────────────┐
│  React + Vite  │ /api     │  BFF API  (Node 24 · Fastify)   Container App     │ ──────────────────► │ Microsoft Graph v1.0 (+beta)  │
│  no tokens     │ /auth    │  • sessions · MSAL token cache (AES-256-GCM)      │                     │ Azure Resource Manager        │
│  SSE for live  │ SSE      │  • request policy (default-deny in read mode)     │                     │ Azure Resource Graph          │
└────────────────┘          │  • definition registry (hot reload)               │                     │ Log Analytics / App Insights  │
                            │  • datasource executor · search                   │                     │ Your Entra-secured Functions  │
                            │  • playbook engine (pg-boss workers) · audit      │                     └──────────────────────────────┘
                            └────────┬───────────────┬───────────────┬──────────┘
                                     │ SQL, LISTEN   │ MI            │ internal HTTPS: job + user's tokens
                              ┌──────▼──────┐  ┌─────▼─────┐  ┌──────▼──────────────────────────┐  delegated  ┌──────────────────────┐
                              │ PostgreSQL  │  │ Key Vault │  │ PS Runner  (Container App,       │ ──────────► │ Exchange Online      │
                              │ Flexible    │  │ (cache    │  │  internal ingress only)          │             │ Teams admin          │
                              │ Server      │  │  key)     │  │  Node supervisor + pwsh 7        │             │ SharePoint admin     │
                              └─────────────┘  └───────────┘  │  single-use pre-forked workers   │             └──────────────────────┘
                                     ▲                         └──────────────┬───────────────────┘
                                     └──────────── step events (INSERT + NOTIFY) ┘
```

### 4.2 Components

| Component | Path | Responsibility |
|---|---|---|
| Web SPA | `apps/web` | Shell, routing, page renderer, widget registry consumers, playbook forms, run views, command palette. Holds no tokens. |
| BFF API | `apps/api` | Auth (read + write apps), sessions, token broker, request policy, datasource executor, definitions API, run orchestration, audit, SSE. Serves the SPA's static files (same origin → no CORS). |
| Worker | `apps/api` (same image, `ROLE=worker`) | pg-boss consumers executing playbook steps. |
| PS Runner | `apps/runner` | Executes pinned PowerShell scripts with forwarded tokens; streams events to Postgres. |
| Design tokens | `packages/design-tokens` | The visual source of truth; emits CSS, Tailwind theme, ECharts themes. |
| UI kit | `packages/ui` | Recipes, primitives, templates. Only consumer of tokens. |
| Widgets | `packages/widgets` | Declarative widget types (schema + component) registered by key. |
| Schemas | `packages/schemas` | zod schemas for all content kinds; JSON Schema export. |
| Expressions | `packages/expressions` | JSONata wrapper: templating, helpers (`$encode`, `$odata`), limits. |
| Connectors | `packages/connectors` | Graph / ARM / Resource Graph / Log Analytics / Function / Runner clients; paging, batching, retries, throttling; request policy. |
| Engine | `packages/engine` | Pure playbook execution engine with ports for persistence, tokens, and step handlers. |
| CLI | `tools/cli` | `adminforge new\|validate\|test\|publish\|fixtures` for content and scaffolds. |
| Content | `content/` | Pages, dashboards, reports, playbooks, runbooks, scripts, connections, navigation. |
| Infra | `infra/` | Bicep for Azure and Entra (Graph extension). |

### 4.3 Key flows

**Sign-in (read session)**
1. SPA calls `GET /api/me` → `401 {login: "/auth/login?returnTo=…"}` → browser navigates there.
2. BFF creates a pre-auth record (state, PKCE verifier, nonce, returnTo; 10-min TTL) and redirects to Entra with the **Read** app, `response_mode=query` (a `form_post` callback is cross-site, so a `SameSite=Lax` cookie would not be sent).
3. `GET /auth/callback` → `acquireTokenByCode` → session row created (id hashed at rest), MSAL cache sealed into `token_cache` under partition `read:<sessionId>`, cookie `__Host-adminforge` (HttpOnly, Secure, SameSite=Lax, Path=/) set → redirect to `returnTo`.

**Read datasource call**
1. SPA: `POST /api/datasources/execute {page:"identity.users", version, datasource:"users", params, cursor?}`.
2. BFF loads the *published* definition (the client never sends a raw Graph URL), validates params against the declared schema, renders the request with JSONata, runs the **request policy** for the session mode, gets a token (`graph`, mode `read`) from the token broker, calls Graph with `client-request-id = correlationId`, applies the `transform`, caches per **user + mode + datasource + params** (delegated results differ per user, so the cache is never shared), returns `{data, cursor, provenance:{service, path, ms, cachedAt, requestId}}`.

**Arm (write session)**
1. User clicks **Arm write access** → dialog (duration, reason — both required and audited) → `GET /auth/arm`.
2. BFF redirects to Entra with the **Write** app, `login_hint=<upn>`, and a `claims` request for `acrs=c1` (CA authentication context).
3. `GET /auth/arm/callback` → verifies the ID token `oid` equals the session's user and `acrs` contains `c1` → stores write account under partition `write:<sessionId>`, sets `writeExpiresAt` → audit `session.armed` → shell switches to armed state.
4. On expiry or **Disarm**: write account removed from cache, `session.disarmed` audited, UI returns to read.

**Playbook run**
1. `POST /api/runs {playbook, inputs, dryRun}` → validates inputs → `runs` row (pinned definition version + sha256) → pg-boss job → `202 {runId}`.
2. Worker executes steps in order; each step: evaluate `when` → render → policy check → (dry-run: record *plan entry* instead of calling) → call → persist step result → `NOTIFY run_events`.
3. SPA streams `GET /api/runs/:id/events` (SSE). Approval steps park the run (`awaiting_approval`); an approver approves while armed; remaining steps run with the approver's tokens.
4. Failure → `onError` policy; if configured, compensating steps run in reverse order.

**Runner (PowerShell) step**
1. Engine resolves the script by path and **sha256 pinned in the published definition**, collects only the services the script declares (`graph`, `exchange`, `teams`, `sharepointAdmin`, `arm`) as delegated tokens of the session's current mode.
2. BFF → runner `POST /jobs` (internal ingress; BFF managed-identity token with app role `Runner.Execute`), body = `{runId, stepId, script, sha256, inputs, tokens, mode, tenant}`.
3. Runner verifies the hash, hands the job to a pre-forked pwsh worker over **stdin** (never args/env), the worker connects (`Connect-ExchangeOnline -AccessToken …` with `-CommandName Get-*` in read mode), runs, emits NDJSON events; the supervisor writes them to `run_step_events` + `NOTIFY`; the worker exits.

**Definition publish (hot reload)**
`adminforge publish --env dev` (or CI on merge) → `POST /api/admin/definitions/publish` → new version rows → `NOTIFY definitions_changed` → every API replica drops its cache → SSE `definitions.changed` to browsers → TanStack Query invalidates → open pages re-render with the new definition. Runs already in flight keep their pinned version.

---

## 5. Identity, permissions, and security model

### 5.1 App registrations (created by `infra/entra/main.bicep`, Graph Bicep extension)

| App | Type | Redirect URIs | Credentials | Key settings |
|---|---|---|---|---|
| **AdminForge (Read)** | Web, single tenant | `https://<host>/auth/callback`, dev `http://localhost:5173/auth/callback` | FIC → BFF managed identity (prod); secret (dev only) | App roles (§5.3); `groupMembershipClaims: None`; ID token optional claims `acrs`, `login_hint`; assignment required = **yes** (Readers group and above) |
| **AdminForge (Write)** | Web, single tenant | `https://<host>/auth/arm/callback`, dev `http://localhost:5173/auth/arm/callback` | same | Assignment required = **yes**, assigned only to Operators; targeted by the write-mode CA policy |
| **AdminForge Runner API** | API only | — | none | Exposes app role `Runner.Execute` (assigned to the BFF's managed identity). No delegated permissions. |

Separate **dev** registrations (`… (Read) [dev]`) keep localhost URIs and secrets out of the production apps.

### 5.2 Permissions (summary — full matrix in Appendix B)

| Resource | Read app | Write app |
|---|---|---|
| Microsoft Graph | `User.Read.All`, `Group.Read.All`, `Directory.Read.All`, `AuditLog.Read.All`, `Reports.Read.All`, `Policy.Read.All`, `RoleManagement.Read.Directory`, `RoleEligibilitySchedule.Read.Directory`, `RoleAssignmentSchedule.Read.Directory`, `UserAuthenticationMethod.Read.All`, `Application.Read.All`, `DeviceManagementManagedDevices.Read.All`, `DeviceManagementConfiguration.Read.All`, `DeviceManagementApps.Read.All`, `SecurityAlert.Read.All`, `SecurityIncident.Read.All`, `IdentityRiskyUser.Read.All`, `ServiceHealth.Read.All`, `ServiceMessage.Read.All`, `Sites.Read.All`, `Team.ReadBasic.All`, `Organization.Read.All` | Start minimal and grow per playbook: `User.ReadWrite.All`, `User.EnableDisableAccount.All`, `User.RevokeSessions.All`, `GroupMember.ReadWrite.All`, `UserAuthenticationMethod.ReadWrite.All`, `RoleAssignmentSchedule.ReadWrite.Directory` (PIM self-activation), `DeviceManagementManagedDevices.PrivilegedOperations.All`, `Mail.Send` (notify step) |
| Azure Service Management | `user_impersonation` (policy: GET + Resource Graph only) | `user_impersonation` |
| Log Analytics API | `Data.Read` | — |
| Office 365 Exchange Online | `Exchange.Manage` (policy: `Get-*` only) | `Exchange.Manage` |
| SharePoint (admin) | — (Graph `Sites.Read.All` covers read) | `AllSites.FullControl` (only if SPO admin playbooks are approved) |
| Skype and Teams Tenant Admin API | `user_impersonation` (policy: `Get-*`) | `user_impersonation` |
| Your Function APIs | `<api>/user_impersonation` per connection | same, write-flagged operations only |

`adminforge validate --scopes` compares the union of `requires.scopes` across published content with what each app actually holds (read via Graph) and reports **missing** and **unused** scopes, so drift shows up in CI.

### 5.3 Portal roles (app roles on the Read app, assigned to groups)

| Role | Grants in the portal |
|---|---|
| `Portal.Reader` | Sign in; view pages, dashboards, reports; dry-run playbooks |
| `Portal.Operator` | Everything Reader can + arm write mode (requires assignment to the Write app as well) + execute write playbooks |
| `Playbook.Author` | Create drafts in the portal editor; run content tests |
| `Playbook.Approver` | Approve run approval gates; approve publishing of write-capable content (cannot approve their own) |
| `Portal.Admin` | Appearance settings, connections, feature flags, audit export, scope drift report |

Portal roles gate **features**. What an engineer can actually change is still decided by Microsoft: their Entra roles (and PIM activations), Azure RBAC, and Exchange/Teams RBAC.

### 5.4 Enforcement layers (all of them apply on every call)

1. **Portal role** (app roles in the ID token) → which pages and actions are offered at all.
2. **Session mode** → read sessions only hold Read-app tokens; write steps refuse to start unless armed.
3. **Token scopes** → Graph refuses writes made with a Read-app token.
4. **BFF request policy** (default-deny) → in read mode only allowlisted operations leave the BFF (ARM GET + Resource Graph; Log Analytics query; Exchange/Teams `Get-*`; Graph GET + allowlisted read POSTs like `/$batch` whose sub-requests are checked individually and `/security/runHuntingQuery`). In write mode, only operations declared by a **published** definition are allowed; there is no free-form write proxy.
5. **Microsoft's own authorization** → Entra roles, Azure RBAC, Exchange RBAC, PIM.
6. **Conditional Access** → baseline on Read; auth-context step-up on Write.

### 5.5 Sessions and tokens

- Session id: 32 random bytes, cookie `__Host-adminforge`; DB stores `sha256(id)` only.
- Idle timeout 60 min, absolute 12 h (configurable); sliding refresh on activity.
- MSAL Node `ConfidentialClientApplication` **per request** with a `DistributedCachePlugin`; partition key `read:<sid>` / `write:<sid>`; cache blobs sealed with **AES-256-GCM**, AAD bound to the partition key (a blob can't be replayed under another session). Key: 32 bytes stored in Key Vault, loaded at startup by managed identity, versioned for rotation (`v` prefix in the envelope).
- CSRF: `SameSite=Lax` + every non-GET `/api` call must carry `X-AdminForge-CSRF` matching a per-session token delivered in `/api/me`.
- Logout clears the session row, both cache partitions, then redirects to Entra end-session.

### 5.6 Write mode ("Arm")

- Preconditions: `Portal.Operator`; assigned to the Write app (Entra enforces); passes the CA auth context.
- Duration chosen in the dialog (15/30/60/…, capped by D6); one extension allowed without re-auth (configurable), then re-arm.
- Expiry handling: T-5 min toast offering **Extend**; at expiry the UI disarms; running playbooks pause at their next write step with status `awaiting_arm`.
- Every arm, extend, disarm, and expiry is audited with the stated reason.

### 5.7 PIM integration

- **Capabilities panel** (`/api/me/capabilities`): active and eligible Entra roles (`roleAssignmentScheduleInstances`, `roleEligibilityScheduleInstances` filtered to the user), plus Azure RBAC on the selected scope.
- **Activate role** playbook (`identity.pim-activate`, write mode): `POST /roleManagement/directory/roleAssignmentScheduleRequests` with `action: selfActivate`, justification, duration.
- After activation the BFF force-refreshes the user's tokens, because some role checks rely on role claims inside the token. The UI says plainly: "Role active. New permissions can take a few minutes to apply across Microsoft services."
- Pages and actions that need a role the user only holds as *eligible* show **Activate to use** instead of a dead button.

### 5.8 Continuous Access Evaluation and claims challenges

- MSAL configured with client capability `CP1`.
- A Graph `401` with `WWW-Authenticate: … error="insufficient_claims", claims="…"` becomes a structured `401 {reauth:{url, claims}}`; the SPA sends the user through re-auth with those claims and retries. Revoked sessions take effect within minutes instead of at token expiry.

### 5.9 Audit

- Append-only `audit_events` with a hash chain (`hash = sha256(prev_hash || canonical_json(row))`). `adminforge audit verify` re-walks the chain.
- Logged: sign-in, arm/extend/disarm, every write request (method, path, redacted body, Microsoft `request-id`, status), every run and step transition, approvals, definition publishes, appearance changes, admin setting changes.
- Mirrored to Application Insights `customEvents` (and optionally a Log Analytics custom table via DCR) so it lands next to your other security logs.
- Graph `client-request-id` = our correlation id, so a portal action can be traced to Microsoft-side logs and support tickets.

### 5.10 Threat model highlights

| Threat | Control |
|---|---|
| XSS steals tokens | No tokens in browser; strict CSP (`script-src 'self' 'nonce-…'`, no inline, `frame-ancestors 'none'`, `object-src 'none'`); React escaping; Markdown rendered with a sanitizer. |
| Session theft | `__Host-` HttpOnly Secure cookie; idle + absolute timeouts; write mode re-authenticates with phishing-resistant MFA; CAE. |
| Forged API calls | Client sends definition references only; server renders requests from published content; CSRF header; params validated by zod. |
| Injection into Graph/OData | Path segments always via `$encode()`; OData string literals via `$odata()` (escapes `'`); validator warns on raw `&` concatenation into `$filter`/`$search`. |
| Malicious or buggy content | Two-person publish for write-capable content; dry-run + plan view; content tests in CI; pinned versions + sha256 per run; `http` step limited to allowlisted hosts. |
| Script tampering | Runner executes only scripts whose sha256 matches the published definition; inputs passed as JSON on stdin, never string-interpolated into script text. |
| Over-privileged apps | Read/Write split; scope drift report; app instance property lock; app owners restricted to `Portal.Admin` group. |
| DB or backup leak | Token cache encrypted with a Key Vault-held key; session ids hashed; no secrets in DB. |
| Throttling or DoS of tenant APIs | Per-user and per-service concurrency limits, `Retry-After` honoured, `$batch`, caching. |
| Lockout by CA changes | CA policies created in report-only first; break-glass accounts excluded; the portal never manages its own CA policies. |

### 5.11 Conditional Access (proposed; created in report-only, enabled at G4)

1. **AdminForge – Read**: target Portal-Read; require MFA (or your existing baseline) + compliant/hybrid-joined device.
2. **AdminForge – Write step-up**: target authentication context `c1`; require *phishing-resistant MFA* authentication strength; sign-in frequency **every time**; compliant device.
3. Block device-code flow for Portal apps (except the dev app if D8 = allowed).

---

## 6. Design system and UI (centrally controlled)

### 6.1 Direction

- **Subject:** an operations console for senior systems engineers who live in it for hours, reading GUIDs, UPNs, resource IDs, and state.
- **Single job of every screen:** show state clearly, and let the engineer act safely.
- **Reference world:** glass-cockpit avionics and NOC consoles — calm, low-glare, dark-but-not-black surfaces where **color is reserved for meaning** (state, mode), not decoration; equipment-label typography for structure.
- **Signature — the Armed state.** The one bold move. In read mode the chrome is calm graphite with a cool *Glacier* accent. When an engineer arms write access, the session rail fills with *Ignition* orange carrying a faint 45° hazard-stripe texture, a 2 px Ignition ring frames the whole viewport, and a countdown (`ARMED · 47:12`) sits next to **Disarm**. Write actions that were locked (lock glyph, "Arm write access to use this") gain a small Ignition dot. It is functional: it tells someone at a glance that they're holding live write credentials — the thing that matters most in this tool.
- **Quiet detail — provenance footers.** Every widget ends with a muted mono line: `graph · /users · 1.2 s · cached 30 s ago`. It's transparency engineers trust, set small enough to stay out of the way.
- **Avoided defaults (why this isn't templated):** not near-black + acid green (canvas is blue-graphite `#131920`, accent is a cool Glacier blue, and orange appears *only* to mean "armed"); no cream/serif; no newspaper hairline grid. Type is chosen for **character legibility** (I/l/1, O/0) rather than fashion.

### 6.2 Color (semantic tokens; values verified)

All values below passed a contrast check (script in §16 Task 1.3 makes it a unit test): `fg` ≥ 7:1, `fg-2`/`fg-3`/`accent`/`armed`/status ≥ 4.5:1 on `canvas`, `panel`, and `raised`; `on-armed`/`on-accent` ≥ 4.5:1 on their fills. Measured: Graphite `fg`/`canvas` 13.8:1, `fg-3`/`raised` 4.91:1, `armed`/`canvas` 6.44:1; Paper `fg`/`canvas` 14.5:1, `armed`/`canvas` 5.20:1.

| Token | Graphite (dark, default) | Paper (light) | Contrast (HC dark) | Use |
|---|---|---|---|---|
| `canvas` | `#131920` | `#EEF1F4` | `#000000` | App background |
| `panel` | `#171E26` | `#FFFFFF` | `#0A0A0A` | Cards, tables |
| `raised` | `#1C242E` | `#F7F8FA` | `#141414` | Menus, popovers, hover rows |
| `sunken` | `#0E1318` | `#E2E7EC` | `#000000` | Code, logs, inputs |
| `line` / `line-strong` | `#29343F` / `#354352` | `#E2E7EC` / `#CDD5DD` | `#5A5A5A` / `#8A8A8A` | Borders |
| `fg` / `fg-2` / `fg-3` | `#DCE4EC` / `#A9B6C3` / `#8292A3` | `#17202A` / `#3E4C5B` / `#586777` | `#FFFFFF` / `#E6E6E6` / `#C8C8C8` | Text tiers |
| `accent` | `#7FB2E5` Glacier | `#2F6497` | `#9CCBFF` | Links, focus, selection, read-mode chrome |
| `armed` / `on-armed` | `#F27B2C` Ignition / `#0E1318` | `#A44A0C` / `#FFFFFF` | `#FFA261` / `#000000` | Write mode **only** |
| `ok` | `#5CC4A5` | `#1F6F5A` | `#6EE7B7` | Healthy, enabled, compliant |
| `warn` | `#E8C14F` | `#8A6410` | `#FFD966` | Degraded, expiring |
| `crit` | `#F07575` | `#B23131` | `#FF8A8A` | Failed, disabled, risky |
| `info` | = accent | = accent | = accent | Informational |

Status color always ships with an icon + label (never color alone). `armed` is never used in charts or status.

**Chart categorical palettes** (validated with the dataviz validator — lightness band, chroma, adjacent CVD ΔE ≥ 8, normal-vision ΔE ≥ 15, ≥ 3:1 vs surface; all PASS):
- Graphite: `#4A8AD8, #C9692A, #1F9C7E, #9775E2, #CB527F, #AD8826` (first three also pass *all-pairs*, so scatter/small-multiple charts cap at 3 series)
- Paper: `#2A6CC0, #C25A14, #178366, #7A55D0, #C2416F, #9A7300`
- More than 6 series → fold into "Other" or small multiples. Never generate hues.

### 6.3 Typography

| Role | Face | Why | Usage |
|---|---|---|---|
| Display | **Archivo** (variable; `wdth` 62–125) | Industrial, equipment-label character; the width axis gives two voices from one family | Page titles at `wdth 112`, weight 650; section eyebrows at `wdth 85`, uppercase, `+0.08em` tracking, 11 px. Used with restraint — titles, eyebrows, KPI numerals only. |
| Body / UI | **Atkinson Hyperlegible Next** | Designed for character disambiguation (I/l/1, O/0) — exactly what reading UPNs and names needs | All UI text, tables, forms |
| Data / code | **Atkinson Hyperlegible Mono** | Same legibility DNA for GUIDs, resource IDs, IPs, KQL, JSON, logs | `IdChip`, code, logs, provenance footers, tabular figures |

Self-hosted via Fontsource packages (verify exact package names at install; fallback is self-hosted woff2 from Google Fonts in `apps/web/public/fonts`). No third-party font CDN, so the CSP stays `font-src 'self'`.

Type scale (px): `2xs 11 · xs 12 · sm 13 · md 14 · lg 16 · xl 20 · 2xl 24 · 3xl 32 · 4xl 40`. UI base is 14 px (comfortable) / 13 px (compact).

### 6.4 Space, shape, motion, density

- Spacing: 4 px grid (`1=4 … 16=64`).
- Radius: `sm 3 · md 6 · lg 10 · xl 14 · pill 999`. Panels use `lg`, controls `md`.
- Elevation: borders do most of the work on dark; shadows only for floating layers (menus, drawers, palette).
- Motion: `fast 120ms`, `base 200ms`, `slow 320ms`, easing `cubic-bezier(0.2,0,0,1)`. The **one** orchestrated moment is arm/disarm (the rail fills left→right in 320 ms, the ring fades in). Everything else is state feedback only. `prefers-reduced-motion` → instant.
- Density modes (per-user, admin default): **Comfortable** (control 34 px, row 40 px) and **Compact** (control 28 px, row 30 px).

### 6.5 Shell layout

```
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◧ Example Org · AdminForge   [⌘K  Jump to user, device, resource, playbook…]   ◉ READ-ONLY  [Arm]│ ← session rail (48px)
│                                                                       PIM: 1 active · 2 elig. │   armed: Ignition fill,
├──────────┬─────────────────────────────────────────────────────────────────────┬──────────────┤   stripe texture, countdown
│ IDENTITY │ IDENTITY / USERS                                     ⟳ Refreshed 30s │  INSPECTOR   │
│  Users   │ Users                                         [Saved views ▾] [⇩ CSV]│  (drawer,    │
│  Groups  │ ┌ filter bar: Type ▾  Status ▾  Department ▾  License ▾  🔍 search ┐  │  440px)      │
│  Roles   │ └──────────────────────────────────────────────────────────────────┘  │  j.doe@…     │
│ DEVICES  │ ┌ KPI ─────┐┌ KPI ─────┐┌ KPI ─────┐┌ KPI ─────┐                       │  Overview    │
│ M365     │ │ 12,408   ││ 311      ││ 97       ││ 4.2%     │                       │  Groups      │
│ AZURE    │ │ Members  ││ Guests   ││ Disabled ││ No MFA   │                       │  Devices     │
│ SECURITY │ └──────────┘└──────────┘└──────────┘└──────────┘                       │  Sign-ins    │
│ AUTOMATE │ ┌ table (virtualized, sticky header, column chooser) ─────────────────┐│  Actions ▸   │
│  Runs    │ │ Name / UPN            Status    Dept     Last sign-in   ⋯           ││   Reset MFA 🔒│
│ REPORTS  │ │ …                                                                   ││   Disable  🔒│
│ ADMIN    │ └─────────────────── graph · /users · 1.2 s · cached 30 s ago ────────┘│              │
├──────────┴─────────────────────────────────────────────────────────────────────┴──────────────┤
│ RUNS ▸ Offboard j.doe — step 4/9 running   ✓ Issue TAP a.lee 2m ago                    [Open] │ ← run dock (36px)
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Nav** is generated from content (`nav:` block in each page definition + `content/navigation.yaml` for section order); collapsible to a 56 px icon rail.
- **Command palette** (`Ctrl/⌘+K`): jump to pages, recent items, users, groups, devices, resources (Resource Graph), playbooks; prefix commands (`>` actions, `#` runs, `@` users).
- **Inspector** drawer: entity detail without leaving the list; deep-linkable (`?inspect=user:<id>`).
- **Run dock**: live runs via SSE; click to open the run timeline.

### 6.6 Page templates (every page uses one)

| Template | For | Regions |
|---|---|---|
| `dashboard` | Overviews | header · filter bar · 12-column widget grid |
| `list-detail` | Users, groups, devices, resources | header · filter bar · KPI strip (optional) · table · inspector |
| `entity` | One user/device/resource | identity header (name, IdChips, status) · tabs · action bar |
| `report` | Exportable tabular reports | header · parameters · summary · table · export bar |
| `playbook` | Launch a playbook | summary · risk banner · generated input form · preflight checks · dry-run plan · run |
| `run` | One run | status header · step timeline · logs · outputs · approvals |
| `runbook` | Guided procedures | document column (Markdown) with inline executable steps and checklists · progress rail |
| `settings` | Admin pages | section nav · forms |

### 6.7 Component inventory (`packages/ui`)

Primitives: `Button`, `IconButton`, `Field`/`TextInput`/`Select`/`Combobox`/`Checkbox`/`Switch`/`Textarea`, `Tabs`, `Tooltip`, `Popover`, `Menu`, `Dialog`, `ConfirmDialog` (typed confirmation: "Type j.doe@contoso.com to confirm"), `Drawer`, `Toast`, `Badge`, `StatusPill`, `IdChip` (`3f2a…9c1d` + copy + full value on hover), `Panel`, `Kpi`, `Sparkline`, `Chart` (ECharts wrapper bound to token themes), `DataTable` (TanStack Table + Virtual), `FilterBar`, `PageHeader`, `Breadcrumbs`, `EmptyState`, `ErrorState`, `Skeleton`, `CodeBlock`, `LogView`, `Timeline`, `ProvenanceFooter`, `ArmControl`, `CommandPalette`, `EntityPicker` (user/group/device/resource search).

### 6.8 Central control model

```
tokens.ts  ──build──►  tokens.css (--af-*)  ──►  tailwind-theme.css (@theme inline, defaults removed)
   │                        │                              │
   │                        └── runtime overrides ◄────────┤  /api/appearance.css (settings, audited)
   ├──► echarts-<theme>.json (chart themes)                │
   └──► tokens.d.ts (typed)                                ▼
                                       recipes (tailwind-variants)  ──►  primitives  ──►  templates  ──►  pages & widgets
```

1. **Tier 1 — primitives** (`primitives.color.*`): raw ramps. Only themes reference them.
2. **Tier 2 — semantic** (`themes.<name>.*`): `canvas`, `fg`, `accent`, `armed`, `ok`… Components use only these.
3. **Tier 3 — component** (`components.*`): `button-radius`, `panel-radius`, `table-row-h`, `kpi-value-font`… Change one line and every instance follows.
4. **Recipes** (`packages/ui/src/recipes/*.ts`): the only place variants and sizes are defined (`button({intent, size})`).
5. **Templates**: pages compose templates; they never lay themselves out.
6. **Runtime overrides** (Admin → Appearance): an allowlisted set of tokens (accent per theme, radius scale, default density, base font size, chart palette order), live preview, automatic contrast check (overrides that fail AA are rejected), publish/rollback, audited. Served as `/api/appearance.css` after `tokens.css`.
7. **Guardrails**: Tailwind's default colors, radii, shadows, and fonts are removed (`--color-*: initial` etc.), so only token utilities exist; ESLint bans hex/rgb literals and arbitrary Tailwind values (`[#…]`, `[13px]`) outside `packages/design-tokens`; Stylelint bans raw colors in CSS; visual regression screenshots catch drift.

### 6.9 Copy rules

- Name things by what engineers control: "Sign-in", "Group membership", "Write access" — not "token", "PATCH", "scope" (technical detail lives in provenance and the dry-run plan).
- Buttons say exactly what happens; the result echoes it: **Disable sign-in** → toast "Sign-in disabled for j.doe@contoso.com".
- Sentence case. No filler, no exclamation marks.
- Errors say what happened and what to do: "Microsoft Graph refused this change (403). Your account has no Entra role that allows disabling users. Activate *User Administrator* in PIM, or ask a Portal Admin." Never "Something went wrong".
- Empty states invite action: "No playbooks in this category yet. Create one with `pnpm adminforge new playbook`."
- Read-only lock tooltip: "Arm write access to use this."

### 6.10 Quality floor

- WCAG 2.2 AA (AAA for body text contrast); full keyboard operation; visible focus ring (`--af-focus`); axe checks in component tests and Playwright.
- Respect `prefers-reduced-motion`, `prefers-color-scheme` (initial theme), `forced-colors`.
- Performance budgets: initial JS ≤ 250 KB gzip (route-level code-splitting; ECharts and Monaco lazy-loaded), LCP ≤ 2.0 s on the dev environment, table scrolling at 60 fps with 10k rows (virtualized).
- Responsive to 1024 px with nav collapsed; inspector becomes a full-height sheet below 1280 px.

---

## 7. Content framework

### 7.1 Layout

```
content/
  navigation.yaml                 # section order, labels, icons
  connections/                    # external APIs (your Function Apps etc.)
    hr-sync.connection.yaml
  pages/
    identity/users.page.yaml
    identity/user.page.yaml       # entity template
  dashboards/
    overview.dashboard.yaml
  reports/
    identity/app-credential-expiry.report.yaml
  playbooks/
    identity/disable-user.playbook.yaml
  runbooks/
    incident/compromised-account.runbook.yaml
  scripts/                        # PowerShell, referenced by playbooks
    exchange/Get-MailboxForwarding.ps1
  fixtures/                       # sanitized recorded responses for mock mode & tests
```

### 7.2 Common envelope (all kinds)

```yaml
$schema: ../../../packages/schemas/generated/playbook.schema.json   # editor autocomplete
kind: playbook                 # page | dashboard | report | playbook | runbook | connection
id: identity.disable-user      # stable key: <section>.<name>
version: 1.2.0                 # semver; bump on every change
title: Disable sign-in
summary: Blocks sign-in and revokes all sessions for one user.
owner: identity-team           # who reviews changes
tags: [identity, incident]
requires:
  portalRoles: [Portal.Operator]
  scopes: { graph: [User.EnableDisableAccount.All, User.RevokeSessions.All] }
  entraRoles: [User Administrator]   # advisory: shown in preflight, enables "Activate in PIM"
```

### 7.3 Pages, dashboards, reports

```yaml
kind: page
id: identity.users
version: 1.0.0
title: Users
summary: Member and guest accounts in the tenant.
template: list-detail
nav: { section: identity, label: Users, icon: users, order: 10 }
requires: { portalRoles: [Portal.Reader], scopes: { graph: [User.Read.All, AuditLog.Read.All] } }

params:
  q:        { type: string, default: "", label: Search }
  userType: { type: enum, values: [All, Member, Guest], default: All, label: Type }
  enabled:  { type: enum, values: [Any, Enabled, Disabled], default: Any, label: Status }

datasources:
  users:
    source: graph
    request:
      method: GET
      path: /users
      headers: { ConsistencyLevel: eventual }
      query:
        $select: id,displayName,userPrincipalName,accountEnabled,userType,department,signInActivity
        $count: true
        $top: 100
        $filter: >-
          ${ $join([
               params.userType != 'All' ? "userType eq " & $odata(params.userType),
               params.enabled = 'Enabled' ? "accountEnabled eq true",
               params.enabled = 'Disabled' ? "accountEnabled eq false"
             ][$], ' and ') }
        $search: ${ params.q ? '"displayName:' & $odataSearch(params.q) & '"' }
    paging: cursor            # follows @odata.nextLink; table loads more on scroll
    cache: { ttl: 60 }
  counts:
    source: graphBatch        # one $batch round-trip for the KPI strip
    requests:
      members:  { path: /users/$count, query: { $filter: "userType eq 'Member'" }, headers: { ConsistencyLevel: eventual } }
      guests:   { path: /users/$count, query: { $filter: "userType eq 'Guest'" },  headers: { ConsistencyLevel: eventual } }
      disabled: { path: /users/$count, query: { $filter: "accountEnabled eq false" }, headers: { ConsistencyLevel: eventual } }
    cache: { ttl: 300 }

layout:
  - widget: kpi
    data: counts.members
    label: Members
  - widget: kpi
    data: counts.guests
    label: Guests
  - widget: kpi
    data: counts.disabled
    label: Disabled
    status: ${ value > 0 ? 'warn' : 'ok' }
  - widget: table
    span: 12
    data: users.value
    rowKey: id
    columns:
      - { field: displayName, label: Name, kind: identity, secondary: userPrincipalName }
      - { field: accountEnabled, label: Status, kind: status, map: { "true": [ok, Enabled], "false": [crit, Disabled] } }
      - { field: userType, label: Type }
      - { field: department, label: Department }
      - { field: signInActivity.lastSignInDateTime, label: Last sign-in, kind: relativeTime }
    inspect: { page: identity.user, params: { id: ${ row.id } } }
    rowActions:
      - { playbook: identity.reset-mfa,    inputs: { userId: ${ row.id } } }
      - { playbook: identity.disable-user, inputs: { userId: ${ row.id } }, when: ${ row.accountEnabled } }
```

- `dashboard` = same schema, `template: dashboard`, widgets placed on a 12-column grid with `span`/`rows`.
- `report` adds `export: { formats: [csv, xlsx], fileName: … }` and `summary` widgets; export streams **all pages** server-side (not just the visible rows) and is audited.
- Saved views: users save param sets per page (`saved_views`), optionally shared.

### 7.4 Widgets (`packages/widgets`)

Each widget is a folder: `schema.ts` (zod config), `Widget.tsx`, `fixtures.ts` (story data), `index.ts` (registers `{type, schema, component}`). The page renderer looks up `widget:` in the registry; unknown types fail validation, not at runtime.

Initial set: `kpi`, `table`, `chart` (line, area, bar, stacked bar, donut ≤ 6 slices, heat grid), `list`, `keyValue`, `statusGrid` (e.g. service health), `timeline`, `markdown`, `actionBar`, `iframeLink` (deep link out to Azure/M365 portals), `logQuery` (KQL result table + chart).

Chart rules (from dataviz): one y-axis only; legend for ≥ 2 series plus direct labels for ≤ 4; crosshair tooltip on line/area, per-mark tooltip on bars; table view toggle on every chart; colors assigned by entity in fixed order, never by rank.

### 7.5 Datasources and connectors

| `source:` | Connector | Notes |
|---|---|---|
| `graph` | `connectors/graph` | v1.0 default, `beta: true` opt-in (flagged in UI as preview); paging, `Retry-After`, `ConsistencyLevel` |
| `graphBatch` | `connectors/graph` | Named sub-requests, auto-chunked by 20 |
| `arm` | `connectors/arm` | `api-version` required per request |
| `resourceGraph` | `connectors/arm` | KQL across subscriptions/management groups; skip-token paging |
| `logAnalytics` | `connectors/loganalytics` | KQL against a workspace; timespan from page time-range |
| `function` | `connectors/function` | Calls an Entra-secured Function via a `connection` (audience, base URL, read/write operation allowlist) |
| `runner` | `connectors/runner` | PowerShell script (Phase 6) |
| `static` | — | Inline data for prototypes and tests |

Every connector returns `{data, provenance}` and throws typed errors (`GraphError{status, code, requestId, claims}`) that the UI maps to the copy rules in §6.9.

### 7.6 Expressions (JSONata)

- Any string that is **exactly** `${ … }` evaluates to a typed value; strings containing `${ … }` segments interpolate to a string.
- Scope: `params`, `inputs`, `row`, `value`, `steps.<id>.output`, `run`, `user` (`oid`, `upn`, `roles`), `env` (tenant id, domains), `now`.
- Helpers: `$encode(s)` (URL path segment), `$odata(s)` (quoted OData string literal with `'` escaped), `$odataSearch(s)` (escapes `"` and `\`), `$guid(s)` (validates or throws), `$daysAgo(n)`, `$iso(d)`.
- Limits: evaluation timeboxed (250 ms) and depth-limited; no I/O; only content authors write expressions — user input only ever arrives as data in `params`/`inputs`.

### 7.7 Playbooks and runbooks

```yaml
kind: playbook
id: identity.disable-user
version: 1.0.0
title: Disable sign-in
summary: Blocks sign-in and revokes all sessions for one user.
risk: high                       # low | medium | high | critical → drives confirmation & approval defaults
mode: write
requires:
  portalRoles: [Portal.Operator]
  scopes: { graph: [User.EnableDisableAccount.All, User.RevokeSessions.All] }
  entraRoles: [User Administrator]
confirm: { type: typed, value: ${ steps.lookup.output.userPrincipalName } }
approval: { required: false }    # e.g. { required: true, approvers: [Playbook.Approver], minApprovals: 1, expiresIn: PT4H }

inputs:
  userId: { type: string, format: guid, label: User, picker: user }
  reason: { type: string, label: Reason, minLength: 10, multiline: true }

steps:
  - id: lookup
    type: graph
    mode: read
    request:
      method: GET
      path: /users/${ $encode(inputs.userId) }
      query: { $select: id,displayName,userPrincipalName,accountEnabled }

  - id: guard
    type: assert
    that: ${ steps.lookup.output.accountEnabled = true }
    message: ${ steps.lookup.output.userPrincipalName & ' is already disabled.' }

  - id: disable
    type: graph
    mode: write
    describe: Set accountEnabled to false
    request:
      method: PATCH
      path: /users/${ $encode(inputs.userId) }
      body: { accountEnabled: false }
    compensate:
      type: graph
      request: { method: PATCH, path: /users/${ $encode(inputs.userId) }, body: { accountEnabled: true } }

  - id: revoke
    type: graph
    mode: write
    describe: Revoke refresh tokens and session cookies
    request: { method: POST, path: /users/${ $encode(inputs.userId) }/revokeSignInSessions }

outputs:
  summary: ${ 'Sign-in disabled and sessions revoked for ' & steps.lookup.output.userPrincipalName }

tests:                           # run by `adminforge test` (dry-run with mocked step outputs)
  - name: refuses an already-disabled user
    inputs: { userId: 6f1c2f6e-0000-4000-8000-000000000001, reason: incident 4411 test }
    mocks: { lookup: { accountEnabled: false, userPrincipalName: x@contoso.com } }
    expect: { status: failed, failedStep: guard }
```

**Step types:** `graph`, `graphBatch`, `arm`, `resourceGraph`, `logAnalytics`, `function`, `runner`, `http` (allowlisted hosts only), `transform` (JSONata), `assert`, `branch` (`if`/`then`/`else`), `forEach` (`items`, `concurrency` ≤ 10, `steps`), `approval`, `manual` (checklist item a human confirms), `wait` (duration or until-condition with timeout), `notify` (Teams chat/channel message or email via Graph, as the user).

**Runbooks** use the same engine and step types, rendered as a guided document: Markdown sections interleaved with `manual` checklist steps and embedded executable steps or child playbooks (`type: playbook, ref: identity.disable-user`). Progress is a run like any other, so it's resumable, auditable, and handed over between engineers ("Assign to…").

### 7.8 Engine semantics

- **States:** `queued → running → (awaiting_approval | awaiting_input | awaiting_arm | awaiting_reauth) → running → succeeded | failed | cancelled | compensated`.
- **Dry run:** read steps execute for real; write steps produce a **plan entry** (`method`, rendered `path`, redacted `body`, `describe`) and their outputs come from `dryRunOutput:` if declared, otherwise `null`. The playbook page always shows the plan before **Run**.
- **Checkpointing:** step results are persisted before moving on; a crashed worker resumes from the last completed step. Steps marked `idempotent: false` that were *in flight* during a crash become `needs_review` instead of being retried.
- **Retries:** `retry: {max: 3, backoff: exponential}` on transient errors (429/5xx/network); Graph `Retry-After` always honoured.
- **Errors:** `onError: fail | continue | compensate`; compensation runs completed steps' `compensate` blocks in reverse.
- **Identity:** each step records `actorOid` and `mode`; after an `approval` step, subsequent steps run as the approver.
- **Limits:** max steps per run 200, `forEach` ≤ 1,000 items (≤ 10 concurrent), max run time 4 h, output ≤ 256 KB per step (larger outputs truncated with a "download full output" link backed by Postgres large object or blob in Phase 8).

### 7.9 Lifecycle and governance

1. **Scaffold** — `pnpm adminforge new playbook identity/disable-user` (writes YAML with `$schema`, a test stub, and a fixture).
2. **Author** — VS Code with YAML schema autocomplete; `pnpm dev` hot-reloads `content/` from disk in mock or live-dev mode.
3. **Validate** — `pnpm adminforge validate` → schema, expression compilation, references (pages ↔ playbooks ↔ scripts), scope declarations vs. app registrations, lint rules (write steps need `describe`; `risk ≥ high` needs `confirm`; `critical` needs `approval`; `$filter` concatenation must use `$odata`).
4. **Test** — `pnpm adminforge test` runs every `tests:` block in dry-run with mocks.
5. **Review** — PR; CODEOWNERS by `owner:`; write-capable content needs an approver who isn't the author.
6. **Publish** — CI on merge to `main` runs `adminforge publish --env dev`; prod publish is a manual approval in the GitHub environment. Publishing is idempotent (same sha256 → no-op) and refuses a version number reused with different content.
7. **Hot reload** — NOTIFY → caches invalidated → open browsers refresh definitions within seconds.
8. **Retire** — `status: retired` hides the item but keeps history for audit.

### 7.10 CLI (`tools/cli`)

```
adminforge new page|dashboard|report|playbook|runbook|widget|connector|script <path> [--template list-detail]
adminforge validate [--scopes] [--env dev]
adminforge test [pattern]
adminforge publish --env dev|prod [--dry-run]
adminforge fixtures record <page-or-playbook> --env dev   # live read → sanitized fixture (PII scrubbed, GUIDs remapped consistently)
adminforge login --device-code --env dev                  # dev app only, if D8 allows
adminforge audit verify
```

---

## 8. Data model (Drizzle, `apps/api/src/db/schema.ts`)

| Table | Key columns |
|---|---|
| `sessions` | `id_hash` PK, `user_oid`, `upn`, `display_name`, `tenant_id`, `roles text[]`, `csrf`, `read_account_id`, `write_account_id?`, `write_expires_at?`, `write_extended bool`, `created_at`, `last_seen_at`, `expires_at`, `ip`, `user_agent` |
| `preauth` | `state` PK, `kind (read/write)`, `verifier`, `nonce`, `return_to`, `session_id_hash?`, `expires_at` |
| `token_cache` | `partition_key` PK, `sealed text`, `updated_at` |
| `definitions` | `id` PK, `kind`, `key`, `version`, `status (draft/in_review/published/retired)`, `body jsonb`, `sha256`, `source (git/portal)`, `author_oid`, `approver_oid?`, `created_at`, `published_at`; unique(`kind`,`key`,`version`) |
| `runs` | `id` PK, `kind`, `definition_key`, `definition_version`, `definition_sha256`, `status`, `dry_run`, `initiator_oid`, `inputs jsonb`, `outputs jsonb`, `error jsonb`, `correlation_id`, timestamps |
| `run_steps` | (`run_id`, `seq`) PK, `step_id`, `attempt`, `status`, `actor_oid`, `mode`, `request jsonb` (redacted), `plan jsonb?`, `output jsonb`, `error jsonb`, `ms_request_id`, timestamps |
| `run_step_events` | `id` PK, `run_id`, `step_seq`, `ts`, `type (log/progress/output)`, `level`, `data jsonb` |
| `approvals` | `id` PK, `run_id`, `step_id`, `policy jsonb`, `decisions jsonb`, `status`, `expires_at` |
| `audit_events` | `seq` bigserial PK, `ts`, `actor_oid`, `actor_upn`, `session_hash`, `mode`, `action`, `target_type`, `target_id`, `details jsonb`, `result`, `correlation_id`, `ip`, `prev_hash`, `hash` |
| `settings` | `key` PK, `value jsonb`, `version`, `updated_by`, `updated_at` (appearance, feature flags, write-mode policy) |
| `user_prefs` | `user_oid` PK, `prefs jsonb` (theme, density, nav state, pinned, recents) |
| `saved_views` | `id` PK, `user_oid`, `page_key`, `name`, `params jsonb`, `shared bool` |
| `pgboss.*` | created by pg-boss |

Retention (configurable): sessions purge 7 days after expiry; run events 180 days; audit kept indefinitely (export + archive policy in Phase 8).

---

## 9. API surface (BFF)

| Method & path | Purpose |
|---|---|
| `GET /auth/login`, `GET /auth/callback` | Read sign-in |
| `GET /auth/arm`, `GET /auth/arm/callback`, `POST /auth/arm/extend`, `POST /auth/disarm` | Write mode |
| `POST /auth/logout` | Sign out everywhere (session + caches + Entra end-session) |
| `GET /api/me` | User, portal roles, mode, `armedUntil`, csrf, prefs, appearance version |
| `GET /api/me/capabilities` | Active/eligible Entra roles, RBAC on scope, missing scopes |
| `PUT /api/me/prefs` | Theme, density, nav, pins |
| `GET /api/nav` | Navigation built from published content + roles |
| `GET /api/definitions/:kind/:key[?version]` | Published definition (sanitized for client: no server-only fields) |
| `POST /api/datasources/execute` | Execute a declared datasource |
| `GET /api/search?q=` | Command palette fan-out |
| `POST /api/runs` · `GET /api/runs` · `GET /api/runs/:id` · `GET /api/runs/:id/events` (SSE) · `POST /api/runs/:id/cancel` | Runs |
| `POST /api/runs/:id/approvals/:stepId` · `POST /api/runs/:id/manual/:stepId` · `POST /api/runs/:id/input/:stepId` | Human steps |
| `POST /api/reports/:key/export` | Streamed CSV/XLSX |
| `GET /api/events` (SSE) | `definitions.changed`, `session.mode`, `run.updated` for the dock |
| `GET /api/audit` · `GET /api/audit/export` | Audit (Portal.Admin) |
| `GET/PUT /api/admin/appearance` · `GET /api/appearance.css` | Runtime tokens |
| `POST /api/admin/definitions/publish` · drafts/review/approve (Phase 7) | Content governance |
| `GET /api/admin/scopes/drift` | Scope drift report |
| `GET /healthz` · `GET /readyz` | Liveness / readiness (DB, Key Vault) |

All `/api` responses: `Cache-Control: no-store`; JSON errors `{error:{code, message, hint?, reauth?, correlationId}}`.

---

## 10. Repository layout

```
Azure-Admin/
├─ apps/
│  ├─ web/                    React SPA
│  │  ├─ src/app/             shell: SessionRail, NavRail, Inspector, RunDock, CommandPalette
│  │  ├─ src/routes/          TanStack Router file routes (generic /p/$key renderer + coded pages)
│  │  ├─ src/renderer/        page renderer, widget host, param/filter state ↔ URL
│  │  ├─ src/lib/             api client, SSE, query client, auth redirects
│  │  └─ e2e/                 Playwright (mock mode) + visual baselines
│  ├─ api/                    Fastify BFF + worker
│  │  ├─ src/auth/            msal factory, routes, token broker, cache plugin
│  │  ├─ src/security/        envelope crypto, csrf, csp, request policy glue
│  │  ├─ src/db/              drizzle schema, migrations
│  │  ├─ src/definitions/     store (fs | db), cache, NOTIFY listener
│  │  ├─ src/datasources/     executor
│  │  ├─ src/runs/            engine ports, pg-boss worker, SSE
│  │  ├─ src/audit/
│  │  └─ src/routes/
│  └─ runner/                 Node supervisor + pwsh worker bootstrap + AdminForge.Runner PS module
├─ packages/
│  ├─ design-tokens/          tokens.ts → dist/{tokens.css,tailwind-theme.css,echarts-*.json}
│  ├─ ui/                     recipes, primitives, templates, styles/base.css
│  ├─ widgets/
│  ├─ schemas/                zod + generated JSON Schema
│  ├─ expressions/
│  ├─ connectors/
│  ├─ engine/
│  └─ config/                 tsconfig, eslint, prettier presets
├─ content/                   (see §7.1)
├─ infra/
│  ├─ azure/                  main.bicep + modules/ (law, appi, kv, pg, acr, cae, apps, identities)
│  ├─ entra/                  main.bicep (Graph extension): apps, SPs, scopes, consent grants, app roles, groups, FICs
│  └─ ca/                     Conditional Access policy JSON (report-only) + apply script
├─ tools/
│  ├─ cli/                    adminforge
│  └─ discovery/              tenant discovery script
├─ docs/
│  ├─ plans/  adr/  runbooks/ (operating the portal itself)  decisions.md
├─ docker-compose.yml         Postgres for local dev
├─ .github/workflows/         ci.yml, deploy-infra.yml, deploy-app.yml, publish-content.yml
└─ turbo.json  pnpm-workspace.yaml  package.json  tsconfig.base.json  eslint.config.js
```

---

## 11. Infrastructure and environments

| Resource | Dev | Prod |
|---|---|---|
| Resource group | `rg-adminforge-dev` | `rg-adminforge-prod` |
| Container Apps environment | Consumption profile, VNet-integrated from day one | Workload profile (D4), internal or Front Door-fronted (D2) |
| Container App `adminforge-api` | 1–2 replicas, `ROLE=api` | 2–6, HTTP scale |
| Container App `adminforge-worker` | 1, `ROLE=worker` | 2, queue-depth KEDA scale |
| Container App `adminforge-runner` | internal ingress, 1 | internal, 2–4 |
| PostgreSQL Flexible Server 17 | B1ms, Entra-only auth, public access restricted to ACA egress | GP D2ds_v5, zone-redundant HA, private access, PITR 35 days |
| Key Vault | RBAC mode, purge protection | same + private endpoint |
| ACR | Basic | Standard + private endpoint |
| Log Analytics + App Insights | 30-day retention | 90 days + archive |
| Managed identities | `id-adminforge-api` (KV secrets user, ACR pull, PG user, FIC subject), `id-adminforge-runner` | same |

- **Bicep**: `infra/azure/main.bicep` with `env` parameter; `az deployment group what-if` gate before every apply.
- **Entra objects**: `infra/entra/main.bicep` using the Microsoft Graph Bicep extension — applications, service principals, `oauth2PermissionGrants` (admin consent for delegated scopes, `consentType: AllPrincipals`), app roles, app role assignments to groups, federated identity credentials, and the Runner app role assignment to the BFF identity. Run by a human admin (🔑) — the deploying identity needs rights to create apps and grant consent.
- **CI/CD (GitHub Actions, OIDC to Azure, no secrets)**:
  - `ci.yml` — install, lint, typecheck, unit/component tests, `adminforge validate` + `adminforge test`, build, Playwright mock-mode e2e + visual diff.
  - `deploy-infra.yml` — what-if on PR (posted as a comment), apply on approval.
  - `deploy-app.yml` — build one image (api/worker share it; runner has its own) → ACR → new Container App revision → smoke `/readyz` → traffic shift.
  - `publish-content.yml` — on `content/**` changes: validate → test → publish to dev; manual approval → prod.

---

## 12. Observability

- OpenTelemetry via `@azure/monitor-opentelemetry` in api, worker, and runner: HTTP server/client spans, pg spans, custom spans per datasource and step.
- Every outbound Microsoft call is tagged `service`, `path template` (not the raw path, to avoid PII in metrics), `status`, `ms`, `throttled`, `ms-request-id`.
- Built-in **Portal health** dashboard (itself a content dashboard using `logAnalytics`): error rate, p95 latency per service, 429 rate, run success rate, active armed sessions, top failing steps.
- Alerts (Bicep): API 5xx > 2% for 5 min; any audit chain verification failure; Postgres CPU/storage; runner job failures > N/h; Key Vault access denied.
- Logs never contain tokens, cookies, or request bodies of write calls (bodies are redacted by field allowlist).

---

## 13. Testing and the validation loop

| Layer | Tooling | What |
|---|---|---|
| Unit | Vitest | tokens (contrast), expressions, schemas, policy, connectors (fake `fetch`), envelope crypto, engine (state machine, dry-run, compensation, resume), audit chain |
| Component | Vitest + Testing Library + `axe-core` | Every primitive and widget: renders, keyboard, a11y violations = 0 |
| Content | `adminforge validate` / `adminforge test` | Every definition in `content/` |
| API | Vitest + Fastify `inject` + test Postgres (docker) | Routes, auth state machine with a fake MSAL, CSRF, policy enforcement, SSE |
| E2E | Playwright (system Chrome, `channel: 'chrome'`) against **mock mode** | Sign-in (mock), navigate, filter, inspect, arm (mock step-up), dry-run, run, approve |
| Visual | Playwright screenshots | Key pages × {graphite, paper, contrast} × {comfortable, compact}; armed vs read shell |
| Live smoke 🔑 | `pnpm test:live --env dev` | Read-only: every published datasource executes with the tester's identity; reports latency, 403s (= missing scope or role), throttling |
| Live write 🔑 | Manual + scripted, test objects only | Each write playbook: dry-run → run on a test user/group/RG → verify → compensate |

**Mock mode** (`AUTH_MODE=mock`, `DATA_MODE=fixtures`): the BFF creates a mock session (roles and armed state switchable from a dev toolbar), and connectors answer from `content/fixtures/` keyed by `(service, method, path template, query)`. This is how UI work proceeds without credentials, and how Playwright runs in CI.

**How live validation works with your credentials** (one of these, per D8):
- **A (preferred):** You open the deployed **dev** portal in your browser and sign in; I watch App Insights (`az monitor app-insights query`) and the audit table, and you report or screenshot anything off.
- **B:** `pnpm adminforge login --device-code --env dev` — I start it, you enter the code in your browser, and the CLI then runs the live smoke suite as you. Needs device-code flow allowed for the dev app only.
- **C (local):** If your browser can reach this machine (or via `ssh -L 5173:localhost:5173 <this-host>`), sign in at `http://localhost:5173`.

---

## 14. Roadmap and gates

| Phase | Outcome | Gate |
|---|---|---|
| **0 — Tooling & discovery** | CLIs installed, repo initialised, tenant discovery report, decisions confirmed | **G0**: you approve `docs/decisions.md` (D1–D9) |
| **1 — Foundations** | Monorepo, tokens, UI kit, shell (all themes/densities), BFF with mock + real **read** SSO, Graph connector, Tenant overview page, CI | **G1**: you sign in with SSO and see live tenant data; screenshots approved |
| **2 — Dev environment & delivery** | Azure dev infra (Bicep), Entra apps via IaC, container build/deploy, OIDC pipelines | **G2**: portal running in Azure dev; deploy by merge |
| **3 — Content framework** | Schemas, expressions, widget registry, page renderer, datasource executor, nav from content, CLI (`new/validate/test/publish`), hot reload, Users/Groups/Devices pages as YAML | **G3**: you (or I, live) add a new dashboard by YAML only in < 15 min and see it appear without deploy |
| **4 — Write mode & engine** | Write app, Arm/Disarm with CA auth context, engine (dry-run, approvals, compensation, resume), runs UI, audit chain, first write playbooks | **G4**: disable + re-enable a test user via playbook (dry-run, then live); audit verified; CA policies switched from report-only to on |
| **5 — Domain wave 1** | Identity (users, groups, roles/PIM, auth methods, sign-ins, apps & credential expiry), Azure (subscriptions, Resource Graph inventory, Function Apps, metrics/logs, your Function connections), M365 (service health, message center, licensing), Security (incidents, Secure Score, risky users) | **G5**: catalog walkthrough; live smoke suite green |
| **6 — PowerShell runner & wave 2** | Runner service, `AdminForge.Runner` module, Exchange Online, Teams, SharePoint pages and playbooks (read first, then write) | **G6**: mailbox forwarding audit + convert-to-shared playbook on test mailbox |
| **7 — Reports, appearance, authoring** | Report exports, Appearance admin with runtime overrides, in-portal editor (Monaco + schema), drafts → review → publish, saved views, personal dashboards | **G7**: a Portal Admin changes accent/radius live; an author publishes a playbook through two-person review in the portal |
| **8 — Hardening & production** | Private networking/WAF per D2, CSP report-only → enforce, pen-test checklist, load test, backup/restore drill, DR runbook, prod infra, go-live checklist | **G8**: production go-live sign-off |

Phases 1 and 2 can overlap once G0 is passed (infra work needs 🔑, UI work doesn't).

---

## 15. Phase 0 — Tooling and tenant discovery (bite-sized)

Machine facts (checked 2026-10-15): Ubuntu 24.04, Node 24.13, pnpm 11.10, Docker 29, git, gh, psql 16, Google Chrome 148 present. **Missing:** Azure CLI, Bicep, PowerShell 7. A local Postgres already listens on `127.0.0.1:5432`, so the dev container uses **55432**. Disk: ~14 GB free on `/` (89% used) — check `df -h /` before pulling container images.

### Task 0.1: Install Azure CLI, Bicep, PowerShell 7

**Files:** none (system tooling)

**Step 1: Install** (needs sudo; if a password prompt blocks, the user runs these with `!`)

```bash
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
az bicep install
source /etc/os-release
wget -q "https://packages.microsoft.com/config/ubuntu/${VERSION_ID}/packages-microsoft-prod.deb" -O /tmp/packages-microsoft-prod.deb
sudo dpkg -i /tmp/packages-microsoft-prod.deb && sudo apt-get update && sudo apt-get install -y powershell
pwsh -NoLogo -Command 'Install-Module Microsoft.Graph.Authentication -Scope CurrentUser -Force'
```

**Step 2: Verify**

Run: `az version -o tsv --query '"azure-cli"'; az bicep version; pwsh -NoLogo -Command '$PSVersionTable.PSVersion.ToString()'`
Expected: an `azure-cli` version, `Bicep CLI version 0.x`, PowerShell `7.x`.

### Task 0.2: Initialise the repository

**Files:**
- Create: `.gitignore`, `.editorconfig`, `.nvmrc`, `README.md`

**Step 1: Write files**

`.gitignore`
```gitignore
node_modules/
dist/
.turbo/
coverage/
playwright-report/
test-results/
.env
.env.*
!.env.example
.local/
*.log
```

`.editorconfig`
```ini
root = true
[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true
[*.ps1]
indent_size = 4
```

`.nvmrc`
```
24
```

`README.md`
```markdown
# AdminForge

Delegated-auth admin portal for Entra ID, Microsoft 365, and Azure.
Plan: `docs/plans/2026-10-15-adminforge-master-plan.md` · Decisions: `docs/decisions.md`
```

**Step 2: Commit**

```bash
git init -b main
git add -A
git commit -m "chore: initialise repository with master plan"
```

**Step 3 (after D1 is confirmed):** `gh repo create <org>/adminforge --private --source . --push`

### Task 0.3 🔑: Sign in to Azure CLI

**Step 1:** Ask the user to run (interactive, their credentials never pass through chat):

```
! az login --tenant <TENANT_ID>
```
If the browser can't open on this host, `az login` falls back to a device code. If CA blocks device code, the user signs in from a session on this machine that has a browser, or uses `az login --use-device-code` from an allowed network.

**Step 2: Verify**

Run: `az account show --query "{tenant:tenantId, user:user.name, sub:name}" -o table`
Expected: the right tenant and the user's admin account.

### Task 0.4 🔑: Read-only tenant discovery

**Files:**
- Create: `tools/discovery/Invoke-TenantDiscovery.ps1`
- Output (git-ignored): `.local/discovery/discovery.json`, `.local/discovery/summary.md`

**Step 1: Write the script**

```powershell
#requires -Version 7.2
<#
.SYNOPSIS
    Read-only tenant discovery for the AdminForge plan. Changes nothing.
.DESCRIPTION
    Signs in to Microsoft Graph with delegated read scopes and records licensing, Conditional Access
    posture, authentication contexts, existing portal apps, and the signed-in admin's roles.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $TenantId,
    [string] $OutDir = (Join-Path $PSScriptRoot '../../.local/discovery'),
    [switch] $UseDeviceCode
)
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.Graph.Authentication

$scopes = 'Organization.Read.All', 'Policy.Read.All', 'Application.Read.All', 'RoleManagement.Read.Directory', 'Directory.Read.All'
Connect-MgGraph -TenantId $TenantId -Scopes $scopes -UseDeviceCode:$UseDeviceCode -NoWelcome

function Get-All([string] $Uri) {
    $items = [System.Collections.Generic.List[object]]::new()
    while ($Uri) {
        $page = Invoke-MgGraphRequest -Method GET -Uri $Uri -OutputType PSObject
        if ($page.value) { $items.AddRange([object[]] $page.value) }
        $Uri = $page.'@odata.nextLink'
    }
    , $items
}
function Try-Get([string] $Uri) {
    try { Get-All $Uri } catch { [pscustomobject]@{ error = $_.Exception.Message } }
}

$g = 'https://graph.microsoft.com/v1.0'
$me = Invoke-MgGraphRequest GET "$g/me?`$select=id,userPrincipalName" -OutputType PSObject
$org = (Invoke-MgGraphRequest GET "$g/organization?`$select=id,displayName,verifiedDomains" -OutputType PSObject).value[0]
$skus = Get-All "$g/subscribedSkus?`$select=skuPartNumber,capabilityStatus,prepaidUnits,consumedUnits,servicePlans"
$plans = $skus | ForEach-Object { $_.servicePlans.servicePlanName } | Sort-Object -Unique
$ca = Try-Get "$g/identity/conditionalAccess/policies"
$authContexts = Try-Get "$g/identity/conditionalAccess/authenticationContextClassReferences"
$apps = Get-All "$g/applications?`$filter=startswith(displayName,'AdminForge')&`$select=id,appId,displayName"
$active = Try-Get "$g/roleManagement/directory/roleAssignmentScheduleInstances?`$filter=principalId eq '$($me.id)'&`$expand=roleDefinition(`$select=displayName)"
$eligible = Try-Get "$g/roleManagement/directory/roleEligibilityScheduleInstances?`$filter=principalId eq '$($me.id)'&`$expand=roleDefinition(`$select=displayName)"

$caList = @($ca | Where-Object { -not $_.error })
$result = [ordered]@{
    collectedAt       = (Get-Date).ToUniversalTime().ToString('o')
    tenant            = @{ id = $org.id; name = $org.displayName; domains = @($org.verifiedDomains | Select-Object name, isDefault, isInitial) }
    signedInAs        = $me.userPrincipalName
    licensing         = @{
        entraP1  = $plans -contains 'AAD_PREMIUM'
        entraP2  = $plans -contains 'AAD_PREMIUM_P2'
        intune   = $plans -contains 'INTUNE_A'
        exchange = [bool]($plans | Where-Object { $_ -like 'EXCHANGE_S_*' })
        skus     = @($skus | Select-Object skuPartNumber, capabilityStatus, consumedUnits, @{ n = 'enabled'; e = { $_.prepaidUnits.enabled } })
    }
    conditionalAccess = @{
        readable               = -not ($ca | Where-Object { $_.error })
        policyCount            = $caList.Count
        enabled                = @($caList | Where-Object state -EQ 'enabled').Count
        reportOnly             = @($caList | Where-Object state -EQ 'enabledForReportingButNotEnforced').Count
        blocksDeviceCodeFlow   = [bool]($caList | Where-Object { $_.state -eq 'enabled' -and "$($_.conditions.authenticationFlows.transferMethods)" -match 'deviceCodeFlow' })
        authenticationContexts = @($authContexts | Select-Object id, displayName, isAvailable, error)
    }
    existingPortalApps = @($apps)
    myRoles           = @{
        active   = @($active | ForEach-Object { $_.roleDefinition.displayName ?? $_.error })
        eligible = @($eligible | ForEach-Object { $_.roleDefinition.displayName ?? $_.error })
    }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$result | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $OutDir 'discovery.json')
@"
# Tenant discovery ($($result.collectedAt))
- Tenant: $($org.displayName) ($($org.id)); signed in as $($me.userPrincipalName)
- Entra ID P1: $($result.licensing.entraP1) · P2 (PIM, Identity Protection): $($result.licensing.entraP2) · Intune: $($result.licensing.intune) · Exchange: $($result.licensing.exchange)
- Conditional Access policies: $($caList.Count) ($($result.conditionalAccess.enabled) on, $($result.conditionalAccess.reportOnly) report-only); device code blocked: $($result.conditionalAccess.blocksDeviceCodeFlow)
- Authentication contexts: $(($result.conditionalAccess.authenticationContexts | ForEach-Object { "$($_.id)=$($_.displayName)" }) -join ', ')
- Existing AdminForge apps: $(@($apps).Count)
- Your active roles: $($result.myRoles.active -join ', ')
- Your eligible roles: $($result.myRoles.eligible -join ', ')
"@ | Set-Content (Join-Path $OutDir 'summary.md')
Disconnect-MgGraph | Out-Null
Write-Host "Wrote $OutDir/discovery.json and summary.md"
```

**Step 2: Run** (user signs in when prompted)

```
! pwsh tools/discovery/Invoke-TenantDiscovery.ps1 -TenantId <TENANT_ID>
```
If the "Microsoft Graph Command Line Tools" app isn't consented in the tenant, the user sees a consent prompt; if consent is blocked, fall back to `az rest` for the Graph calls the CLI's token can make, and mark the rest "manual check" in the summary.

**Step 3: Azure side**

```bash
az account list --query "[].{name:name, id:id, state:state}" -o table
az provider show -n Microsoft.App --query registrationState -o tsv
az provider show -n Microsoft.DBforPostgreSQL --query registrationState -o tsv
```
Expected: target subscription listed; providers `Registered` (else `az provider register -n …`).

**Step 4: Commit the script only**

```bash
git add tools/discovery/Invoke-TenantDiscovery.ps1
git commit -m "feat(discovery): read-only tenant discovery script"
```

### Task 0.5: Record decisions — Gate G0

**Files:**
- Create: `docs/decisions.md`

**Step 1:** Fill a table with D1–D9 (§3), the user's answers, and the discovery facts that drive them (P1/P2 present? device code blocked? existing auth contexts?). Licence consequences: no P1 → no CA auth context (write step-up falls back to `prompt=login` + `max_age=0`, weaker); no P2 → PIM features hidden.

**Step 2:** Present the summary to the user → **G0 approval** → commit `docs: record G0 decisions`.

---

## 16. Phase 1 — Foundations (bite-sized)

### Task 1.1: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`
- Create: `docs/adr/001-bff-token-custody.md` … `010-runs-need-live-identity.md` (one short ADR each, using §3's rows: Context / Decision / Consequences)

**Step 1: Write root files**

`package.json`
```json
{
  "name": "adminforge",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.10.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "format": "prettier --write .",
    "adminforge": "tsx tools/cli/src/index.ts",
    "db:up": "docker compose up -d --wait postgres",
    "db:down": "docker compose down"
  }
}
```

`pnpm-workspace.yaml`
```yaml
packages:
  - apps/*
  - packages/*
  - tools/*
```

`turbo.json`
```json
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "stream",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "dev": { "dependsOn": ["^build"], "cache": false, "persistent": true },
    "test": { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

**Step 2: Install root tooling**

Run: `pnpm add -Dw turbo typescript tsx vitest @types/node prettier eslint @eslint/js typescript-eslint eslint-plugin-react-hooks`
If pnpm reports ignored build scripts (e.g. `esbuild`), run `pnpm approve-builds` and allow only `esbuild`.

**Step 3: Verify**

Run: `pnpm turbo run build`
Expected: exits 0 ("No tasks were executed" is fine at this point).

**Step 4: Commit** — `git add -A && git commit -m "chore: pnpm + turbo workspace and ADRs"`

### Task 1.2: Shared TypeScript, lint, and format config (with the token guardrail)

**Files:**
- Create: `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`
- Test: `tools/lint-fixtures/bad-color.tsx` (temporary)

**Step 1: Write config**

`tsconfig.base.json`
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  }
}
```

`eslint.config.js`
```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const ARBITRARY = /\w-\[[^\]]+\]/;
const RAW_COLOR = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(|hsla?\(|oklch\(/;

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.gen.ts', '**/coverage/**', 'packages/design-tokens/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // Central control: visual values come from @adminforge/design-tokens only.
    files: ['apps/**/*.{ts,tsx}', 'packages/{ui,widgets}/**/*.{ts,tsx}', 'tools/lint-fixtures/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `Literal[value=/${RAW_COLOR.source}/]`, message: 'Use a design token (bg-panel, text-fg, var(--af-…)) instead of a raw color.' },
        { selector: `Literal[value=/${ARBITRARY.source}/]`, message: 'Arbitrary Tailwind values bypass the design system. Add or use a token.' },
        { selector: `TemplateElement[value.raw=/${ARBITRARY.source}/]`, message: 'Arbitrary Tailwind values bypass the design system. Add or use a token.' },
      ],
    },
  },
);
```

`.prettierrc.json`
```json
{ "singleQuote": true, "printWidth": 110, "trailingComma": "all" }
```

**Step 2: Write a failing lint fixture**

`tools/lint-fixtures/bad-color.tsx`
```tsx
export const Bad = () => <div className="bg-[#ff0000]" style={{ color: '#ff0000' }} />;
```

**Step 3: Verify the guardrail fires**

Run: `pnpm eslint tools/lint-fixtures/bad-color.tsx`
Expected: FAIL with both "Arbitrary Tailwind values…" and "Use a design token…". (If esquery rejects a regex, simplify the pattern until both messages appear — this test is the point.)

**Step 4: Delete the fixture, commit**

```bash
rm -r tools/lint-fixtures
git add -A && git commit -m "chore: shared TS/ESLint/Prettier config with token guardrails"
```

### Task 1.3: Design tokens — source of truth + contrast tests

**Files:**
- Create: `packages/design-tokens/package.json`, `packages/design-tokens/tsconfig.json`
- Create: `packages/design-tokens/src/color.ts`, `src/tokens.ts`, `src/index.ts`
- Test: `packages/design-tokens/test/color.test.ts`, `test/tokens.test.ts`

**Step 1: Package files**

`packages/design-tokens/package.json`
```json
{
  "name": "@adminforge/design-tokens",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./tokens.css": "./dist/tokens.css",
    "./tailwind-theme.css": "./dist/tailwind-theme.css",
    "./echarts/*.json": "./dist/echarts-*.json"
  },
  "scripts": {
    "build": "tsx src/build.ts",
    "dev": "tsx watch src/build.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

`packages/design-tokens/tsconfig.json`
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["node"] }, "include": ["src", "test"] }
```

**Step 2: Write the failing color test**

`test/color.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { contrastRatio, hexToRgb } from '../src/color';

describe('color', () => {
  it('parses #RRGGBB', () => expect(hexToRgb('#7FB2E5')).toEqual([127, 178, 229]));
  it('rejects other formats', () => expect(() => hexToRgb('red')).toThrow(/#RRGGBB/));
  it('computes WCAG 2 contrast', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#DCE4EC', '#131920')).toBeCloseTo(13.77, 2);
  });
});
```

**Step 3: Run** — `pnpm --filter @adminforge/design-tokens test` → FAIL ("Cannot find module '../src/color'").

**Step 4: Implement**

`src/color.ts`
```ts
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Expected #RRGGBB, got ${hex}`);
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(channel) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
```

**Step 5: Run** → PASS.

**Step 6: Write the failing tokens test**

`test/tokens.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/color';
import { resolveHex, SEMANTIC_KEYS, THEME_NAMES, themes, type SemanticKey } from '../src/tokens';

const SURFACES = ['canvas', 'panel', 'raised'] as const satisfies readonly SemanticKey[];
const TEXT_TARGETS: Array<[SemanticKey, number]> = [
  ['fg', 7], ['fg-2', 4.5], ['fg-3', 4.5], ['accent', 4.5], ['armed', 4.5], ['ok', 4.5], ['warn', 4.5], ['crit', 4.5],
];
const FILLS: Array<[SemanticKey, SemanticKey]> = [['on-armed', 'armed'], ['on-accent', 'accent'], ['fg-inverse', 'crit']];

describe.each(THEME_NAMES)('theme %s', (name) => {
  const hex = (key: SemanticKey) => resolveHex(themes[name][key]);

  it('defines every semantic key', () => {
    expect(Object.keys(themes[name]).sort()).toEqual([...SEMANTIC_KEYS].sort());
  });

  it.each(SURFACES)('text and status tokens meet contrast targets on %s', (surface) => {
    for (const [key, min] of TEXT_TARGETS) {
      const ratio = contrastRatio(hex(key), hex(surface));
      expect(ratio, `${key} on ${surface} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
    }
  });

  it.each(FILLS)('%s on %s is at least 4.5:1', (fg, bg) => {
    expect(contrastRatio(hex(fg), hex(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it('chart colors are at least 3:1 against panel', () => {
    for (const i of [1, 2, 3, 4, 5, 6] as const) {
      expect(contrastRatio(hex(`chart-${i}`), hex('panel'))).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('resolveHex', () => {
  it('throws on unknown references', () => expect(() => resolveHex('{graphite.123}')).toThrow(/Unknown color reference/));
});
```

**Step 7: Run** → FAIL (no `tokens.ts`).

**Step 8: Implement the token source**

`src/tokens.ts`
```ts
/**
 * Single source of truth for every visual attribute of the portal.
 * Change a value here → `pnpm dev` rebuilds dist/ → every page follows.
 * Tier 1 primitives → tier 2 semantic themes → tier 3 component tokens.
 * Theme values may reference primitives as {family.step}; they compile to var(--af-p-family-step).
 */

export const primitives = {
  color: {
    graphite: { 950: '#0E1318', 900: '#131920', 850: '#171E26', 800: '#1C242E', 750: '#222B36', 700: '#29343F', 600: '#354352', 500: '#4A5A6B', 400: '#8292A3', 300: '#A9B6C3', 100: '#DCE4EC' },
    slate: { 900: '#17202A', 700: '#3E4C5B', 600: '#586777', 300: '#CDD5DD', 200: '#E2E7EC', 100: '#EEF1F4', 50: '#F7F8FA', 0: '#FFFFFF' },
    glacier: { 800: '#24507A', 700: '#2F6497', 400: '#7FB2E5', 300: '#A6CBF0' },
    ignition: { 700: '#A44A0C', 500: '#F27B2C' },
    verdigris: { 700: '#1F6F5A', 400: '#5CC4A5' },
    sodium: { 700: '#8A6410', 400: '#E8C14F' },
    signal: { 700: '#B23131', 400: '#F07575' },
    hc: { black: '#000000', 950: '#0A0A0A', 900: '#141414', line: '#5A5A5A', linestrong: '#8A8A8A', fg3: '#C8C8C8', fg2: '#E6E6E6', white: '#FFFFFF', accent: '#9CCBFF', armed: '#FFA261', ok: '#6EE7B7', warn: '#FFD966', crit: '#FF8A8A' },
    // Categorical chart palettes — validated with the dataviz palette validator (dark vs #171E26, light vs #FFFFFF).
    'chart-dark': { 1: '#4A8AD8', 2: '#C9692A', 3: '#1F9C7E', 4: '#9775E2', 5: '#CB527F', 6: '#AD8826' },
    'chart-light': { 1: '#2A6CC0', 2: '#C25A14', 3: '#178366', 4: '#7A55D0', 5: '#C2416F', 6: '#9A7300' },
  },
} as const;

export const SEMANTIC_KEYS = [
  'canvas', 'panel', 'raised', 'sunken', 'hover', 'selected',
  'line', 'line-strong',
  'fg', 'fg-2', 'fg-3', 'fg-inverse',
  'accent', 'accent-strong', 'accent-subtle', 'on-accent',
  'armed', 'armed-subtle', 'on-armed',
  'ok', 'ok-subtle', 'warn', 'warn-subtle', 'crit', 'crit-subtle', 'info', 'neutral',
  'focus',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6',
] as const;
export type SemanticKey = (typeof SEMANTIC_KEYS)[number];

export const THEME_NAMES = ['graphite', 'paper', 'contrast'] as const; // default first
export type ThemeName = (typeof THEME_NAMES)[number];
export const DEFAULT_THEME: ThemeName = 'graphite';

export const themeMeta: Record<ThemeName, { label: string; scheme: 'dark' | 'light' }> = {
  graphite: { label: 'Graphite', scheme: 'dark' },
  paper: { label: 'Paper', scheme: 'light' },
  contrast: { label: 'High contrast', scheme: 'dark' },
};

const mix = (ref: string, pct: number, over = 'transparent') => `color-mix(in oklab, ${ref} ${pct}%, ${over})`;

export const themes: Record<ThemeName, Record<SemanticKey, string>> = {
  graphite: {
    canvas: '{graphite.900}', panel: '{graphite.850}', raised: '{graphite.800}', sunken: '{graphite.950}',
    hover: '{graphite.750}', selected: mix('{glacier.400}', 14, '{graphite.850}'),
    line: '{graphite.700}', 'line-strong': '{graphite.600}',
    fg: '{graphite.100}', 'fg-2': '{graphite.300}', 'fg-3': '{graphite.400}', 'fg-inverse': '{graphite.950}',
    accent: '{glacier.400}', 'accent-strong': '{glacier.300}', 'accent-subtle': mix('{glacier.400}', 16), 'on-accent': '{graphite.950}',
    armed: '{ignition.500}', 'armed-subtle': mix('{ignition.500}', 16), 'on-armed': '{graphite.950}',
    ok: '{verdigris.400}', 'ok-subtle': mix('{verdigris.400}', 14),
    warn: '{sodium.400}', 'warn-subtle': mix('{sodium.400}', 14),
    crit: '{signal.400}', 'crit-subtle': mix('{signal.400}', 14),
    info: '{glacier.400}', neutral: '{graphite.400}', focus: '{glacier.300}',
    'chart-1': '{chart-dark.1}', 'chart-2': '{chart-dark.2}', 'chart-3': '{chart-dark.3}',
    'chart-4': '{chart-dark.4}', 'chart-5': '{chart-dark.5}', 'chart-6': '{chart-dark.6}',
  },
  paper: {
    canvas: '{slate.100}', panel: '{slate.0}', raised: '{slate.50}', sunken: '{slate.200}',
    hover: '{slate.100}', selected: mix('{glacier.700}', 10, '{slate.0}'),
    line: '{slate.200}', 'line-strong': '{slate.300}',
    fg: '{slate.900}', 'fg-2': '{slate.700}', 'fg-3': '{slate.600}', 'fg-inverse': '{slate.0}',
    accent: '{glacier.700}', 'accent-strong': '{glacier.800}', 'accent-subtle': mix('{glacier.700}', 12), 'on-accent': '{slate.0}',
    armed: '{ignition.700}', 'armed-subtle': mix('{ignition.700}', 12), 'on-armed': '{slate.0}',
    ok: '{verdigris.700}', 'ok-subtle': mix('{verdigris.700}', 12),
    warn: '{sodium.700}', 'warn-subtle': mix('{sodium.700}', 12),
    crit: '{signal.700}', 'crit-subtle': mix('{signal.700}', 12),
    info: '{glacier.700}', neutral: '{slate.600}', focus: '{glacier.700}',
    'chart-1': '{chart-light.1}', 'chart-2': '{chart-light.2}', 'chart-3': '{chart-light.3}',
    'chart-4': '{chart-light.4}', 'chart-5': '{chart-light.5}', 'chart-6': '{chart-light.6}',
  },
  contrast: {
    canvas: '{hc.black}', panel: '{hc.950}', raised: '{hc.900}', sunken: '{hc.black}',
    hover: '{hc.900}', selected: mix('{hc.accent}', 22, '{hc.black}'),
    line: '{hc.line}', 'line-strong': '{hc.linestrong}',
    fg: '{hc.white}', 'fg-2': '{hc.fg2}', 'fg-3': '{hc.fg3}', 'fg-inverse': '{hc.black}',
    accent: '{hc.accent}', 'accent-strong': '{hc.white}', 'accent-subtle': mix('{hc.accent}', 22), 'on-accent': '{hc.black}',
    armed: '{hc.armed}', 'armed-subtle': mix('{hc.armed}', 22), 'on-armed': '{hc.black}',
    ok: '{hc.ok}', 'ok-subtle': mix('{hc.ok}', 20),
    warn: '{hc.warn}', 'warn-subtle': mix('{hc.warn}', 20),
    crit: '{hc.crit}', 'crit-subtle': mix('{hc.crit}', 20),
    info: '{hc.accent}', neutral: '{hc.fg3}', focus: '{hc.white}',
    'chart-1': '{chart-dark.1}', 'chart-2': '{chart-dark.2}', 'chart-3': '{chart-dark.3}',
    'chart-4': '{chart-dark.4}', 'chart-5': '{chart-dark.5}', 'chart-6': '{chart-dark.6}',
  },
};

export const scale = {
  space: { 0: '0', 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px', 8: '32px', 10: '40px', 12: '48px', 16: '64px' },
  radius: { none: '0', sm: '3px', md: '6px', lg: '10px', xl: '14px', pill: '999px' },
  fontSize: { '2xs': '11px', xs: '12px', sm: '13px', md: '14px', lg: '16px', xl: '20px', '2xl': '24px', '3xl': '32px', '4xl': '40px' },
  lineHeight: { tight: '1.15', snug: '1.3', normal: '1.5' },
  tracking: { label: '0.08em', tight: '-0.01em', normal: '0' },
  shadow: {
    1: '0 1px 0 rgb(0 0 0 / 0.25)',
    2: '0 6px 20px -6px rgb(0 0 0 / 0.45)',
    3: '0 18px 48px -12px rgb(0 0 0 / 0.55)',
  },
  motion: { fast: '120ms', base: '200ms', slow: '320ms', ease: 'cubic-bezier(0.2, 0, 0, 1)' },
  layout: { 'rail-h': '48px', 'nav-w': '232px', 'nav-w-collapsed': '56px', 'inspector-w': '440px', 'dock-h': '36px', 'content-max': '1680px' },
  z: { sticky: '10', dock: '20', drawer: '30', overlay: '40', toast: '50', palette: '60' },
} as const;

export const DENSITY_NAMES = ['comfortable', 'compact'] as const; // default first
export type DensityName = (typeof DENSITY_NAMES)[number];
export const DEFAULT_DENSITY: DensityName = 'comfortable';
export const densities: Record<DensityName, Record<string, string>> = {
  comfortable: { 'control-h': '34px', 'row-h': '40px', 'font-size-ui': '14px', 'pad-panel': '20px', 'gap-grid': '16px' },
  compact: { 'control-h': '28px', 'row-h': '30px', 'font-size-ui': '13px', 'pad-panel': '14px', 'gap-grid': '12px' },
};

export const fonts = {
  display: "'Archivo Variable', 'Archivo', ui-sans-serif, system-ui, sans-serif",
  body: "'Atkinson Hyperlegible Next', ui-sans-serif, system-ui, sans-serif",
  mono: "'Atkinson Hyperlegible Mono', ui-monospace, 'Cascadia Mono', monospace",
} as const;

/** Tier 3: change one line, every instance follows. Values may use any --af-* variable. */
export const components = {
  'button-radius': 'var(--af-radius-md)',
  'input-radius': 'var(--af-radius-md)',
  'panel-radius': 'var(--af-radius-lg)',
  'panel-border': '1px solid var(--af-line)',
  'pill-radius': 'var(--af-radius-pill)',
  'table-row-h': 'var(--af-row-h)',
  'display-stretch': '112%',
  'label-stretch': '85%',
  'page-title-font': '650 var(--af-font-size-2xl) / var(--af-line-height-tight) var(--af-font-display)',
  'kpi-value-font': '600 var(--af-font-size-3xl) / 1 var(--af-font-display)',
  'label-font': '600 var(--af-font-size-2xs) / 1 var(--af-font-display)',
  'focus-ring': '0 0 0 2px var(--af-canvas), 0 0 0 4px var(--af-focus)',
  'armed-ring': 'inset 0 0 0 2px var(--af-armed)',
  'armed-texture': 'repeating-linear-gradient(45deg, rgb(0 0 0 / 0.07) 0 8px, transparent 8px 16px)',
} as const;

/** Resolves a theme value that is exactly one primitive reference (or a raw hex) to #RRGGBB. */
export function resolveHex(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase();
  const m = /^\{([a-z-]+)\.([a-z0-9]+)\}$/i.exec(value);
  const hex = m ? (primitives.color as Record<string, Record<string, string>>)[m[1]!]?.[m[2]!] : undefined;
  if (!hex) throw new Error(`Unknown color reference ${value}`);
  return hex;
}
```

`src/index.ts`
```ts
export * from './tokens';
export { contrastRatio, luminance, hexToRgb } from './color';
```

**Step 9: Run** → PASS (values in §6.2 were pre-verified; if a pair fails, adjust the primitive, never the threshold).

**Step 10: Commit** — `git add packages/design-tokens && git commit -m "feat(tokens): typed token source with contrast-tested themes"`

### Task 1.4: Design tokens — emit CSS, Tailwind theme, ECharts themes

**Files:**
- Create: `packages/design-tokens/src/emit.ts`, `src/build.ts`
- Test: `packages/design-tokens/test/emit.test.ts`

**Step 1: Failing test**

`test/emit.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { emitCss, emitEchartsTheme, emitTailwindTheme, resolveRefs } from '../src/emit';
import { SEMANTIC_KEYS } from '../src/tokens';

describe('emitCss', () => {
  const css = emitCss();
  it('emits primitives, the default theme on :root, and later themes after it', () => {
    expect(css).toContain('--af-p-graphite-900: #131920;');
    expect(css).toMatch(/:root, \[data-theme="graphite"\] \{[^}]*--af-canvas: var\(--af-p-graphite-900\);/);
    expect(css.indexOf('[data-theme="paper"]')).toBeGreaterThan(css.indexOf('[data-theme="graphite"]'));
    expect(css).toMatch(/\[data-theme="paper"\] \{\s*color-scheme: light;/);
  });
  it('emits densities and scale tokens', () => {
    expect(css).toMatch(/\[data-density="compact"\] \{[^}]*--af-row-h: 30px;/);
    expect(css).toContain('--af-font-size-md: 14px;');
    expect(css).toContain('--af-motion-slow: 320ms;');
  });
  it('re-resolves component tokens inside themed subtrees', () => {
    expect(css).toMatch(/:root, \[data-theme\], \[data-density\] \{[^}]*--af-table-row-h: var\(--af-row-h\);/);
  });
});

describe('resolveRefs', () => {
  it('rejects unknown references', () => expect(() => resolveRefs('{nope.1}')).toThrow(/Unknown color reference/));
});

describe('emitTailwindTheme', () => {
  const tw = emitTailwindTheme();
  it('removes Tailwind defaults and maps every semantic color', () => {
    expect(tw).toContain('--color-*: initial;');
    for (const k of SEMANTIC_KEYS) expect(tw).toContain(`--color-${k}: var(--af-${k});`);
    expect(tw).toContain('--text-2xs: var(--af-font-size-2xs);');
    expect(tw).toContain('--radius-lg: var(--af-radius-lg);');
  });
});

describe('emitEchartsTheme', () => {
  it('resolves chart colors to hex in order', () => {
    expect(emitEchartsTheme('graphite').color).toEqual(['#4A8AD8', '#C9692A', '#1F9C7E', '#9775E2', '#CB527F', '#AD8826']);
    expect(emitEchartsTheme('paper').color[0]).toBe('#2A6CC0');
  });
});
```

**Step 2: Run** → FAIL.

**Step 3: Implement**

`src/emit.ts`
```ts
import {
  components, densities, DEFAULT_DENSITY, DEFAULT_THEME, fonts, primitives, resolveHex, scale,
  SEMANTIC_KEYS, themeMeta, THEME_NAMES, themes, type SemanticKey, type ThemeName,
} from './tokens';

const P = '--af-';
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const REF = /\{([a-z-]+)\.([a-z0-9]+)\}/gi;
const colors = primitives.color as Record<string, Record<string, string>>;

export function resolveRefs(value: string): string {
  return value.replace(REF, (_m, family: string, step: string) => {
    if (!colors[family]?.[step]) throw new Error(`Unknown color reference {${family}.${step}}`);
    return `var(${P}p-${family}-${step})`;
  });
}

function block(selector: string, vars: Record<string, string>, extra: string[] = []): string {
  const lines = [...extra, ...Object.entries(vars).map(([k, v]) => `${P}${k}: ${v};`)];
  return `${selector} {\n${lines.map((l) => `  ${l}`).join('\n')}\n}\n`;
}

const selectorFor = (attr: string, name: string, isDefault: boolean) =>
  isDefault ? `:root, [${attr}="${name}"]` : `[${attr}="${name}"]`;

export function emitCss(): string {
  const base: Record<string, string> = {};
  for (const [family, steps] of Object.entries(colors)) for (const [step, hex] of Object.entries(steps)) base[`p-${family}-${step}`] = hex;
  for (const [group, entries] of Object.entries(scale)) for (const [k, v] of Object.entries(entries)) base[`${kebab(group)}-${k}`] = v;
  for (const [k, v] of Object.entries(fonts)) base[`font-${k}`] = v;

  const out = ['/* Generated by @adminforge/design-tokens — edit src/tokens.ts, not this file. */\n', block(':root', base)];
  for (const name of THEME_NAMES) {
    const vars = Object.fromEntries(SEMANTIC_KEYS.map((k) => [k, resolveRefs(themes[name][k])]));
    out.push(block(selectorFor('data-theme', name, name === DEFAULT_THEME), vars, [`color-scheme: ${themeMeta[name].scheme};`]));
  }
  for (const [name, vars] of Object.entries(densities)) out.push(block(selectorFor('data-density', name, name === DEFAULT_DENSITY), vars));
  // Declared on themed subtrees too, so a compact table inside a comfortable page re-resolves var(--af-row-h).
  out.push(block(':root, [data-theme], [data-density]', components));
  return out.join('\n');
}

export function emitTailwindTheme(): string {
  const lines = [
    '/* Generated by @adminforge/design-tokens. Tailwind can only express design tokens: defaults are removed on purpose. */',
    '@theme inline {',
    '  --color-*: initial;',
    '  --font-*: initial;',
    '  --text-*: initial;',
    '  --radius-*: initial;',
    '  --shadow-*: initial;',
    '  --spacing: 4px;',
    '  --color-transparent: transparent;',
    '  --color-current: currentColor;',
    ...SEMANTIC_KEYS.map((k) => `  --color-${k}: var(${P}${k});`),
    ...Object.keys(fonts).map((k) => `  --font-${k}: var(${P}font-${k});`),
    ...Object.keys(scale.fontSize).map((k) => `  --text-${k}: var(${P}font-size-${k});`),
    ...Object.keys(scale.radius).map((k) => `  --radius-${k}: var(${P}radius-${k});`),
    ...Object.keys(scale.shadow).map((k) => `  --shadow-${k}: var(${P}shadow-${k});`),
    '}',
  ];
  return `${lines.join('\n')}\n`;
}

export function emitEchartsTheme(name: ThemeName) {
  const hex = (k: SemanticKey) => resolveHex(themes[name][k]);
  return {
    color: ([1, 2, 3, 4, 5, 6] as const).map((i) => hex(`chart-${i}`)),
    backgroundColor: 'transparent',
    textStyle: { fontFamily: fonts.body, color: hex('fg-2') },
    title: { textStyle: { color: hex('fg'), fontFamily: fonts.display } },
    legend: { textStyle: { color: hex('fg-2') } },
    tooltip: { backgroundColor: hex('raised'), borderColor: hex('line-strong'), textStyle: { color: hex('fg') } },
    categoryAxis: { axisLine: { lineStyle: { color: hex('line-strong') } }, axisTick: { show: false }, axisLabel: { color: hex('fg-3') }, splitLine: { show: false } },
    valueAxis: { axisLine: { show: false }, axisLabel: { color: hex('fg-3') }, splitLine: { lineStyle: { color: hex('line') } } },
    line: { lineStyle: { width: 2 }, symbolSize: 8 },
    bar: { itemStyle: { borderRadius: [4, 4, 0, 0] } },
  };
}
```

`src/build.ts`
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emitCss, emitEchartsTheme, emitTailwindTheme } from './emit';
import { THEME_NAMES } from './tokens';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
mkdirSync(dist, { recursive: true });
writeFileSync(`${dist}tokens.css`, emitCss());
writeFileSync(`${dist}tailwind-theme.css`, emitTailwindTheme());
for (const name of THEME_NAMES) writeFileSync(`${dist}echarts-${name}.json`, `${JSON.stringify(emitEchartsTheme(name), null, 2)}\n`);
console.log(`design-tokens: wrote ${2 + THEME_NAMES.length} files to dist/`);
```

**Step 4: Run tests** → PASS. **Run build:** `pnpm --filter @adminforge/design-tokens build` → `design-tokens: wrote 5 files to dist/`.

**Step 5: Commit** — `git commit -am "feat(tokens): emit CSS variables, Tailwind theme, ECharts themes"` (add new files first).

### Task 1.5: Web app scaffold (Vite, React, TanStack Router, Tailwind v4, fonts)

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/public/theme-init.js`, `apps/web/src/main.tsx`, `apps/web/src/styles.css`
- Create: `apps/web/src/routes/__root.tsx`, `apps/web/src/routes/index.tsx`
- Create: `packages/ui/package.json`, `packages/ui/src/styles/base.css`, `packages/ui/src/index.ts`

**Step 1: Install**

```bash
mkdir -p apps/web packages/ui
pnpm --filter @adminforge/web add react react-dom @tanstack/react-router @tanstack/react-query @adminforge/ui@workspace:* @adminforge/design-tokens@workspace:*
pnpm --filter @adminforge/web add -D vite @vitejs/plugin-react tailwindcss @tailwindcss/vite @tanstack/router-plugin @types/react @types/react-dom
pnpm view @fontsource-variable/archivo name && pnpm view @fontsource/atkinson-hyperlegible-next name && pnpm view @fontsource/atkinson-hyperlegible-mono name
```
Add whichever font packages resolve (variable variants preferred). If one doesn't exist, download the woff2 files from Google Fonts into `apps/web/public/fonts/` and declare `@font-face` in `styles.css` instead. Record the outcome in `docs/decisions.md`.

**Step 2: Write files**

`apps/web/vite.config.ts`
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001', '/auth': 'http://localhost:3001' },
  },
});
```

`apps/web/index.html`
```html
<!doctype html>
<html lang="en" data-theme="graphite" data-density="comfortable">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AdminForge</title>
    <script src="/theme-init.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/public/theme-init.js` (external file, so the CSP needs no inline script; prevents a theme flash before React boots)
```js
(function () {
  var root = document.documentElement;
  try {
    var prefs = JSON.parse(localStorage.getItem('adminforge.prefs') || '{}');
    root.dataset.theme = prefs.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'paper' : 'graphite');
    root.dataset.density = prefs.density || 'comfortable';
  } catch (e) {
    root.dataset.theme = 'graphite';
  }
})();
```

`apps/web/src/styles.css`
```css
@import 'tailwindcss';
@import '@adminforge/design-tokens/tokens.css';
@import '@adminforge/design-tokens/tailwind-theme.css';
@import '@adminforge/ui/styles/base.css';
@source '../../../packages/ui/src';
@source '../../../packages/widgets/src';
```

`packages/ui/src/styles/base.css`
```css
@layer base {
  html {
    background: var(--af-canvas);
    color: var(--af-fg);
    font-family: var(--af-font-body);
    font-size: var(--af-font-size-ui);
    line-height: var(--af-line-height-normal);
    -webkit-font-smoothing: antialiased;
  }
  body { margin: 0; min-height: 100dvh; }
  :focus-visible { outline: none; box-shadow: var(--af-focus-ring); }
  ::selection { background: var(--af-accent-subtle); }
  code, kbd, samp, pre { font-family: var(--af-font-mono); font-size: 0.95em; }
  .tabular { font-variant-numeric: tabular-nums; }
  .az-eyebrow {
    font: var(--af-label-font);
    font-stretch: var(--af-label-stretch);
    letter-spacing: var(--af-tracking-label);
    text-transform: uppercase;
    color: var(--af-fg-3);
  }
  .az-page-title { font: var(--af-page-title-font); font-stretch: var(--af-display-stretch); letter-spacing: var(--af-tracking-tight); }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
  }
}
```

`packages/ui/package.json`
```json
{
  "name": "@adminforge/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./styles/base.css": "./src/styles/base.css" },
  "scripts": { "test": "vitest run", "typecheck": "tsc -p tsconfig.json", "lint": "eslint src" }
}
```

`apps/web/src/routes/__root.tsx`
```tsx
import { createRootRoute, Outlet } from '@tanstack/react-router';

export const Route = createRootRoute({ component: () => <Outlet /> });
```

`apps/web/src/routes/index.tsx`
```tsx
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: () => (
    <main className="p-8">
      <p className="az-eyebrow">Tenant</p>
      <h1 className="az-page-title text-fg">AdminForge</h1>
      <p className="text-fg-2">Foundations are running.</p>
    </main>
  ),
});
```

`apps/web/src/main.tsx`
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });
const router = createRouter({ routeTree, context: { queryClient } });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
```

`apps/web/package.json` scripts: `"dev": "vite"`, `"build": "vite build"`, `"preview": "vite preview"`, `"typecheck": "tsc -p tsconfig.json"`, `"lint": "eslint src"`, `"e2e": "playwright test"`. `apps/web/tsconfig.json` extends base with `"lib": ["ES2023", "DOM", "DOM.Iterable"]`, `"jsx": "react-jsx"`, `"types": ["vite/client"]`.

**Step 3: Verify**

Run: `pnpm --filter @adminforge/design-tokens build && pnpm --filter @adminforge/web build`
Expected: build succeeds; `dist/assets/*.css` contains `--af-canvas` and a `.bg-panel`-style utility only if used (Tailwind tree-shakes). Then `pnpm --filter @adminforge/web dev`, screenshot `http://localhost:5173` with Playwright (system Chrome) in both themes (`document.documentElement.dataset.theme='paper'`) and check the title renders in Archivo and body in Atkinson.

**Step 4: Commit** — `feat(web): Vite + React + TanStack Router + token-only Tailwind`

### Task 1.6: UI recipes and the Button primitive (template for every primitive)

**Files:**
- Create: `packages/ui/src/recipes/tv.ts`, `packages/ui/src/recipes/button.ts`, `packages/ui/src/primitives/Button.tsx`
- Create: `packages/ui/vitest.config.ts`, `packages/ui/test/setup.ts`
- Test: `packages/ui/test/button.test.tsx`

**Step 1: Install** — `pnpm --filter @adminforge/ui add react tailwind-variants tailwind-merge radix-ui @phosphor-icons/react @adminforge/design-tokens@workspace:*` and `-D vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom axe-core @vitejs/plugin-react @types/react`

`packages/ui/vitest.config.ts`
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()], test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'] } });
```

`packages/ui/test/setup.ts`
```ts
import '@testing-library/jest-dom/vitest';
```

**Step 2: Failing test**

`test/button.test.tsx`
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../src/primitives/Button';
import { button } from '../src/recipes/button';

describe('Button', () => {
  it('renders its label and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save changes</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('a locked action stays focusable, explains why, and does nothing', async () => {
    const onClick = vi.fn();
    render(<Button locked="Arm write access to use this." onClick={onClick}>Disable sign-in</Button>);
    const btn = screen.getByRole('button', { name: 'Disable sign-in' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAccessibleDescription('Arm write access to use this.');
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('merges token classes without dropping colour or size (tailwind-merge knows our tokens)', () => {
    const cls = button({ intent: 'primary', class: 'text-2xs' });
    expect(cls).toContain('text-on-accent');
    expect(cls).toContain('text-2xs');
  });

  it('has no axe violations', async () => {
    const { container } = render(<Button intent="primary">Run playbook</Button>);
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
```

**Step 3: Run** → FAIL.

**Step 4: Implement**

`src/recipes/tv.ts`
```ts
import { createTV } from 'tailwind-variants';
import { scale, SEMANTIC_KEYS } from '@adminforge/design-tokens';

/** tailwind-merge must know our token names, or it treats text-fg and text-2xs as conflicts. */
export const tv = createTV({
  twMergeConfig: {
    extend: {
      theme: {
        color: [...SEMANTIC_KEYS],
        text: Object.keys(scale.fontSize),
        radius: Object.keys(scale.radius),
        shadow: Object.keys(scale.shadow),
      },
    },
  },
});
```
(If the installed tailwind-variants version names this option differently, adapt — the merge test above is the contract.)

`src/recipes/button.ts`
```ts
import type { VariantProps } from 'tailwind-variants';
import { tv } from './tv';

export const button = tv({
  base: [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap select-none',
    'h-(--af-control-h) px-3 rounded-(--af-button-radius) text-sm font-semibold',
    'transition-colors duration-(--af-motion-fast)',
    'aria-disabled:cursor-not-allowed aria-disabled:opacity-55',
  ],
  variants: {
    intent: {
      primary: 'bg-accent text-on-accent hover:bg-accent-strong',
      secondary: 'bg-raised text-fg border border-line hover:border-line-strong hover:bg-hover',
      ghost: 'text-fg-2 hover:text-fg hover:bg-hover',
      danger: 'bg-crit text-fg-inverse hover:opacity-90',
      armed: 'bg-armed text-on-armed hover:opacity-90',
    },
    size: { sm: 'h-7 px-2 text-xs', md: '', icon: 'w-(--af-control-h) px-0' },
  },
  defaultVariants: { intent: 'secondary', size: 'md' },
});

export type ButtonVariants = VariantProps<typeof button>;
```

`src/primitives/Button.tsx`
```tsx
import { useId, type ComponentProps, type MouseEvent } from 'react';
import { button, type ButtonVariants } from '../recipes/button';

export type ButtonProps = ComponentProps<'button'> & ButtonVariants & {
  /** When set, the button stays focusable but inert, and this text is announced as its description. */
  locked?: string;
};

export function Button({ intent, size, locked, className, onClick, children, type = 'button', ...rest }: ButtonProps) {
  const descId = useId();
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (locked) return e.preventDefault();
    onClick?.(e);
  };
  return (
    <button
      type={type}
      {...rest}
      aria-disabled={locked ? true : rest['aria-disabled']}
      aria-describedby={locked ? descId : rest['aria-describedby']}
      className={button({ intent, size, className })}
      onClick={handleClick}
    >
      {children}
      {locked && <span id={descId} className="sr-only">{locked}</span>}
    </button>
  );
}
```

**Step 5: Run** → PASS. **Step 6: Commit** — `feat(ui): recipe pattern and Button primitive`

### Task 1.7: Core primitives (same TDD pattern as Task 1.6)

**Files:** `packages/ui/src/recipes/*.ts`, `packages/ui/src/primitives/*.tsx`, `packages/ui/test/*.test.tsx`

Implement each with a recipe + component + test (render, keyboard where interactive, axe = 0 violations):

| Component | Acceptance criteria |
|---|---|
| `IdChip` | Shows `3f2a…9c1d` for a GUID; full value in `title`; copy button labelled "Copy <label> <value>" writes the full value; mono font, tabular. |
| `StatusPill` | `status: ok\|warn\|crit\|info\|neutral` → icon + label (never color alone); uses `-subtle` fill + solid text. |
| `Panel` | Header (eyebrow + title + actions), body, footer slot; `--af-panel-*` tokens only. |
| `Kpi` | Value in `--af-kpi-value-font`, label, optional delta and status, loading skeleton, `aria-live="polite"` on refresh. |
| `ProvenanceFooter` | `service · path · 1.2 s · cached 30 s ago`, muted mono 11 px; relative time updates every 15 s. |
| `DataTable` | TanStack Table + Virtual; sticky header; sortable headers with `aria-sort`; row height `--af-table-row-h`; column kinds `text\|identity\|status\|relativeTime\|number\|id`; keyboard row navigation; empty and error states. |
| `EmptyState` / `ErrorState` | Title, one-line guidance, one primary action; error shows code + correlation id (IdChip). |
| `Skeleton` | Shimmer disabled under reduced motion. |
| `Tooltip`, `Dialog`, `ConfirmDialog`, `Drawer`, `Menu`, `Tabs`, `Toast` | Radix-based; focus trapped/restored; `ConfirmDialog` typed mode blocks confirm until the exact text is typed. |

Example implementation to copy the pattern from:

`src/primitives/IdChip.tsx`
```tsx
import { useState } from 'react';
import { Check, Copy } from '@phosphor-icons/react';
import { tv } from '../recipes/tv';

const chip = tv({
  slots: {
    root: 'inline-flex items-center gap-1 rounded-sm border border-line bg-sunken px-1.5 py-0.5 text-xs',
    label: 'text-fg-3',
    value: 'font-mono tabular text-fg-2',
    copy: 'inline-flex size-5 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg',
  },
});

export function shorten(value: string, head = 4, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export function IdChip({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const s = chip();
  return (
    <span className={s.root()}>
      {label && <span className={s.label()}>{label}</span>}
      <code className={s.value()} title={value}>{shorten(value)}</code>
      <button
        type="button"
        className={s.copy()}
        aria-label={`Copy ${label ?? 'value'} ${value}`}
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
    </span>
  );
}
```
(`px-1.5`/`py-0.5`/`size-5` are spacing-scale utilities, not arbitrary values.)

Commit after each component: `feat(ui): <Component>`.

### Task 1.8: App shell with theme, density, and the armed state

**Files:**
- Create: `apps/web/src/app/AppShell.tsx`, `SessionRail.tsx`, `NavRail.tsx`, `Inspector.tsx`, `RunDock.tsx`, `ArmControl.tsx`, `UserMenu.tsx`, `DevToolbar.tsx`
- Create: `apps/web/src/app/session.ts` (`useSession()` over `GET /api/me` with TanStack Query), `apps/web/src/app/prefs.ts`
- Create: `packages/ui/src/styles/shell.css` (imported by base.css)
- Test: `apps/web/src/app/arm.test.ts`, `apps/web/src/app/ArmControl.test.tsx`

**Step 1: Failing unit test for the countdown**

`apps/web/src/app/arm.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { formatRemaining } from './arm';

describe('formatRemaining', () => {
  it('formats minutes and seconds', () => expect(formatRemaining(59 * 60_000 + 41_000)).toBe('59:41'));
  it('formats hours when needed', () => expect(formatRemaining(2 * 3_600_000 + 5 * 60_000)).toBe('2:05:00'));
  it('never goes negative', () => expect(formatRemaining(-5_000)).toBe('0:00'));
});
```

**Step 2: Implement** `apps/web/src/app/arm.ts`

```ts
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
```

**Step 3: Armed chrome** — `packages/ui/src/styles/shell.css`

```css
@layer components {
  .az-rail {
    position: relative;
    height: var(--af-layout-rail-h);
    background: var(--af-panel);
    color: var(--af-fg);
    border-bottom: 1px solid var(--af-line);
    isolation: isolate;
  }
  /* The one orchestrated moment: the rail fills left → right when write access is armed. */
  .az-rail::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background: var(--af-armed-texture), var(--af-armed);
    transform: scaleX(0);
    transform-origin: left;
    transition: transform var(--af-motion-slow) var(--af-motion-ease);
  }
  html[data-mode='armed'] .az-rail { color: var(--af-on-armed); border-bottom-color: var(--af-armed); }
  html[data-mode='armed'] .az-rail::before { transform: scaleX(1); }
  html[data-mode='armed'] body::after {
    content: '';
    position: fixed;
    inset: 0;
    pointer-events: none;
    box-shadow: var(--af-armed-ring);
    z-index: var(--af-z-overlay);
  }
}
```

**Step 4: Components** — behaviour to implement and test (`ArmControl.test.tsx`):
- Read mode: pill "Read-only" (accent outline) + button **Arm write access** (opens dialog with duration select and required reason; **Continue to sign-in** navigates to `/auth/arm?minutes=…&reason=…`). Hidden entirely for users without `Portal.Operator`.
- Armed: `<html data-mode="armed">`; text `Armed · 47:12` (updates each second via `formatRemaining`, `aria-live="off"` so screen readers aren't spammed; a polite announcement at 5 min remaining); **Extend** (once) and **Disarm**.
- `WriteAction` wrapper: `<Button locked={armed ? undefined : 'Arm write access to use this.'}>` + lock glyph in read mode, small `armed` dot when armed.
- `UserMenu`: theme (Graphite / Paper / High contrast / Match system), density (Comfortable / Compact) → sets `<html data-theme/data-density>`, mirrors to `localStorage['adminforge.prefs']`, persists via `PUT /api/me/prefs`.
- `NavRail`: sections from `/api/nav` (static list until Phase 3), collapsible to icons, active item indicator in accent.
- `DevToolbar` (mock mode only): toggle roles and armed state.

**Step 5: Verify** — Playwright screenshots of the shell in read vs armed, all themes; check the ring and rail fill visually; check keyboard: Tab reaches Arm, menu, nav.

**Step 6: Commit** — `feat(web): app shell with theme/density switching and armed state`

### Task 1.9: BFF skeleton with validated config

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/config.ts`, `apps/api/src/app.ts`, `apps/api/src/main.ts`, `apps/api/.env.example`
- Test: `apps/api/test/config.test.ts`, `apps/api/test/health.test.ts`

**Step 1: Install** — `pnpm --filter @adminforge/api add fastify @fastify/cookie @fastify/helmet @fastify/rate-limit @fastify/static zod` and `-D tsup vitest pino-pretty @types/node`

**Step 2: Failing tests**

`test/config.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const base = { PUBLIC_BASE_URL: 'http://localhost:5173', DATABASE_URL: 'postgres://x' };

describe('loadConfig', () => {
  it('defaults to mock auth in development', () => {
    expect(loadConfig({ ...base }).AUTH_MODE).toBe('mock');
  });
  it('requires Entra settings when AUTH_MODE=entra', () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: 'entra' })).toThrow(/ENTRA_TENANT_ID/);
  });
  it('refuses mock auth in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', AUTH_MODE: 'mock' })).toThrow(/mock auth/i);
  });
});
```

`test/health.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

describe('health', () => {
  it('GET /healthz returns ok with no-store and a CSP', async () => {
    const app = await buildApp(loadConfig({ PUBLIC_BASE_URL: 'http://localhost:5173', DATABASE_URL: 'postgres://x' }));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});
```

**Step 3: Run** → FAIL.

**Step 4: Implement**

`src/config.ts`
```ts
import { z } from 'zod';

const Schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3001),
    PUBLIC_BASE_URL: z.url(),
    AUTH_MODE: z.enum(['entra', 'mock']).default('mock'),
    DATA_MODE: z.enum(['live', 'fixtures']).default('fixtures'),
    ENTRA_TENANT_ID: z.uuid().optional(),
    ENTRA_READ_CLIENT_ID: z.uuid().optional(),
    ENTRA_WRITE_CLIENT_ID: z.uuid().optional(),
    ENTRA_CREDENTIAL: z.enum(['secret', 'managedIdentity']).default('secret'),
    ENTRA_READ_CLIENT_SECRET: z.string().optional(),
    ENTRA_WRITE_CLIENT_SECRET: z.string().optional(),
    MANAGED_IDENTITY_CLIENT_ID: z.uuid().optional(),
    WRITE_AUTH_CONTEXT: z.string().regex(/^c([1-9]|[1-9][0-9])$/).optional(),
    WRITE_SESSION_MAX_MINUTES: z.coerce.number().int().min(5).max(480).default(60),
    SESSION_IDLE_MINUTES: z.coerce.number().int().default(60),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().default(12),
    DATABASE_URL: z.string().min(1),
    TOKEN_CACHE_KEY: z.string().optional(), // base64, 32 bytes — local dev only; Azure loads it from Key Vault
    KEY_VAULT_URL: z.url().optional(),
    SPO_TENANT_NAME: z.string().optional(), // "contoso" for contoso-admin.sharepoint.com
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === 'entra') {
      for (const key of ['ENTRA_TENANT_ID', 'ENTRA_READ_CLIENT_ID'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when AUTH_MODE=entra` });
      }
    }
    if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'mock') {
      ctx.addIssue({ code: 'custom', path: ['AUTH_MODE'], message: 'mock auth is not allowed in production' });
    }
  });

export type Config = z.infer<typeof Schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
```

`src/app.ts`
```ts
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import type { Config } from './config';

export async function buildApp(config: Config) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: true,
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // tightened in Phase 8 once Radix/Monaco style injection is audited
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/auth')) reply.header('cache-control', 'no-store');
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.decorate('config', config);
  return app;
}
```

`src/main.ts`
```ts
import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const app = await buildApp(config);
await app.listen({ port: config.PORT, host: '0.0.0.0' });
```

`apps/api/package.json` scripts: `"dev": "tsx watch --env-file=.env.local src/main.ts"`, `"build": "tsup src/main.ts --format esm --target node24 --clean --no-splitting --noExternal @adminforge"`, `"start": "node dist/main.js"`, `"test": "vitest run"`, `"typecheck": "tsc -p tsconfig.json"`.

`.env.example`
```dotenv
PUBLIC_BASE_URL=http://localhost:5173
AUTH_MODE=mock
DATA_MODE=fixtures
DATABASE_URL=postgres://adminforge:adminforge-local-only@127.0.0.1:55432/adminforge
# AUTH_MODE=entra
# ENTRA_TENANT_ID=
# ENTRA_READ_CLIENT_ID=
# ENTRA_READ_CLIENT_SECRET=   (written by Task 1.16, never committed)
# TOKEN_CACHE_KEY=            (openssl rand -base64 32)
```

**Step 5: Run** → PASS. **Step 6: Commit** — `feat(api): Fastify BFF skeleton with validated config and security headers`

### Task 1.10: Local Postgres and the Phase 1 schema

**Files:**
- Create: `docker-compose.yml`, `apps/api/drizzle.config.ts`, `apps/api/src/db/schema.ts`, `apps/api/src/db/client.ts`
- Generated: `apps/api/drizzle/0000_*.sql`

**Step 1:** `docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: adminforge
      POSTGRES_PASSWORD: adminforge-local-only
      POSTGRES_DB: adminforge
    ports: ['127.0.0.1:55432:5432'] # 5432 is taken by the host's own Postgres
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U adminforge']
      interval: 5s
      retries: 10
volumes:
  pgdata: {}
```

**Step 2:** Install `pnpm --filter @adminforge/api add drizzle-orm pg` and `-D drizzle-kit @types/pg`.

`src/db/schema.ts`
```ts
import { sql } from 'drizzle-orm';
import { bigserial, boolean, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const sessions = pgTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userOid: text('user_oid').notNull(),
    upn: text('upn').notNull(),
    displayName: text('display_name').notNull(),
    tenantId: text('tenant_id').notNull(),
    roles: text('roles').array().notNull().default(sql`'{}'::text[]`),
    csrf: text('csrf').notNull(),
    readAccountId: text('read_account_id'),
    writeAccountId: text('write_account_id'),
    writeExpiresAt: ts('write_expires_at'),
    writeExtended: boolean('write_extended').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userOid)],
);

export const preauth = pgTable('preauth', {
  state: text('state').primaryKey(),
  kind: text('kind', { enum: ['read', 'write'] }).notNull(),
  verifier: text('verifier').notNull(),
  nonce: text('nonce').notNull(),
  returnTo: text('return_to').notNull(),
  sessionIdHash: text('session_id_hash'),
  details: jsonb('details'),
  expiresAt: ts('expires_at').notNull(),
});

export const tokenCache = pgTable('token_cache', {
  partitionKey: text('partition_key').primaryKey(),
  sealed: text('sealed').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const auditEvents = pgTable(
  'audit_events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    ts: ts('ts').notNull().defaultNow(),
    actorOid: text('actor_oid'),
    actorUpn: text('actor_upn'),
    sessionHash: text('session_hash'),
    mode: text('mode'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    details: jsonb('details'),
    result: text('result').notNull(),
    correlationId: text('correlation_id').notNull(),
    ip: text('ip'),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [index('audit_actor_idx').on(t.actorOid), index('audit_action_idx').on(t.action)],
);

export const userPrefs = pgTable('user_prefs', {
  userOid: text('user_oid').primaryKey(),
  prefs: jsonb('prefs').notNull().default({}),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
```

`drizzle.config.ts`
```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

Scripts: `"db:generate": "drizzle-kit generate"`, `"db:migrate": "drizzle-kit migrate"`.

**Step 3: Verify**

```bash
pnpm db:up
cp apps/api/.env.example apps/api/.env.local
pnpm --filter @adminforge/api exec drizzle-kit generate
DATABASE_URL=postgres://adminforge:adminforge-local-only@127.0.0.1:55432/adminforge pnpm --filter @adminforge/api db:migrate
psql postgres://adminforge:adminforge-local-only@127.0.0.1:55432/adminforge -c '\dt'
```
Expected: tables `sessions, preauth, token_cache, audit_events, user_prefs`.

**Step 4: Commit** — `feat(api): local Postgres and Phase 1 schema`

### Task 1.11: Envelope encryption and the encrypted MSAL token cache

**Files:**
- Create: `apps/api/src/security/envelope.ts`, `apps/api/src/auth/token-cache.ts`
- Test: `apps/api/test/envelope.test.ts`, `apps/api/test/token-cache.int.test.ts`

**Step 1: Failing test**

`test/envelope.test.ts`
```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { open, seal } from '../src/security/envelope';

const key = randomBytes(32);

describe('envelope', () => {
  it('round-trips', () => expect(open(seal('{"a":1}', key, 'read:abc'), key, 'read:abc')).toBe('{"a":1}'));
  it('does not leak plaintext', () => expect(seal('secret-token', key, 'p')).not.toContain('secret'));
  it('rejects tampering', () => {
    const parts = seal('hello', key, 'p').split('.');
    parts[3] = Buffer.from('jello').toString('base64url');
    expect(() => open(parts.join('.'), key, 'p')).toThrow();
  });
  it('binds ciphertext to its partition (AAD)', () => {
    expect(() => open(seal('hello', key, 'read:alice'), key, 'read:bob')).toThrow();
  });
  it('requires a 32-byte key', () => expect(() => seal('x', randomBytes(16), 'p')).toThrow(/32 bytes/));
});
```

**Step 2: Run** → FAIL. **Step 3: Implement**

`src/security/envelope.ts`
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = '1';

function assertKey(key: Buffer) {
  if (key.length !== 32) throw new Error('Envelope key must be 32 bytes');
}

/** AES-256-GCM. Output: "1.<iv>.<tag>.<ciphertext>" (base64url). `aad` binds the blob to its owner. */
export function seal(plaintext: string, key: Buffer, aad: string): string {
  assertKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function open(sealed: string, key: Buffer, aad: string): string {
  assertKey(key);
  const [version, iv, tag, ct] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error('Unsupported envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
```

**Step 4: Run** → PASS.

**Step 5: Token cache** — `src/auth/token-cache.ts` implements MSAL Node's `ICacheClient` (`get(key)`, `set(key, value)`) over `token_cache`, sealing with `aad = partitionKey`, plus `FixedPartition implements IPartitionManager` (`getKey()` and `extractKey()` both return the request's partition, e.g. `read:<sha256(sid)>`). Integration test (`*.int.test.ts`, skipped unless `DATABASE_URL` is set): `set` then `get` round-trips; the stored row doesn't contain the plaintext; `delete(partition)` removes it.

**Step 6: Commit** — `feat(api): AES-GCM envelope and encrypted MSAL cache store`

### Task 1.12: Request policy (default-deny in read mode)

**Files:**
- Create: `packages/connectors/package.json`, `packages/connectors/src/policy.ts`
- Test: `packages/connectors/test/policy.test.ts`

**Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/policy';

describe('request policy', () => {
  describe('read mode', () => {
    it('allows Graph GET', () => expect(evaluate('read', { service: 'graph', method: 'get', path: '/users' }).allowed).toBe(true));
    it('denies Graph PATCH with guidance', () => {
      const d = evaluate('read', { service: 'graph', method: 'PATCH', path: '/users/1' });
      expect(d).toEqual({ allowed: false, reason: expect.stringMatching(/Arm write access/) });
    });
    it('allows Resource Graph queries but not listKeys', () => {
      expect(evaluate('read', { service: 'arm', method: 'POST', path: '/providers/Microsoft.ResourceGraph/resources' }).allowed).toBe(true);
      expect(evaluate('read', { service: 'arm', method: 'POST', path: '/subscriptions/s/resourceGroups/r/providers/Microsoft.Storage/storageAccounts/a/listKeys' }).allowed).toBe(false);
    });
    it('checks every $batch sub-request', () => {
      const ok = { requests: [{ id: '1', method: 'GET', url: '/users' }] };
      const bad = { requests: [{ id: '1', method: 'GET', url: '/users' }, { id: '2', method: 'DELETE', url: '/groups/9' }] };
      expect(evaluate('read', { service: 'graph', method: 'POST', path: '/$batch', body: ok }).allowed).toBe(true);
      expect(evaluate('read', { service: 'graph', method: 'POST', path: '/$batch', body: bad }).allowed).toBe(false);
    });
    it('allows only Get-* cmdlets for Exchange and Teams', () => {
      expect(evaluate('read', { service: 'exchange', method: 'POST', path: '/InvokeCommand', cmdlet: 'Get-Mailbox' }).allowed).toBe(true);
      expect(evaluate('read', { service: 'exchange', method: 'POST', path: '/InvokeCommand', cmdlet: 'Set-Mailbox' }).allowed).toBe(false);
    });
    it('allows runner jobs only for steps declared read', () => {
      expect(evaluate('read', { service: 'runner', method: 'POST', path: '/jobs' }).allowed).toBe(true);
      expect(evaluate('read', { service: 'runner', method: 'POST', path: '/jobs', declaredWrite: true }).allowed).toBe(false);
    });
  });
  describe('write mode', () => {
    it('denies writes not declared by a published definition', () =>
      expect(evaluate('write', { service: 'graph', method: 'PATCH', path: '/users/1' }).allowed).toBe(false));
    it('allows declared writes', () =>
      expect(evaluate('write', { service: 'graph', method: 'PATCH', path: '/users/1', declaredWrite: true }).allowed).toBe(true));
  });
});
```

**Step 2: Run** → FAIL. **Step 3: Implement** `src/policy.ts`

```ts
export type ServiceId = 'graph' | 'arm' | 'logAnalytics' | 'exchange' | 'teams' | 'sharepointAdmin' | 'function' | 'runner';
export type Mode = 'read' | 'write';

export interface OutboundRequest {
  service: ServiceId;
  method: string;
  path: string;
  body?: unknown;
  /** Set by the executor only for steps a *published* definition marks `mode: write`. */
  declaredWrite?: boolean;
  /** Exchange/Teams cmdlet name for admin-API calls. */
  cmdlet?: string;
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

const ALLOW: PolicyDecision = { allowed: true };
const deny = (reason: string): PolicyDecision => ({ allowed: false, reason });
const SAFE = new Set(['GET', 'HEAD']);
const READ_POSTS: Partial<Record<ServiceId, RegExp[]>> = {
  graph: [/^\/\$batch$/, /^\/security\/runHuntingQuery$/],
  arm: [/^\/providers\/Microsoft\.ResourceGraph\/resources$/i],
  logAnalytics: [/^\/v1\/workspaces\/[0-9a-f-]{36}\/query$/i],
};

const isReadPost = (r: OutboundRequest) =>
  r.method.toUpperCase() === 'POST' && (READ_POSTS[r.service] ?? []).some((re) => re.test(r.path));

function evaluateBatch(body: unknown): PolicyDecision {
  const requests = (body as { requests?: Array<{ method?: string; url?: string }> } | undefined)?.requests;
  if (!Array.isArray(requests)) return deny('Malformed $batch request.');
  const bad = requests.find((r) => !SAFE.has((r.method ?? 'GET').toUpperCase()));
  return bad ? deny(`$batch includes ${bad.method} ${bad.url}, which needs write access. Arm write access to continue.`) : ALLOW;
}

export function evaluate(mode: Mode, req: OutboundRequest): PolicyDecision {
  const method = req.method.toUpperCase();
  if (mode === 'write') {
    if (SAFE.has(method) || isReadPost(req) || req.declaredWrite) return ALLOW;
    return deny('Write requests must come from a published playbook or action.');
  }
  if (req.service === 'exchange' || req.service === 'teams') {
    return req.cmdlet && /^Get-[A-Za-z]+$/.test(req.cmdlet)
      ? ALLOW
      : deny(`Only Get-* cmdlets run in read-only mode (requested ${req.cmdlet ?? 'none'}). Arm write access to continue.`);
  }
  if (req.service === 'runner') return req.declaredWrite ? deny('This script changes data. Arm write access to continue.') : ALLOW;
  if (SAFE.has(method)) return ALLOW;
  if (isReadPost(req)) return req.service === 'graph' && req.path === '/$batch' ? evaluateBatch(req.body) : ALLOW;
  return deny(`${method} ${req.path} changes data. Arm write access to continue.`);
}
```

**Step 4: Run** → PASS. **Step 5: Commit** — `feat(connectors): default-deny request policy`

### Task 1.13: Microsoft Graph client (paging, retries, batching, typed errors)

**Files:**
- Create: `packages/connectors/src/graph.ts`
- Test: `packages/connectors/test/graph.test.ts`

**Step 1: Failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildUrl, createGraphClient, GraphError } from '../src/graph';

type Fake = { status: number; body?: unknown; headers?: Record<string, string> };
function fakeFetch(responses: Fake[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 500 };
    const text = typeof r.body === 'string' || typeof r.body === 'number';
    return new Response(r.body === undefined ? null : text ? String(r.body) : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': text ? 'text/plain' : 'application/json', ...r.headers },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}
const client = (responses: Fake[], extra = {}) => {
  const f = fakeFetch(responses);
  const sleep = vi.fn(async () => {});
  return { f, sleep, g: createGraphClient({ getToken: async () => 'tok', fetch: f.fetch, sleep, correlationId: 'corr-1', ...extra }) };
};

describe('buildUrl', () => {
  it('keeps $ keys and encodes values with %20', () => {
    expect(buildUrl('https://graph.microsoft.com', { path: '/users', query: { $filter: "userType eq 'Guest'", $top: 5, skip: undefined } }))
      .toBe("https://graph.microsoft.com/v1.0/users?$filter=userType%20eq%20'Guest'&$top=5");
  });
  it('rejects traversal', () => expect(() => buildUrl('https://g', { path: '/users/../me' })).toThrow(/Invalid Graph path/));
});

describe('graph client', () => {
  it('sends auth and correlation headers and returns data with requestId', async () => {
    const { g, f } = client([{ status: 200, body: { id: '1' }, headers: { 'request-id': 'ms-1' } }]);
    const r = await g.request<{ id: string }>({ path: '/me' });
    expect(r).toMatchObject({ data: { id: '1' }, status: 200, requestId: 'ms-1' });
    const h = f.calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['client-request-id']).toBe('corr-1');
  });
  it('honours Retry-After on 429', async () => {
    const { g, sleep } = client([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200, body: { ok: true } }]);
    await expect(g.request({ path: '/users' })).resolves.toMatchObject({ data: { ok: true } });
    expect(sleep).toHaveBeenCalledWith(2000);
  });
  it('throws GraphError with code, message, and requestId', async () => {
    const { g } = client([{ status: 403, body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } }, headers: { 'request-id': 'ms-9' } }]);
    await expect(g.request({ path: '/users' })).rejects.toMatchObject({ status: 403, code: 'Authorization_RequestDenied', requestId: 'ms-9' });
  });
  it('surfaces CAE claims challenges', async () => {
    const { g } = client([{ status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'x' } }, headers: { 'www-authenticate': 'Bearer error="insufficient_claims", claims="eyJhY2Nlc3NfdG9rZW4iOnt9fQ=="' } }]);
    const err = await g.request({ path: '/me' }).catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.claims).toBe('eyJhY2Nlc3NfdG9rZW4iOnt9fQ==');
  });
  it('parses $count text responses as numbers', async () => {
    const { g } = client([{ status: 200, body: 12408 }]);
    expect((await g.request<number>({ path: '/users/$count' })).data).toBe(12408);
  });
  it('follows nextLink and refuses links outside Graph', async () => {
    const { g } = client([
      { status: 200, body: { value: [1, 2], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=a' } },
      { status: 200, body: { value: [3], '@odata.nextLink': 'https://evil.example/steal' } },
    ]);
    const seen: number[] = [];
    await expect((async () => { for await (const page of g.pages<number>({ path: '/users' })) seen.push(...page); })()).rejects.toThrow(/outside Graph/);
    expect(seen).toEqual([1, 2, 3]);
  });
  it('chunks $batch by 20 and maps responses by id', async () => {
    const items = Array.from({ length: 45 }, (_, i) => ({ id: String(i), path: `/users/${i}` }));
    const reply = (ids: string[]) => ({ status: 200, body: { responses: ids.map((id) => ({ id, status: 200, body: { id } })) } });
    const { g, f } = client([reply(items.slice(0, 20).map((i) => i.id)), reply(items.slice(20, 40).map((i) => i.id)), reply(items.slice(40).map((i) => i.id))]);
    const out = await g.batch(items);
    expect(f.calls).toHaveLength(3);
    expect(out['44']).toEqual({ status: 200, body: { id: '44' } });
  });
});
```

**Step 2: Run** → FAIL. **Step 3: Implement** `src/graph.ts`

```ts
export interface GraphRequest {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  beta?: boolean;
}
export interface GraphResult<T> { data: T; status: number; requestId?: string; ms: number }

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly claims?: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

export interface GraphClientOptions {
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
  baseUrl?: string;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  correlationId?: string;
}

const RETRYABLE = new Set([429, 503, 504]);

export function buildUrl(base: string, req: GraphRequest): string {
  if (!req.path.startsWith('/') || req.path.split('/').includes('..')) throw new Error(`Invalid Graph path: ${req.path}`);
  const qs = Object.entries(req.query ?? {})
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${base}/${req.beta ? 'beta' : 'v1.0'}${req.path}${qs ? `?${qs}` : ''}`;
}

export function retryDelay(retryAfter: string | null, attempt: number): number {
  const secs = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 120_000);
  return Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 250);
}

function parseBody(text: string, contentType: string): unknown {
  if (!text) return undefined;
  if (contentType.includes('json')) return JSON.parse(text);
  return /^\d+$/.test(text.trim()) ? Number(text) : text;
}

export function createGraphClient(opts: GraphClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? 'https://graph.microsoft.com';
  const maxRetries = opts.maxRetries ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function send<T>(req: GraphRequest, url = buildUrl(base, req)): Promise<GraphResult<T>> {
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      const res = await doFetch(url, {
        method: req.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${await opts.getToken()}`,
          Accept: 'application/json',
          ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.correlationId ? { 'client-request-id': opts.correlationId } : {}),
          ...req.headers,
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      });
      const requestId = res.headers.get('request-id') ?? undefined;
      if (RETRYABLE.has(res.status) && attempt < maxRetries) {
        await sleep(retryDelay(res.headers.get('retry-after'), attempt));
        continue;
      }
      const data = parseBody(await res.text(), res.headers.get('content-type') ?? '');
      const ms = Math.round(performance.now() - started);
      if (!res.ok) {
        const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error ?? {};
        const claims = /claims="([^"]+)"/.exec(res.headers.get('www-authenticate') ?? '')?.[1];
        throw new GraphError(res.status, err.code ?? `HTTP${res.status}`, err.message ?? res.statusText, requestId, claims);
      }
      return { data: data as T, status: res.status, requestId, ms };
    }
  }

  async function* pages<T>(req: GraphRequest, maxPages = 50): AsyncGenerator<T[]> {
    let next: string | undefined = buildUrl(base, req);
    for (let i = 0; next && i < maxPages; i++) {
      const { data }: GraphResult<{ value: T[]; '@odata.nextLink'?: string }> = await send(req, next);
      yield data.value;
      next = data['@odata.nextLink'];
      if (next && !next.startsWith(`${base}/`)) throw new Error('nextLink points outside Graph; refusing to follow it.');
    }
  }

  async function batch(items: Array<{ id: string } & GraphRequest>): Promise<Record<string, { status: number; body: unknown }>> {
    const out: Record<string, { status: number; body: unknown }> = {};
    for (let i = 0; i < items.length; i += 20) {
      const requests = items.slice(i, i + 20).map((r) => ({
        id: r.id,
        method: r.method ?? 'GET',
        url: buildUrl('', r).replace(/^\/(v1\.0|beta)/, ''),
        ...(r.body !== undefined ? { body: r.body, headers: { 'Content-Type': 'application/json', ...r.headers } } : r.headers ? { headers: r.headers } : {}),
      }));
      const { data } = await send<{ responses: Array<{ id: string; status: number; body: unknown }> }>({ method: 'POST', path: '/$batch', body: { requests } });
      for (const r of data.responses) out[r.id] = { status: r.status, body: r.body };
    }
    return out;
  }

  return { request: send, pages, batch };
}
export type GraphClient = ReturnType<typeof createGraphClient>;
```

**Step 4: Run** → PASS. **Step 5: Commit** — `feat(connectors): Graph client with paging, retries, batching, CAE claims`

### Task 1.14: Audit log with hash chain

**Files:**
- Create: `apps/api/src/audit/chain.ts`, `apps/api/src/audit/writer.ts`
- Test: `apps/api/test/audit-chain.test.ts`

**Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { canonical, chainHash, GENESIS, verifyChain } from '../src/audit/chain';

const ev = (action: string) => ({ ts: '2026-10-15T12:00:00.000Z', actorOid: 'u1', action, result: 'success', correlationId: 'c', details: { b: 2, a: 1 } });

describe('audit chain', () => {
  it('canonicalises with sorted keys and no undefined', () => {
    expect(canonical({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe('{"a":{"c":[2,1]},"b":1}');
  });
  it('verifies an intact chain and finds the first tampered row', () => {
    const rows: Array<ReturnType<typeof ev> & { prevHash: string; hash: string }> = [];
    let prev = GENESIS;
    for (const a of ['session.signin', 'session.armed', 'run.started']) {
      const hash = chainHash(prev, ev(a));
      rows.push({ ...ev(a), prevHash: prev, hash });
      prev = hash;
    }
    expect(verifyChain(rows)).toEqual({ ok: true });
    rows[1]!.details = { a: 1, b: 3 };
    expect(verifyChain(rows)).toEqual({ ok: false, brokenAt: 1 });
  });
});
```

**Step 2: Run** → FAIL. **Step 3: Implement** `src/audit/chain.ts`

```ts
import { createHash } from 'node:crypto';

export const GENESIS = '0'.repeat(64);

export function canonical(v: unknown): string {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

export function chainHash(prevHash: string, event: Record<string, unknown>): string {
  return createHash('sha256').update(prevHash).update('\n').update(canonical(event)).digest('hex');
}

export function verifyChain(rows: Array<Record<string, unknown> & { prevHash: string; hash: string }>, genesis = GENESIS) {
  let prev = genesis;
  for (const [i, { prevHash, hash, ...event }] of rows.entries()) {
    if (prevHash !== prev || chainHash(prev, event) !== hash) return { ok: false as const, brokenAt: i };
    prev = hash;
  }
  return { ok: true as const };
}
```

**Step 4:** `writer.ts` — `append(event)` runs in a transaction: `SELECT pg_advisory_xact_lock(hashtext('audit'))`, read the last `hash` (or `GENESIS`), compute `chainHash`, insert. The hashed `event` is exactly the persisted columns minus `seq`, `prevHash`, `hash` (with `ts` set by the app, not the DB default, so the hash is reproducible). Also emits an App Insights custom event when telemetry is configured.

**Step 5: Run** → PASS. **Step 6: Commit** — `feat(api): hash-chained audit log`

### Task 1.15: Sessions, mock sign-in, `/api/me`, and CSRF

**Files:**
- Create: `apps/api/src/auth/session-store.ts` (interface + `PgSessionStore` + `MemorySessionStore`), `apps/api/src/auth/session-plugin.ts`, `apps/api/src/auth/mock-routes.ts`, `apps/api/src/routes/me.ts`
- Test: `apps/api/test/session.test.ts`

**Step 1: Failing tests** (Fastify `inject`, `MemorySessionStore`):
1. `GET /api/me` without a cookie → `401 {error:{code:'unauthenticated', login:'/auth/login?returnTo=%2F'}}`.
2. Mock `GET /auth/login` → `302` to `/`, sets the cookie (`adminforge-dev` in development, `__Host-adminforge` in production; HttpOnly, SameSite=Lax, `Secure` in production).
3. With that cookie `GET /api/me` → `200 {user:{name:'Mock Engineer',…}, roles:[…], mode:'read', armedUntil:null, csrf:'<token>'}`.
4. `PUT /api/me/prefs` without `X-AdminForge-CSRF` → `403 {error:{code:'csrf'}}`; with the header → `200`.
5. `POST /auth/mock/arm {minutes:30}` (mock mode only) → `/api/me` shows `mode:'armed'` and `armedUntil` ≈ now + 30 min.
6. Idle expiry: advance a fake clock past `SESSION_IDLE_MINUTES` → `401`.

**Step 2: Implement** — the session plugin decorates `request.session` (looked up by `sha256(cookie)`), slides `lastSeenAt`, enforces idle + absolute expiry, and registers a `preHandler` on `/api` that requires a session and, for non-GET methods, `X-AdminForge-CSRF === session.csrf`. Mock routes are registered **only** when `AUTH_MODE=mock` (the config already forbids that in production). Mock roles come from `MOCK_ROLES` (default `Portal.Reader,Portal.Operator`).

**Step 3: Run** → PASS. **Step 4: Commit** — `feat(api): sessions, mock sign-in, /api/me, CSRF`

### Task 1.16 🔑: Entra dev registration (Read app) as code

**Files:**
- Create: `infra/entra/bicepconfig.json`, `infra/entra/main.bicep`, `infra/entra/README.md`

**Step 1:** `bicepconfig.json` — pin the Microsoft Graph Bicep extension (look up the current GA tag in the Microsoft Graph Bicep "what's new" docs and pin it exactly):

```json
{ "extensions": { "microsoftGraphV1": "br:mcr.microsoft.com/bicep/extensions/microsoftgraph/v1.0:<pinned-version>" } }
```

**Step 2:** `main.bicep`

```bicep
extension microsoftGraphV1

@description('Environment label used in names, e.g. dev')
param envLabel string = 'dev'
@description('Base URL that Entra redirects back to')
param redirectBase string = 'http://localhost:5173'
@description('Object id of the admin running the deployment; added to the Admins group')
param adminObjectId string

var graphAppId = '00000003-0000-0000-c000-000000000000'
var armAppId = '797f4846-ba00-4fd7-ba43-dac1f8f63013'

var readGraphScopes = [
  'openid', 'profile', 'offline_access', 'User.Read'
  'User.Read.All', 'Group.Read.All', 'Directory.Read.All', 'AuditLog.Read.All', 'Reports.Read.All'
  'Policy.Read.All', 'RoleManagement.Read.Directory', 'RoleEligibilitySchedule.Read.Directory'
  'RoleAssignmentSchedule.Read.Directory', 'UserAuthenticationMethod.Read.All', 'Application.Read.All'
  'DeviceManagementManagedDevices.Read.All', 'DeviceManagementConfiguration.Read.All'
  'ServiceHealth.Read.All', 'ServiceMessage.Read.All', 'Organization.Read.All'
]

var portalRoles = [
  { value: 'Portal.Reader', name: 'Portal reader', desc: 'View pages, dashboards, and reports; dry-run playbooks.' }
  { value: 'Portal.Operator', name: 'Portal operator', desc: 'Arm write access and run write playbooks.' }
  { value: 'Playbook.Author', name: 'Playbook author', desc: 'Draft and test content.' }
  { value: 'Playbook.Approver', name: 'Playbook approver', desc: 'Approve runs and publishing of write-capable content.' }
  { value: 'Portal.Admin', name: 'Portal admin', desc: 'Appearance, connections, audit export, scope drift.' }
]

resource graphSp 'Microsoft.Graph/servicePrincipals@v1.0' existing = { appId: graphAppId }
resource armSp 'Microsoft.Graph/servicePrincipals@v1.0' existing = { appId: armAppId }

resource readApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: 'adminforge-portal-read-${envLabel}'
  displayName: 'AdminForge (Read) [${envLabel}]'
  signInAudience: 'AzureADMyOrg'
  web: {
    redirectUris: [ '${redirectBase}/auth/callback' ]
    implicitGrantSettings: { enableAccessTokenIssuance: false, enableIdTokenIssuance: false }
  }
  appRoles: [for r in portalRoles: {
    id: guid('adminforge', envLabel, r.value)
    value: r.value
    displayName: r.name
    description: r.desc
    allowedMemberTypes: [ 'User' ]
    isEnabled: true
  }]
  optionalClaims: { idToken: [ { name: 'acrs' }, { name: 'login_hint' } ] }
  requiredResourceAccess: [
    {
      resourceAppId: graphAppId
      resourceAccess: [for s in readGraphScopes: { id: filter(graphSp.oauth2PermissionScopes, x => x.value == s)[0].id, type: 'Scope' }]
    }
    {
      resourceAppId: armAppId
      resourceAccess: [ { id: filter(armSp.oauth2PermissionScopes, x => x.value == 'user_impersonation')[0].id, type: 'Scope' } ]
    }
  ]
}

resource readSp 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: readApp.appId
  appRoleAssignmentRequired: true
}

resource graphGrant 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = {
  clientId: readSp.id
  resourceId: graphSp.id
  consentType: 'AllPrincipals'
  scope: join(readGraphScopes, ' ')
}

resource armGrant 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = {
  clientId: readSp.id
  resourceId: armSp.id
  consentType: 'AllPrincipals'
  scope: 'user_impersonation'
}

resource groups 'Microsoft.Graph/groups@v1.0' = [for r in portalRoles: {
  uniqueName: 'sg-adminforge-${envLabel}-${toLower(replace(r.value, '.', '-'))}'
  displayName: 'SG-AdminForge-${envLabel}-${r.value}'
  mailEnabled: false
  mailNickname: 'sg-adminforge-${envLabel}-${toLower(replace(r.value, '.', '-'))}'
  securityEnabled: true
  members: { relationships: r.value == 'Portal.Admin' || r.value == 'Portal.Operator' || r.value == 'Portal.Reader' ? [ adminObjectId ] : [] }
}]

resource roleAssignments 'Microsoft.Graph/appRoleAssignedTo@v1.0' = [for (r, i) in portalRoles: {
  appRoleId: guid('adminforge', envLabel, r.value)
  principalId: groups[i].id
  resourceId: readSp.id
}]

output readAppId string = readApp.appId
output tenantId string = tenant().tenantId
```
(If the extension version rejects a property, e.g. relationship syntax for `members`, fix to the documented shape and note it in `infra/entra/README.md`.)

**Step 3: Deploy** (user's admin session; activate in PIM first: Application Administrator + Privileged Role Administrator + Groups Administrator, or Global Administrator for this bootstrap only)

```bash
az group create -n rg-adminforge-dev -l <region>
ADMIN_OID=$(az ad signed-in-user show --query id -o tsv)
az deployment group create -g rg-adminforge-dev -f infra/entra/main.bicep -p envLabel=dev adminObjectId="$ADMIN_OID" --query properties.outputs
```
Expected: `readAppId` and `tenantId` outputs.

**Step 4: Dev secret straight into `.env.local`** (never printed, never committed)

```bash
APP_ID=<readAppId>
SECRET=$(az ad app credential reset --id "$APP_ID" --display-name local-dev --years 0.5 --query password -o tsv)
{ echo "AUTH_MODE=entra"; echo "DATA_MODE=live"; echo "ENTRA_TENANT_ID=<tenantId>"; echo "ENTRA_READ_CLIENT_ID=$APP_ID"; echo "ENTRA_READ_CLIENT_SECRET=$SECRET"; echo "TOKEN_CACHE_KEY=$(openssl rand -base64 32)"; } >> apps/api/.env.local
unset SECRET
```

**Step 5: Verify** — `az ad sp show --id <readAppId> --query "{assignmentRequired:appRoleAssignmentRequired}"` → `true`; Entra admin center shows admin consent granted.

**Step 6: Commit** — `feat(infra): Entra dev Read app, portal roles, and groups as code`

### Task 1.17 🔑: Real Entra sign-in and the token broker

**Files:**
- Create: `apps/api/src/auth/types.ts`, `apps/api/src/auth/msal-client.ts`, `apps/api/src/auth/routes.ts`, `apps/api/src/auth/token-broker.ts`, `apps/api/src/auth/return-to.ts`
- Test: `apps/api/test/auth-routes.test.ts` (fake `AuthClient`), `apps/api/test/return-to.test.ts`

**Step 1: Failing tests**
- `safeReturnTo('/identity/users?x=1')` → same; `safeReturnTo('//evil.com')`, `'https://evil.com'`, `'javascript:…'` → `/`.
- Callback with unknown/expired `state` → `400 invalid_state` ("Sign-in expired or was started in another tab. Start again.").
- Callback where ID token `nonce` ≠ stored nonce, or `tid` ≠ configured tenant → `400`, no session created.
- Successful callback → session row with `roles` from the ID token, cookie set, audit `session.signin`, redirect to `returnTo`.
- `getToken(session, 'graph', 'read')` when the client throws `ReauthRequired` → route returns `401 {error:{code:'reauth', reauth:{url:'/auth/login?…'}}}`.

**Step 2: Implement**

`src/auth/types.ts`
```ts
export type AppKind = 'read' | 'write';

export interface IdClaims {
  oid: string;
  tid: string;
  nonce?: string;
  name?: string;
  preferred_username?: string;
  roles?: string[];
  acrs?: string[];
}

export interface AuthClient {
  authUrl(i: { kind: AppKind; state: string; challenge: string; nonce: string; loginHint?: string; claims?: string }): Promise<string>;
  redeem(i: { kind: AppKind; code: string; verifier: string; partitionKey: string }): Promise<{ homeAccountId: string; claims: IdClaims }>;
  token(i: { kind: AppKind; partitionKey: string; homeAccountId: string; scopes: string[]; forceRefresh?: boolean; claims?: string }): Promise<string>;
  forget(i: { kind: AppKind; partitionKey: string }): Promise<void>;
}

export class ReauthRequired extends Error {
  constructor(readonly kind: AppKind, readonly claims?: string) {
    super(`Sign-in required for ${kind} access`);
  }
}
```

`src/auth/msal-client.ts`
```ts
import {
  ConfidentialClientApplication, DistributedCachePlugin, InteractionRequiredAuthError, ResponseMode,
  type ICacheClient, type IPartitionManager,
} from '@azure/msal-node';
import { ManagedIdentityCredential } from '@azure/identity';
import type { Config } from '../config';
import { ReauthRequired, type AppKind, type AuthClient, type IdClaims } from './types';

class FixedPartition implements IPartitionManager {
  constructor(private readonly key: string) {}
  async getKey() { return this.key; }
  async extractKey() { return this.key; }
}

const SIGN_IN_SCOPES = ['openid', 'profile', 'offline_access', 'https://graph.microsoft.com/.default'];

export function createMsalAuthClient(cfg: Config, cache: ICacheClient): AuthClient {
  const mi = cfg.ENTRA_CREDENTIAL === 'managedIdentity' ? new ManagedIdentityCredential({ clientId: cfg.MANAGED_IDENTITY_CLIENT_ID! }) : undefined;
  const clientId = (k: AppKind) => (k === 'read' ? cfg.ENTRA_READ_CLIENT_ID! : cfg.ENTRA_WRITE_CLIENT_ID!);
  const redirectUri = (k: AppKind) => `${cfg.PUBLIC_BASE_URL}${k === 'read' ? '/auth/callback' : '/auth/arm/callback'}`;
  const credential = (k: AppKind) =>
    mi
      ? { clientAssertion: async () => (await mi.getToken('api://AzureADTokenExchange/.default')).token }
      : { clientSecret: k === 'read' ? cfg.ENTRA_READ_CLIENT_SECRET! : cfg.ENTRA_WRITE_CLIENT_SECRET! };

  // One client per request: the distributed cache plugin loads exactly one partition.
  const app = (k: AppKind, partitionKey: string) =>
    new ConfidentialClientApplication({
      auth: { clientId: clientId(k), authority: `https://login.microsoftonline.com/${cfg.ENTRA_TENANT_ID}`, clientCapabilities: ['CP1'], ...credential(k) },
      cache: { cachePlugin: new DistributedCachePlugin(cache, new FixedPartition(partitionKey)) },
    });

  return {
    authUrl: ({ kind, state, challenge, nonce, loginHint, claims }) =>
      app(kind, 'preauth').getAuthCodeUrl({
        scopes: SIGN_IN_SCOPES, redirectUri: redirectUri(kind), responseMode: ResponseMode.QUERY,
        codeChallenge: challenge, codeChallengeMethod: 'S256', state, nonce, loginHint, claims,
      }),
    redeem: async ({ kind, code, verifier, partitionKey }) => {
      const r = await app(kind, partitionKey).acquireTokenByCode({ code, codeVerifier: verifier, redirectUri: redirectUri(kind), scopes: SIGN_IN_SCOPES });
      if (!r.account) throw new Error('Sign-in returned no account');
      return { homeAccountId: r.account.homeAccountId, claims: r.idTokenClaims as IdClaims };
    },
    token: async ({ kind, partitionKey, homeAccountId, scopes, forceRefresh, claims }) => {
      const cca = app(kind, partitionKey);
      const account = await cca.getTokenCache().getAccountByHomeId(homeAccountId);
      if (!account) throw new ReauthRequired(kind);
      try {
        return (await cca.acquireTokenSilent({ account, scopes, forceRefresh, claims })).accessToken;
      } catch (e) {
        if (e instanceof InteractionRequiredAuthError) throw new ReauthRequired(kind, claims);
        throw e;
      }
    },
    forget: async ({ kind, partitionKey }) => {
      const tc = app(kind, partitionKey).getTokenCache();
      for (const a of await tc.getAllAccounts()) await tc.removeAccount(a);
    },
  };
}
```
(Check option names against the installed `@azure/msal-node` major — e.g. `clientAssertion` callback support and `ResponseMode` export; the fake-client tests pin the behaviour, this adapter just maps it.)

`src/auth/token-broker.ts`
```ts
import type { ServiceId } from '@adminforge/connectors';
import type { Config } from '../config';
import type { AuthClient } from './types';

export const resourceScopes = (cfg: Config): Record<Exclude<ServiceId, 'function' | 'runner'>, string[]> => ({
  graph: ['https://graph.microsoft.com/.default'],
  arm: ['https://management.azure.com/.default'],
  logAnalytics: ['https://api.loganalytics.io/.default'],
  exchange: ['https://outlook.office365.com/.default'],
  teams: ['48ac35b8-9aa8-4d74-927d-1f4a14a0b239/.default'], // Skype and Teams Tenant Admin API — verify id in your tenant
  sharepointAdmin: [`https://${cfg.SPO_TENANT_NAME}-admin.sharepoint.com/.default`],
});
```
`TokenBroker.get(session, service, mode)` → picks the `read`/`write` account and partition (`write` throws `NotArmed` if `writeExpiresAt` is past), calls `auth.token`, and never logs the token.

`src/auth/routes.ts` — `/auth/login`, `/auth/callback`, `/auth/logout` as described in §4.3, using `CryptoProvider().generatePkceCodes()` from `@azure/msal-node`, 32-byte random `state`/`nonce`, `preauth` rows with a 10-minute TTL deleted on first use, `safeReturnTo`, nonce/tenant checks, audit events.

**Step 3: Run tests** → PASS.

**Step 4: Live check 🔑** — `pnpm dev` (api + web), the user opens `http://localhost:5173` (directly or via `ssh -L 5173:localhost:5173 <host>`), signs in, and `/api/me` shows their name and portal roles. Then `curl` is not used with their cookie; instead I check the `sessions` and `audit_events` rows and API logs.

**Step 5: Commit** — `feat(api): Entra sign-in (read app), encrypted cache, token broker`

### Task 1.18: Tenant overview page (first real page, coded)

**Files:**
- Create: `apps/api/src/routes/overview.ts` (temporary coded endpoint; becomes YAML in Phase 3)
- Create: `apps/web/src/routes/index.tsx` (replace placeholder), `content/fixtures/graph/organization.json`, `subscribedSkus.json`, `healthOverviews.json`
- Test: `apps/api/test/overview.test.ts`

**Behaviour:**
- `GET /api/overview` → one Graph `$batch`: `/organization`, `/subscribedSkus`, `/admin/serviceAnnouncement/healthOverviews?$select=service,status`, plus `/users/$count` (eventual consistency). Returns `{org, skus[], health[], counts, provenance}`.
- Page (template `dashboard`): eyebrow "Tenant", title = org display name, IdChip for tenant id; KPI strip — Users, Licensed seats used (top SKU), Services with issues (status ≠ `serviceOperational`, `warn`/`crit` + icon); Panel "Licenses" (DataTable: SKU, used / available, utilization bar, StatusPill when > 90%); Panel "Verified domains" (list with default/initial badges); `ProvenanceFooter` on each panel.
- Mock mode serves fixtures; live mode calls Graph with the user's token.

**Tests:** fixture-backed route returns the shape above; a `403` from Graph on health maps to a partial result with `health: {error:{code, message, hint:'Needs ServiceHealth.Read.All'}}` rather than failing the whole page.

**Live check 🔑:** user sees their tenant; any 403s are listed in `docs/decisions.md` as scope gaps.

**Commit:** `feat: tenant overview page`

### Task 1.19: Playwright visual baseline (mock mode)

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/shell.spec.ts`

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:5173', channel: 'chrome', viewport: { width: 1440, height: 900 } },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  webServer: [
    { command: 'pnpm --filter @adminforge/api dev', port: 3001, reuseExistingServer: true, env: { AUTH_MODE: 'mock', DATA_MODE: 'fixtures' } },
    { command: 'pnpm --filter @adminforge/web dev', port: 5173, reuseExistingServer: true },
  ],
});
```

```ts
// e2e/shell.spec.ts
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const theme of ['graphite', 'paper', 'contrast']) {
  for (const density of ['comfortable', 'compact']) {
    test(`overview · ${theme} · ${density}`, async ({ page }) => {
      await page.addInitScript(([t, d]) => localStorage.setItem('adminforge.prefs', JSON.stringify({ theme: t, density: d })), [theme, density]);
      await page.goto('/auth/login');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page).toHaveScreenshot(`overview-${theme}-${density}.png`, { fullPage: true });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });
  }
}

test('armed shell', async ({ page }) => {
  await page.goto('/auth/login');
  await page.request.post('/auth/mock/arm', { data: { minutes: 30 } });
  await page.reload();
  await expect(page.getByText(/Armed · \d+:\d{2}/)).toBeVisible();
  await expect(page).toHaveScreenshot('shell-armed.png');
});
```

Install: `pnpm --filter @adminforge/web add -D @playwright/test @axe-core/playwright` (no browser download — uses installed Chrome).
Run: `pnpm --filter @adminforge/web e2e --update-snapshots` once, **look at every screenshot** (Read tool), fix anything off, then run without `--update-snapshots` → PASS.
Commit: `test(web): visual + a11y baseline in mock mode`

### Task 1.20: CI

**Files:** Create `.github/workflows/ci.yml`

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  build-test:
    runs-on: ubuntu-24.04
    services:
      postgres:
        image: postgres:17-alpine
        env: { POSTGRES_USER: adminforge, POSTGRES_PASSWORD: adminforge-ci, POSTGRES_DB: adminforge }
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U adminforge" --health-interval 5s --health-retries 10
    env:
      DATABASE_URL: postgres://adminforge:adminforge-ci@localhost:5432/adminforge
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm --filter @adminforge/api db:migrate
      - run: pnpm test
      - run: pnpm build
      - run: pnpm --filter @adminforge/web e2e
      - if: failure()
        uses: actions/upload-artifact@v4
        with: { name: playwright-report, path: apps/web/playwright-report }
```
Commit: `ci: lint, typecheck, test, build, e2e`

### Gate G1 checklist
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green locally and in CI
- [ ] Visual baselines reviewed: 3 themes × 2 densities + armed shell
- [ ] 🔑 You signed in with SSO; overview shows live tenant data; any scope gaps recorded
- [ ] Audit rows for your sign-in verify (`verifyChain`)
- [ ] You approve the look and feel (or list changes — they go into `tokens.ts`, not into pages)

---

## 17. Phases 2–8 — task breakdowns

Each phase starts by expanding these into a bite-sized plan file with the same TDD structure as §16.

### Phase 2 — Dev environment and delivery
| # | Task | Files | Acceptance |
|---|---|---|---|
| 2.1 | Azure infra modules | `infra/azure/main.bicep`, `modules/{monitoring,keyvault,postgres,acr,containerenv,containerapp,identity,roles}.bicep`, `params/dev.bicepparam` | `what-if` clean; deploy creates everything in §11 (dev column); Postgres Entra-only auth with `id-adminforge-api` as a DB principal |
| 2.2 | Image builds | `apps/api/Dockerfile` (multi-stage, `node:24-slim`, non-root, `pnpm deploy --prod`), `.dockerignore` | Image < 250 MB; runs as non-root; `/readyz` checks DB + Key Vault |
| 2.3 | Secretless runtime | `apps/api/src/db/client.ts` (Entra token as PG password, refreshed), `src/security/keys.ts` (cache key from Key Vault) | No secrets in Container App config; MSAL uses MI-based federated credential |
| 2.4 | Entra apps for the Azure dev URL | `infra/entra/main.bicep` (+ FIC to `id-adminforge-api`, ACA redirect URI) | Dev portal signs in with no client secret in Azure |
| 2.5 | GitHub OIDC + pipelines | `.github/workflows/deploy-infra.yml`, `deploy-app.yml`; UAMI `id-adminforge-github` with federated credential for `repo:<org>/<repo>:environment:dev` | Merge to `main` deploys a new revision; infra changes show `what-if` on the PR |
| 2.6 | Observability baseline | OpenTelemetry bootstrap in api; App Insights connection via MI | Requests and Graph dependency calls visible in App Insights |
| **G2** | You sign in at the dev URL and see the overview | | |

### Phase 3 — Content framework
| # | Task | Files | Acceptance |
|---|---|---|---|
| 3.1 | Schemas | `packages/schemas/src/{envelope,params,datasource,page,report,playbook,runbook,connection}.ts`, `scripts/emit-json-schema.ts` (`z.toJSONSchema`) | Valid/invalid fixtures per kind; JSON Schemas generated; VS Code autocomplete works via `.vscode/settings.json` `yaml.schemas` |
| 3.2 | Expressions | `packages/expressions/src/{template,evaluate,helpers}.ts` | Brace- and string-aware `${…}` splitting; typed whole-value expressions; `$odata("O'Brien")` → `'O''Brien'`; `$encode`; 250 ms timebox; compile errors report file + path |
| 3.3 | Definition store | `apps/api/src/definitions/{fs-store,db-store,cache,notify}.ts`, `definitions` table | Dev reads `content/` with file watching; publish writes versions; `NOTIFY` invalidates all replicas; same version + different sha256 rejected |
| 3.4 | Datasource executor | `apps/api/src/datasources/executor.ts`, route | Params validated; request rendered from published definition only; policy enforced; per-user cache keyed by `oid+mode+ds+params`; provenance returned; partial failures per datasource |
| 3.5 | More connectors | `packages/connectors/src/{arm,resource-graph,log-analytics,function}.ts` | Same test style as Graph: paging/skip tokens, retries, typed errors, `api-version` required for ARM |
| 3.6 | Widget registry + widgets | `packages/widgets/src/<type>/{schema.ts,Widget.tsx,index.ts}` | kpi, table, chart, list, keyValue, statusGrid, markdown, actionBar, iframeLink, logQuery; each with component + a11y tests; charts follow dataviz rules (legend, table view, fixed color order) |
| 3.7 | Page renderer | `apps/web/src/renderer/*`, route `/p/$key` | Templates from §6.6; params ↔ URL; filter bar generated from `params`; inspector deep links; saved views |
| 3.8 | Navigation & command palette | `apps/web/src/app/{NavRail,CommandPalette}.tsx`, `/api/nav`, `/api/search` | Nav built from content + roles; palette finds pages, recents, users, groups, devices, Azure resources |
| 3.9 | CLI | `tools/cli/src/{index,new,validate,test,publish,fixtures}.ts`, `tools/cli/templates/*` | `adminforge new page identity/foo --template list-detail` produces a valid, rendering page; `validate` catches schema, reference, scope, and lint errors with file:line |
| 3.10 | Hot reload | SSE `/api/events`, client invalidation | Edit YAML → open browser updates in < 5 s, no deploy |
| 3.11 | Port pages to YAML | `content/dashboards/overview.dashboard.yaml`, `content/pages/identity/{users,user,groups,group}.page.yaml`, `content/pages/devices/devices.page.yaml` | Coded overview endpoint removed; pages match baselines |
| **G3** | New dashboard built from YAML alone in < 15 min | | |

### Phase 4 — Write mode and engine
| # | Task | Files | Acceptance |
|---|---|---|---|
| 4.1 | Write app + CA | `infra/entra/main.bicep` (Write app, Operators assignment), `infra/ca/{auth-context.json,adminforge-read.json,adminforge-write.json,apply.ps1}` | Write app assignment-required; auth context `c1` exists; CA policies in **report-only** |
| 4.2 | Arm / extend / disarm | `apps/api/src/auth/arm-routes.ts`, web `ArmControl` wiring | ID token `oid` must match session; `acrs` must contain `c1` when configured; expiry, extend-once, disarm all audited; tests with fake AuthClient |
| 4.3 | Engine | `packages/engine/src/{engine,state,handlers,plan,compensate,foreach}.ts` | State machine (§7.8) fully unit-tested: dry-run plan, retries, compensation order, `forEach` concurrency, branch, assert, approval/manual/wait parking, resume after crash, `idempotent:false` → `needs_review` |
| 4.4 | Runs persistence & workers | `runs`, `run_steps`, `run_step_events`, `approvals` tables; `apps/api/src/runs/{worker,service,sse}.ts` (pg-boss) | Runs survive api restarts; SSE streams step events; cancel works |
| 4.5 | Playbook & run UI | `apps/web/src/renderer/playbook/*`, `run/*`, `RunDock` | Input form generated from schema with entity pickers; preflight (roles, scopes, armed, PIM eligibility); dry-run plan diff view; typed confirmation for `risk ≥ high` |
| 4.6 | Approvals & notify | approval inbox page; `notify` step (Teams chat / mail via Graph) | Approver can't approve own run; post-approval steps run as approver; expiry handled |
| 4.7 | Audit UI | `content/pages/admin/audit.page.yaml`, `adminforge audit verify` | Filter by actor/action/target/time; export; chain verification visible |
| 4.8 | First write playbooks | `content/playbooks/identity/{disable-user,enable-user,revoke-sessions,add-group-member,remove-group-member,issue-tap,pim-activate}.playbook.yaml` | Each has tests; 🔑 live: dry-run then real run on a **test user**, compensation verified |
| **G4** | Disable + re-enable a test user end-to-end; audit verified; CA policies switched on | | |

### Phase 5 — Domain wave 1 (catalog in Appendix A)
| # | Task | Acceptance |
|---|---|---|
| 5.1 | Identity: users, user detail, groups, roles & PIM (active/eligible, activation), auth methods & MFA registration, sign-in logs, audit logs, enterprise apps & app registrations, credential expiry, risky users, CA policies (read-only view) | Live smoke green; each page has fixtures and baselines |
| 5.2 | Devices: Intune devices, compliance, configuration profiles, apps; playbooks sync/restart/retire (wipe = `critical`, approval required) | Wipe blocked without approval in tests |
| 5.3 | M365: service health, message center, licensing & assignment, usage reports (with the "concealed names" setting detected and explained) | |
| 5.4 | Azure: subscriptions, Resource Graph inventory (by type/location/tag), resource detail, Function Apps (functions, host status, invocations/metrics, logs via Log Analytics/App Insights), start/stop/restart/sync-triggers playbooks, **your Function connections** | Function calls use per-connection audience and read/write allowlist |
| 5.5 | Security: Defender incidents/alerts, Secure Score + improvement actions, risky user confirm/dismiss | |
| 5.6 | Capabilities panel + "Activate in PIM" affordances; `pnpm test:live` suite | Pages explain missing role/scope instead of failing |
| **G5** | Catalog walkthrough; live smoke green | |

### Phase 6 — PowerShell runner and wave 2
| # | Task | Files | Acceptance |
|---|---|---|---|
| 6.1 | Runner supervisor | `apps/runner/src/{server,pool,worker-bridge,events}.ts` | Validates BFF MI token + `Runner.Execute` role; verifies script sha256; pre-forks N single-use pwsh workers; job JSON via stdin only; NDJSON events → Postgres + NOTIFY; job timeout + kill |
| 6.2 | `AdminForge.Runner` module | `apps/runner/ps/AdminForge.Runner/*.psm1`, `worker.ps1`, Pester tests | `Connect-AdminForgeServices` (Graph, EXO with `-CommandName Get-*` in read mode, Teams, PnP, Az) using forwarded tokens; `Write-AdminForgeLog/Output/Progress` |
| 6.3 | Image | `apps/runner/Dockerfile` (pwsh + Node, modules saved at build with pinned versions, non-root) | Cold start of a pre-forked worker < 2 s to job start |
| 6.4 | Wiring | Runner Entra app + role assignment (IaC); internal ingress; `runner` step type + datasource | Read-mode script attempting `Set-Mailbox` fails with "not loaded" (command restriction) |
| 6.5 | Exchange, Teams, SharePoint content | mailboxes, forwarding/inbox-rule audit, mailbox permissions, convert to shared, Teams inventory/policies, SharePoint sites/sharing settings | 🔑 live on test mailbox/team/site |
| **G6** | Forwarding audit + convert-to-shared on a test mailbox | | |

### Phase 7 — Reports, appearance, authoring
| # | Task | Acceptance |
|---|---|---|
| 7.1 | Report exports | CSV streaming of all pages; XLSX via `exceljs`; export audited; large exports paged server-side with progress |
| 7.2 | Appearance admin | Allowlisted tokens editable with live preview; contrast validated with `@adminforge/design-tokens` `contrastRatio`; publish/rollback; `/api/appearance.css` with ETag; audited |
| 7.3 | In-portal editor | Monaco + YAML schema; drafts in `local.` namespace; diff vs published; run tests in-browser (server-side); two-person publish for write-capable content |
| 7.4 | Saved views & personal dashboards | Share views; pin any widget (`pageKey#widgetId`) to "My dashboard"; drag to arrange |
| **G7** | Admin changes accent/radius live; author publishes via in-portal review | |

### Phase 8 — Hardening and production
| # | Task | Acceptance |
|---|---|---|
| 8.1 | Network per D2 | Private ingress or Front Door Premium + WAF; Postgres/Key Vault/ACR on private endpoints |
| 8.2 | CSP enforcement | Nonce-based, no `unsafe-inline` styles (or documented exception); report-only soak first |
| 8.3 | Supply chain | Dependabot, `pnpm audit` gate, Trivy image scan, secret scanning, SBOM |
| 8.4 | Security review | OWASP ASVS L2 checklist; threat model re-run; external pen test if required |
| 8.5 | Resilience | k6 load test incl. Graph throttling simulation; backup/restore drill; DR runbook; key rotation runbook |
| 8.6 | Production | Prod infra + prod Entra apps; CA policies on; go-live checklist; operating runbooks in `docs/runbooks/` (emergency disable = disable both enterprise apps) |
| **G8** | Go-live sign-off | |

---

## 18. What I need from you

**Before Phase 0 completes (G0):**
1. **Tenant ID** and primary domain; **dev subscription ID**; **region** (D3); naming prefix (D4).
2. **An admin account for setup** that you sign in with interactively on this machine (`! az login --tenant …`). Please don't paste passwords or secrets into chat. Roles to activate (PIM) for bootstrap:
   - Application Administrator (app registrations, service principals)
   - Privileged Role Administrator (tenant-wide admin consent and app-role grants — Cloud Application Administrator may be enough for delegated consent in your tenant; discovery will tell us)
   - Groups Administrator (portal role groups)
   - Conditional Access Administrator (auth context + report-only policies, Phase 4)
   - On the dev subscription: Owner, or Contributor + User Access Administrator
3. **Licensing facts** (discovery collects them): Entra ID P1 (CA, auth context, sign-in activity), P2 (PIM, Identity Protection), Intune, Defender.
4. **Groups** for portal roles (D7): use new `SG-AdminForge-*` groups (default) or name existing ones.
5. **Test identities**: at least one test user (licensed for Exchange/Teams), one test group, one test device if available, and a test resource group — the only targets for write validation.
6. **Git hosting** (D1): GitHub org/repo name, or Azure DevOps.
7. **Live-validation method** (D8): A (you use the deployed dev portal), B (device code for the dev app), or C (port-forward to this host).
8. **Your Azure Functions** to integrate: names, Function App URLs, and whether they're already protected by Entra (App Service authentication) — we'll add a `connection` for each.

**Before Phase 4 (G4):** approval of the Write-app permission list and the CA policies in report-only.

---

## 19. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Admin consent role requirements differ in your tenant | Setup blocked | Discovery identifies roles; Bicep is idempotent so it can be re-run by whoever holds the role |
| Exchange/Teams token-based PowerShell behaviour changes between module versions | Runner steps break | Pin module versions in the image; runner smoke tests per release; prefer Graph where an equivalent exists |
| Graph beta endpoints change | Page breaks | v1.0 by default; `beta: true` flagged in UI and in `validate` output |
| Delegated-only rules out unattended automation | Some requested jobs impossible | Explicit out-of-scope decision (ADR-010); revisit with a separate, approved app-only design if needed |
| Throttling at scale (large tenants) | Slow pages, 429s | `$batch`, `$select`, per-user cache, concurrency limits, delta queries for big lists in Phase 5 |
| CA policy mistakes | Admin lockout | Report-only first; break-glass excluded; portal never edits its own CA policies |
| Content authors write unsafe expressions or over-broad playbooks | Wrong changes | Two-person publish, validator lint rules, dry-run plans, content tests, risk levels with confirmation/approval |
| Token cache key compromise | Session tokens exposed | Key in Key Vault (MI-only access), rotation runbook, AAD-bound envelopes, short idle timeouts |
| Local disk is 89% full | Docker/node_modules fail | Check `df -h /` before pulls; prune images; keep Playwright on system Chrome |
| Font packages unavailable under expected names | Visual drift | Self-host woff2 fallback (Task 1.5) |

---

## 20. Appendix A — Starter catalog

**Dashboards:** Tenant overview · Identity health (MFA registration %, risky users, stale accounts, guest growth) · Azure inventory (resources by type/region/tag, cost-relevant SKUs) · Function Apps health (failures, latency, top errors) · Security posture (Secure Score trend, open incidents by severity) · Portal health (§12).

**Pages:** Users · User (entity) · Groups · Group (entity) · Directory roles & PIM · Authentication methods · Sign-in logs · Directory audit logs · Enterprise apps · App registrations · Conditional Access (read) · Devices · Device (entity) · Compliance · Licenses · Service health · Message center · Subscriptions · Resources (Resource Graph) · Resource (entity) · Function Apps · Function App (entity: functions, invocations, logs) · Mailboxes · Teams · SharePoint sites · Incidents · Runs · Audit.

**Reports:** App credential expiry (30/60/90 days) · Users without MFA registered · Inactive users (> 90 days) · Inactive guests · Privileged role assignments (active + eligible) · License utilization & unassigned seats · Stale devices · Non-compliant devices · Mailbox external forwarding · Teams without owners · Public/anyone-link SharePoint sites · Untagged Azure resources · Function Apps without Entra auth.

**Playbooks:** Disable/enable sign-in · Revoke sessions · Issue Temporary Access Pass · Reset MFA methods · Add/remove group members (bulk) · Assign/remove licenses · PIM self-activate · Offboard user (disable, revoke, remove groups/licenses, convert mailbox to shared, set auto-reply, hide from GAL, grant manager OneDrive access — approval required) · Onboard user · Rotate app secret (approval) · Restart / stop / start Function App · Sync Function triggers · Intune sync / restart / retire / wipe (wipe = critical, approval) · Confirm risky user compromised / dismiss.

**Runbooks:** Compromised account response (embeds disable, revoke, TAP, investigation queries) · Break-glass account validation · Quarterly privileged access review · New subscription onboarding · Function App incident triage · Leaver process with HR sign-off.

## Appendix B — Permission matrix (initial)

| Feature | Read app (delegated) | Write app (delegated) | Entra / RBAC role the engineer needs |
|---|---|---|---|
| Users, groups (view) | `User.Read.All`, `Group.Read.All` | — | Directory readers or higher |
| Sign-in activity, sign-in & audit logs | `AuditLog.Read.All` | — | Reports Reader / Security Reader |
| Disable/enable, revoke sessions | — | `User.EnableDisableAccount.All`, `User.RevokeSessions.All` | User Administrator (Privileged Auth Admin for admins) |
| Group membership changes | — | `GroupMember.ReadWrite.All` | Groups Administrator / group owner |
| Auth methods view / TAP / reset | `UserAuthenticationMethod.Read.All` | `UserAuthenticationMethod.ReadWrite.All` | Authentication Administrator (Privileged Auth Admin for admins) |
| PIM view / activate | `RoleEligibilitySchedule.Read.Directory`, `RoleAssignmentSchedule.Read.Directory` | `RoleAssignmentSchedule.ReadWrite.Directory` | Eligible assignment |
| Apps & credential expiry | `Application.Read.All` | `Application.ReadWrite.All` (only if secret rotation is approved) | Application Administrator |
| Conditional Access (view) | `Policy.Read.All` | — | Security Reader / CA Administrator |
| Intune devices | `DeviceManagementManagedDevices.Read.All`, `DeviceManagementConfiguration.Read.All`, `DeviceManagementApps.Read.All` | `DeviceManagementManagedDevices.PrivilegedOperations.All`, `DeviceManagementManagedDevices.ReadWrite.All` | Intune Administrator / scoped Intune roles |
| Service health, message center | `ServiceHealth.Read.All`, `ServiceMessage.Read.All` | — | Service Support Admin / Message Center Reader |
| Usage reports | `Reports.Read.All` | — | Reports Reader |
| Security incidents, alerts, Secure Score | `SecurityIncident.Read.All`, `SecurityAlert.Read.All`, `SecurityEvents.Read.All` | `SecurityIncident.ReadWrite.All` (if triage actions approved) | Security Reader / Security Operator |
| Risky users | `IdentityRiskyUser.Read.All` | `IdentityRiskyUser.ReadWrite.All` | Security Operator |
| SharePoint / Teams (Graph) | `Sites.Read.All`, `Team.ReadBasic.All` | `Sites.FullControl.All` / `TeamSettings.ReadWrite.All` (per approved playbook) | SharePoint / Teams Administrator |
| Azure resources, Resource Graph, Function Apps | ARM `user_impersonation` (policy-limited to reads) | ARM `user_impersonation` | Reader / Contributor / Website Contributor on scope |
| Logs & metrics | Log Analytics `Data.Read` | — | Log Analytics Reader |
| Exchange Online | `Exchange.Manage` (policy: `Get-*`) | `Exchange.Manage` | Exchange Administrator / scoped Exchange role |
| Teams admin (PowerShell) | Teams Tenant Admin API `user_impersonation` (`Get-*`) | same | Teams Administrator |
| Notify step | — | `Mail.Send`, `Chat.ReadWrite` (or `ChannelMessage.Send`) | — (sends as the engineer) |
| Your Function APIs | `<api>/user_impersonation` (read operations) | same (write operations) | Whatever each Function enforces |

Every scope added later must be declared by the content that needs it and appear in the drift report — nothing is added "just in case".
