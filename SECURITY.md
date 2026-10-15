# Security model

AdminForge holds powerful delegated and application access to a Microsoft Entra tenant, so its design assumes that a
mistake in content, a stolen cookie, or a compromised neighbour process should not turn into tenant-wide write access.
This page is the reference for how that works. Decisions behind it are in `docs/adr/` and `docs/decisions.md`;
operating procedures (rotation, backups) are in `docs/operations.md`.

**Reporting a vulnerability:** open a private security advisory on the GitHub repository (Security → Advisories), or
contact the repository owner directly. Don't file a public issue.

## Identities

| Identity                     | Kind                                    | Who uses it                     | Can change data?                                                                                                                                       |
| ---------------------------- | --------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AdminForge Read `[<label>]`  | Delegated (signed-in user)              | Everyone with a portal role     | No: read scopes only; assignment required                                                                                                              |
| AdminForge Write `[<label>]` | Delegated                               | Operators, only while **armed** | Yes, as the user, within their Entra roles; assigned to the Operator group only                                                                        |
| AdminForge Automation        | Application                             | Scheduler and scheduled runs    | Read-only by default: provisioning skips write application permissions unless `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`                             |
| Provisioner                  | Application (created by you, not by us) | `adminforge provision …` only   | Yes (creates apps, groups, consent). Lives in `<env>.admin.env`, never read by the services. Rotate its secret after setup and whenever it was shared. |

Delegated calls can never do more than the signed-in person could do in the Entra admin centre; AdminForge adds
restrictions, never privileges.

## Signing in

- Authorization code flow with PKCE (S256), a single-use `state` that expires after 10 minutes, and a `nonce` checked
  against the ID token. The tenant (`tid`) and user (`oid`) are checked; guest and personal accounts are refused.
- Each round trip is bound to the browser that started it: an HttpOnly binding cookie's hash is stored with the
  pending sign-in, and the callback must present it. A callback URL captured from someone else's sign-in can't be
  completed in your browser (login CSRF / session swap).
- `returnTo` is restricted to same-origin paths after normalisation (no `//host`, no dot-segment tricks).
- Portal roles come from the **app-role** claim (assigned through `SG-AdminForge-<label>-<Role>` groups), not group
  claims. They are **re-read every 5 minutes** with a forced token refresh: changes apply within minutes, a session
  with no AdminForge role left ends, and so does one Entra refuses to refresh (disabled account, password reset).
- Failures land on a public, designed problem page that shows only an error code, a reference and the AADSTS number —
  never Entra's raw text or JSON.

## Sessions and tokens

- Session cookie `__Host-adminforge` (production): HttpOnly, Secure, SameSite=Lax, path `/`. Only its SHA-256 is
  stored. Idle timeout 60 minutes, absolute 12 hours (`SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS`).
- Every state-changing request needs the per-session `X-AdminForge-CSRF` header (constant-time compare).
- Microsoft tokens never reach the browser. The MSAL cache is sealed with AES-256-GCM (`TOKEN_CACHE_KEY`), with the
  partition key as associated data, and stored in Postgres.
- Sign-out deletes the session and both token partitions and goes through Entra's end-session endpoint; the
  signed-out page never signs the person back in automatically.

## Write access ("arming")

- Only `Portal.Operator` can arm, and Entra enforces it again (only the Operator group is assigned to the Write app).
- **Step-up:** with `WRITE_AUTH_CONTEXT` set (Entra ID P1), a Conditional Access authentication context must be
  satisfied (`acrs` claim). Without it, a fresh interactive sign-in is required and **proven** by the ID token's
  `auth_time` (at most 5 minutes old); a token without `auth_time` is refused. The verifying account must be the
  signed-in user.
- Time-boxed: `WRITE_SESSION_MAX_MINUTES` (default 60), one extension. Expiry, disarm, sign-out and losing the
  Operator role drop the Write tokens.
- Writes happen only through published content that declares them (`mode: write` steps with `describe`, `risk`,
  `confirm` / `approval`). There is no generic write proxy. Reads go through a default-deny request policy.
- Risky playbooks must be previewed first; the server checks that the confirmation matches the preview (same user,
  version, inputs, under 15 minutes old). Interactive runs always use the **current** published version.
- Run approvals need a second person with `Playbook.Approver`; self-approval is refused, and an approver must be armed
  when the steps after the approval write as them.

## Unattended work (schedules)

- Runs as the automation identity, audited as "scheduled by X, executed as the automation identity".
- Write-capable schedules need a second person's approval to be enabled. The approval covers the schedule definition
  **and a fingerprint of the playbook and every child playbook it can start**. Publishing a new version of any of them
  voids the approval: the next run is refused (`approval_outdated`), audited, and the schedule is switched off until
  it is approved again. A `job.approvedBy` list in content is a review note, not proof.
