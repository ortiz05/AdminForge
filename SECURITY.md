# Security model

AdminForge holds powerful delegated and application access to a Microsoft Entra tenant, so its design assumes that a
mistake in content, a stolen cookie, or a compromised neighbour process should not turn into tenant-wide write access.
This page is the reference for how that works. Decisions behind it are in `docs/adr/` and `docs/decisions.md`;
operating procedures (rotation, backups) are in `docs/operations.md`.

**Reporting a vulnerability:** open a private security advisory on the GitHub repository (Security → Advisories), or
contact the repository owner directly. Don't file a public issue.

## Identities

| Identity                     | Kind                                    | Who uses it                     | Can change data?                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | --------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AdminForge Read `[<label>]`  | Delegated (signed-in user)              | Everyone with a portal role     | Not through AdminForge: the request policy allows reads only. Workload scopes that can write at the token level (ARM `user_impersonation`; on licensed tenants Exchange `Exchange.Manage`, SharePoint `AllSites.FullControl`, Teams) are flagged by provisioning                                                                                                                                                                 |
| AdminForge Write `[<label>]` | Delegated                               | Operators, only while **armed** | Yes, as the user, within their Entra roles; assigned to the Operator group only. Tier-0 scopes (role management and PIM, app credentials, app-role and consent grants, `Directory.AccessAsUser.All`, tenant policies) only with `AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true`                                                                                                                                                          |
| AdminForge Automation        | Application                             | Scheduler and scheduled runs    | Read-only by default: write permissions need `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`; reads of mail, files, sites, chats, calendars, contacts, notes, BitLocker keys, meeting transcripts or authentication methods need `AF_AUTOMATION_ALLOW_SENSITIVE_READS=true`. Assignment required; a certificate replaces its secret when `AF_AUTOMATION_CERT_PATH` is set                                                           |
| Provisioner                  | Application (created by you, not by us) | `adminforge provision …` only   | Yes (creates apps, groups, consent). Lives in `<env>.admin.env`, never read by the services and never backed up. Give it Global Administrator only while provisioning; prefer a short-lived secret per run (`docs/operations.md`). Graph application permissions granted for the test fixtures (several tier-0) survive removing its directory role: remove them between runs too — `provision status` warns while it holds them |

Delegated calls can never do more than the signed-in person could do in the Entra admin centre; AdminForge adds
restrictions, never privileges.

**Drift and unexpected privilege:** `adminforge provision status` fails when something provisioning did not grant
appears: other principals assigned to the apps, extra application permissions, per-user or foreign consent grants,
owners on the apps or their service principals, extra secrets or certificates, public-client/SPA redirect URIs,
identifier URIs or exposed scopes, or Azure roles beyond Reader (plus Log Analytics Reader on the test workspace).
Output is names and counts only.

**Validation user** (live tests): exists only where `AF_ENV_LABEL` is in `AF_TEST_IDENTITY_LABELS` (default
`dev,test`). It holds Global Reader, User Administrator and Reader/Operator/Admin, owns `AF-Test-Group-01`, is never
Approver or Groups Administrator, and is **disabled** except while `pnpm test:live` runs. Only with
`AF_TEST_SERVICE_ADMIN_ROLES=true` (admin file; default off) and only where the tenant licenses the workload does it
also hold Exchange Recipient Administrator and SharePoint Administrator — tenant-wide service admin roles, needed only
to run the Exchange and SharePoint write playbooks live; without the opt-in, re-provisioning removes them. It is
excluded from Entra's authentication-methods registration campaign so unattended sign-in isn't interrupted — a write
to that tenant-wide policy: provisioning re-reads the campaign and sends it back unchanged except for this one user in
its exclusions. The only other accounts it ever adds there are the approver fixture ("AF Tester 2") and the sign-ins
fixture's AF-Test-SignIn-01 and -02 (each taken out again before it is deleted); nobody else is excluded. Provisioning manages only an account it created: the UPN must
start with `af-` and the account must carry the `employeeType` marker "AdminForge validation" set at creation (or the
display name "AF Tester"); any other account at `AF_TEST_USER_UPN` is refused before anything changes — no password
reset, roles, groups, campaign exclusion, enabling or disabling. `provision status` fails on any other directory role
it holds (other roles, narrower scopes, roles through a group) and on any PIM-eligible role provisioning didn't grant.

