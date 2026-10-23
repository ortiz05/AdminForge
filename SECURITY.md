# Security model

AdminForge holds powerful delegated and application access to a Microsoft Entra tenant, so its design assumes that a
mistake in content, a stolen cookie, or a compromised neighbour process should not turn into tenant-wide write access.
This page is the reference for how that works. Decisions behind it are in `docs/adr/` and `docs/decisions.md`;
operating procedures (rotation, backups) are in `docs/operations.md`.

**Reporting a vulnerability:** open a private security advisory on the GitHub repository (Security → Advisories), or
contact the repository owner directly. Don't file a public issue.

## Identities

| Identity                     | Kind                                    | Who uses it                     | Can change data?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AdminForge Read `[<label>]`  | Delegated (signed-in user)              | Everyone with a portal role     | Not through AdminForge: the request policy allows reads only. Workload scopes that can write at the token level (ARM `user_impersonation`; on licensed tenants Exchange `Exchange.Manage`, SharePoint `AllSites.FullControl`, Teams) are flagged by provisioning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| AdminForge Write `[<label>]` | Delegated                               | Operators, only while **armed** | Yes, as the user, within their Entra roles; assigned to the Operator group only. Tier-0 scopes (role management and PIM, app credentials, app-role and consent grants, `Directory.AccessAsUser.All`, tenant policies) only with `AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| AdminForge Automation        | Application                             | Scheduler and scheduled runs    | Read-only by default: write permissions need `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`; reads of mail, files, sites (full control included), chats and team memberships, calendars, contacts, notes, presence, meeting and call recordings and transcripts, Copilot interactions, BitLocker keys, LAPS passwords or authentication methods need `AF_AUTOMATION_ALLOW_SENSITIVE_READS=true`; tier-0 permissions (role management, tenant policies and sign-in trust, app credentials, authentication methods, group membership, Intune scripts and apps) need `AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS=true`; neither is lifted by the write opt-in. `Sites.Selected` needs neither: it reaches only the sites an administrator grants it (synthetic transactions: write on one test site — never `fullcontrol`). Assignment required; a certificate replaces its secret when `AF_AUTOMATION_CERT_PATH` is set |
| Provisioner                  | Application (created by you, not by us) | `adminforge provision …` only   | Yes (creates apps, groups, consent). Lives in `<env>.admin.env`, read only by `provision …`, `validate --scopes`, `env check` (key states only) and the live tests — never by the services, never backed up. Give it Global Administrator only while provisioning; prefer a short-lived secret per run (`docs/operations.md`). Graph application permissions granted for the test fixtures (several tier-0) survive removing its directory role: remove them between runs too — `provision status` warns while it holds them                                                                                                                                                                                                                                                                                                                                                                                        |

Delegated calls can never do more than the signed-in person could do in the Entra admin centre; AdminForge adds
restrictions, never privileges.

**Drift and unexpected privilege:** `adminforge provision status` fails when something provisioning did not grant
appears: other principals assigned to the apps, extra application permissions, per-user or foreign consent grants,
owners on the apps or their service principals, extra secrets or certificates, public-client/SPA redirect URIs,
identifier URIs or exposed scopes, directory roles held by the apps (active or PIM-eligible), or Azure roles beyond
Reader (plus Log Analytics Reader on the test workspace).
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
- At most 5,000 sign-ins may be pending. When the table is full, the address holding the most pending sign-ins (IPv4,
  or an IPv6 /64, recorded pseudonymously) gives up its oldest if it holds more than the starting address, so a few
  addresses can't hold the table against everyone else; otherwise the oldest pending sign-in that has had two minutes
  is dropped to make room (its callback answers `invalid_state`). A start is refused with 503 `signin_busy`, writing
  nothing, only when every pending sign-in is younger than that. Arming and schedule consent are never refused or
  dropped. Refusals log at info, with a warning once a minute.
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
  stylesheet, the emergency-stop state and the event stream. At most 5 event streams per session, at most 5 run
  streams per session, and at most 5 open runs per person (`RUN_MAX_OPEN_PER_USER`).
- Every state-changing request needs the per-session `X-AdminForge-CSRF` header (constant-time compare).
- Microsoft tokens never reach the browser. The MSAL cache is sealed with AES-256-GCM (`TOKEN_CACHE_KEY`), with the
  partition key as associated data, and stored in the database.
- **A new session id at every arm.** Turning on write access moves the session to a new random id and CSRF token in
  one database transaction, together with what is kept under the old id: its unfinished runs and the approval
  decisions on them, the sign-in round trips it started, and its Microsoft token partitions (sealed again: the
  partition key is their associated data). The Write app's tokens are redeemed straight into the new id's partition.
  Held show-once secrets follow; open event and run streams of the old id end and the browser reconnects with the new
  cookie. The old id stops working at once (a request still carrying it within a minute is refused without clearing
  the browser's new cookie). A run bound to the session while it was read-only keeps reading, but its next write waits
  (`awaiting_arm`) until the person resumes it. Extending or ending write access keeps the id.
- Sign-out deletes the session and both token partitions and goes through Entra's end-session endpoint; the
  signed-out page never signs the person back in automatically.
- Query Studio history (`localStorage`, per user) is removed at sign-out and on any 401; after a session ends nothing
  is stored again until a signed-in session names its owner.

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
  `confirm` / `approval`). There is no generic write proxy. Reads go through a default-deny request policy. A step
  that starts a child playbook that writes, and any step with a `compensate` block, is a write too: `validate` refuses
  either without `mode: write`, and in a write playbook the engine counts them as writes wherever it looks for one —
  where the approval gate of `approval: { required: true }` goes, and whether whoever approves or confirms a manual
  step before them must be armed.
- Risky playbooks must be previewed first; the server checks that the confirmation matches the preview (same user,
  version, inputs, under 15 minutes old), and a preview confirms at most one run. Drafts can be previewed, never run.
  High- and critical-risk playbooks and runbooks, and every playbook offered as a bulk action from risk medium up,
  confirm by typing a value the person recognises — in bulk, the number of items
  (`tests/content/high-risk-typed-confirm.test.ts`). The text to type and the message are rendered by the API from the
  preview and shown only to the person who previewed; a value that can't be rendered, has nothing visible or holds a
  masked value can't be confirmed. So where the value is a name anyone can choose (an app's, a group's, a device's,
  a role's), the playbook works out what to ask for in a `confirmAs` step: the name, or the object's id when the name
  has nothing visible to type or holds a masked value, so such a name can't block the change
  (`tests/content/typed-confirm-fallback.test.ts`: seven playbooks so far; the others that type a chosen name, and a
  generic fallback in the API, are in `docs/backlog.md`). Typed confirmations are compared the same way in the browser
  and the API (`confirmationMatches`: invisible characters removed, NFKC, whitespace collapsed, case ignored), and the
  dialog marks and lists characters that can make a name pass for another (invisible characters, unusual spaces, styled
  letters, letters of a look-alike alphabet).
- Interactive calls — runs, page data, exports — use only the **current** published version; older or retired
  versions answer 409 (`version_superseded`, `definition_retired`), so a later access rule or fix can't be sidestepped.
  Child playbooks start on their current version too (a pin to an older one fails `version_superseded`).
- **Resuming** a run (after arming, signing in again or an approval) re-checks what starting it checked: the person
  still holds the roles it needs, and — while nothing has been changed yet — the run is still on the current version
  (otherwise it ends `run_outdated`; start a new one). A run that already sent a change finishes on the version that
  started it, and runbooks (checklists) carry on, since every playbook they start runs its current version. A
  confirmed change whose preview is more than 15 minutes old stops before writing (`preview_stale`). Runs waiting for
  write access or a new sign-in stop after 24 hours (`run_expired`). A restart interrupts runs instead of cancelling
  them: a resumed run passes the same re-checks (the current version unless it may have written; the initiator's
  roles), and every write step re-checks arming. A step in flight at the restart is retried unless it is
  `idempotent: false` (then the run ends `needs_review`), so write steps whose second send would hurt declare
  `idempotent: false` (`tests/content/non-idempotent-writes.test.ts`). Such a step's request is also sent at most once
  by the HTTP client (`sendOnce`): never again after a server error, a network failure or a timeout, only after a 429,
  which Microsoft answers before processing the request — and validate refuses a `retry` policy on it. A sign-in
  (claims) challenge after Microsoft accepted a change — on an Azure long-running operation's poll, or a `$batch`
  chunk after one was processed — fails the step (`accepted_unconfirmed`) instead of sending the change again. A worker
  whose run lock lapsed stops at its next checkpoint once its lease renewal notices.
- **A resumed run checks again before it writes** (`engine.ts` › `recheck`). After any pause — an approval, input,
  write access, a sign-in, a `wait`, a restart — the reads, transforms and asserts the run ran since the last write
  sent in their scope run again right before its next write, so a check such as "the session still belongs to this
  person" holds when the write goes out, not only when the run paused. They run as who ran them (`user.*` keeps its
  meaning); their reads go out with the access of the person the write runs as — after an approval the approver, who
  then needs read access to them — except a Graph read of `/me`, which keeps its first answer. A check that fails now
  stops the write (its `onError` applies; by default the run ends `failed` with the assert's message), and a write
  that may already have gone out before the run stopped ends `needs_review` instead. The write's own `when` and the
  `excludes` of the approvals decided on the way are worked out again (`approval_excludes_approver` when they now name
  an approver). What the run decided stays decided — approvals and input, the `when` of reads and checks, a branch's
  `if` and a forEach's `items` — so guards must be `assert` steps. Writes already sent, and what was read before them,
  are never repeated; steps with show-once secrets, `idempotent: false` reads and child playbooks (which check for
  themselves) aren't run again.
- Run approvals need a second person with `Playbook.Approver`; self-approval is refused, and an approver must be armed
  when the steps after the approval write as them — and hold the playbook's portal roles. **Nobody can approve a change
  that grants them access**: approval gates name the beneficiaries (`approval.excludes` — e.g. the principal getting a
  directory or Azure role, the people being added to a role-assignable group, a new app owner), and those people get
  `own_access`. Approval requests expire after 72 hours unless the playbook says otherwise. An approval can't be
  stepped over: a rejected, expired or unworkable one always stops the run, and `validate` refuses `onError: continue`
  on it. Child playbooks need their own roles from whoever runs them. Only the person a manual step waits for can
  confirm it or supply its values (others may only decline); confirming one with write steps after it needs write
  access, as approving does (`not_armed`), because those steps run as whoever confirms. The values are audited with
  `redact` fields masked.
- **Protected objects:** AdminForge can't be used to change its own access. The executor refuses every write — REST
  or PowerShell — that names by object id, in its path, query or body, AdminForge's own app registrations and service
  principals (the schedules' app identities, retired ones included), any app in `AF_PROTECTED_APP_IDS` (such as the
  provisioner), every principal assigned an AdminForge app role (the `SG-AdminForge-*` groups — the groups, not their
  members) or an account in `AF_PROTECTED_USER_IDS` (break-glass accounts): `protected_object`. The set is read from
  Microsoft Graph by id (automation identity, else the caller's Read sign-in) and cached for 10 minutes; when it can't
  be read, the ids already known are still refused, and writes to groups (and their members and owners), apps,
  service principals, app-role assignments, authentication methods, directory objects and delegated permission
  grants are refused (`protected_objects_unavailable`). Because the match is by id, a Graph write that names a user
  by sign-in name or address — `/users/{upn}`, `users('{upn}')`, an `@odata.id` / `…@odata.bind` reference or a
  `$id` query naming one — is refused outright (`user_not_by_id`); `adminforge validate` requires `$guid()` there in
  Graph writes. Exceptions: AdminForge's own notification mail (its sender is configured as an address) and the
  notify step's one-on-one Teams chat, whose members are a conversation, not a change to an account. A delegated
  permission grant's id isn't an object id, so a write to one (any path spelling, `$batch` included) reads the grant
  first (`clientId`, the same readers) and is refused when the client is a protected app; a grant key that isn't a
  plain id, or a grant that can't be read, is refused (`protected_objects_unavailable`). A write that addresses a
  group, app, service principal or directory object by anything but its id is refused too (`object_not_by_id`):
  `groups(uniqueName='…')` — the key provisioning sets on AdminForge's own groups and apps — after a type cast or in a
  segment of its own, a GUID without hyphens, or any other segment after the collection; `appId='{id}'` and
  `id='{id}'` keys are compared like ids. Paths are read segment by segment, each decoded on its own, folded as .NET
  does (`groupſ`), casts and runs of `/` ignored, so none of them takes a write out of the fail-closed rule. `$batch`
  written another way (`/$Batch`, `/$batch/`, `/%24batch`) is checked request by request and sent as `/$batch`;
  anything else that starts like `$batch`, and a batch inside a batch, is refused. Ids inside an encoded body (a
  base64 `$batch` sub-request) aren't matched. PowerShell inputs are matched by object id only (names and UPNs aren't). Playbooks keep friendly
  early checks.
- Playbooks that act on a target whose id can be reused or change hands (Azure Virtual Desktop session numbers, a list
  that may be minutes old) carry what the person saw and assert it still holds before writing — so a stale screen
  can't sign out or message the wrong person — and high-risk ones (and every bulk action from medium risk up) ask for
  a typed confirmation (in bulk, the number of items).
- Group, distribution-list, app-owner and app-assignment playbooks refuse adding yourself — for an app assignment
  also a group you belong to or own; group members must be users, and a mail-enabled security group takes people,
  not other groups — adding to a role-assignable group (which
  carries directory roles) or to a mail-enabled security group (which grants access like any security group), and
  making someone an app owner need a second person's approval. Nobody dismisses their own
  sign-in risk, turns on an inbox rule that sends someone else's mail to them, or issues themselves a Temporary
  Access Pass or removes their own MFA methods. The people who approve AdminForge changes (everyone holding
  Playbook Approver or Portal Admin on the Read app, through a group or directly) get no new credential through
  AdminForge at all: whoever held it could approve their own change as a second person. "Yourself" is the account
  you are signed in with: a second account of yours (a separate everyday or admin account, or one you create with
  onboarding and receive the first credential for) isn't recognised (Known gaps).
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
    one identity's write access never extends to another. Tier-0 application permissions (role management and PIM, app credentials and consent, tenant policies and organization settings, every user's authentication methods, group membership — AdminForge's own role groups included — and what Conditional Access and sign-in decide on: device and custom security attributes, user risk, token-issuance hooks, administrative units, agent identities) need `AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS=true` for any app-only identity, the automation identity included; the write opt-in alone never grants them. Its client id is protected like the built-in apps — and so is an
    identity taken out of `AF_SCHEDULE_IDENTITIES` (found by its "AdminForge Identity …" name; `provision status`
    fails until it is deleted); a client id listed in `AF_PROTECTED_APP_IDS` is refused as an identity. It shares
    the automation rate-limit pool, and its tokens and caches are keyed by its name. Changing a write schedule's
    identity changes its definition, so the two-person approval must be given again. **Any** Operator can pick any
    configured identity for a report schedule they create in the portal (reports only, read-only), so list only
    identities whose read access every Operator may use;
  - which of these a schedule uses can also come from the **installation default** for its kind
    (`AF_SCHEDULE_DEFAULT_IDENTITY…`, read-only jobs only, so a deploy never moves a write-capable schedule) or an
    **Operator's override** on a content schedule (audited `schedule.run_as_changed`). An override may only name an
    identity that already holds the application permissions the schedule and its probes declare — checked by reading
    the identity's app roles with the automation identity, the one read on an Operator's request that uses it
    (rate-limited, 10 a minute); on a write-capable schedule it turns the schedule off and cancels a pending request,
    the enable approval records the account (`policy.identity`), and the scheduler runs the schedule only as the
    account its approval covered (`schedules.approved_identity`). Defaults never apply to probe sweeps, and a sweep
    that runs synthetic transactions keeps the account its content names;
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
- **Synthetic transactions** (ADR-015: the `mailFlow`, `fileRoundTrip` and `onlineMeeting` probes) are the only
  unattended writes without a two-person approval. They are built-in code with fixed calls — send a test message and
  read it back, upload a file and download it, create an online meeting — each removed again in the same run (and
  stale test items of earlier runs, recognised by their marker and age, never a running check's). Their targets must
  be `${ env.AF_SYNTHETIC_… }` keys (a sender may also be `AF_MAIL_SENDER`) — refused by validation and again at run
  time, where the value is read straight from configuration (never evaluated) — so content can't point them at a
  recipient list, an approver or any address in git; an unset key means no call. Mailboxes are resolved to their
  object id first, so the protected-object guard recognises a protected account. Every changing call is a declared
  write (request policy, emergency stop, protected-object guard), reads stay read-only, and they refuse a person's
  grant. A run in which a transaction acted is audited as a write (`schedule.run`, `mode: write`, each transaction's
  outcome code), and so is each one a scheduler one-shot (`--probe`, `--once`) ran (`probe.run`); one-shots run none
  while automation is paused, `--schedule` refuses a turned-off schedule that runs them, and without the database
  (`--no-store`) a one-shot refuses every write and `--schedule` runs only on fixture data, since it can neither read
  the emergency stop nor keep an audit record. **Run now** is refused while their schedule is turned off. Their reach
  is the administrator's scoping of the identity to the test objects: Exchange RBAC for Applications on the test
  mailbox, Sites.Selected with write on one site, a Teams application access policy for one test user
  (OnlineMeetings.ReadWrite.All still needs `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS`, which lifts the ceiling for every
  write permission content declares — use a dedicated named identity for them if that matters, ADR-014). The file
  check downloads only from a SharePoint host over https on the default port, without credentials.
- Report files, probe result rows and the outputs of scheduled runs were collected with application permissions, so
  by default only `Portal.Operator` can see them (for files, runs and run history a schedule's `requires.portalRoles`
  overrides this; probe rows use the default), plus the report's or playbook's own roles. That includes the error
  message, hint and run id in a schedule's run history (for a schedule that runs with its creator's access: the
  creator and Portal Admins): others see the status and the error code — the scheduler's own messages, such as a
  missed run, stay — and the `schedule.failed` browser event carries the code only. A probe's result **message** is shown to every Reader, so checks never copy
  names, ids or rows into it (an aggregate such as the most common sign-in error code and Microsoft's reason text is
  allowed); others see the probe's `remedy` and `link`, whose in-app pages read with their own permissions. A probe
  `link` is an in-app path or an https URL — validation refuses protocol-relative (`//host`) and backslash paths,
  checks that a `/p/` target exists, and the web app re-checks the shape before rendering it.
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
- **Who sees a run:** a delegated run collected its data with its people's Entra rights — the initiator's, and after
  an approval the approver's: the steps after it run as the approver, and so do the reads a resumed run makes again
  before a write (above), whose outputs are stored in the run like any other. The initiator therefore sees data read
  with the approver's access (approving lets the run read as the approver; a known property, not a leak to others).
  Its inputs, outputs, step requests and outputs, plan, logs, error messages and hints, approval messages, manual-step
  instructions, and decision comments and values are shown only to its initiator (of that run or one above it), its
  approvers — while a gate they may decide is pending and not expired (with the default
  `approvers: [Playbook.Approver]`, every Approver who may open the run and isn't excluded from the gate), or
  permanently once they approved or rejected — the person a manual step waits for, and Portal.Admin. Anyone else who
  may open it sees metadata: playbook, who, when, status, step names and states, and references (correlation id,
  Microsoft request-id, error code and HTTP status, child run ids). The run stream sends the same, without logs, and
  re-decides after each read of new events. The approvals inbox shows gates decided by others, and gates on runs the
  approver can't open, as metadata — unless the approver is asked to decide the gate or did (then the gate's message
  and comments, not the run). Scheduled runs (automation identity) are no one person's data: whoever may open them
  sees them whole.
