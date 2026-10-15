# Security model

AdminForge holds powerful delegated and application access to a Microsoft Entra tenant, so its design assumes that a
mistake in content, a stolen cookie, or a compromised neighbour process should not turn into tenant-wide write access.
This page is the reference for how that works. Decisions behind it are in `docs/adr/` and `docs/decisions.md`;
operating procedures (rotation, backups) are in `docs/operations.md`.

**Reporting a vulnerability:** open a private security advisory on the GitHub repository (Security → Advisories), or
contact the repository owner directly. Don't file a public issue.

## Identities

| Identity                     | Kind                                    | Who uses it                     | Can change data?                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AdminForge Read `[<label>]`  | Delegated (signed-in user)              | Everyone with a portal role     | Not through AdminForge: the request policy allows reads only. Workload scopes that can write at the token level (ARM `user_impersonation`; on licensed tenants Exchange `Exchange.Manage`, SharePoint `AllSites.FullControl`, Teams) are flagged by provisioning                                                                                                       |
| AdminForge Write `[<label>]` | Delegated                               | Operators, only while **armed** | Yes, as the user, within their Entra roles; assigned to the Operator group only. Tier-0 scopes (role management and PIM, app credentials, app-role and consent grants, `Directory.AccessAsUser.All`, tenant policies) only with `AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true`                                                                                                |
| AdminForge Automation        | Application                             | Scheduler and scheduled runs    | Read-only by default: write permissions need `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`; reads of mail, files, sites, chats, calendars, contacts, notes, BitLocker keys, meeting transcripts or authentication methods need `AF_AUTOMATION_ALLOW_SENSITIVE_READS=true`. Assignment required; a certificate replaces its secret when `AF_AUTOMATION_CERT_PATH` is set |
| Provisioner                  | Application (created by you, not by us) | `adminforge provision …` only   | Yes (creates apps, groups, consent). Lives in `<env>.admin.env`, never read by the services and never backed up. Give it Global Administrator only while provisioning; prefer a short-lived secret per run (`docs/operations.md`)                                                                                                                                      |

Delegated calls can never do more than the signed-in person could do in the Entra admin centre; AdminForge adds
restrictions, never privileges.

**Drift and unexpected privilege:** `adminforge provision status` fails when something provisioning did not grant
appears: other principals assigned to the apps, extra application permissions, per-user or foreign consent grants,
owners on the apps or their service principals, extra secrets or certificates, public-client/SPA redirect URIs,
identifier URIs or exposed scopes, or Azure roles beyond Reader (plus Log Analytics Reader on the test workspace).
Output is names and counts only.

**Validation user** (live tests): exists only where `AF_ENV_LABEL` is in `AF_TEST_IDENTITY_LABELS` (default
`dev,test`). It holds Global Reader, User Administrator and Reader/Operator/Admin, owns `AF-Test-Group-01`, is never
Approver or Groups Administrator, and is **disabled** except while `pnpm test:live` runs.

## Signing in

- Authorization code flow with PKCE (S256), a single-use `state` that expires after 10 minutes, and a `nonce` checked
  against the ID token. The tenant (`tid`) and user (`oid`) are checked, and guest accounts (`acct` claim = 1) are
  refused at sign-in and arming. Members of the tenant can sign in, including a personal Microsoft account that is a
  member (such as the account that created the tenant).
- Each round trip is bound to the browser that started it: an HttpOnly binding cookie's hash is stored with the
  pending sign-in, and the callback must present it. A callback URL captured from someone else's sign-in can't be
  completed in your browser (login CSRF / session swap).
- `returnTo` is restricted to same-origin paths after normalisation (no `//host`, no dot-segment tricks).
- Portal roles come from the **app-role** claim (assigned through `SG-AdminForge-<label>-<Role>` groups), not group
  claims. They are **re-read every 5 minutes** with a forced token refresh: changes apply within minutes, a session
  with no AdminForge role left ends, and so does one Entra refuses to refresh (`invalid_grant`: disabled account,
  password reset, revoked sessions), one whose account became a guest, and one whose roles couldn't be confirmed for
  15 minutes.
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
- **Step-up:** every arm forces a fresh interactive sign-in (`prompt=login`, `max_age=0`) **proven** by the ID token's
  `auth_time` (at most 5 minutes old; a token without it is refused). With `WRITE_AUTH_CONTEXT` set (Entra ID P1) the
  Conditional Access authentication context must also be satisfied (`acrs` claim). The verifying account must be the
  signed-in user.