- Report files and probe result rows were collected with application permissions, so by default only
  `Portal.Operator` can download them or see the rows (a schedule's `requires.portalRoles` overrides this).

## Data handling

- **Secrets:** show-once outputs (temporary access passes, passwords, app secrets) are never stored; inputs declared
  `redact: true` are masked in stored steps, run events and the audit log; credentials, cookies and auth codes are
  redacted from logs.
- **Injection:** OData/KQL values go through `$odata()` / `$kql()`; advanced filters are compiled server-side from
  structured data; request paths may not contain `?` or `#`; exports neutralise spreadsheet formulas.
- **Delivery:** email recipients and Teams webhooks are only ever `${ env.X }` configuration; webhooks must be https on
  Microsoft hosts and never follow redirects; `*WEBHOOK*` keys are hidden from content expressions. Email goes through
  Graph as the automation identity (Mail.Send needs the explicit write-permission opt-in).
- **Outbound:** connections may only request tokens for your own app registrations (never Graph, ARM, Exchange or
  other Microsoft first-party audiences) and refuse redirects. Generic `http` steps are disabled. KQL queries ask the
  service for a bounded number of rows.

## PowerShell runner

Loopback only. Every request is HMAC-signed over timestamp, method, path and body hash (±60 s, with a replay cache).
Scripts are pinned by SHA-256 and run in single-use `pwsh` workers with an allow-listed environment; tokens arrive on
stdin. The service reads only `<env>.runner.env` (the shared key), not the API's configuration.

## Audit

Every sign-in, arm/disarm, run, approval, schedule change, content publish, sensitive read, download, notification and
retention purge is appended to an append-only (database-enforced), hash-chained log. The Audit page,
`adminforge audit verify` and the hourly `probes.audit-chain` check verify the chain. History (runs, schedule runs,
probe results, report files) is purged after its retention period; the audit log is never purged.

## Host and network

- Caddy terminates TLS on `:8443` with its own CA (`tls internal`); its admin API is off. The API listens on
  `127.0.0.1` and trusts `X-Forwarded-*` only from loopback. Security headers: CSP (`script-src 'self'`,
  `frame-ancestors 'none'`), HSTS, `nosniff`, `no-referrer`, `no-store` on API and auth responses; rate limits on
  every route and tighter ones on sign-in and arming.
- Configuration lives outside the repository in layered files, all mode 600 in a 700 directory:
  `<env>.env` (runtime), `<env>.admin.env` (provisioner and live-test credentials, CLI only), `<env>.host.env`
  (the services' own database) and `<env>.runner.env` (runner key only). The services and `pnpm dev` use separate
  databases, so a developer's API never picks up production jobs.
- `/readyz` reports the run worker and scheduler from their heartbeats, and every Microsoft call is logged as one
  structured line (path template, status, duration, throttling, request id) for tracing by Reference.
- The systemd user units load a hardening drop-in with the seccomp-based restrictions that user units enforce
  (`NoNewPrivileges`, `SystemCallFilter=@system-service`, `RestrictAddressFamilies`, `RestrictNamespaces`, …).

## Threats and mitigations

| Threat                                                   | Mitigation                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Stolen session cookie                                    | `__Host-`/HttpOnly/Secure cookie; idle and absolute expiry; writes need step-up as the same user; roles re-checked |
| Phishing via the portal's own URL                        | Same-origin `returnTo` only; browser-bound sign-in round trips                                                     |
| Silent SSO used to arm without re-authentication         | `auth_time` freshness (or Conditional Access auth context) checked server-side                                     |
| Removed or disabled admin keeps acting                   | Roles re-read every 5 minutes; session ends when Entra refuses the refresh                                         |
| Changed playbook runs unattended under an old approval   | Approval fingerprint covers the playbook and its children; outdated approvals refuse and switch the schedule off   |
| Content grants the automation identity tenant-wide write | Provisioning ceiling: write application permissions need an explicit opt-in                                        |
| Token sent to a third-party host                         | Connections can't target Microsoft audiences; redirects refused; `http` steps disabled                             |
| Readers seeing app-permission data                       | Report files and probe rows need Operator by default                                                               |
| Neighbour process on the host reads secrets              | Admin credentials split out; runner gets only its key; 600/700 permissions; seccomp hardening (see gaps)           |
| Developer server consumes production jobs                | Separate databases via the `host` overlay                                                                          |

## Known gaps and accepted risks

Tracked in `docs/backlog.md`:

- The session id is not rotated when write access is turned on (a cookie stolen while read-only could ride a later
  arm by the real user). Mitigated by the cookie flags and expiry; rotation needs runs and pending secrets re-keyed.
- The audit chain is unkeyed: someone with database write access could rewrite and re-hash its tail. Anchor the head
  outside the database for stronger guarantees.
- Definitions loaded from the database are trusted as published (not re-validated on load).
- CSP allows inline **styles** (`style-src 'unsafe-inline'`) because Radix and Monaco inject them; scripts stay
  `'self'` only, so CSS injection can't execute code.
- User units can't isolate the filesystem on hosts that restrict unprivileged user namespaces (Ubuntu 24.04): run as a
  dedicated system user with system units for that.
- Browsers must trust Caddy's local CA for LAN access; use a certificate from your own CA and a DNS name for wider use.