- **Injection:** OData/KQL values go through `$odata()` / `$kql()`; advanced filters are compiled server-side from
  structured data; request paths may not contain `?`, `#` or control characters (the policy also judges the path
  exactly as it will be sent), and validation runs a taint analysis over every expression that reaches a request path,
  url, query, OData option, KQL query or body (`portal/packages/expressions/src/taint.ts`). It follows user data
  (params except enum params, inputs, rows, items, a datasource's result per field, a step's output) through
  functions, function values, lambdas, `~>`, variables and constructors, and flags it where it reaches a request
  `path`/`url` without `$encode()`; OData `$filter` / `$search` / `$orderby` / `$expand` text (in the query or the
  body) without `$odata()` / `$odataSearch()` / `$guid()`; a `$batch` url's query string without `$guid()`, a number
  or a literal allow-list; a KQL query without `$kql()`. Encoders count only in their own text and position, and not
  once the value is taken apart. `$orderby` takes a literal allow-list. A `$replace` character allow-list counts
  inside a quoted literal, and in a path or anywhere else only when it leaves nothing but letters, digits, `-` and `_`
  (in a path) or digits. A whole path may be a guid or entity param as it is — the API checks a page param and a
  playbook input alike as the id it names (a GUID, a UPN for a user, `/subscriptions/…` for a resource); a whole KQL
  query from a param needs `/* adminforge: user-query */`. Known limits: `user.*` claims are trusted; quote placement is judged from the
  literal text. `adminforge publish` and the content health check run the same checks, and `publish` refuses on
  errors. Content `pattern:`s are refused at validate time when they can backtrack without bound, always match the
  whole value (`u` flag) and never see values over 4,096 characters. Regular expressions written into an expression
  get the same shape check at validate time (case-folded under `i`), but run unanchored on values of any length, so a
  pattern such as `\s+$` can still take seconds on a long value; the check is static, not a proof. Exports and Query
  Studio's Copy neutralise spreadsheet formulas. Values inserted into Markdown are escaped and links are limited to
  http(s), mailto, same-origin paths and anchors; every link from data is rendered through `safeUrl` (`AppLink`, the
  list, KPI, status-grid, key-value, table, action and Markdown widgets, run and runbook text) and every navigation
  from data follows `followSafeUrl` (`portal/packages/ui/src/lib/links.ts`), which apply the same rule — anything else
  stays text. A key-value link without `href` uses its data value literally (never evaluated) and only when it's an
  external URL. Tenant HTML becomes text by linear passes, numeric character references that name no character stay as
  written, and Markdown links are read in linear time. A block that still fails while it renders is caught by its own
  error boundary: it shows a reference generated in the browser (logged only to that browser's console), and the rest
  of the page keeps working. Expressions have size and time caps (built text — `&` and the encoders included — at 10 M
  characters), and `$eval` is unavailable.
- **Settings in content:** content expressions read only the `AF_*` keys `config/example.env` declares, minus
  secret-looking names — the same keys `adminforge validate` accepts. Nothing else in the environment (in the pod,
  the Secret and the ConfigMap) reaches content. The API refuses to start without the example file.
- **Delivery:** email recipients and Teams webhooks are only ever `${ env.X }` configuration — recipients must be keys
  named `AF_…RECIPIENTS`, `AF_…EMAIL` or `AF_…ALERTS`, and delivery (run approvals' notifications included) reads only
  those keys, the sender and the webhook keys; webhooks must be https on Microsoft hosts and never follow redirects;
  `*WEBHOOK*` keys are hidden from content expressions. Email goes through Graph as the automation identity, which
  should be allowed to send only as `AF_MAIL_SENDER` (Exchange RBAC for Applications); Entra `Mail.Send` would let it
  send as any mailbox and needs the write-permission opt-in.
- **Outbound:** connection audiences are an allow-list — `api://…`, an application id, or an https host listed in
  `AF_CONNECTION_AUDIENCE_HOSTS` — and Microsoft first-party audiences are always refused; scopes are plain names on
  that audience, so a token can't be steered to another resource. Connections refuse redirects. Generic `http` steps
  are disabled. KQL queries ask the service for a bounded number of rows, and Log Analytics queries run one statement
  at a time; every response body is size-capped (`OUTBOUND_MAX_BYTES`). HTTP probes don't follow redirects, can't
  reach private, loopback or link-local addresses other than the portal itself — re-checked at connect time on a
  pinned connection, as for news feeds, so a DNS change between the check and the connect is refused — and POST only
  with `allowPost: true`. Certificate probes follow the same rule (this portal's host, or one that resolves only to
  public addresses, connected to at the address checked), and DNS probes ask the system resolver, a public one named
  by IP, or one listed in `AF_PROBE_RESOLVERS` (`probe_target_not_allowed` otherwise). Content can't set the headers AdminForge owns (`Authorization`, `Cookie`,
  `Proxy-Authorization`, `Host`, `client-request-id`, `x-ms-client-request-id`, and the method-override headers
  `X-HTTP-Method-Override`, `X-HTTP-Method` and `X-Method-Override`; any case): validate refuses them, the executor
  refuses them (also on `$batch` sub-requests), and the HTTP client drops them before adding the bearer token and the
  correlation id. A connection's `mode: read` operation that POSTs runs unarmed only with `readPost: true` (validate
  refuses it otherwise; the policy refuses it at run time; the value comes from the published connection, never the
  caller), and a read operation never uses PUT, PATCH or DELETE. Review every `readPost: true` as a loosening.
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
transcription logging out of the log (it logged module source at warning level). The runner container gets only
the shared key (`RUNNER_SHARED_KEY`), never the rest of the configuration. Write jobs pass the API's emergency stop and protected-object guard before any
token is minted.