- Time-boxed: `WRITE_SESSION_MAX_MINUTES` (default 60), one extension. Expiry, disarm, sign-out and losing the
  Operator role drop the Write tokens.
- Writes happen only through published content that declares them (`mode: write` steps with `describe`, `risk`,
  `confirm` / `approval`). There is no generic write proxy. Reads go through a default-deny request policy.
- Risky playbooks must be previewed first; the server checks that the confirmation matches the preview (same user,
  version, inputs, under 15 minutes old), and a preview confirms at most one run. Drafts can be previewed, never run.
- Interactive calls — runs, page data, exports — use only the **current** published version; older or retired
  versions answer 409 (`version_superseded`, `definition_retired`), so a later access rule or fix can't be sidestepped.
- Run approvals need a second person with `Playbook.Approver`; self-approval is refused, and an approver must be armed
  when the steps after the approval write as them — and hold the playbook's portal roles. Child playbooks need their
  own roles from whoever runs them. Only the person a manual step waits for can supply its values (others may only
  decline); the values are audited with `redact` fields masked.
- AdminForge can't be used to grant itself access: its playbooks refuse to change the `SG-AdminForge-*` role groups
  (members, owners, dynamic rules) and AdminForge's own app registrations, plus any app listed in
  `AF_PROTECTED_APP_IDS` such as the provisioner (owners, credentials, consent, disabling). Change those in the
  Microsoft Entra admin center.

## Unattended work (schedules)

- Runs as the automation identity, audited as "scheduled by X, executed as the automation identity".
- Write-capable schedules need a second person's approval to be enabled. The approval covers the schedule definition
  **and a fingerprint of the playbook and every child playbook it can start**. Publishing a new version of any of them
  voids the approval: the next run is refused (`approval_outdated`), audited, and the schedule is switched off until
  it is approved again. A `job.approvedBy` list in content is a review note, not proof.
- The approval fingerprint also covers the connections that function steps call, write capability is computed over
  the whole child tree, and **any** change to an approved schedule voids its approval.