**Approver fixture** (opt-in, `AF_TEST_FIXTURES=approver`, test labels only): "AF Tester 2" holds Portal.Reader and
Playbook.Approver — never Operator, Author or Admin — and no directory roles, so approval flows can be tested with two
accounts. It carries its own marker (`employeeType` "AdminForge validation approver"; the validation user's checks
never accept it, and its checks never accept the validation user's), its UPN must differ from the validation user's,
it is enabled only with an explicit `provision test-identities --enable --approver` (`--disable` always disables both),
and it is refused wherever `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`. A leftover approver fails `provision status`
until `--remove-fixtures` deletes it (after taking it out of the campaign's exclusions).

**Audit Conditional Access fixture** (opt-in, `AF_TEST_FIXTURES=ca-audit`, test labels only): example policies named
`AF-Audit: …` that are **report-only, never enforced**. A create's body can only be report-only (type and a runtime
check); an update carries no state at all, and is made only to a policy that is report-only when re-checked right
before each attempt (writes go without client retries; a throttled write is re-checked before it is sent again) and
is read back afterwards. A same-named policy that is on, off or in an unknown state is left alone (`✗`). Most target
all users (minus `AF_PROTECTED_USER_IDS` and the Directory Synchronization Accounts role; the two that block also
minus Global Administrator, which Graph requires), so real sign-ins produce report-only results; the device and
location examples target AF-Test-Group-01 only, and are refused while that group has other members or dynamic
membership. `provision status` warns while `AF_PROTECTED_USER_IDS` is empty. Anyone with Conditional Access
Administrator (or the provisioner's `Policy.ReadWrite.ConditionalAccess`) can still switch one on — from then on
provisioning leaves it alone. **If one were switched on:**

| Policy                                            | Risk if enforced                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Require phishing-resistant MFA for administrators | locks out every admin without a passkey, Windows Hello for Business or certificate-based authentication             |
| Block unknown device platforms                    | may end AdminForge sessions — first check its report-only results for the Read/Write apps' non-interactive sign-ins |
| Admin sign-in frequency and no persistent browser | admins re-authenticate every 4 hours; parked delegated runs fail when their token outlives it                       |
| Device and location examples (AF-Test-Group-01)   | block the validation user (no compliant device, not inside the documentation range)                                 |

**Enterprise fixtures** (opt-in, `AF_TEST_FIXTURES=directory,guest,apps,auth-methods,intune-more,sign-ins`, test labels
only): synthetic `AF-Test-*` users, groups, an administrative unit, a guest, app registrations, authentication
methods, Intune policies and two sign-in accounts, so reports have known answers. None holds a portal role, a
directory role or a permission: the fixture apps are **never** granted, consented or assigned anything (the risky one
only _requests_ Mail.ReadWrite), their secrets are dropped the moment Graph returns them and their certificates are
throwaway (the key is never kept); the Temporary Access Pass is dropped likewise. The directory users' passwords are
random and unstored, nobody signs in as them, and the dynamic group's rule matches a test-only department value. Only
the two sign-in accounts have stored passwords (admin file); they must hold nothing — `provision status` fails on any
group, unit or role membership, directory role (direct, scoped or through a group), PIM eligibility, licence or app
role assignment — stay disabled except during `tests/live/scripts/generate-sign-ins.ts` (which disables them on exit,
Ctrl-C included; status warns while one is enabled), and are disabled by `--disable`. Everything carries
provisioning's marker — the guest too (a guest that can't be marked is deleted again) — and same-named objects without
it are refused, never changed or removed; AF-Test-User-01..03 and AF-Test-Group-01 are used (owner, members, nesting,
policy assignment) only when they are the test identities' own, and the policies are refused while AF-Test-Group-01
has other members. Fixture apps are ownerless or owned by AF-Test-User-01 (never the risky one), and `provision
status` fails on any service principal, permission grant or assignment on them (the SAML app's own service principal
excepted, which must have no grants or assignments and requires assignment). Tenant-wide settings (guest invitations,
the authentication methods policy's method switches, group expiry) are never changed; the one tenant-wide write is
the registration campaign exclusion of the two sign-in accounts (above). A fixture the tenant refuses prints `✗` with
the reason.

## Signing in

- Authorization code flow with PKCE (S256), a single-use `state` that expires after 10 minutes, and a `nonce` checked
  against the ID token. The tenant (`tid`) and user (`oid`) are checked, and guest accounts (`acct` claim = 1) are
  refused at sign-in and arming; a token without the `acct` claim is refused too (`account_status_missing` —
  provisioning adds the claim). Members of the tenant can sign in, including a personal Microsoft account that is a
  member (such as the account that created the tenant).
- Each round trip is bound to the browser that started it: an HttpOnly binding cookie's hash is stored with the
  pending sign-in, and the callback must present it. A callback URL captured from someone else's sign-in can't be
  completed in your browser (login CSRF / session swap).
- `returnTo` is restricted to same-origin paths after normalisation (no `//host`, no dot-segment tricks).
- Portal roles come from the **app-role** claim (assigned through `SG-AdminForge-<label>-<Role>` groups), not group
  claims. They are **re-read every 5 minutes** with a forced token refresh: changes apply within minutes, a session
  with no AdminForge role left ends, and so does one Entra refuses to refresh (`invalid_grant`: disabled account,
  password reset, revoked sessions), one whose account became a guest, and one whose roles couldn't be confirmed for
  15 minutes. The run worker applies the same check before every delegated step (when the session's roles were last
  confirmed is stored with the session, so the API and the worker share one schedule): removing someone from the
  Operator group stops their unattended runs' writes within 5 minutes too.
- Failures land on a public, designed problem page that shows only an error code, a reference and the AADSTS number —
  never Entra's raw text or JSON. The audit log keeps only the OAuth error code (from a fixed list) and the AADSTS
  number of a failed sign-in or arm, never text from the callback URL.

## Sessions and tokens

- Session cookie `__Host-adminforge` (production): HttpOnly, Secure, SameSite=Lax, path `/`. Only its SHA-256 is
  stored. Idle timeout 60 minutes, absolute 12 hours (`SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS`). Only what the
  person does keeps a session alive: requests the browser makes on its own (polling, background refreshes — anything
  not within 10 seconds of a click, key press or navigation) carry `X-AdminForge-Background: 1` and don't move the
  idle timer, and event streams never do. An idle tab shows "You're signed out" and waits; it never starts a sign-in
  by itself.
- Every `/api` route needs `Portal.Reader`, except reading your own profile and preferences, the appearance
  stylesheet, the emergency-stop state and the event stream. At most 5 event streams per session.
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
  signed-in user. **Without `WRITE_AUTH_CONTEXT`, arming proves a fresh sign-in, not MFA** (v2 ID tokens carry no
  `amr`): set it in production. Each `session.armed` audit event records which one it was (`stepUp`), Admin →
  Settings shows it, and `adminforge env check` warns when it's missing.
- Time-boxed: `WRITE_SESSION_MAX_MINUTES` (default 60), one extension. Expiry, disarm, sign-out and losing the
  Operator role drop the Write tokens.
- Writes happen only through published content that declares them (`mode: write` steps with `describe`, `risk`,
  `confirm` / `approval`). There is no generic write proxy. Reads go through a default-deny request policy.
- Risky playbooks must be previewed first; the server checks that the confirmation matches the preview (same user,
  version, inputs, under 15 minutes old), and a preview confirms at most one run. Drafts can be previewed, never run.
- Interactive calls — runs, page data, exports — use only the **current** published version; older or retired
  versions answer 409 (`version_superseded`, `definition_retired`), so a later access rule or fix can't be sidestepped.
  Child playbooks start on their current version too (a pin to an older one fails `version_superseded`).
- **Resuming** a run (after arming, signing in again or an approval) re-checks what starting it checked: the person
  still holds the roles it needs, and — while nothing has been changed yet — the run is still on the current version
  (otherwise it ends `run_outdated`; start a new one). A run that already sent a change finishes on the version that
  started it, and runbooks (checklists) carry on, since every playbook they start runs its current version. A
  confirmed change whose preview is more than 15 minutes old stops before writing (`preview_stale`). Runs waiting for
  write access or a new sign-in stop after 24 hours (`run_expired`).
- Run approvals need a second person with `Playbook.Approver`; self-approval is refused, and an approver must be armed
  when the steps after the approval write as them — and hold the playbook's portal roles. **Nobody can approve a change
  that grants them access**: approval gates name the beneficiaries (`approval.excludes` — e.g. the principal getting a
  directory or Azure role, the people being added to a role-assignable group, a new app owner), and those people get
  `own_access`. Approval requests expire after 72 hours unless the playbook says otherwise. Child playbooks need their
  own roles from whoever runs them. Only the person a manual step waits for can confirm it or supply its values (others
  may only decline); the values are audited with `redact` fields masked.
- **Protected objects:** AdminForge can't be used to change its own access. The executor refuses every write — REST
  or PowerShell — that names, in its path, query or body, AdminForge's own app registrations and service principals,
  any app in `AF_PROTECTED_APP_IDS` (such as the provisioner), every principal assigned an AdminForge app role (the
  `SG-AdminForge-*` groups — the groups, not their members) or an account in `AF_PROTECTED_USER_IDS` (break-glass
  accounts): `protected_object`. The set is read from Microsoft Graph by id (automation identity, else the caller's
  Read sign-in) and cached for 10 minutes; when it can't be read, writes to groups' members and owners, apps, service
  principals, app-role assignments and authentication methods are refused (`protected_objects_unavailable`).
  PowerShell inputs are matched by object id only (names and UPNs aren't). Playbooks keep friendly early checks.
- Group and app-owner playbooks refuse adding yourself; adding to a role-assignable group (which carries directory
  roles) and making someone an app owner need a second person's approval.
- **Emergency stop** (Admin → Settings): a `Portal.Admin` or `Playbook.Approver` can pause all changes or all
  automation with a reason; only a `Portal.Admin` resumes. While changes are paused every declared write — interactive,
  scheduled or PowerShell — is refused (`writes_paused`; AdminForge's own notification mail still goes out); while
  automation is paused no schedule fires (`automation_paused`). Both are audited (`emergency.paused` /
  `emergency.resumed`) and shown in a banner.

## Unattended work (schedules)

- Runs as the schedule's `identity` (ADR-014), audited as "scheduled by X, executed as <identity>" on the run and
  every audit event (`runs.identity_name` keeps the name):
  - the **automation identity** (default);
  - a **named app identity** (`identity: { app: <name> }`, listed in `AF_SCHEDULE_IDENTITIES`): an app registration of
    its own that `provision entra` grants only the application permissions of the schedules naming it, under the
    automation identity's ceilings **and** its own opt-ins (`AF_IDENTITY_<NAME>_ALLOW_WRITE_PERMISSIONS`,
    `_ALLOW_SENSITIVE_READS`, `_ALLOW_PRIVILEGED_PERMISSIONS`, each only together with the matching global key), so
    one identity's write access never extends to another. Tier-0 application permissions (role management, app
    credentials and consent, tenant policies) need `AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS=true` for any app-only
    identity, the automation identity included. Its client id is protected like the built-in apps — and so is an
    identity taken out of `AF_SCHEDULE_IDENTITIES` (found by its "AdminForge Identity …" name; `provision status`
    fails until it is deleted); a client id listed in `AF_PROTECTED_APP_IDS` is refused as an identity. It shares
    the automation rate-limit pool, and its tokens and caches are keyed by its name. Changing a write schedule's
    identity changes its definition, so the two-person approval must be given again. **Any** Operator can pick any
    configured identity for a report schedule they create in the portal (reports only, read-only), so list only
    identities whose read access every Operator may use;
  - its **creator's own read access** (`identity: { user: creator }`, portal report schedules only, read-only jobs):
    the creator signs in once for the schedule through the **Read app** (`POST /auth/schedule-consent`, CSRF,
    `prompt=login` + `max_age=0`, and the callback requires `auth_time` within 5 minutes, as arming does). The code is
    redeemed into a temporary partition and moved to the schedule's own (`schedule:<id>`) only on success, so a failed
    sign-in never disturbs a working grant; the orphan purge keeps that partition only while the grant exists. The
    grant is written only for a schedule that still runs as its creator and isn't deleted — checked again after
    writing, so a delete or a change of "Run as" racing the sign-in can't leave one behind. Before every run the
    creator's roles are read again (`refreshClaims`; without the `acct` claim the run doesn't happen) and the creator
    check below runs; it never uses the Write app or a session and refuses any write. When Microsoft asks for a new
    sign-in (`invalid_grant`, reauth) the schedule is marked **needs sign-in**, later runs are skipped and the owner is
    notified; only the creator can sign in again. Deleting the schedule, changing its identity, someone else (a Portal
    Admin) saving it, or the creator losing access deletes the grant and its tokens — and a confirmed loss of access
    also turns the schedule off (`schedule.disabled`), whichever check notices it. Its **files are the creator's**:
    they hold what the creator can see (their directory roles, data a ceiling withholds from the automation
    identity), so only the creator downloads them, or a Portal Admin (audited `artifact.downloaded` with
    `adminOverride`); other Operators see the runs but no file. Email and Teams deliveries go to the lists the creator
    chose. Runner (PowerShell) datasources are refused for app identities and creators
    (`runner_identity_not_supported`). Secret-bearing reads (`outbound.sensitive_read`) record the identity and the
    schedule. **Trade-off:** a stolen database plus `TOKEN_CACHE_KEY` also yields these read-only refresh tokens
    (rotate the key: they then need a new sign-in).
- Write-capable schedules need a second person's approval to be enabled. The emergency stop pauses all of them at once. The approval covers the schedule definition
  **and a fingerprint of the playbook and every child playbook it can start**. Publishing a new version of any of them
  voids the approval: the next run is refused (`approval_outdated`), audited, and the schedule is switched off until
  it is approved again. A `job.approvedBy` list in content is a review note, not proof.
- The approval fingerprint also covers the connections that function steps call, write capability is computed over
  the whole child tree, and **any** change to an approved schedule voids its approval.
- Report files, probe result rows and the outputs of scheduled runs were collected with application permissions, so
  by default only `Portal.Operator` can see them (a schedule's `requires.portalRoles` overrides this), plus the
  playbook's own roles for run outputs.
- **Report schedules created in the portal** (Reports → Schedule) run without git review, so the server keeps them
  narrow:
  - only a `Portal.Operator` who also holds every role the report requires can create one (the refusal doesn't name
    the report); the job is always a published, active report, read-only (other job kinds: `job_not_allowed`);
  - before **every** run (cron, retry, Run now) the scheduler confirms, as the automation identity, that the creator
    (by object id) is still an enabled member — not a guest — holding `Portal.Operator` and every role of the schedule
    and of the report's current version. Confirmed loss: the run doesn't happen (`creator_access_removed`), the
    schedule is turned off and audited (`schedule.disabled`, reason). Can't confirm (Graph unreadable): that run
    doesn't happen (`creator_unverified`; fail closed), the schedule stays on. Answers are cached for 10 minutes;
  - only params the schedule form offers can be set (string, number, boolean or enum without a picker); entity
    pickers, dates, ids, hidden params and the query builder's filter always use the report's default
    (`invalid_params`);
  - names and summaries are one line of plain text (no control or format characters such as bidi overrides, no links
    or markup); Teams cards escape Markdown in anything not written in reviewed content, and every message from such a
    schedule says "Scheduled in AdminForge by <creator>";
  - runs are at most hourly (`cron_too_frequent`); Run now waits while a run is queued or running and for 15 minutes
    after the last manual run (`run_too_soon`);
  - email and Teams go only to recipient lists and webhooks named in the installation's configuration — never the
    approval keys (`AF_APPROVALS_*`); requests carry key names, values are never returned;
  - 25 active schedules per person, 200 in total and 50 created per person in 24 hours (deleted ones count), counted
    and inserted atomically; create, edit and delete are audited (`schedule.created`, `schedule.updated`,
    `schedule.deleted`) with `redact: true` params masked — as they are in schedule items and JSON files;
  - only the creator (by object id) or a `Portal.Admin` edits or deletes one; any Operator can turn one off. A
    schedule's params, delivery and alerts are shown only to people who may open its report;
  - the schedule stores `requires.portalRoles` = `Portal.Operator` + the report's roles, so its files stay restricted
    even after the report is retired. Content schedules may not use the `portal.` key namespace (refused by
    `adminforge validate`), so content can't collide with or replace one.

  **Accepted risk:** an Operator can collect a report's data with the automation identity's (or any configured app
  identity's) application permissions (within the report's reviewed queries; only its simple params can be set).
  Operators can already download the files of content schedules, so this adds no new kind of access. A schedule that
  uses its creator's own access is different — its files can hold more than other Operators may see — so only the
  creator (or a Portal Admin, audited) opens them. A report that must not be scheduled or downloaded by Operators sets
  `requires.portalRoles` (e.g. `Portal.Admin`).

## Data handling

- **Secrets:** show-once outputs (temporary access passes, passwords, app secrets) are never stored; inputs and
  manual-step fields declared `redact: true` are masked in stored steps, run outputs and errors, run events and the
  audit log. After a pause, pure steps are recomputed from the real inputs, and a masked value is never sent anywhere
  (`redacted_value`). Credentials, cookies, auth codes and database query parameters are kept out of logs.
- **Injection:** OData/KQL values go through `$odata()` / `$kql()`; advanced filters are compiled server-side from
  structured data; request paths may not contain `?`, `#` or control characters (the policy also judges the path
  exactly as it will be sent), and validation flags user data in a `path` or `url` without `$encode()` and user data
  placed in an OData `$filter`, `$search` or `$orderby` (query or body) without `$odata()` / `$odataSearch()` /
  `$guid()` — `$orderby` takes a literal allow-list. `adminforge publish` runs the same checks and refuses on errors.
  Exports and Query Studio's Copy neutralise spreadsheet formulas. Values inserted into Markdown are escaped and links
  are limited to http(s), mailto, same-origin paths and anchors; a key-value link without `href` uses its data value
  literally (never evaluated) and only when it's an external URL. Expressions have size and time caps, and `$eval` is
  unavailable.
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
- **News and changes feeds** (`docs/news.md`): public feeds are fetched only over https from the hosts in
  `NEWS_FEED_HOSTS` (`portal/packages/schemas/src/news.ts` — adding one is a reviewed code change, never
  configuration or content), only when the name resolves to public addresses — re-checked at connect time, and the
  socket goes only to an address that passed (no DNS rebinding) — following at most three redirects and only to those
  hosts, with a time limit, a size cap and an identifying User-Agent that never names the portal. XML that declares a
  DOCTYPE or entities is refused. Source text is reduced to plain text by a linear scanner (at most 64 KiB per field,
  so hostile markup can't stall the scheduler) and rendered as text (never HTML). Citation links are kept only when
  they are https on a Microsoft domain (`NEWS_LINK_DOMAINS`), short, free of control characters and — for public feeds
  — on the feed's own or its homepage's host; otherwise the feed's homepage is cited. "Microsoft host" doesn't mean
  "Microsoft-authored": Tech Community and the PowerShell Gallery carry others' posts and packages, so every item names
  its publisher. Only a headline, a short excerpt and a few facts are stored. Tenant feeds read Message Center and
  service health with the automation identity's ServiceMessage.Read.All / ServiceHealth.Read.All (read-only
  application permissions) and Azure Service Health with Reader; they are shown to every Portal.Reader (service
  announcements — the one deliberate exception to the Operator-only default for scheduled data). Data-privacy Message
  Center posts are shown only to Portal.Admin, a feed's `requires.portalRoles` is enforced when items are read, and
  feed error details go only to Portal.Operator.

## PowerShell runner

Loopback only. `RUNNER_SHARED_KEY` is never used directly: HKDF-SHA256 derives separate keys for request signing, the
runner's answers and token encryption. Every request is HMAC-signed over timestamp, method, path and body hash
(±60 s); job ids are refused for 10 minutes after use, and requests signed before the runner started are refused. A
job's delegated tokens travel sealed (AES-256-GCM, bound to the job id and timestamp), so a process answering on
`RUNNER_URL` instead of the runner receives only ciphertext; the API sends a nonce with every job, the runner signs
every event of its answer over it, and the API uses nothing it can't verify. Redirects are refused. Scripts are pinned
by SHA-256 and run in single-use `pwsh` workers with an allow-listed environment; tokens reach the worker on stdin.
Workers start with `-SettingsFile ps/powershell.config.json`, which keeps PowerShell's own script-block, module and
transcription logging out of the journal (it logged module source at warning level). The service reads only
`<env>.runner.env` (the shared key). Write jobs pass the API's emergency stop and protected-object guard before any
token is minted.

Read-mode jobs use Read-app tokens, some of which can write (Exchange `Exchange.Manage`, SharePoint
`AllSites.FullControl`), so the runner keeps them to reads in two layers. Before the script runs, a static policy over
the parsed script allows `Get-*` commands, the AdminForge helpers, a fixed set of PowerShell utilities and the
script's own functions, and refuses everything else: module-qualified calls, dynamic invocation, scripts and programs
by path, `Get-*` commands that return tokens or connections, .NET types outside a small allow-list, reflection and
invocation members, engine and provider variables, classes and `using`. While it runs, every non-`Get` command of every
loaded service module (Exchange Online, Teams, PnP, Microsoft Graph, Az) is replaced by a guard, REST cmdlets accept
only GET, and module auto-loading is off.

## Audit

Every sign-in, arm/disarm, run, approval, schedule change, content publish, sensitive read, download, notification,
emergency stop and retention purge is appended to an append-only (database-enforced), hash-chained log. Refused
security-relevant requests are recorded too (`request.denied`: forbidden, CSRF, policy denials, self-approval, wrong
confirmation, stale preview, protected objects, paused writes, session mismatch) with the route, code and status only —
at most one event per minute per session and code, then a `suppressed` count. Failed sign-ins (`session.signin`
failures — anyone can send a browser to `/auth/callback` with an error) are recorded at most 10 a minute per client
address (IPv6: per /64), then a `suppressed` count. `content.published` records the git
commit and whether the content was reviewed (committed and on `origin/main`); `--allow-unreviewed` is recorded with
its reasons. The Audit page,
`adminforge audit verify` and the hourly `probes.audit-chain` check verify the chain. History (runs, schedule runs,
probe results, report files) is purged after its retention period; the audit log is never purged.

## Host and network

- Caddy terminates TLS on `:8443` with its own CA (`tls internal`); its admin API is off. The API listens on
  `127.0.0.1` and trusts `X-Forwarded-*` only from loopback. Security headers: CSP (`script-src 'self'`,
  `frame-ancestors 'none'`), HSTS, `nosniff`, `no-referrer`, a `Permissions-Policy` that turns off camera,
  microphone, geolocation, payment and USB, `no-store` on API and auth responses; rate limits on every route and
  tighter ones on sign-in and arming (sign-in and anything without a valid session count per client address, never
  per cookie; `TRUST_PROXY=true`, which would let anyone forge the address, is refused in production). Production source maps are kept out of what's served
  (`portal/apps/web/sourcemaps/`), and the example Caddyfile drops the `Via` header.
- Request logs carry the signed-in user's object id, never query values on `/api` (parameter names only), cookies,
  auth codes or the CSRF header. The public `/readyz` answer never names configuration keys or commands.
- The services connect to Postgres as `adminforge_app`, not the owner: row access only, no DDL outside the run queue's
  own `pgboss` schema, insert/select only on the audit log (on top of its append-only triggers), per-role statement,
  lock and idle-in-transaction limits and a connection cap; production refuses to start (fail closed) on a role —
  `current_user` or `session_user` — that is a superuser or `BYPASSRLS`, can change audit events, belongs to the audit
  table's owner, can create in `public` or holds a `pg_*_server_*` role. Migrations run as a **non-superuser owner**
  (`adminforge_owner`) through `DATABASE_MIGRATION_URL`, kept with `POSTGRES_PASSWORD` in owner files (`*.owner.env`)
  that the services' configuration never reads — though code running as the services' Unix account can still read
  them (a dedicated account is what separates them). Passwords are set as client-side SCRAM verifiers in sessions that
  log no statements, so the server log never holds one. The container's superuser can sign in over its local socket
  only (`pg_hba.conf` rejects it over TCP); databases are closed to `PUBLIC`; foreign keys and status CHECKs hold in the
  database; approval decisions are append-only there — rebinding only to the decider's own session, deletion only with
  the run or schedule, trigger functions on a fixed `search_path` (`docs/operations.md` → Postgres hardening;
  `pnpm db:harden`).
- Backups (`adminforge-backup.timer`) are encrypted to an off-host GPG key (`AF_BACKUP_GPG_RECIPIENT`) and refuse to
  run without one unless plaintext is accepted explicitly (`AF_BACKUP_ALLOW_PLAINTEXT=1`). They never include
  `<env>.admin.env`, the database owner's credentials (owner files and owner keys in older env files) or stray copies,
  and include Caddy's private keys only when encrypted. They never contain sessions, pending sign-ins or the token
  cache (table definitions only; a restore signs everyone out). Copy them off the host. The backup unit gets the same
  hardening drop-in.
- Configuration lives outside the repository in layered files, all mode 600 in a 700 directory:
  `<env>.env` (runtime), `<env>.admin.env` (provisioner and live-test credentials, CLI only), `<env>.host.env`
  (the services' own database), `<env>.owner.env` / `<env>.host.owner.env` (database owner and superuser, migrations
  and database scripts only) and `<env>.runner.env` (runner key only). The services and `pnpm dev` use separate
  databases, so a developer's API never picks up production jobs.
- `/readyz` reports the run worker and scheduler from their heartbeats (cached 5 s, rate-limited), and every Microsoft
  call is logged as one structured line (path template, status, duration, throttling, request id) for tracing by
  Reference. The Reference (correlation id) is always generated by the API, never taken from the browser.
- Mock sign-in (`AUTH_MODE=mock`) only starts with fixture data, a loopback address and no credentials configured.
- The systemd user units load a hardening drop-in with the seccomp-based restrictions that user units enforce
  (`NoNewPrivileges`, `SystemCallFilter=@system-service`, `RestrictAddressFamilies`, `RestrictNamespaces`, …).
- **Run AdminForge under an account of its own.** File permissions (600/700) protect secrets from other users, not from
  other processes of the same user. The account that runs AdminForge must not run other network-facing services and
  must not be in the `docker`, `sudo`, `lxd` or `adm` groups: membership of `docker` is root on the host (and a
  superuser on any Postgres container), which would undo every boundary above. Run Postgres where that account can't
  administer it (a dedicated cluster, or rootless containers under the AdminForge account).

## Threats and mitigations

| Threat                                                           | Mitigation                                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen session cookie                                            | `__Host-`/HttpOnly/Secure cookie; idle and absolute expiry; writes need step-up as the same user; roles re-checked                                                                    |
| Phishing via the portal's own URL                                | Same-origin `returnTo` only; browser-bound sign-in round trips                                                                                                                        |
| Silent SSO used to arm without re-authentication                 | `prompt=login`, `max_age=0` and `auth_time` freshness always checked server-side (plus the auth context when set)                                                                     |
| Removed or disabled admin keeps acting                           | Roles re-read every 5 minutes, by the API and the run worker; session ends on `invalid_grant`, guest status, or 15 minutes without confirmation                                       |
| An approver approves their own elevation                         | Approval gates exclude the people a change grants access to (`own_access`); self-approval refused                                                                                     |
| A parked run continues on an older, weaker version               | Resume and the worker re-check roles and (before anything was changed) the current version; parked runs expire after 24 hours                                                         |
| Abuse in progress                                                | Emergency stop: pause all changes or all automation from the portal, audited                                                                                                          |
| Changed playbook runs unattended under an old approval           | Approval fingerprint covers the playbook and its children; outdated approvals refuse and switch the schedule off                                                                      |
| Content grants the automation identity tenant-wide write         | Provisioning ceiling: write application permissions need an explicit opt-in                                                                                                           |
| Token sent to a third-party host                                 | Connection audiences allow-listed, scopes are names only, Microsoft audiences refused; redirects refused; `http` steps disabled                                                       |
| Content or a pinned script writes with a Reader's read tokens    | Runner read mode: static allow-list before the script runs; guards on every service write command; no module auto-loading                                                             |
| Another process answers on the runner's port                     | Tokens sealed per job; answers signed over a per-request nonce; redirects refused                                                                                                     |
| An old or retired content version is used to bypass a later rule | Interactive calls and child playbooks use only the current version (409 otherwise)                                                                                                    |
| Someone else's input drives my write steps                       | Only the person a manual step waits for can supply its values; approvers need the playbook's roles                                                                                    |
| Report data emailed to an outside address                        | Recipients only from `AF_…RECIPIENTS/EMAIL/ALERTS` configuration keys                                                                                                                 |
| An Operator schedules a report to collect app-permission data    | Accepted risk (Operators already get content schedules' files); reports Operators mustn't schedule or download set `requires.portalRoles` (e.g. `Portal.Admin`)                       |
| A portal schedule outlives its creator's access                  | Creator's account and roles confirmed before every run; loss turns it off (`creator_access_removed`); unreadable skips the run (`creator_unverified`)                                 |
| A name typed in the portal phishes email or Teams recipients     | Single-line plain-text names without links or markup; Markdown escaped in Teams; "Scheduled in AdminForge by …"; approval channels excluded                                           |
| Readers seeing app-permission data                               | Report files and probe rows need Operator by default (service announcements on News and changes are the documented exception)                                                         |
| A news feed used to reach internal hosts or to inject markup     | Feed hosts are a code allow-list (https, public addresses pinned at connect, redirects only within it); no DTDs/entities; linear plain-text reduction; links on the source's own host |
| Neighbour process on the host reads secrets                      | Admin credentials split out; runner gets only its key; 600/700 permissions; seccomp hardening — holds only if no other service runs as the same account (see Host and network)        |
| Developer server consumes production jobs                        | Separate databases via the `host` overlay                                                                                                                                             |
| Content gives the Write app tier-0 scopes                        | Provisioning ceiling: role management, app credentials, consent grants, `Directory.AccessAsUser.All` and tenant policies need `AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true`                 |
| Content gives the automation identity sensitive reads            | Mail, files, sites, chats, calendars, BitLocker keys and similar need `AF_AUTOMATION_ALLOW_SENSITIVE_READS=true`                                                                      |
| Someone adds an owner, secret or assignment to an AdminForge app | `provision status` fails on unexpected privilege                                                                                                                                      |
| An engineer grants themselves portal roles through AdminForge    | The executor refuses writes naming AdminForge's apps, the principals holding its app roles, `AF_PROTECTED_APP_IDS` and `AF_PROTECTED_USER_IDS`, by id                                 |
| Unreviewed content is published                                  | `publish` runs `validate` and the playbook tests, and refuses uncommitted content or a commit not on `origin/main` unless `--allow-unreviewed` (audited)                              |
| Validation user misused                                          | Disabled between live runs, least roles (Exchange / SharePoint admin roles only with `AF_TEST_SERVICE_ADMIN_ROLES=true`), test labels only; `provision status` flags any other role   |
| Provisioning pointed at someone's real account                   | Only an `af-…` account with the "AdminForge validation" marker (or "AF Tester" name) is managed; any other is refused before a password, role or exclusion changes                    |
| One person approves their own request with the approver fixture  | Accepted in test labels only (see Known gaps); refused where automation writes are allowed; enabled only on request (`--enable --approver`); Portal.Reader + Approver only            |
| An `optional` datasource hides a denial                          | Never for a missing role, the request policy, a licence, sign-in or arming anywhere in the chain; suppressed errors are recorded, and a scheduled report fails `report_incomplete`    |
| A compromised service rewrites the audit log                     | The services' database role can't update, delete or truncate audit events, or alter tables                                                                                            |

## Known gaps and accepted risks

Tracked in `docs/backlog.md`:

- **The provisioner is powerful while its credential is on the host** (typically Global Administrator, plus a role that can assign Azure roles). Remove its directory role and Owner membership when not
  provisioning, or use a short-lived secret per run (`docs/operations.md`). **Graph application permissions survive
  removing the directory role**: the test fixtures' `RoleEligibilitySchedule.ReadWrite.Directory` (PIM),
  `Policy.ReadWrite.ConditionalAccess` and `DeviceManagementConfiguration.ReadWrite.All` are tier-0, and
  `LicenseAssignment.ReadWrite.All`, `DeviceManagementApps.ReadWrite.All`, `UserAuthenticationMethod.ReadWrite.All`,
  `User.Invite.All` and `Team.Create` are standing write access too. Grant them only for a
  provisioning run and remove them afterwards (`docs/operations.md` → The provisioner); `provision status` shows a ⚠
  while the provisioner's token still holds any of them.
- **Two-person approval through one credential file (accepted risk, test labels only).** The approver fixture's
  password sits in the same `<env>.admin.env` as the validation user's, so whoever holds that file can request and
  approve alone. That is acceptable for testing approval flows in a validation tenant and nowhere else: the fixture
  exists only in `AF_TEST_IDENTITY_LABELS`, is refused (plan and status ✗) where `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS`
  is true — where two-person approval guards scheduled writes — stays disabled unless `--enable --approver`, and holds
  no write role.
- The Read app holds write-capable workload scopes where those workloads are licensed (Exchange, SharePoint, Teams;
  ARM always). Only AdminForge's read policy and the runner's read-mode constraints stop writes through them.
- The validation user's User Administrator role can manage groups that aren't role-assignable. It stays disabled
  between live runs; scope it to an administrative unit (Entra ID P1) for a stronger boundary. With
  `AF_TEST_SERVICE_ADMIN_ROLES=true` it also holds Exchange Recipient Administrator (every mailbox's permissions and
  forwarding) and SharePoint Administrator (every site, including site collection admins): its stored password is then
  a tenant-wide Exchange and SharePoint credential while the account is enabled. Keep the opt-in to validation tenants,
  enable the account only for a live run (`provision test-identities --enable` / `--disable`), and turn the opt-in off
  when the Exchange and SharePoint write playbooks aren't being validated.
- The validation user is excluded from Entra's authentication-methods registration campaign, so Entra never nudges it
  to register a passkey or Authenticator; its MFA (TOTP under Security Defaults) or Conditional Access still applies.
- Read-mode PowerShell still runs in FullLanguage: the static policy is the boundary, not a sandbox. A
  ConstrainedLanguage runspace needs six read scripts rewritten. Runner answers are authenticated, not encrypted
  (loopback); `/healthz` and cancel answers aren't signed.
- A child playbook's own typed confirmation isn't asked when a parent starts it; the parent must have a confirmation of
  its own. Five existing definitions need aligning before the stricter rule can be enforced.
- HTTP probes check the resolved address before connecting, but not across a DNS change in between (rebinding). News
  feeds pin the connection to the checked addresses; the same dispatcher can be adopted for probes (docs/backlog.md).

- The session id is not rotated when write access is turned on (a cookie stolen while read-only could ride a later
  arm by the real user). Mitigated by the cookie flags and expiry; rotation needs runs and pending secrets re-keyed.
- The audit chain is unkeyed: someone with database write access could rewrite and re-hash its tail. Each verification
  writes the verified tail (`seq`, `hash`) to the services' journal as an external checkpoint; forward the journal off
  the host so the anchor doesn't share the database's fate.
- Definitions loaded from the database are trusted as published (not re-validated on load), and the services'
  database role can insert and update them; `publish`'s review check is a process control on a local ref, not a
  security boundary. Two-person review needs branch protection and a second code owner on the repository.
- Approval gates exclude a group's members and a principal, not a service principal's owners.
- CSP allows inline **styles** (`style-src 'unsafe-inline'`) because Radix and Monaco inject them; scripts stay
  `'self'` only, so CSS injection can't execute code.
- User units can't isolate the filesystem on hosts that restrict unprivileged user namespaces (Ubuntu 24.04): run as a
  dedicated system user with system units for that. Until then, write-mode PowerShell (FullLanguage) and any process of
  the same account can read the services' configuration.
- The Read and Write apps authenticate with client secrets (certificates are supported for the automation identity
  only), and one key (`TOKEN_CACHE_KEY`) seals both the token cache and run-secret hand-offs. Blobs name their key
  (key id), so it can be rotated with `TOKEN_CACHE_PREVIOUS_KEYS` without signing everyone out.
- A compromised service can still record a forged approval decision (the database keeps decisions append-only and the
  audit log records each one, but neither knows who clicked); approval integrity rests on the API process. Likewise
  the owner files only keep the owner's credentials out of the services' configuration: code running as the
  services' Unix account can read them.
- Browsers must trust Caddy's local CA for LAN access; use a certificate from your own CA and a DNS name for wider use.