Read-mode jobs use Read-app tokens, some of which can write (Exchange `Exchange.Manage`, SharePoint
`AllSites.FullControl`), so the runner keeps them to reads in two layers. Before the script runs, a static policy over
the parsed script allows `Get-*` commands, the AdminForge helpers, a fixed set of PowerShell utilities and the
script's own functions, and refuses everything else: module-qualified calls, dynamic invocation, scripts and programs
by path, `Get-*` commands that return tokens or connections, .NET types outside a small allow-list, reflection and
invocation members, engine and provider variables, classes, `using`, file redirection (`>`, `>>`, `2>`, `*>`, also
`> $null`; merging a stream into the output, `2>&1`, writes no file and stays allowed), and changes to objects the
script didn't build: a change queued on a SharePoint client object a `Get-PnP*` cmdlet returned would go out with the
connection's next request. Properties and indexes may be set only on a variable the script assigns nothing but `@{…}`
or `[ordered]@{…}`; `set_*()` accessors, `.ForEach('Name', value)` and wildcard member names are refused; and common
change methods (`Update()`, `Delete…()`, `Recycle()`, `Set…()`, `CopyTo()`, `Publish()`, `Move…()`, `Share…()` …) are
refused by name — a deny-list, see Known gaps. While it runs, every non-`Get`
command of every loaded service module (Exchange Online, Teams, PnP, Microsoft Graph, Az) is replaced by a guard,
REST cmdlets accept only GET, and module auto-loading is off.