- Report files, probe result rows and the outputs of scheduled runs were collected with application permissions, so
  by default only `Portal.Operator` can see them (a schedule's `requires.portalRoles` overrides this), plus the
  playbook's own roles for run outputs.

## Data handling

- **Secrets:** show-once outputs (temporary access passes, passwords, app secrets) are never stored; inputs and
  manual-step fields declared `redact: true` are masked in stored steps, run outputs and errors, run events and the
  audit log. After a pause, pure steps are recomputed from the real inputs, and a masked value is never sent anywhere
  (`redacted_value`). Credentials, cookies, auth codes and database query parameters are kept out of logs.
- **Injection:** OData/KQL values go through `$odata()` / `$kql()`; advanced filters are compiled server-side from
  structured data; request paths may not contain `?`, `#` or control characters (the policy also judges the path
  exactly as it will be sent), and validation flags user data in a `path` or `url` without `$encode()`; exports
  neutralise spreadsheet formulas. Values inserted into Markdown are escaped and links are limited to http(s), mailto,
  same-origin paths and anchors. Expressions have size and time caps, and `$eval` is unavailable.
- **Delivery:** email recipients and Teams webhooks are only ever `${ env.X }` configuration — recipients must be keys
  named `AF_…RECIPIENTS`, `AF_…EMAIL` or `AF_…ALERTS`, and delivery reads only those keys, the sender and the webhook
  keys; webhooks must be https on Microsoft hosts and never follow redirects; `*WEBHOOK*` keys are hidden from content
  expressions. Email goes through Graph as the automation identity, which should be allowed to send only as `AF_MAIL_SENDER` (Exchange RBAC for Applications); Entra `Mail.Send` would let it send as any mailbox and needs the write-permission opt-in.
- **Outbound:** connection audiences are an allow-list — `api://…`, an application id, or an https host listed in
  `AF_CONNECTION_AUDIENCE_HOSTS` — and Microsoft first-party audiences are always refused; scopes are plain names on
  that audience, so a token can't be steered to another resource. Connections refuse redirects. Generic `http` steps
  are disabled. KQL queries ask the service for a bounded number of rows and run one statement at a time; every
  response body is size-capped (`OUTBOUND_MAX_BYTES`). HTTP probes don't follow redirects, can't reach private,
  loopback or link-local addresses other than the portal itself, and POST only with `allowPost: true`.

## PowerShell runner

Loopback only. `RUNNER_SHARED_KEY` is never used directly: HKDF-SHA256 derives separate keys for request signing, the
runner's answers and token encryption. Every request is HMAC-signed over timestamp, method, path and body hash
(±60 s); job ids are refused for 10 minutes after use, and requests signed before the runner started are refused. A
job's delegated tokens travel sealed (AES-256-GCM, bound to the job id and timestamp), so a process answering on
`RUNNER_URL` instead of the runner receives only ciphertext; the API sends a nonce with every job, the runner signs
every event of its answer over it, and the API uses nothing it can't verify. Redirects are refused. Scripts are pinned
by SHA-256 and run in single-use `pwsh` workers with an allow-listed environment; tokens reach the worker on stdin. The
service reads only `<env>.runner.env` (the shared key).

Read-mode jobs use Read-app tokens, some of which can write (Exchange `Exchange.Manage`, SharePoint
`AllSites.FullControl`), so the runner keeps them to reads in two layers. Before the script runs, a static policy over
the parsed script allows `Get-*` commands, the AdminForge helpers, a fixed set of PowerShell utilities and the
script's own functions, and refuses everything else: module-qualified calls, dynamic invocation, scripts and programs
by path, `Get-*` commands that return tokens or connections, .NET types outside a small allow-list, reflection and
invocation members, engine and provider variables, classes and `using`. While it runs, every non-`Get` command of every
loaded service module (Exchange Online, Teams, PnP, Microsoft Graph, Az) is replaced by a guard, REST cmdlets accept
only GET, and module auto-loading is off.

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
- The services connect to Postgres as `adminforge_app`, not the owner: row access only, no DDL outside the run queue's own `pgboss` schema, and insert/select only on the audit log (on top of its append-only triggers). Migrations use the owner via `DATABASE_MIGRATION_URL`.
- Backups (`adminforge-backup.timer`) never include `<env>.admin.env` (provisioner and validation-user credentials)
  or stray copies, and include Caddy's private keys only when encrypted to an off-host GPG key
  (`AF_BACKUP_GPG_RECIPIENT`). Unencrypted backups still hold the services' client secrets and `TOKEN_CACHE_KEY`.
- Configuration lives outside the repository in layered files, all mode 600 in a 700 directory:
  `<env>.env` (runtime), `<env>.admin.env` (provisioner and live-test credentials, CLI only), `<env>.host.env`
  (the services' own database) and `<env>.runner.env` (runner key only). The services and `pnpm dev` use separate
  databases, so a developer's API never picks up production jobs.
- `/readyz` reports the run worker and scheduler from their heartbeats (cached 5 s, rate-limited), and every Microsoft
  call is logged as one structured line (path template, status, duration, throttling, request id) for tracing by
  Reference. The Reference (correlation id) is always generated by the API, never taken from the browser.
- Mock sign-in (`AUTH_MODE=mock`) only starts with fixture data, a loopback address and no credentials configured.
- The systemd user units load a hardening drop-in with the seccomp-based restrictions that user units enforce
  (`NoNewPrivileges`, `SystemCallFilter=@system-service`, `RestrictAddressFamilies`, `RestrictNamespaces`, …).

## Threats and mitigations

| Threat                                                           | Mitigation                                                                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen session cookie                                            | `__Host-`/HttpOnly/Secure cookie; idle and absolute expiry; writes need step-up as the same user; roles re-checked                                                    |
| Phishing via the portal's own URL                                | Same-origin `returnTo` only; browser-bound sign-in round trips                                                                                                        |
| Silent SSO used to arm without re-authentication                 | `prompt=login`, `max_age=0` and `auth_time` freshness always checked server-side (plus the auth context when set)                                                     |
| Removed or disabled admin keeps acting                           | Roles re-read every 5 minutes; session ends on `invalid_grant`, guest status, or 15 minutes without confirmation                                                      |
| Changed playbook runs unattended under an old approval           | Approval fingerprint covers the playbook and its children; outdated approvals refuse and switch the schedule off                                                      |
| Content grants the automation identity tenant-wide write         | Provisioning ceiling: write application permissions need an explicit opt-in                                                                                           |
| Token sent to a third-party host                                 | Connection audiences allow-listed, scopes are names only, Microsoft audiences refused; redirects refused; `http` steps disabled                                       |
| Content or a pinned script writes with a Reader's read tokens    | Runner read mode: static allow-list before the script runs; guards on every service write command; no module auto-loading                                             |
| Another process answers on the runner's port                     | Tokens sealed per job; answers signed over a per-request nonce; redirects refused                                                                                     |
| An old or retired content version is used to bypass a later rule | Interactive calls use only the current version (409 otherwise)                                                                                                        |
| Someone else's input drives my write steps                       | Only the person a manual step waits for can supply its values; approvers need the playbook's roles                                                                    |
| Report data emailed to an outside address                        | Recipients only from `AF_…RECIPIENTS/EMAIL/ALERTS` configuration keys                                                                                                 |
| Readers seeing app-permission data                               | Report files and probe rows need Operator by default                                                                                                                  |
| Neighbour process on the host reads secrets                      | Admin credentials split out; runner gets only its key; 600/700 permissions; seccomp hardening (see gaps)                                                              |
| Developer server consumes production jobs                        | Separate databases via the `host` overlay                                                                                                                             |
| Content gives the Write app tier-0 scopes                        | Provisioning ceiling: role management, app credentials, consent grants, `Directory.AccessAsUser.All` and tenant policies need `AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true` |
| Content gives the automation identity sensitive reads            | Mail, files, sites, chats, calendars, BitLocker keys and similar need `AF_AUTOMATION_ALLOW_SENSITIVE_READS=true`                                                      |
| Someone adds an owner, secret or assignment to an AdminForge app | `provision status` fails on unexpected privilege                                                                                                                      |
| An engineer grants themselves portal roles through AdminForge    | Playbooks refuse the `SG-AdminForge-*` groups, AdminForge's own apps and `AF_PROTECTED_APP_IDS`                                                                       |
| Validation user misused                                          | Disabled between live runs, least roles, test labels only                                                                                                             |
| A compromised service rewrites the audit log                     | The services' database role can't update, delete or truncate audit events, or alter tables                                                                            |

## Known gaps and accepted risks

Tracked in `docs/backlog.md`:

- **The provisioner is powerful while its credential is on the host** (typically Global Administrator, plus a role that can assign Azure roles). Remove its directory role and Owner membership when not
  provisioning, or use a short-lived secret per run (`docs/operations.md`).
- The Read app holds write-capable workload scopes where those workloads are licensed (Exchange, SharePoint, Teams;
  ARM always). Only AdminForge's read policy and the runner's read-mode constraints stop writes through them.
- The validation user's User Administrator role can manage groups that aren't role-assignable. It stays disabled
  between live runs; scope it to an administrative unit (Entra ID P1) for a stronger boundary.
- Read-mode PowerShell still runs in FullLanguage: the static policy is the boundary, not a sandbox. A
  ConstrainedLanguage runspace needs six read scripts rewritten. Runner answers are authenticated, not encrypted
  (loopback); `/healthz` and cancel answers aren't signed.
- A child playbook's own typed confirmation isn't asked when a parent starts it; the parent must have a confirmation of
  its own. Five existing definitions need aligning before the stricter rule can be enforced.
- HTTP probes check the resolved address before connecting, but not across a DNS change in between (rebinding).

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
