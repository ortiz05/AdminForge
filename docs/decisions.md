# Decisions log

Decisions taken while building AdminForge, in addition to the ADRs in `docs/adr/`. Newest first within each group.

## Open decisions from the plan (D1–D9)

| #   | Decision                | Outcome                                                                                                                                                                                                         |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Git host                | GitHub (`ortiz05/AdminForge`), Actions CI on latest action majors                                                                                                                                               |
| D2  | Network exposure        | This host; services on `http://localhost:3300`, published to the LAN through Caddy (`tls internal`, port 8443, no root) — TLS is required for any non-localhost origin (`__Host-` cookie, Entra redirect rules) |
| D3  | Region                  | `eastus` for test resources (`AF_TEST_LOCATION`)                                                                                                                                                                |
| D4  | Naming prefix           | `adminforge` / `AF_`                                                                                                                                                                                            |
| D5  | Write step-up           | Conditional Access auth context when `WRITE_AUTH_CONTEXT` is set (needs Entra ID P1); validation tenant has no P1, so step-up is a fresh interactive sign-in (`prompt=login`, `max_age=0`) to the Write app     |
| D6  | Write session length    | 60 min default, `WRITE_SESSION_MAX_MINUTES` caps it, one extension                                                                                                                                              |
| D7  | Portal role groups      | `SG-AdminForge-<label>-<Role>` created by provisioning                                                                                                                                                          |
| D8  | Live validation         | Automated: dedicated test user signs in with password + TOTP (registered once by the live helper); writes only on `AF-Test-*` objects                                                                           |
| D9  | Content source of truth | Git (`portal/content`) → `adminforge publish` → Postgres; production reads Postgres, dev reads the files with hot reload                                                                                        |

## Plan review (2026-10-15)

The implementation was compared with the master plan section by section; the plan's "Revision 3" block lists the
outcome. Decisions taken in that review:

- **Content stays in git.** The in-portal YAML editor, drafts and in-app two-person publish (plan §7.9, task 7.3, half of
  gate G7) are superseded by D9 + R7/ADR-012: content is reviewed in pull requests (`.github/CODEOWNERS` + branch
  protection), published with the CLI, and `adminforge publish` is audited. The **schedule editor** therefore produces
  YAML for review rather than saving schedules.
- **Overview stays coded** (`/api/overview`): it batches many Graph calls into one round trip; a YAML dashboard would
  be slower. Task 3.11 superseded.
- **Widgets:** `iframeLink` is covered by `actionBar` links and column links; `logQuery` by the `logAnalytics`
  datasource with table/chart widgets and Query Studio. Table `pageSize` is moot with virtualised tables (kept in the
  schema for compatibility); `selection: single` is implemented.
- **Runbook "Assign to…" handover** is declined: runs act with the starter's live identity (ADR-010), so handing a run
  to someone else would change who acts. Start a new run instead.
- **CSP:** `script-src 'self'` only; `style-src` keeps `'unsafe-inline'` because Radix and Monaco inject style
  elements and attributes at runtime. Accepted risk: CSS injection can't execute script.
- **Retention:** finished runs and schedule history 180 days, probe results 35 days, report files 90 days (configurable;
  the audit log is never purged); applied by the API every 6 hours and audited.
- **Delivery:** email through Graph `sendMail` as the automation identity from `AF_MAIL_SENDER`; Teams through
  Workflows webhooks on Microsoft hosts only; recipients and webhooks are always `${ env.X }` configuration. Failure
  alerts fire only when no retry is left. Approval requests notify `AF_APPROVALS_EMAIL` / `AF_APPROVALS_TEAMS_WEBHOOK`.
- **Self-monitoring:** the worker and scheduler write heartbeats; `/readyz` reports `degraded` when either goes quiet,
  which the portal-readiness probe catches. `probes.audit-chain` re-walks the audit chain hourly. Every Microsoft call
  is logged as one structured line (template path, status, duration, throttling, request id). OpenTelemetry export is
  optional and not built.
- **Backups:** `adminforge-backup.timer` (daily, 14 days) with a recorded restore drill (docs/operations.md).
- **Least privilege:** baseline Write-app scopes no content uses were removed; content declares what it needs.

## Platform

- **TypeScript 7** (native compiler) for all packages; the lint toolchain lives in `tooling/lint` with TypeScript 6 because typescript-eslint needs the classic compiler API.
- **Latest majors everywhere** (React 19.3, Vite 8, Vitest 5, zod 4.6, Fastify 5, MSAL Node 7, pg-boss 12, ECharts 6, Postgres 18). `pnpm outdated -r` is clean except the deliberate TS 6 in `tooling/lint`.
- **Fonts**: Fontsource variable packages (Archivo with the width axis, Atkinson Hyperlegible Next and Mono), self-hosted.
- **Runtime vs tests split**: everything runnable under `portal/`, every test and test-only dependency under `tests/`.
- **Formatting**: Prettier enforced in CI (`pnpm format:check`); the Claude Code hook formats files as they're written. Content YAML and fixtures are excluded.

## Security

- **Security review, 2026-10-15** — see `SECURITY.md` for the resulting model. Decisions taken:
  - Step-up without an auth context is proven by `auth_time` (≤ 5 min) and fails closed when the claim is missing.
  - Sign-in round trips are bound to the browser (HttpOnly binding cookie, hash on the pre-auth record).
  - Roles are re-read every 5 minutes by refreshing the Read token, rather than trusting the sign-in token for 12 h.
  - A schedule approval covers a fingerprint of the playbook and its children; content `job.approvedBy` is not proof.
  - Scheduled report files and probe rows need Operator by default (collected with application permissions).
  - Provisioning grants content-declared automation **write** permissions only with
    `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`.
  - Configuration is layered: runtime / admin-only / per-deployment overlay / runner-only files; the host services and
    `pnpm dev` use separate databases.
  - Failed browser navigations (sign-in, arming, report downloads) land on a public problem page with only a code,
    reference and Microsoft code in the URL; the copy lives in the web app.
  - Deferred (backlog): session-id rotation on arm, keyed audit anchor, re-validating definitions on load.

- **Two delegated apps** (Read, Write) plus an **automation** app for schedules (ADR-002, ADR-011).
- **Provisioning grants exactly the baseline ∪ content-declared scopes**; `adminforge validate --scopes` reports drift. Remaining drift is limited to unlicensed workloads (Exchange, Teams, SharePoint).
- **Preview-then-confirm** for risky playbooks is enforced by the API (not only the UI).
- **Show-once secrets** (TAPs, passwords, app secrets) are never persisted.
- **Advanced filters** are structured data compiled server-side to quoted OData/KQL.
- **Runner** requests are HMAC-signed over timestamp, method, path, and body hash.

## Validation tenant specifics (not tenant identifiers)

- No Microsoft 365 / Entra P1/P2 / Intune / Defender licences; see `docs/licensing-review.md`.
- Security Defaults on → TOTP registration for the validation user.
- A capped Log Analytics workspace (0.1 GB/day) and activity-log export were provisioned for KQL validation (`adminforge provision azure-test --destroy` removes them).