## Audit

Every sign-in, arm/disarm, run, approval, schedule change, content publish, sensitive read, download, notification,
emergency stop and retention purge is appended to an append-only (database-enforced), hash-chained log. Refused
security-relevant requests are recorded too (`request.denied`: forbidden, CSRF, request-policy denials of page data,
self-approval, approving a change that grants you access, completing a step that waits for someone else, wrong
confirmation, missing or stale preview, session mismatch) with the route, code and status only — at most one event
per minute per session and code, then a `suppressed` count. Refusals inside a run or a schedule (request policy,
protected objects, `user_not_by_id`, paused writes) end the step and appear in the audit log only as the run's or
schedule run's error code. Failed sign-ins (`session.signin`
failures — anyone can send a browser to `/auth/callback` with an error) are recorded at most 10 a minute per client
address (IPv6: per /64), then a `suppressed` count. `content.published` records the git
commit, whether the content was reviewed (committed and on origin's `main`), the `main` commit it was checked against
(`mainCommit`, from `git ls-remote` or the image's fetch) and origin's URL without credentials; `--allow-unreviewed`
is recorded with its reasons. Every `adminforge db backup` is recorded too (`database.backup`, below). The Audit page
and `adminforge audit verify` walk the whole chain; `probes.audit-chain` checks hourly the events since the last
verified checkpoint (and that checkpoint event), and the whole chain after a restart, once a day and after any break.
An older event changed without re-hashing through the checkpoint is found by the next full walk, the Audit page or
`adminforge audit verify`. With `AUDIT_CHAIN_KEY` (in the installation's Secret, never on the volume) the chain is
HMAC-SHA256 from a cut-over event the API appends at start (`audit.chain_keyed`); earlier events keep their SHA-256
links and the cut-over seals them. With `AUDIT_CHAIN_KEYED_SINCE` pinning the first cut-over as well, someone with
only the volume can't change any event and re-hash the rest. Without the pin they can strip the cut-over and re-hash
the whole log unkeyed (the API cuts over again at its next start); only the shipped checkpoints show that, so set
the pin once the first cut-over is logged. Once the log is keyed, the API doesn't start without the key, and
`publish`, `db backup` and `db sign-out-everyone` refuse before changing anything.
`adminforge audit verify --checkpoint <seq>:<hash>` checks a checkpoint from the shipped log; events keyed with a key
that isn't configured fail as "can't be verified", not as broken. The key never appears in logs, errors, API answers
or backups; key ids (derived from it) do. A bulk run's `run.created` records
the inputs every item shares (`inputsTemplate` — the reason, a message), redacted like a single run's, since the
per-item runs don't record inputs. History (runs, schedule runs,
probe results, report files) is purged after its retention period; the audit log is never purged.

## Deployment, storage and network

AdminForge runs as one pod on Kubernetes (ADR-017; `portal/deploy/kubernetes`) and keeps all state in one SQLite file
on a PersistentVolume (ADR-016).

- **TLS** is the Ingress's. With Entra sign-in, the API starts outside `NODE_ENV=production` only on this machine (a
  loopback `API_HOST`, and a `PUBLIC_BASE_URL` on localhost or a loopback address), so a portal others reach can't run
  without HSTS, the `__Host-` cookie and the production checks; the app image and the base ConfigMap set production
  (`tests/guards/image-node-env.test.ts`). The API listens on the pod's interface on port 3300 behind the Service and
  trusts `X-Forwarded-*` only from `TRUST_PROXY` (the ingress controller's pod network; `true`, which would let anyone
  forge the address, is refused in production). Security headers: CSP (`script-src 'self'`, `frame-ancestors 'none'`;
  nothing in the web bundle may need `eval` — Zod's eval probe is switched off before anything validates, and
  `tests/e2e/prod/csp-no-eval.spec.ts` fails the production build on any violation), HSTS, `nosniff`, `no-referrer`, a
  `Permissions-Policy` that turns off camera, microphone, geolocation, payment and USB, `no-store` on API and auth
  responses; rate limits on every route and tighter ones on sign-in and arming (sign-in and anything without a valid
  session count per client address, never per cookie). Production source maps are kept out of what's served
  (`portal/apps/web/sourcemaps/`).
- Request logs carry the signed-in user's object id, never query values on `/api` (parameter names only), cookies,
  auth codes or the CSRF header. The public `/readyz` answer never names configuration keys or commands.
- **The pod:** one replica (`Recreate`); both containers non-root with fixed uids (10001 api, 10002 runner), a
  read-only root file system, no capabilities, no privilege escalation, RuntimeDefault seccomp — the restricted Pod
  Security Standard; no service-account token (the pod never talks to the Kubernetes API). The runner is a sidecar on
  the pod's loopback: nothing outside the pod can reach it, and it gets only `RUNNER_SHARED_KEY`. A NetworkPolicy
  allows ingress to the HTTP port (from the ingress controller, in the overlay) and egress to the cluster's DNS and to
  public addresses on 443 only. Where the cluster enforces NetworkPolicies (`preflight.sh` checks for an engine), the
  private ranges and the reserved ranges clusters use are refused (10/8, 172.16/12, 192.168/16, 100.64/10,
  link-local with the cloud instance metadata service, WireServer, 0/8, 192.0.0/24, 198.18/15, 224/3), so the pod
  can't borrow the node's identity or reach other workloads. Exceptions an installation needs go in a policy of the
  overlay's own, which opens only what it lists; the base's refusals hold for everything else
  (`tests/guards/networkpolicy-private-egress.test.ts`). The loader pod
  gets no network at all.
- **Images** start from bases pinned by digest (`name:tag@sha256:…`, and the `# syntax=` frontend;
  `tests/guards/image-digests.test.ts`). A pin moves only by a reviewed commit. The runner's build also installs
  Ubuntu's updates of its day (signed by Canonical; outside git and any waiting period, so that a rebuild brings
  security fixes) and PowerShell from the release archive its Dockerfile pins by version and SHA-256, checked before it
  is unpacked (`tests/guards/runner-powershell-download.test.ts`).
