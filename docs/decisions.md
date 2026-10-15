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

## Platform

- **TypeScript 7** (native compiler) for all packages; the lint toolchain lives in `tooling/lint` with TypeScript 6 because typescript-eslint needs the classic compiler API.
- **Latest majors everywhere** (React 19.3, Vite 8, Vitest 5, zod 4.6, Fastify 5, MSAL Node 7, pg-boss 12, ECharts 6, Postgres 18). `pnpm outdated -r` is clean except the deliberate TS 6 in `tooling/lint`.
- **Fonts**: Fontsource variable packages (Archivo with the width axis, Atkinson Hyperlegible Next and Mono), self-hosted.
- **Runtime vs tests split**: everything runnable under `portal/`, every test and test-only dependency under `tests/`.
- **Formatting**: Prettier enforced in CI (`pnpm format:check`); the Claude Code hook formats files as they're written. Content YAML and fixtures are excluded.

## Security

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