- **Dependencies** wait seven days: pnpm resolves only versions published at least seven days ago
  (`minimumReleaseAge: 10080`, strict, versions without a publish time refused), and every install — CI and both image
  builds — runs from the frozen lockfile under that setting. The package manager above the lockfile doesn't come
  through that floor, so it is pinned by hash instead: pnpm's exact version with its sha512 in `packageManager`
  (Corepack refuses a download that doesn't match), and Corepack itself — Node 25 and later no longer bundle it — at
  an exact version whose registry tarball both images check against a recorded sha512 and install without
  scripts (`tests/unit/tooling/package-manager-pin.test.ts`); either moves by a reviewed commit of version and hash,
  once the version is seven days old. Dependabot waits the same seven days (`cooldown`) on npm, GitHub Actions and
  both images' base images. Its security updates skip the cooldown but not pnpm's floor, so an urgent fix adds one
  exact `name@x.y.z` to `minimumReleaseAgeExclude`, with a comment saying why and when it goes, in the same pull
  request. `.gitignore` keeps env files, key material and SQLite files out of git (images are built from
  `git archive HEAD`; `tests/guards/gitignore-secrets.test.ts`).
- **The database file.** SQLite has no roles: whoever can write the file can do anything to it, including dropping the
  append-only triggers. So the file itself is guarded: no other user may write its folder, the file and its `-wal`/`-shm`
  are 0600 (tightened at every start; a volume's `fsGroup` may add the pod's own group) and owned by the API's user,
  symlinks are resolved before anything is checked, and it must be on a local file system — production refuses to start otherwise (statfs
  refuses NFS, SMB/Azure Files and FUSE, where SQLite's locking corrupts databases). The volume is ReadWriteOncePod (one
  pod can ever mount it) on block storage the cloud encrypts at rest; nothing else in the cluster mounts it except the
  one-off loader pod an operator starts while AdminForge is stopped. Inside the file, triggers keep audit events
  append-only and approval decisions append-only and final (rebinding only to the decider's own session, deletion only
  with the run or schedule), and foreign keys and status CHECKs hold — against the application's own mistakes, not
  against someone with the volume. Deleted sessions and tokens are overwritten (`secure_delete`).
- **Configuration** comes from the environment: the `adminforge-env` Secret (made from the env file, without the
  admin-only keys — provisioner and test-account credentials never reach the cluster) and the ConfigMap, which wins
  for the pod's layout (a copied env file can't move the database off the volume). Protect the Secret with the
  cluster's RBAC and encryption at rest: it holds `TOKEN_CACHE_KEY`, `AUDIT_CHAIN_KEY` and the apps' credentials. On a
  workstation the env files stay mode 600 in a 700 directory: `<env>.env` (runtime) and `<env>.admin.env` (CLI and
  live tests only). The API, the scheduler's one-shots, the live tests and every CLI command but `env check` refuse an
  env file with any group or world permission, naming the file and the `chmod 600` fix (`env check` doesn't check
  modes yet). A developer's `pnpm dev` uses a database file of its own (`~/.local/share/adminforge/dev.db`).
- **Backups:** volume snapshots, and `adminforge db backup` — a consistent copy without sessions, pending sign-ins or
  the token cache (a restore signs everyone out), checked before it is written, mode 600, not encrypted: stream it out
  of the pod and encrypt it there with a key whose private half is not in the cluster (`portal/deploy/kubernetes/
README.md` → Backups). Every `db backup` is itself in the audit log: a `database.backup` event is written before the
  copy leaves, and without it nothing leaves. A record, not a control: whoever can read the volume can copy it without
  the CLI. A copy of a keyed audit log verifies only with `AUDIT_CHAIN_KEY`, which is never in the copy.
- `/readyz` reports the run worker and scheduler from their heartbeats (cached 5 s, rate-limited), and every Microsoft
  call is logged as one structured line (path template, status, duration, throttling, request id) for tracing by
  Reference. The Reference (correlation id) of an API error is always generated by the API, never taken from the
  browser; a crash while the browser renders gets a local reference.
- Show-once secrets never leave the API process: the run worker is part of it, so they are never written anywhere, not
  even sealed.
- Mock sign-in (`AUTH_MODE=mock`) only starts outside production, with fixture data, a loopback `API_HOST`, a
  `PUBLIC_BASE_URL` on localhost and no credentials configured; a session left without any AdminForge role ends, as
  with Entra sign-in. Only then does the fixture fetch accept a write no fixture describes (204: there is no tenant).
  A POST the request policy lists as a read is never accepted that way, and with Entra sign-in on fixtures an
  unfixtured write stays a 404. With fixture data (either sign-in) a playbook's PowerShell steps answer from the runner
  fixtures, as PowerShell datasources do, and never reach the runner — a write script still through the emergency
  stop and the protected-object guard, and accepted without a fixture only with mock sign-in.

## Threats and mitigations

| Threat                                                            | Mitigation                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen session cookie                                             | `__Host-`/HttpOnly/Secure cookie; idle and absolute expiry; writes need step-up as the same user; roles re-checked; a new session id and CSRF token at every arm, so a cookie copied while read-only can't arm, start writes or confirm a manual step that writes follow, and the runs it started wait for a resume ahead of their next write       |
| Phishing via the portal's own URL                                 | Same-origin `returnTo` only; browser-bound sign-in round trips                                                                                                                                                                                                                                                                                      |
| Silent SSO used to arm without re-authentication                  | `prompt=login`, `max_age=0` and `auth_time` freshness always checked server-side (plus the auth context when set)                                                                                                                                                                                                                                   |
| Removed or disabled admin keeps acting                            | Roles re-read every 5 minutes, by the API and the run worker; session ends on `invalid_grant`, guest status, or 15 minutes without confirmation                                                                                                                                                                                                     |
| An approver approves their own elevation                          | Approval gates exclude the people a change grants access to (`own_access`); self-approval refused                                                                                                                                                                                                                                                   |
| A parked run continues on an older, weaker version                | Resume and the worker re-check roles and (before anything was changed) the current version; parked runs expire after 24 hours                                                                                                                                                                                                                       |
| A write acts on what changed while its run was paused             | A resumed run reads and runs its asserts again right before its next write; a write that may already have gone out ends `needs_review`                                                                                                                                                                                                              |
| Abuse in progress                                                 | Emergency stop: pause all changes or all automation from the portal, audited                                                                                                                                                                                                                                                                        |
| Changed playbook runs unattended under an old approval            | Approval fingerprint covers the playbook and its children; outdated approvals refuse and switch the schedule off                                                                                                                                                                                                                                    |
| Content grants the automation identity tenant-wide write          | Provisioning ceiling: write application permissions need an explicit opt-in                                                                                                                                                                                                                                                                         |
| Token sent to a third-party host                                  | Connection audiences allow-listed, scopes are names only, Microsoft audiences refused; redirects refused; `http` steps disabled                                                                                                                                                                                                                     |
| Content or a pinned script writes with a Reader's read tokens     | Runner read mode: static allow-list before the script runs; guards on every service write command; no module auto-loading                                                                                                                                                                                                                           |
| Another process answers on the runner's port                      | Tokens sealed per job; answers signed over a per-request nonce; redirects refused                                                                                                                                                                                                                                                                   |
| An old or retired content version is used to bypass a later rule  | Interactive calls and child playbooks use only the current version (409 otherwise)                                                                                                                                                                                                                                                                  |
| Someone else's input drives my write steps                        | Only the person a manual step waits for can supply its values; approvers need the playbook's roles                                                                                                                                                                                                                                                  |
| Report data emailed to an outside address                         | Recipients only from `AF_…RECIPIENTS/EMAIL/ALERTS` configuration keys                                                                                                                                                                                                                                                                               |
| An Operator schedules a report to collect app-permission data     | Accepted risk (Operators already get content schedules' files); reports Operators mustn't schedule or download set `requires.portalRoles` (e.g. `Portal.Admin`)                                                                                                                                                                                     |
| A portal schedule outlives its creator's access                   | Creator's account and roles confirmed before every run; loss turns it off (`creator_access_removed`); unreadable skips the run (`creator_unverified`)                                                                                                                                                                                               |
| A name typed in the portal phishes email or Teams recipients      | Single-line plain-text names without links or markup; Markdown escaped in Teams; "Scheduled in AdminForge by …"; approval channels excluded                                                                                                                                                                                                         |
| Readers seeing app-permission data                                | Report files and probe rows need Operator by default (service announcements on News and changes are the documented exception)                                                                                                                                                                                                                       |
| A news feed used to reach internal hosts or to inject markup      | Feed hosts are a code allow-list (https, public addresses pinned at connect, redirects only within it); no DTDs/entities; linear plain-text reduction; links on the source's own host                                                                                                                                                               |
| Another workload in the cluster reads secrets or the database     | Admin credentials never reach the cluster; runner gets only its key; non-root pod, RWOP volume, NetworkPolicy, no service-account token (see Deployment, storage and network)                                                                                                                                                                       |
| Developer server consumes production jobs                         | A developer's API uses its own database file; the production file is only on the pod's volume                                                                                                                                                                                                                                                       |
| Content gives the Write app tier-0 scopes                         | Provisioning ceiling: role management, app credentials, consent grants, `Directory.AccessAsUser.All` and tenant policies need `AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true`                                                                                                                                                                               |
| Content gives the automation identity sensitive reads             | Mail, files, sites (full control of every site included), chats, calendars, call records, BitLocker keys, Windows LAPS passwords and similar need `AF_AUTOMATION_ALLOW_SENSITIVE_READS=true`, on top of the write opt-in for those that also change data                                                                                            |
| Content gives an app-only identity tier-0 permissions             | Role management, tenant policies, organization settings, authentication methods and group membership need `AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS=true` (and a named identity's own key); `Exchange.ManageAsApp` stays a write permission, since it reaches nothing until an Exchange role is assigned to the app and provisioning assigns none |
| Someone adds an owner, secret or assignment to an AdminForge app  | `provision status` fails on unexpected privilege                                                                                                                                                                                                                                                                                                    |
| An engineer grants themselves portal roles through AdminForge     | The executor refuses writes naming AdminForge's apps, the principals holding its app roles, `AF_PROTECTED_APP_IDS` and `AF_PROTECTED_USER_IDS`, by id                                                                                                                                                                                               |
| Unreviewed content is published                                   | `publish` runs `validate` and the playbook tests, and refuses uncommitted content or a commit not on origin's `main` as origin has it now (unreachable = unreviewed) unless `--allow-unreviewed` (audited)                                                                                                                                          |
| Validation user misused                                           | Disabled between live runs, least roles (Exchange / SharePoint admin roles only with `AF_TEST_SERVICE_ADMIN_ROLES=true`), test labels only; `provision status` flags any other role                                                                                                                                                                 |
| Provisioning pointed at someone's real account                    | Only an `af-…` account with the "AdminForge validation" marker (or "AF Tester" name) is managed; any other is refused before a password, role or exclusion changes                                                                                                                                                                                  |
| One person approves their own request with the approver fixture   | Accepted in test labels only (see Known gaps); refused where automation writes are allowed; enabled only on request (`--enable --approver`); Portal.Reader + Approver only                                                                                                                                                                          |
| An `optional` datasource hides a denial                           | Never for a missing role, the request policy, a licence, sign-in or arming anywhere in the chain; suppressed errors are recorded, and a scheduled report fails `report_incomplete`                                                                                                                                                                  |
| A compromised service rewrites the audit log                      | Not prevented (SQLite has no roles); detected by the hash chain against its checkpoints in the container log shipped off the cluster (`adminforge audit verify --checkpoint`); the api container holds the key                                                                                                                                      |
| Someone with a copy of the volume rewrites the audit log          | With `AUDIT_CHAIN_KEY` and `AUDIT_CHAIN_KEYED_SINCE` pinning the first cut-over, changing any event or removing the keyed part fails verification; without the pin the whole log can be stripped of its cut-over and re-hashed unkeyed; removing the newest events shows only against the shipped checkpoints                                       |
| Hostile tenant text takes a page down or a link leaves the portal | Linear text and Markdown reduction, range-checked character references, a per-block error boundary; one link rule (`safeUrl`) for every link and navigation from data                                                                                                                                                                               |
| An Operator reads what someone else's run found                   | Someone else's delegated run is metadata only (run page, stream, approvals inbox) unless you are its approver, the person a manual step waits for or a Portal Admin                                                                                                                                                                                 |
| A compromised dependency release reaches the cluster              | Seven-day floor in pnpm and Dependabot; frozen lockfile on every install; `pnpm audit` in CI; the runner's PowerShell checked against its release's SHA-256                                                                                                                                                                                         |
| Threat                                                            | Mitigation                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------       |
| Stolen session cookie                                             | `__Host-`/HttpOnly/Secure cookie; idle and absolute expiry; writes need step-up as the same user; roles re-checked; a new session id and CSRF token at every arm, so a cookie copied while read-only can't arm, start writes or confirm a manual step that writes follow, and the runs it started wait for a resume ahead of their next write       |
| Phishing via the portal's own URL                                 | Same-origin `returnTo` only; browser-bound sign-in round trips                                                                                                                                                                                                                                                                                      |
| Silent SSO used to arm without re-authentication                  | `prompt=login`, `max_age=0` and `auth_time` freshness always checked server-side (plus the auth context when set)                                                                                                                                                                                                                                   |
| Removed or disabled admin keeps acting                            | Roles re-read every 5 minutes, by the API and the run worker; session ends on `invalid_grant`, guest status, or 15 minutes without confirmation                                                                                                                                                                                                     |
| An approver approves their own elevation                          | Approval gates exclude the people a change grants access to (`own_access`); self-approval refused                                                                                                                                                                                                                                                   |
| A parked run continues on an older, weaker version                | Resume and the worker re-check roles and (before anything was changed) the current version; parked runs expire after 24 hours                                                                                                                                                                                                                       |
| A write acts on what changed while its run was paused             | A resumed run reads and runs its asserts again right before its next write; a write that may already have gone out ends `needs_review`                                                                                                                                                                                                              |
| Abuse in progress                                                 | Emergency stop: pause all changes or all automation from the portal, audited                                                                                                                                                                                                                                                                        |
| Changed playbook runs unattended under an old approval            | Approval fingerprint covers the playbook and its children; outdated approvals refuse and switch the schedule off                                                                                                                                                                                                                                    |
| Content grants the automation identity tenant-wide write          | Provisioning ceiling: write application permissions need an explicit opt-in                                                                                                                                                                                                                                                                         |
| Token sent to a third-party host                                  | Connection audiences allow-listed, scopes are names only, Microsoft audiences refused; redirects refused; `http` steps disabled                                                                                                                                                                                                                     |
| Content or a pinned script writes with a Reader's read tokens     | Runner read mode: static allow-list before the script runs; guards on every service write command; no module auto-loading                                                                                                                                                                                                                           |
| Another process answers on the runner's port                      | Tokens sealed per job; answers signed over a per-request nonce; redirects refused                                                                                                                                                                                                                                                                   |
| An old or retired content version is used to bypass a later rule  | Interactive calls and child playbooks use only the current version (409 otherwise)                                                                                                                                                                                                                                                                  |
| Someone else's input drives my write steps                        | Only the person a manual step waits for can supply its values; approvers need the playbook's roles                                                                                                                                                                                                                                                  |
| Report data emailed to an outside address                         | Recipients only from `AF_…RECIPIENTS/EMAIL/ALERTS` configuration keys                                                                                                                                                                                                                                                                               |
| An Operator schedules a report to collect app-permission data     | Accepted risk (Operators already get content schedules' files); reports Operators mustn't schedule or download set `requires.portalRoles` (e.g. `Portal.Admin`)                                                                                                                                                                                     |
| A portal schedule outlives its creator's access                   | Creator's account and roles confirmed before every run; loss turns it off (`creator_access_removed`); unreadable skips the run (`creator_unverified`)                                                                                                                                                                                               |
| A name typed in the portal phishes email or Teams recipients      | Single-line plain-text names without links or markup; Markdown escaped in Teams; "Scheduled in AdminForge by …"; approval channels excluded                                                                                                                                                                                                         |
| Readers seeing app-permission data                                | Report files and probe rows need Operator by default (service announcements on News and changes are the documented exception)                                                                                                                                                                                                                       |
| A news feed used to reach internal hosts or to inject markup      | Feed hosts are a code allow-list (https, public addresses pinned at connect, redirects only within it); no DTDs/entities; linear plain-text reduction; links on the source's own host                                                                                                                                                               |
| Another workload in the cluster reads secrets or the database     | Admin credentials never reach the cluster; runner gets only its key; non-root pod, RWOP volume, NetworkPolicy, no service-account token (see Deployment, storage and network)                                                                                                                                                                       |
| Developer server consumes production jobs                         | A developer's API uses its own database file; the production file is only on the pod's volume                                                                                                                                                                                                                                                       |
| Content gives the Write app tier-0 scopes                         | Provisioning ceiling: role management, app credentials, consent grants, `Directory.AccessAsUser.All` and tenant policies need `AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true`                                                                                                                                                                               |
| Content gives the automation identity sensitive reads             | Mail, files, sites, chats, calendars, BitLocker keys and similar need `AF_AUTOMATION_ALLOW_SENSITIVE_READS=true`                                                                                                                                                                                                                                    |
| Someone adds an owner, secret or assignment to an AdminForge app  | `provision status` fails on unexpected privilege                                                                                                                                                                                                                                                                                                    |
| An engineer grants themselves portal roles through AdminForge     | The executor refuses writes naming AdminForge's apps, the principals holding its app roles, `AF_PROTECTED_APP_IDS` and `AF_PROTECTED_USER_IDS`, by id                                                                                                                                                                                               |
| Unreviewed content is published                                   | `publish` runs `validate` and the playbook tests, and refuses uncommitted content or a commit that isn't one of `main`'s own commits on origin as origin has it now (unreachable = unreviewed; a commit of a merged branch, reachable but never `main` itself, too) unless `--allow-unreviewed` (audited)                                           |
| Validation user misused                                           | Disabled between live runs, least roles (Exchange / SharePoint admin roles only with `AF_TEST_SERVICE_ADMIN_ROLES=true`), test labels only; `provision status` flags any other role                                                                                                                                                                 |
| Provisioning pointed at someone's real account                    | Only an `af-…` account with the "AdminForge validation" marker (or "AF Tester" name) is managed; any other is refused before a password, role or exclusion changes                                                                                                                                                                                  |
| One person approves their own request with the approver fixture   | Accepted in test labels only (see Known gaps); refused where automation writes are allowed; enabled only on request (`--enable --approver`); Portal.Reader + Approver only                                                                                                                                                                          |
| An `optional` datasource hides a denial                           | Never for a missing role, the request policy, a licence, sign-in or arming anywhere in the chain; suppressed errors are recorded, and a scheduled report fails `report_incomplete`                                                                                                                                                                  |
| A compromised service rewrites the audit log                      | Not prevented (SQLite has no roles); detected by the hash chain against its checkpoints in the container log shipped off the cluster (`adminforge audit verify --checkpoint`); the api container holds the key                                                                                                                                      |
| Someone with a copy of the volume rewrites the audit log          | With `AUDIT_CHAIN_KEY` and `AUDIT_CHAIN_KEYED_SINCE` pinning the first cut-over, changing any event or removing the keyed part fails verification; without the pin the whole log can be stripped of its cut-over and re-hashed unkeyed; removing the newest events shows only against the shipped checkpoints                                       |
| Hostile tenant text takes a page down or a link leaves the portal | Linear text and Markdown reduction, range-checked character references, a per-block error boundary; one link rule (`safeUrl`) for every link and navigation from data                                                                                                                                                                               |
| An Operator reads what someone else's run found                   | Someone else's delegated run is metadata only (run page, stream, approvals inbox) unless you are its approver, the person a manual step waits for or a Portal Admin                                                                                                                                                                                 |
| A compromised dependency release reaches the cluster              | Seven-day floor in pnpm and Dependabot; frozen lockfile on every install; `pnpm audit` in CI; the runner's PowerShell checked against its release's SHA-256                                                                                                                                                                                         |

## Known gaps and accepted risks

Tracked in `docs/backlog.md`:

- **A second account of the same person isn't "yourself".** The self-benefit refusals compare with the account that is
  signed in. An engineer with a separate everyday and admin account (Microsoft's recommendation) can add the other one
  to a group, assign it an app, issue it a pass or dismiss its risk; onboarding (`identity.create-user`) hands the
  person running it the new account's first credential and can add it to ordinary groups, which makes a stand-in
  account. The writes still run with the engineer's own Microsoft roles; linking accounts (an `employeeId` or a
  configured attribute) is in `docs/backlog.md`.
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
- **Write-mode scripts can read the runner's shared key (accepted risk).** The supervisor and its `pwsh` workers run
  as one uid (10002), so a write-mode (FullLanguage) script can read `RUNNER_SHARED_KEY` from the supervisor's
  `/proc/<pid>/environ`. A uid split needs `CAP_SETUID`/`CAP_SETGID`, which the restricted Pod Security Standard and
  `capabilities: drop: [ALL]` forbid. Write scripts are SHA-256-pinned published content and run only for an armed
  engineer; read-mode scripts can't reach `/proc` (no `Get-Content`, file .NET types, `$env:` or provider variables).
- Read-mode PowerShell still runs in FullLanguage: the static policy is the boundary, not a sandbox. A
  ConstrainedLanguage runspace needs six read scripts rewritten. Its list of change methods is a deny-list: a change
  method of a client object it doesn't name (a collection's `Add()` looks like a .NET list's) would still queue a change
  for the next `Get-PnP*` call to send; a runtime check that the PnP connection holds no queued change is on the
  backlog. Runner answers are authenticated, not encrypted
  (loopback); `/healthz` and cancel answers aren't signed.
- A child playbook's own confirmation isn't asked when a parent starts it; `adminforge validate` refuses a parent (or
  a compensation) that starts a child asking for one unless the parent has a confirmation of its own. The parent's
  risk and kind of confirmation aren't yet required to match the child's: `identity.create-user` and
  `azure.new-subscription-onboarding` confirm with a click and start children that ask for a typed one.
- **Query Studio runs whatever KQL the service accepts.** There is no operator blocklist (`externaldata`, `evaluate`,
  `workspace()`, `cluster()`): a query runs with the engineer's own delegated read access, on the sources the
  installation offers (`AF_QUERY_SOURCES`), with a 5,000-row cap, and is audited (`query.executed`, with the query's
  hash and first 200 characters). It can do nothing the engineer couldn't do in the Azure portal with the same
  account.
- **The "created by AdminForge" mark on Exchange recipients is a guard rail, not a boundary.** The create playbooks
  set `CustomAttribute15` ("AdminForge-created by … on …") so a re-run can finish its own recipient and
  `m365.remove-created-recipient` refuses anything unmarked. Anyone who can edit custom attributes can set it — an
  Exchange administrator outside AdminForge, or on-premises `extensionAttribute15` for synced objects — and the
  object ids a run passes come from that same run's lookup, so they don't prove origin. A marked shared mailbox could
  be "finished" (people given access, sign-in changed) or removed. What holds: the engineer types the address to
  confirm, sees "on the existing mailbox" in the plan, can't grant themselves access, and Exchange's own roles decide
  what they may change; every change is audited. Checking the recipient against the object id recorded by
  AdminForge's own successful create run is the follow-up (`docs/backlog.md`).

- Around arming: a token refresh in flight during the id rotation can write the old partition back (unreachable;
  purged with orphaned partitions after a day, as at sign-out); a request authenticated just before can finish with
  the old record; a sign-out sent with the old cookie while the arm completes leaves the new session to idle expiry;
  a post-run token refresh is skipped if the session rotated mid-run (docs/backlog.md).
- **The database file is the boundary (ADR-016).** With Postgres the services' role could not drop the audit log's
  append-only triggers; with SQLite, anything that can write the file — the API process itself, or someone with the
  volume — can rewrite rows and drop triggers. Each verification writes the verified tail (`seq`, `hash`) to the API's
  log as an external checkpoint: ship the container logs off the cluster so the anchor doesn't share the database's
  fate, and compare with `adminforge audit verify --checkpoint`. Without `AUDIT_CHAIN_KEY` (optional until the owner
  sets it) a rewritten history can be re-hashed. With it and `AUDIT_CHAIN_KEYED_SINCE`, only the newest events can be
  removed unnoticed; unless the pin is set, the whole history can be rewritten (cut-over stripped, re-hashed unkeyed).
  The checkpoints in the shipped container log show either, so shipping the logs is required. Whatever runs in the api
  container holds the key, so a compromised service is not stopped by it. An earlier key lost after its rotation
  leaves its events unverifiable.
- Definitions loaded from the database are re-validated against their kind's schema and their row (kind, id,
  version, status); this catches rows that bypass `publish` (an import, a restored file), not a valid but weaker
  definition written by someone with the volume. `publish`'s review check is a process control, not a security
  boundary: in the pod `pods/exec` is the publish boundary and the Kubernetes audit log names the person, and
  BUILD.json is self-asserted by whoever builds the image (a hand-run `docker build` can claim `reviewed`) until CI
  builds the images. Two-person review needs branch protection and a second code owner on the repository.
- Approval gates exclude a group's members and a principal, not a service principal's owners.
- CSP allows inline **styles** (`style-src 'unsafe-inline'`) because Radix and Monaco inject them; scripts stay
  `'self'` only, so CSS injection can't execute code.
- The Read and Write apps authenticate with client secrets (certificates are supported for the automation identity
  only), and one key (`TOKEN_CACHE_KEY`) seals the token cache, including schedules' grant tokens. Blobs name their key
  (key id), so it can be rotated with `TOKEN_CACHE_PREVIOUS_KEYS` without signing everyone out.
- A compromised service can still record a forged approval decision (the database keeps decisions append-only and the
  audit log records each one, but neither knows who clicked); approval integrity rests on the API process.
- Not yet verified on a real cluster: that its CNI enforces the NetworkPolicies, Pod Security admission of the
  manifests, the storage class's behaviour (zonal disks), the Ingress's handling of Server-Sent Events, and
  `preflight.sh` itself (docs/backlog.md).
- **The runner is as current as its last build.** Its PowerShell, and the .NET runtime inside it, moves only by a
  reviewed bump of the version and hash in `portal/apps/runner/Dockerfile` (Dependabot doesn't see it, and nothing yet
  says a newer 7.6.x exists: `docs/backlog.md`), and its Ubuntu packages are those of the day it was built: rebuild and
  deploy it monthly and after a PowerShell or .NET security release (`docs/operations.md` → Upgrade).
- Egress is filtered by address, not by name: the pod may reach any public address on 443. Filtering by host name
  needs a firewall in front of the cluster.
