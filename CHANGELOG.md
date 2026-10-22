# Changelog

All notable changes to AdminForge are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Mail-enabled security groups need a second engineer (2026-10-22)

- **`m365.add-distribution-list-members` 1.3.0 asks for approval when the list is a mail-enabled security group**
  (owner decision after the 2026-10-22 security review): such a group grants access like any security group, so a
  Playbook Approver who isn't among the people being added approves, and the update then runs as them. A list
  Microsoft Entra ID can't name by its primary address (`/groups?$filter=mail eq …`), or names twice, is treated the same
  way and the messages say which; plain distribution lists stay one-step. Because the update then runs as the approver,
  the playbook now refuses your own addresses itself — primary, aliases and UPN (`/me`) — instead of leaving aliases to
  the script. The page's bulk action leaves out selections with a mail-enabled security group (an approval would hold
  the rest of the run): add to those one at a time. It needs `Group.Read.All` on the Write app (already granted).

### Borderline app-only permissions are tier 0 (2026-10-22)

- **Decided by the owner after the 2026-10-22 security review.** Application permissions that change what Conditional
  Access and sign-in decide on (`Device.ReadWrite.All`, `CustomSecAttributeAssignment.ReadWrite.All`,
  `IdentityRiskyUser.ReadWrite.All`), token-issuance hooks (`EventListener`, `CustomAuthenticationExtension`), app
  proxy publishing, multi-tenant organizations, SharePoint tenant settings, administrative units, the Intune cloud CA,
  `User.ManageIdentities.All`, PIM alerts and removals, and agent identities, blueprints and instances now need
  `AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS=true` for any app-only identity, and rank critical in
  `identity.app-permissions` and `identity.app-registration-risks` (2.2.0). No shipped content asks for them.
- **`UserAuthenticationMethod.ReadWrite.All` stays an ordinary delegated write scope** (decided): the Temporary Access
  Pass, password and MFA playbooks refuse yourself and Playbook Approvers, so they keep working on a default install.

### Read-mode scripts can't change SharePoint client objects (2026-10-22)

- **Property sets only on hashtables the script builds.** A `Get-PnP*` cmdlet returns SharePoint client objects; a
  property set or `.Update()` on one queues a change that the connection's next request sends — in read mode, under a
  Reader's token. The read-only policy now refuses a property or index set (`=`, `+=`, `++`, also in parentheses or
  a multiple assignment) on anything but a variable the script only ever assigns `@{…}` or `[ordered]@{…}` (never
  `$_`, a parameter, a `foreach` or `-PipelineVariable` variable), `set_*()` accessors, `.ForEach('Name', value)`,
  wildcard member names in `ForEach-Object` (which reached every denied method, `.ExecuteQuery()` included), and
  common change methods by name (`Update…`, `Delete…`, `Recycle`, `Restore…`, `Set…`, `CopyTo`, `Publish`, `Approve`,
  `Move…`, `Share…`, …). Every shipped read script passes unchanged. From the 2026-10-22 security review; the method
  list is a deny-list, and what the static policy still can't see is in `docs/backlog.md` (constrained runspace).

### Live sign-in without the web dev server (2026-10-22)

- **`verify-api-live.ts` and the other `forwardToApi` live scripts sign in again.** They rerouted the browser's
  `PUBLIC_BASE_URL` requests to the API inside Chrome, which left the sign-in binding cookie off Entra's redirect back,
  so every sign-in ended in `invalid_state`. The live harness now runs a small stand-in for the web dev server on
  `PUBLIC_BASE_URL` that forwards `/auth` and `/api` to the API, as Vite's proxy does.

### Permission reports: critical means tier 0 (2026-10-22)

- **`identity.app-permissions` 2.1.0 and `identity.app-registration-risks` 2.1.0 rank critical every application
  permission provisioning holds back as tier 0** for app-only identities — `Synchronization.ReadWrite.All`,
  `Directory.Write.Restricted`, `User-PasswordProfile.ReadWrite.All`, certificate and federation trust,
  `Application.ReadUpdate.All`, the Intune write permissions, and the role, policy, authentication-method,
  lifecycle-workflow, agent-blueprint and Teams-consent families whatever Microsoft names next. Several of them ranked
  low before (`Directory.Write.Restricted`, `Application.ReadUpdate.All`, `UserAuthMethod-*.Delete.*`, …), so the
  default "Critical and high" view, its figures and the weekly archive (`reports.app-permissions-weekly`, pinned to
  `tier: high`) left them out: from 2.1.0 the archive and figures gain those rows although nothing changed in the
  tenant.
- **`identity.consent-grants` 2.2.0 ranks every delegated tier-0 scope critical** — the PIM role and group schedules,
  `RoleManagementPolicy`, `Policy.ReadWrite.CrossTenantAccess`, `Domain`, `IdentityProvider` and
  `EntitlementManagement` writes and any `RoleManagement.ReadWrite.*` ranked only high.
- A new test runs the three reports' transforms on one synthetic grant per tier-0 name and checks the reports' copy of
  provisioning's families word for word; `tests/unit/cli/app-only-ceilings.test.ts` already covers the other
  direction.

### `provision status` flags directory roles on the AdminForge apps (2026-10-22)

- **A directory role on the Read, Write or automation app is unexpected privilege.** Provisioning assigns none, and an
  app's directory role works without any signed-in user — Exchange or SharePoint Administrator on the automation
  identity would reach far past its own permissions. `provision status` now lists active and PIM-eligible directory
  roles of every AdminForge app by role name and fails on them; where eligibility can't be read (no Microsoft Entra ID
  P2) it still checks the active ones and says so. From the 2026-10-22 security review.

### Provisioning ceilings for app-only identities (2026-10-22)

- **Tier-0 application permissions have a list of their own.** The automation identity and named schedule identities
  were held to the delegated tier-0 list, so `Organization.ReadWrite.All` (certificate-based authentication trust),
  `Policy.ReadWrite.SecurityDefaults`, `Directory.Write.Restricted`, password profiles, directory sync and owned-app
  credentials were granted with `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS` alone. They now need
  `AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS`, as do certificate and federation trust (`PublicKeyInfrastructure`,
  `MutualTlsOauthConfiguration`, `Domain-InternalFederation`), authentication contexts, every user's authentication
  methods (one method at a time too, `UserAuthMethod-*`), group membership (AdminForge's own role groups are ordinary
  groups), app and agent-blueprint credentials, Intune scripts, apps, configuration and roles, lifecycle workflows,
  partner admin relationships, Teams app consent and the whole role-management, PIM and `Policy.ReadWrite.*` families
  (`isPrivilegedAppRole`). The Write app's delegated list is unchanged.
- **Sensitive reads cover every verb.** `Sites.FullControl.All` and `Sites.Manage.All` (Graph and SharePoint),
  `full_access_as_app`, `Mail-Advanced`, mailbox exports and inbox rules, team, channel and chat membership, Windows
  LAPS passwords, call records, recordings and transcripts, joining calls, meeting AI notes, Copilot interactions,
  group and Viva Engage conversations, print jobs, user data exports and sticky notes need
  `AF_AUTOMATION_ALLOW_SENSITIVE_READS`; before, the write opt-in or no opt-in at all granted them.
  The weekly Anyone-link sites schedule (1.0.1) therefore needs both opt-ins for its `Sites.FullControl.All`. An
  identity that already holds a permission it would no longer be granted shows under unexpected privilege in
  `provision status` until the opt-in is set or `provision entra --prune` removes it.
- A test keeps provisioning in step with the application-permission report: no name it ranks critical is granted to
  an app-only identity on the write opt-in alone (`Exchange.ManageAsApp` excepted: it reaches nothing until an Exchange
  role is assigned to the app, and provisioning assigns none).

### Scheduled-run details for the roles that may see them (2026-10-22)

- **Schedule run history** (`GET /api/schedules/:key/runs`) gave every Portal.Reader a failed run's error message,
  hint and run id, though the run collected its data with application permissions and the run itself and its files
  are for the schedule's roles (default Portal.Operator) plus its report's or playbook's own. Others now see the
  status and the error code, with a message naming the roles that see more, and no link to a file they can't open.
  The scheduler's own messages (a missed or interrupted run, a timeout, why a run was skipped) stay for everyone.
- **`schedule.failed`**, sent to every signed-in browser whatever its roles, carried the error message (up to 500
  characters) and the schedule's title; it now carries the error code only. Nothing in the portal read either field.
- **The schedule editor's scaffold** copied the requirements of any report or playbook a Reader named, including ones
  whose `requires.portalRoles` they don't hold; it now refuses them (`forbidden`), as the definitions route does.

### Protected-object guard: keys and path spellings (2026-10-22)

- A declared Graph write addressing a group, app, service principal or directory object by anything but its id is
  refused (`object_not_by_id`): an alternate key (`groups(uniqueName='sg-adminforge-…')`, the key provisioning sets
  on AdminForge's own groups and apps), also after a type cast or in a segment of its own, a GUID without hyphens, or
  any other segment after the collection. The guard matches ids, so such a write could change AdminForge's own access
  unnoticed. `appId='{id}'` and `id='{id}'` keys still work. An id written without hyphens, which Graph accepts, is
  matched as that id in a request body. Every form was checked live (`docs/licensing/findings/2026-10-22-…`).
- While the protected set can't be read, a write to `/groups//{id}/members`, `/groups/{id}/microsoft.graph.group/
members` or `/groupſ/{id}/members` was not treated as the sensitive write it is: paths are now read segment by
  segment, decoded and folded as .NET does, and every write under `/directoryObjects` is sensitive.
- `$batch` spelled `/$Batch`, `/$batch/` or `/%24batch` was sent as one opaque write; those are now normalised,
  checked request by request and sent as `/$batch`, and anything else that starts like `$batch` (`/$batch;x`), or a
  batch inside a batch, is refused (`execution/batch.ts`, moved out of `outbound.ts`; `isBatchPath` in
  `@adminforge/schemas`, shared with the engine).

### Nobody benefits from their own change (2026-10-22)

- **Assigning an enterprise app** (`identity.assign-app-access` 1.2.0) refuses yourself and any group you belong to or
  own; before, an armed engineer could give themselves an app role with no second person.
- **Adding group members** (`identity.add-group-members` 1.3.0) checks that every id is a user: a group's id passed
  the self check and nested the whole group, you perhaps included.
- **Distribution lists** (`m365.add-distribution-list-members` 1.2.0, `Set-DistributionListMembers.ps1`) refuse
  adding yourself under your sign-in name or any of your Exchange addresses (looked up by object id), and a
  mail-enabled security group takes people, not other groups or lists. The script fails closed when it can't tell
  who is running it.
- **Credentials** (`identity.issue-tap`, `identity.reset-password`, `identity.reset-mfa` 1.1.0) are never issued or
  removed for the people who approve AdminForge changes (everyone holding Playbook Approver or Portal Admin on the
  Read app, through any group or directly, read from its role assignments), and a pass or an MFA reset is never for
  your own account. The central guard protects the role groups, not their members, so
  an Operator could otherwise make an approver's account a second approver of their own change.
- **Your own risk and mail:** `security.dismiss-risky-user` (1.3.0) refuses your own account, and `m365.set-inbox-rule`
  (1.1.0, `Set-InboxRuleState.ps1`) doesn't turn on a rule in someone else's mailbox that sends their mail to you
  (by address, alias or legacy DN, read from the recipient rather than the display name).

### Availability limits and probe targets (2026-10-22)

- **Sign-in starts have a fair share per address.** A few addresses, each within its rate limit, could fill the
  5,000 pending sign-ins within the two minutes each is protected and refuse everyone else's sign-in. When the table
  is full, the address holding the most pending sign-ins now gives up its oldest if it holds more than the starting
  address; otherwise the age rule decides as before. The address is recorded pseudonymously (a keyed hash; IPv4, or
  an IPv6 /64). Migration `0003_preauth_address_hash`.
- **PowerShell jobs per person** (`RUNNER_JOBS_PER_PERSON`, default 3): one person's pages, exports or playbook steps
  could hold every runner worker and fail everyone else's jobs after the queue timeout. Beyond three, a page read is
  refused (429 `runner_busy_for_you`) and a playbook step waits for one of that person's own. The runner's queue is
  bounded too (`RUNNER_MAX_WAITING`, default 4 × max jobs): past it a job is refused at once (503 `runner_busy`) instead
  of timing out.
- **Certificate and DNS probes** follow the HTTP probes' address rule: a certificate probe connects to this portal's
  host or a host that resolves only to public addresses, at the address it checked; a DNS probe asks the system
  resolver, a public one by IP, or one listed in `AF_PROBE_RESOLVERS`.
- **Synthetic transactions on a turned-off schedule:** a Run now queued while the schedule was on and claimed after it
  was switched off ran its transactions; the probe job now holds them back (`held`) and runs only the other probes.

### Publish review gate: main's own commits only (2026-10-22)

- **Publish's review gate** counted any commit reachable from origin's `main` as reviewed, so an intermediate commit of
  a branch merged with a merge commit passed. Only `main`'s own commits (its first-parent chain) count now, in
  `adminforge publish` and in `build-images.sh`.

### SharePoint sharing at scale (2026-10-22)

- **SharePoint sharing at tens of thousands of sites** (still live, with the engineer's own delegated sign-in; no
  file-level data). `Get-SiteSharing.ps1` sends a summary, then the sites in chunks of 2,000 (one output line held
  every site and broke the runner's 8 MB line limit around 23,000 sites), shaping each site itself. The SharePoint
  sharing page (1.3) caches that read apart from search and filters — before, every search or filter ran the script
  again — and searches title, URL and owner natively; the browser gets the first 10,000 matches and the export every
  one. Public and Anyone-link sites (1.4) reads up to 60,000 sites of the usage report instead of the first 1,500,
  filtered, summed and sorted natively, keeps only the fields it shows, falls back to the site id when names are
  concealed, and lists the 10,000 sites with the most links. Each transform takes about 80 ms at 50,000 sites, within
  the 250 ms budget (`content-at-scale-sharepoint-sharing.scale.test.ts`); the OneDrive-sized ceiling is in the backlog.
- A page fetched every datasource whose name appeared anywhere in a templated text, prose included: a note saying
  "10,000 sites are listed" made the browser download a datasource called `sites`. Only the `${ … }` parts count now
  (`templateExpressions` in the renderer; the perf harness uses the same).
- The "Open in SharePoint admin center" actions (SharePoint sharing and site pages) never appeared: they read
  `AF_SPO_TENANT_NAME` in the browser, which has no `env`. The pages now work the link out on the server.

### Dependencies (2026-10-22)

- **Node.js 26** (from 24): the app image's base and the runner image's build stage (`node:26.11.1-bookworm-slim`, by
  digest), CI's `setup-node`, `.nvmrc`, `engines` (`>=26`) and both bundles' build target. Node 25 and later no longer
  bundle Corepack: both images install `corepack@0.36.0` themselves, and engineers install the same version once
  (setup guide).
- **Every npm dependency at its latest release at least seven days old** (`minimumReleaseAge`): tsup 9 (from 8;
  esbuild 0.28 underneath: the bundles are unchanged but for esbuild's module helpers, and the low esbuild advisory
  through tsup is gone), React 19.3.1, Playwright 1.64.1, the TanStack Router plugin, and pnpm 11.28.5 (from
  11.10.0, with pnpm's own security fixes since). The `undici@8.12.1` release-age exclude is gone (it aged past seven
  days). Held back: TypeScript 7 in `tooling/lint` (typescript-eslint 8.72 supports TypeScript below 6.1) and pnpm 12
  (a native executable that Corepack can't install the way it installs pnpm 11: its own change).
- **The package manager is pinned by hash** (it sits above the lockfile, outside the release-age floor):
  `packageManager` carries pnpm's sha512, which Corepack checks; both images check Corepack's own tarball against
  a recorded sha512 and install it without scripts; the setup guide installs the same `corepack@0.36.0`
  (`tests/unit/tooling/package-manager-pin.test.ts`).
- **The runner on a maintained base**: its image starts from `ubuntu:24.04` (pinned by digest) with the Ubuntu updates
  of the build's day, and installs PowerShell 7.6.7 (the 7.6 LTS line; was 7.5.0) from Microsoft's release archive,
  checked against the release's SHA-256 before it is unpacked (`tests/guards/runner-powershell-download.test.ts`); its
  build stage moves to Node 26. MCR's `powershell:7.5-ubuntu-24.04`, last rebuilt on 2025-01-30, had missed about 21
  months of Ubuntu and .NET security fixes in the container that holds engineers' forwarded Exchange and SharePoint
  tokens. Dependabot proposes each new `ubuntu:24.04` digest; PowerShell is a reviewed bump
  (`portal/apps/runner/README.md` → Container image).

### Platform review (2026-10-21)

The SQLite-on-Kubernetes build was reviewed for security, functionality, design and organization
(`docs/plans/2026-10-21-platform-review-*.md`; ids in parentheses: S security, F functionality, D design, O
organization). There was no critical or high security finding; the fixes are below, and what remains is in
`docs/backlog.md`. Whole-branch security, design and content reviews of the fixes followed (no critical or high
security finding, no content blocker); their fixes are below too, with the reviews' own ids: M1, M2 and L1–L4 security,
H1, H2, M3–M9 and L10–L18 design, S1–S6 and N1–N8 content.

#### Added

- **Cluster preflight** (`portal/deploy/kubernetes/preflight.sh`): a read-only check of the cluster AdminForge goes
  to — Kubernetes 1.29 or later, the namespace's restricted Pod Security label, a storage class on block storage (not
  network or FUSE file systems; CSI, `fsGroup`, binding mode, expansion) with a ReadWriteOncePod dry run, an enforcing
  NetworkPolicy engine, the cluster DNS pods, cluster addresses in the ranges egress refuses, amd64 nodes with room,
  the IngressClass (a warning for the retired ingress-nginx) and the pull secret's type. It never reads a Secret's
  data. The Kubernetes README's **Requirements** say what the cluster must provide, measured, with a readiness
  checklist.
- **Content schema version** (D-07; `CONTENT_SCHEMA_VERSION` in `@adminforge/schemas`, now 2): `adminforge publish`
  stamps it on every definition row (migration `0002`, a plain `ADD COLUMN`; earlier rows are version 1), and
  `publish --dry-run` lists rows stamped with an older version and whether they still pass. Version 2 is the stricter
  `pattern:` rule and the `status`/`enum` column rule below; after upgrading, publish the content again.
  `build-images.sh --dry-run` prints the build record.
- **`adminforge list [--kind] [--section] [--status] [--search] [--json]`** (O-05): every content definition with its
  id, kind, section, status and file. The section is where it shows (`nav.section`, a report's `area`, a probe's
  `group`, a schedule's target); `--section` also matches the id prefix and tags, so `--section exchange` finds the
  Exchange pages, reports and playbooks kept under `m365/`. It reads the content directory only, never the admin env
  file. `portal/content/README.md` describes where content goes.
- **Preview** (F-11, F-19): `preview: true` marks a definition not yet confirmed to work against a live tenant. Its
  page shows a quiet "Preview" badge ("Not yet confirmed to work against a live tenant: what it shows may differ from
  what Microsoft returns"), and `adminforge validate` lists every preview; `m365.teams-user-policies` is the first.
- **`enum` table column kind** (D-16): a category shown as plain text with its label
  (`map: { AzureAd: Entra joined }`) and a facet filter, in tables and exports; `status` is for values that are fine
  or not. 43 category columns moved from neutral status pills to `enum`. `wrap: true` gives a text column two lines.
  **keyValue fields** take `enum` too (M4), with the table's map and lookup, so a list and its entity page say the same
  thing: nine fields moved from neutral pills (user type, group membership, session-host hosting, device ownership, CA
  grant operator, host-pool validation, mailbox litigation hold, auto-reply state and audience), and `validate` refuses
  a tone in an `enum` map and a bare label in a `status` map (`tests/content/key-value-status-tones.test.ts`). An
  entity header's `neutral` status is an outline badge.
- **`entity:` on pages** (D-08; `user|group|device|app|resource`): the command palette opens that kind of search
  result on the declaring page. `validate` allows one active page per kind, and that page needs an `id` param.
- **Write playbooks run end to end in mock mode** (F-02): with mock sign-in on fixtures, a write no fixture describes
  is accepted (nothing changes: there is no tenant), a read with no fixture fails with a message that names no file,
  and the API log names the fixture to add.
- **Every page renders from the fixtures** (F-03, O-16): `tests/content/fixtures-complete.test.ts` renders every
  active page, dashboard and report datasource from the fixtures, and every KQL probe from its `af:` variant (eight
  KQL probes gained one); an API test runs a write playbook through the real executor down to its compensation.

#### Changed

- **Restarts no longer cancel runs** (D-01): a stop (every deploy) lets each run finish the step it is on and stop at
  its next checkpoint; a step still in flight after 10 s is interrupted. The runs stay `running`, their jobs are
  queued again, and the next process resumes them where they stopped — an interrupted step is retried, or, if it is
  `idempotent: false`, the run ends `needs_review`. A resumed run passes the same version and role re-checks as a
  parked one, and reads and checks again before its next write (Security, below). A worker whose run lock lapsed stops
  at its next checkpoint once its lease renewal notices. A person's cancel still cancels. Writes whose second send
  would hurt say `idempotent: false`: `avd.log-off-user-session` and `avd.send-user-message` (the session number may
  belong to someone else by then), `endpoint.restart-device` and `endpoint.wipe-device`
  (`tests/content/non-idempotent-writes.test.ts`). `endpoint.restart-device` is 1.0.1; the other three are 1.0.2, their
  comments saying why they still aren't retried now that checks run again: whether the first send took effect is
  unknown.
- **At most 5 open runs per person** (F-08, `RUN_MAX_OPEN_PER_USER`): starting a run, preview or bulk run over the
  cap — or resuming a parked run of yours over it — answers 429 `too_many_runs`. Runs parked on an approval, input,
  write access or a sign-in, finished runs and scheduled runs don't count; a bulk run counts once.
  `RUN_WORKER_CONCURRENCY` now defaults to 8 (was 4).
- **Shutdown deadline** (D-24, `SHUTDOWN_TIMEOUT_SECONDS`, default 50): a stop that takes longer logs what is still
  open and exits 1, before the pod's 60 s grace ends; a second signal exits at once. At most 5 run streams
  (`GET /api/runs/:id/events`) per session (429 `too_many_streams`).
- **Retention within a budget** (D-02): each pass deletes 2,000 rows at a time, lets requests in between and stops
  after 2 s; the rest continues at the next 10-minute pass, and freed space goes back to the volume in steps. Report
  files and News and changes items are pruned within the same budget; report files continue where the last pass
  stopped, and symbolic links are never followed.
- **Audit chain check** (D-05): `probes.audit-chain` checks the events since the last verified checkpoint every hour,
  and walks the whole chain after a restart, once a day and after any break; a changed event, or one removed from
  the middle, stays reported on the checks after it.
- **Missed schedule times** (F-09): a time missed by more than an hour (the pod was down) is recorded as a skipped run
  (`schedule_missed`) that says when and why, and it is audited.
- **Run now on a switched-off schedule** (F-10) only writes the file: no email, Teams post or notification; the
  button, the toast and the history say so.
- **Heartbeats from progress** (D-09): the scheduler's heartbeat comes from its ticks and the run worker's from its
  queue polls, not from timers, so `/readyz` and `GET /api/schedules` (`scheduler`) show one that stopped working as
  `degraded`. A timed-out scheduled job keeps its slot until it ends (at most 2 minutes more), and a report job told
  to stop sends nothing (D-23).
- **Error messages in plain words** (F-13): validation names the field and what it must be ("format must be csv or
  xlsx") instead of zod's text; an oversized body is 413 `body_too_large` (was `ctp_body_too_large`), a non-JSON body
  415 `unsupported_media_type`, unreadable JSON `invalid_request`; common codes carry a hint when the thrower gave
  none; an unknown address no longer echoes its path.
- **Retired content says so** (F-05): a retired page, report or playbook answers 409 `definition_retired` with its
  retirement note, shown only to people who may open it, instead of 404; an unknown key's hint is worded for the
  person.
- **Navigation rail** (D-14, F-16, M5): section rows are full size with their hidden-page count. Each section with
  probes ends with its check status (Synthetic monitoring's status icon at 12 px — check, warning or cross — once one
  of its probes has a result, in place of the closed section's page count; its name and tooltip give the counts),
  linking to Synthetic monitoring for that section (`/monitoring?group=<key>`). The eight "Service checks" items are
  gone (navigation 1.5.0). Only Readers' rails ask for probe status. The "N new breaking" pill in the top bar uses the
  info tone, without a pulse or an outline, and its name starts with what it shows (D-13); the News page keeps its own
  tones.
- **Session rail on small screens** (H2): it fits every window from a 360 px phone up. Below `xl` the tenant moves into
  the account menu and the breaking pill and PIM show their short form; below `lg` the mode pill drops its icon, Arm
  write access reads "Arm" and the armed pill shows the time left (Extend stays in the command palette and the
  five-minute warning); below `sm` jump-to is a 32 px icon button. PIM's name starts with what it shows ("PIM
  (privileged roles): …").
- **Probe drawer** (D-17): "What to do" appears only for degraded or failing results; healthy probes keep their link
  under "What this checks". The history is under "Last 24 hours" and says why there is no chart. Tile messages wrap
  to two lines, and times are never cut. **Token probes** (1.0.4) say what the administrator checks and where renewal
  is described; the SharePoint token's summary no longer names configuration keys.
- **Charts** (D-12): whole-number data steps by whole numbers; value labels that would overlap are dropped, and a
  value axis with less than about 160 px shows none. Panel titles wrap to two lines and are whole on hover. The
  inactive guests domains chart is full width (2.0.1).
- **List pages put more rows above the fold** (D-11): actions on the title row, a one-line description with More, a
  KPI strip that folds to one line (remembered per page; its warnings stay visible) and a filter bar that stays at the
  top while the list scrolls. The inspector is 920 px wide and stays beside the list at 1440 and 1920 px (D-10).
- **KPI strips and failed figures** (M3, L11): every cell is as tall as its row (drill-down cells too), so the numbers
  line up; a cell that can't be shown keeps its place — its label, its reference and a Try again icon, then "—" in
  line with the other figures. On a phone the cells' narrower sides keep a status's words.
- **Lists at 1440 px** (L17): columns that need more room than the table has scroll sideways under the row-actions
  column, which stays at the right edge with a hairline, and the focus ring stays whole; headers wrap to two lines
  before they are cut off. The Users list hides Job title by default (the column chooser and exports still have it;
  `identity.users` 1.3.0). The Microsoft 365 overview names its chart series (Any service, Exchange, Teams, OneDrive,
  SharePoint) and drops a hint that was cut off beside its status (1.1.2).
- **List headers** (M8): Runs, Audit, Schedules and Reports use the list page header (actions on the title row, the
  description on one line with "More"). **Facts** (M7) put the label above the value on a phone; Settings' fresh
  sign-in step-up is a short pill with what to do under it. The key figures fold points right when closed and down
  when open, like the navigation (L15).
- **Content write actions show the lock** (D-18): buttons and "More actions" that run a write playbook show a lock and
  "Arm write access to run this; previewing it doesn't need it" while unarmed (without the Operator role: "Running
  this needs the Portal Operator role") and the ember dot once armed; they stay clickable, to preview. So do a table's
  row menu and bulk bar (H1), whose links are judged by their evaluated target with `safeUrl` (a templated Entra link
  says it opens a new tab; an unsafe one is a disabled item that says why); a bulk action over its row limit is inert
  and shows no ember dot.
- A block with a broken configuration, or one that fails while it renders, is "<name> couldn't be shown" — its title,
  a KPI's label, a timeline's heading; untitled, "This part of the page couldn't be shown" — never a widget type (L10),
  and keeps the details "For the content author"; the user page's copy is plain (D-19).
- **One wording for the same fact** (L18, N4): a person's sign-in is "Sign-in: Allowed / Blocked" (Blocked in crit) on
  the Users list, the user and group pages and the inactive-users, password-age and privileged-role-assignment
  reports, and a directory sync source is "Source: Cloud / Synced from AD" wherever it shows
  (`tests/content/account-sign-in-wording.test.ts`; the Microsoft 365 team, distribution-list and licence pages still
  say "Enabled / Disabled", `docs/backlog.md`). A group's header shows a status only when the group is
  role-assignable.
- **The provenance line never widens a phone page** (L13): it stays one line, cuts the path first, leaves out the
  request time below `sm`, and drops whole parts that don't fit.
- **One check for params and inputs** (D-06, D-15, D-21): page params, query-builder values and run inputs are
  checked by the same code in the browser and the API (`@adminforge/schemas`, which has a browser entry without
  `yaml`); page-param messages read after the label. Exports read `[n]` column paths and the table's labels and tags.
  KPI labels wrap to two lines; time cells never truncate; truncated table text shows in full on hover.
- **Folders follow ids** (O-05): `adminforge validate` (and so `publish`) refuses a definition outside the folder its
  id prefix names (`identity.users` belongs in `pages/identity/`) and names the right folder. `probes.*` and `feeds.*`
  sit directly in `probes/` and `feeds/`; three older folders are listed exceptions (flat section overview
  dashboards, `sweep.*` in `schedules/probes/`, `integrations.hr-sync`). Nothing moved.
  `adminforge new probe probes/<name>` writes `probes/<name>.probe.yaml`, not `probes/probes/`.
- **Kubernetes manifests:** amd64 nodes only (the runner's base image is amd64 only), a startup probe for the runner,
  requests from measurements (api 500m CPU and 1 GiB, runner 250m and 1 GiB), a 3 GiB memory limit for the runner
  and 4 GiB of `/tmp` for the api (room for the copy `db backup -` stages there). The Dockerfiles name their base
  images literally instead of through build arguments.
- **Tests pick their project by file name** (O-06, O-03): `*.scale.test.ts` (wall-clock budgets, one at a time) and
  `*.pwsh.test.ts` (real PowerShell, the new `pwsh` project: `pnpm --filter @adminforge/tests test:pwsh`); guards keep
  the names honest and keep runtime code to other packages' declared entry points.
- **Tooling** (O-11, O-13): `pnpm typecheck` no longer builds packages first (no `dist/` written). Commit scope `plan`
  is retired and `dev` is renamed `tooling`.
- **One GUID check, one byte format** (O-07): `isGuid` / `GUID_RE` / `GUID_PATTERN` from `@adminforge/schemas` (its
  browser entry too) replace 27 copies of the GUID regex in schemas, expressions, api, web and cli — the same answer
  everywhere (hyphenated 8-4-4-4-12, either case, no braces); `tests/guards/guid-literal.test.ts` keeps the pattern
  written out in the shared module only (connectors' Log Analytics check and the Microsoft app id families are listed
  exceptions). File sizes on the schedule and report pages use the widgets' `formatBytes`: from 10 MB without a
  decimal ("12 MB"), from 1 GB in GB. The scheduled jobs' and transaction probes' abortable waits are one
  `abortableDelay` in `@adminforge/connectors`.
- **File-size ratchet** (O-04): `tests/guards/file-size.test.ts` holds runtime files under `portal/` to 800 lines. The
  eleven already over it are listed at their size when the review ended (`engine.ts` at 2,401, 533 lines of it the
  resume re-check) and may only shrink; an entry is lowered when its file shrinks by more than 50 lines. Splitting
  them stays in the backlog.
- **Claude Code kit** (O-08): every skill follows one template (Overview, When not to use, Steps, Done when, Common
  mistakes, See also); new skills for coded screens, configuration keys, expression helpers, CLI commands and ADRs;
  `docs/content-recipes.md` holds the expression helpers, quoting rules, Microsoft quirks, fixtures and lifecycle the
  page skill used to carry; the design reviewer states the design direction itself;
  `tests/unit/docs/skills-shape.test.ts` keeps the kit's shape and every path it cites.
- **Documentation** (O-01, O-09, O-10, O-12): one index, `docs/README.md` (every document, what it owns, its
  audience, when to update it); CLAUDE.md states one rule for checkouts a running service serves; every plan opens
  with a status line and finished plans carry no agent directive; the glossary names each term's code identifier and
  UI label and makes British spelling the rule for new identifiers and UI text; ADR-001 to ADR-010 are back-filled
  with context, options and consequences; `tests/unit/docs/` checks every path, link and heading reference in
  CLAUDE.md, `.claude/`, the onboarding guides and the index, an index row per document, and a status line per plan.
  The operator and reference docs (`docs/operations.md`, the Kubernetes guide, `docs/api.md`,
  `docs/troubleshooting.md`, `docs/widgets.md`, `docs/architecture.md`, `docs/decisions.md`) describe the platform
  review as built: runs that resume after a restart and check again before writing, the keyed audit chain, audited
  backups, run visibility, a new session id at every arm, open-run and stream caps, missed and file-only schedule runs.
- **Registers** (O-02): `docs/backlog.md` is a register by area — nine tables of item · status · since · owner type ·
  link, one row per open item, no dated sections — and `docs/licensing-review.md` is the current feature → licence
  map (licence features, a table per area, previews), with each dated finding in
  `docs/licensing/findings/<date>-<topic>.md`; `tests/unit/docs/registers.test.ts` keeps both that way.
- **`adminforge validate` warns** about a `compensate` that can never run, because no step after it fails with
  `onError: compensate` (N5; 35 playbooks, `docs/backlog.md`).
- App Service security settings (`azure.app-service-security` 1.1.0) offers Restart, Start and Stop for web apps; their
  only entry points had been the retired Function App pages (N8).
- Retirements that name their replacement need no bring-back backlog row (N7, `docs/content-recipes.md`).

#### Fixed

- **`pnpm test` is green on any day and on a busy machine** (F-01): the m365 overview sort test counts from its pinned
  clock; unit, component and content allow 15 s per test; the importer test uses only `TEST_POSTGRES_URL` (never the
  env file's database), skips without it locally and fails in CI.
- **Mock mode never reaches the network** (F-20, F-04): HTTP, DNS and certificate probes answer from host, DNS and TLS
  fixtures (`tests/fixtures/{hosts,dns,tls}`), and Teams delivery — scheduled, the approvers' message of a run
  waiting for approval, and scheduler one-shots with a delivery override — posts through the fixtures. Before, every
  mock `pnpm dev` sent anonymous requests to Microsoft and public DNS every 15 minutes and Monitoring showed false
  crits.
- **Probes on fixtures say what they couldn't do:** a probe whose URL or DNS name uses only settings that aren't set
  says "not configured"; a missing or broken fixture is "could not evaluate", never a crit — for a Graph, ARM or KQL
  request `fixture_not_found`, with a message that never names the fixture file — and a probe expecting a 404 no
  longer passes on a missing fixture. Only fixtures mode reads a missing fixture that way.
- **Query Studio refuses Resource Graph queries Azure would refuse** (F-06) — more than three `join`/`union`, a second
  join to another table or a union across tables (unless all are `resources` ↔ `resourcecontainers`), a leading
  `union` — with the same rules `adminforge validate`
  applies, before anything is sent or audited (before, "Save as report" failed after the query seemed to work). The
  join lint runs in linear time (100,000 newlines or escaped quotes blocked the API for 5–10 s).
- `docs/api.md` lists every registered route (70) and the right sign-in limits; a test keeps the index honest in both
  sign-in modes (F-07).
- **Throttling** (D-03): when Microsoft throttles, waiting calls no longer all retry on the same second — Retry-After
  is spread ±20 % (still at most 120 s), ARM long-running-operation polls included. Scheduler one-shots (`--schedule`,
  `--probe`, `--once`) log a `microsoft call` line per call, like the API.
- An ARM long-running operation stops waiting between polls as soon as its run is cancelled, its pod stops or its
  schedule times out (D-23).
- A datasource expression that fails while a page loads says what went wrong in plain words; the expression's path
  and its JSONata code are in the details and the log under the reference, never JSONata's message or the data
  (D-19).
- Out-of-range relative dates or durations (`-999999999d`, `P300000Y`) are refused instead of causing a 500.
- `identity.create-user` 1.1.1 passes the new user's id through `$guid()` in its manager step and compensation.
- Wording: `billing.month-close` 1.0.1 says in words what to configure instead of naming configuration keys;
  `probes.m365-workload-incidents` 1.2.1 says it is retired and what replaced it. Field descriptions, summaries and
  one widget of ten more definitions, among them `identity.remove-group-owner` and `billing.chargeback-monthly`, say in
  words what to configure instead of naming `AF_*` keys or `pnpm adminforge provision entra` (S4, N6;
  `tests/content/inputs-no-setup-details.test.ts`). The token probes' remedies use straight apostrophes (1.0.5, N2).
- **Runbooks with a `confirm` block** (`identity.leaver`, `identity.compromised-account`,
  `azure.new-subscription-onboarding`) start from the runbook page: preview (the reads run, checklists are skipped,
  writes are planned), then confirm, like playbooks. The page used to start them without a preview, which the API
  refused (409 `preview_required`). A runbook still starts without write access — its write steps wait for it — but
  needs the Portal Operator role, and the start button says so.
- A run started before its session last armed write access says so on its page ("Paused: check this run is yours,
  then resume it", with when it started) and asks its person to check it is theirs, then resume it — or cancel it if
  they don't recognise it. It reads "Waiting to be resumed" on its run page, its runbook page, the Runs list and the
  run dock (M6; `GET /api/runs` gives `waitingReason: 'prearm'`), and the runbook page shows the run page's parked-run
  banner (arm, sign in, resume, needs review). A parked run no longer says it is running, and resuming refreshes the
  dock and the Runs list.
- `m365.licence` 2.1.1 declares the Entra ID P1 licence its holders list needs for the Last sign-in column: without P1
  the list says which licence it needs instead of failing (S2).
- `azure.resource` and `azure.role-assignments` quote ids, scopes and role names with `$kql()`; resource groups with
  non-ASCII letters were found by nothing (S3).
- The not-found page's button fits a phone (no Ctrl K hint there, L12); "Chain verified" has one check mark (L16);
  waiting text on runbooks and the run timeline carries the waiting glyph (L14); an expired preview says "Select Start
  runbook (or Run) to preview again and confirm" (M9); the Runs list's Duration is whole at 1440 px.

#### Removed

- The content "Probe dashboard" (`automation.monitoring`) is retired (1.3.0): Synthetic monitoring (`/monitoring`)
  shows every probe by service, with history and what to do. Its summary names the replacement (1.3.1, N1).
- The "Coming soon" placeholder and its page catalogue (D-08): an address without a page shows "There's no page at
  this address".
- Unused dependencies: `jose` from the runner, five workspace packages from the scheduler (S-39, D-21).

#### Security

- **Production fence** (S-01, D-04): with `AUTH_MODE=entra` the API refuses to start outside `NODE_ENV=production`
  when it listens beyond loopback (`API_HOST`) or `PUBLIC_BASE_URL` names a host other than localhost or a loopback
  address, so a portal others reach can't quietly lose HSTS, the `__Host-` cookie and the production checks. The app
  image and the base ConfigMap set production (`tests/guards/image-node-env.test.ts`); development against the tenant
  on this machine is unchanged.
- **Mock sign-in stays on this machine** (S-16, F-12): it also needs `PUBLIC_BASE_URL` on localhost, and it ends a
  session left without any AdminForge role (403 `no_portal_role`), as Entra sign-in does. Only under mock sign-in
  does the fixture fetch accept a write no fixture describes, and never a POST the request policy lists as a read;
  with Entra sign-in on fixtures an unfixtured write stays a 404.
- **Fixture data never reaches the PowerShell runner** (M2): with `DATA_MODE=fixtures` a playbook's PowerShell steps
  answer from the runner fixtures, as PowerShell datasources do, with either sign-in. With Entra sign-in and a runner
  configured they went to the runner with real Exchange tokens while every other step read fixtures. Write scripts
  still pass the emergency stop and the protected-object guard; one no fixture describes is accepted only with mock
  sign-in.
- **Scheduler one-shots follow the emergency stop** (L1): a synthetic transaction a `--probe` / `--once` one-shot ran
  that acted is audited as a write (`probe.run`); none runs while automation is paused, and a `--schedule` run is
  recorded as skipped then. `--schedule` refuses a turned-off schedule that runs synthetic transactions, as Run now
  does (`schedule_disabled`). Without the database (`--no-store`) a one-shot refuses every write its probes would send
  and `--schedule` runs only on fixture data (`database_required`): it can read neither switch nor keep an audit
  record.
- **A new session id at every arm** (S-08): turning on write access gives the session a new id and CSRF token and
  moves its unfinished runs, approval decisions, pending sign-in round trips and Microsoft token partitions (sealed
  again) with it in one transaction; held show-once secrets follow once it commits, and the Write app's tokens go
  straight to the new id. The old id stops working at once; its open streams end and the browser reconnects with the
  new cookie. Runs bound to the session while it was read-only keep reading but wait for a resume before they write.
  Extending and disarming keep the id.
- **A run that paused reads and checks again before its next write:** after an approval, input, write access, a
  sign-in, a `wait` or a restart, the reads, transforms and asserts it ran since its last write run again right before
  that write — as who ran them, their reads going out with the access of the person the write runs as. The write's own
  `when` and the approvals' `excludes` are worked out again (every approver of a gate is checked; one they now name
  stops the run, `approval_excludes_approver`). A check that fails now stops the write (by default `failed`, with the
  assert's message and a hint that the run had paused); a write that may already have gone out ends `needs_review`
  instead. Before, `avd.log-off-user-session` checked that the session belonged to the expected person, waited for
  write access, and up to 24 hours later signed out whoever held that session number by then.
- **A change whose outcome is unknown is never sent again** (L2): an `idempotent: false` step's request (any method but
  GET, HEAD and OPTIONS) is not resent by the HTTP client after a server error (a 503 with Retry-After included), a
  network failure or a timeout — only a 429 is waited out — and validate refuses `retry` on such a step. A sign-in
  (claims) challenge after Microsoft accepted a change — on an Azure long-running operation's poll, or a `$batch`
  chunk after one was processed — fails the step (`accepted_unconfirmed`) instead of sending the change again.
  Before, `avd.log-off-user-session`'s DELETE was resent after a 500, or after such a challenge on its poll.
- **Confirming a manual step with write steps after it needs write access**, as approving such a gate does (403
  `not_armed`, "Arm write access, then confirm."): the steps after it run as the person who confirms. The step card
  says so up front and keeps **Mark done** locked until write access is armed. Declining needs nothing, and a step
  with no writes after it confirms read-only.
- **An approval can't be stepped over:** `validate` refuses `onError: continue` on an approval, and a rejected,
  expired or unworkable approval always stops the run.
- **A step that starts a writing child playbook is a write** (M1): validate refuses a `type: playbook` step whose child
  writes unless it says `mode: write`, and any step with a `compensate` block unless it says `mode: write`; in a write
  playbook the engine also counts such steps as writes when it places the implicit approval gate and decides whether
  whoever approves or confirms a manual step must be armed. Before, a critical playbook whose only step started a
  writing child without `mode: write` got no approval gate. Every shipped playbook already declared it.
- **Someone else's run shows what ran, not what it found** (S-25): a delegated run's inputs, outputs, step requests
  and outputs, plan, logs, error messages, task messages and comments are shown only to its initiator (of that run or
  one above it), its approvers (while a gate they may decide is pending and not expired, or once they decided), the
  person a manual step waits for, and Portal Admins. Other Operators and Approvers who may open it see the playbook,
  who, when, status, step names and states, and references (`run.access: metadata`). The run stream does the same and
  drops logs; the approvals inbox shows gates decided by others, and gates on runs the approver can't open (except a
  gate they are asked to decide), as metadata. The run and runbook pages say who can see the inputs and results ("Only
  … can see the inputs and results"). Scheduled runs are unchanged.
- **A connection's read operation may POST only with `readPost: true`** (S-23): validate refuses a `mode: read` POST
  without it, and the request policy refuses one at run time; `readPost` comes from the published connection only.
  Read operations can no longer use PUT, PATCH or DELETE unarmed.
- **Content can't set the headers AdminForge owns** (S-02): `Authorization`, `Cookie`, `Proxy-Authorization`,
  `Host`, `client-request-id`, `x-ms-client-request-id` and the method-override headers (`X-HTTP-Method-Override`,
  `X-HTTP-Method`, `X-Method-Override`), in any case. Validate refuses them in datasource requests and in Graph,
  `$batch`, ARM, function and `http` steps; the executor refuses them at run time (`invalid_request`), `$batch`
  sub-requests included; and the HTTP client drops them before adding the bearer token and the correlation id.
- **Graph writes name users by object id** (S-15): a declared write that names a user by sign-in name or address —
  in the path (`/users/{upn}`, `users('{upn}')`), in an `@odata.id` / `…@odata.bind` reference or in a `$id` query
  — is refused (`user_not_by_id`): the protected-object guard matches ids, so a UPN could otherwise reach a
  break-glass account. `adminforge validate` requires `$guid()` on the `/users/` segment of every Graph write (write
  steps, changing batch requests, compensations).
- **Delegated permission grants are protected objects:** a write to `/oauth2PermissionGrants/{id}` (any path
  spelling, `$batch` included) reads the grant's client and is refused (`protected_object`) when it is one of
  AdminForge's own apps or one in `AF_PROTECTED_APP_IDS`. A grant key that isn't a plain id, a grant that can't be
  read, or a grant write while the protected set can't be read is refused (`protected_objects_unavailable`).
- **Typed confirmations:** high- and critical-risk playbooks and runbooks, and every playbook offered as a bulk action
  from risk medium up, confirm by typing — in bulk, the number of items; low-risk bulk actions may click
  (`tests/content/high-risk-typed-confirm.test.ts`). `identity.revoke-consent-grant` 1.2.0 asks for the app's name (it
  was one click), `azure.remove-role-assignment` 1.1.0 for the role's name — its plan and summary name the role and
  who loses it — and `identity.add-app-owner` 1.3.0 for the app's name; the runbooks `identity.leaver` and
  `identity.compromised-account` for the user's sign-in name (S5); and eleven medium-risk bulk actions that confirmed
  with a click (S6), among them `endpoint.restart-device`, which restarted up to 100 devices on one click. The API
  renders the message and the text to type from the preview (`run.confirm` on `GET /api/runs/:id`, only
  for the person who previewed), so the dialog and the risk banner no longer show `${ … }`. The browser and the API
  compare the typed text one way (Unicode NFKC, invisible characters, spacing and case ignored), and the dialog marks
  and lists characters that can make a name pass for another (invisible characters, unusual spaces, styled letters,
  letters of a look-alike alphabet). `identity.remove-group-owner` 1.2.1 names an app owner in its confirmation.
- **A name anyone can choose can't block its own change** (L4, S1): typed confirmations of names anyone can choose
  (apps, groups, custom roles, devices) fall back to the object id when the name has nothing visible to type or holds
  `[redacted]`, and the message shows what to type. Before, an app's publisher could make revoking its consent or
  disabling it impossible to confirm. Affected: `identity.revoke-consent-grant`, `identity.add-app-owner`,
  `identity.disable-enterprise-app`, `azure.remove-role-assignment` (the assignment's GUID, which its message didn't
  show), `identity.remove-expired-app-credentials`, `identity.remove-group-members`, `endpoint.restart-device`
  (`tests/content/typed-confirm-fallback.test.ts`); the playbooks that don't fall back yet are in `docs/backlog.md`.
- **The injection lint follows user data through wrappers, functions and variables** (S-03, S-13).
  `adminforge validate` / `publish` and the content health check used to recognise `params.q` only on its own:
  `$lowercase(params.q)`, `$string`, `$join([…])`, a block variable, `$map`, `$trim(params.id)` in a path and anything
  in `$expand` all passed. A taint analysis now follows params, inputs, rows, items, `forEach` items, a transform's
  `value`, datasource results (`ds.<name>`, per field; a Microsoft response is tenant data), step outputs and
  `advanced` on `dialect: rows` pages — through functions, functions kept as values, lambdas, `~>`, variables, the
  context JSONata hands a built-in, and object/array constructors. An encoder counts only in its own kind of text and
  position: `$odata` and `$kql` outside a quoted literal, `$odataSearch` inside its `"…"`, `$encode` in paths, `$guid`
  anywhere; a value taken apart again (`$substring`, `$replace`) is user data again. Also linted: `$expand`;
  `filter`/`orderby`/`expand` without the `$`; bodies written as one `${ { … } }`; a `$batch` url's query string (only
  `$guid`, numbers and literal allowlists). A whole path/url may come straight only from a guid or entity param; a
  whole KQL query from a param needs `/* adminforge: user-query */`. Enum params count as allowlists. `$x := …` is
  allowed only as a block statement, the whole expression or a function body. All shipped definitions stay clean.
- **Entity params are the ids they name** (L3): `user`, `group`, `device`, `app`, `resource` and `subscription` page
  params take a GUID (also a UPN for a user, a whole `/subscriptions/…` id with no empty or dot segment for a
  resource), as playbook inputs do, in the API and the browser alike; validation lets a whole request path come from
  one.
- **Size caps** (S-34): `&` is size-checked like `$join`, and the encoders (`$encodeUrl`, `$encodeUrlComponent`,
  `$base64encode`, `$encode`, `$odata`, `$odataSearch`, `$kql`) refuse an input whose result could pass 10 million
  characters, like the other string built-ins. `$__af…` names are refused as `@`/`#` bindings too.
- **Regular expressions are checked for unbounded backtracking** (S-14): content `pattern:`s are refused at validate
  time when they can backtrack without bound, always match the whole value (`u` flag) and never see values over 4,096
  characters. Every regular expression in an expression (`$match`, `$contains`, `$replace`, `$split`, anywhere) gets
  the same shape check, with its `i` flag — but it runs unanchored on values of any length, so the check is not a
  proof there. Run inputs refuse control characters like page params. `m365.add-distribution-list-members`,
  `m365.remove-distribution-list-members` and `m365.create-distribution-list` (1.0.1) check typed addresses in
  linear time; a local part over 64 characters or an empty domain label is now refused.
- **Hostile tenant text can't take a page down** (S-05, S-21, S-32): a numeric character reference that names no
  character (`&#1114112;`, surrogates) stays as written instead of blanking the whole `/p/<key>` page; HTML in values,
  the Markdown widget's inline syntax and the links in runbook sections, manual-step instructions and approval
  messages are read in linear time (64,000 `<` or `[` used to freeze the page for seconds; a label now ends at the
  next `[` or `]` and a target at `(`, `)` or whitespace — percent-encode parentheses in a target); every widget
  renders inside its own error boundary — a block that still can't render names itself and says it couldn't be
  shown, with a reference and Try again, and the rest of the page keeps working.
- **One rule for links from data** (S-11): a templated target becomes a link only for `https://`, `http://`,
  `mailto:`, an in-app `/…` path (never `//host` or `/\host`) or `#anchor`; anything else stays text. `AppLink` and
  the list, KPI, status-grid, key-value, table, action and Markdown widgets render through `safeUrl`, and navigation
  from data — the web app's and the widgets' `followHref`, table row actions — goes through `followSafeUrl`
  (`@adminforge/ui`), next to it. Content action buttons and "More actions" say why an unsafe address is shown as
  text.
- **Query Studio history** leaves the browser on any 401 (an expired session, a tab left open), not only at sign-out
  (S-32).
- **HTTP probes pin their connection** to the address the SSRF guard checked (the news feeds' dispatcher), closing
  the DNS-rebinding window; the portal's own origin is not pinned (S-24).
- A notify step's Teams chat target is bound as a quoted OData literal, so an apostrophe can't close it early (S-31).
  The tenant name read at sign-in goes through the outbound executor (request policy, concurrency, `microsoft call`
  line, correlation id) and still never holds sign-in up (S-26).
- **Published definitions are re-validated when loaded** (S-07): against their schema, and they must match their row
  (kind, id, version, status); a row that fails is refused (`definition_unavailable`, logged, reported by the content
  health check) and never runs. `definitions.changed` no longer names the changed keys (`{all: true}`, S-27).
- **Publish review is checked against origin's `main` as it is now** (S-06): `git ls-remote` (`build-images.sh`
  fetches `refs/heads/main`), ignoring tags, replace refs and grafts. It fails closed, and BUILD.json and the
  `content.published` event record `mainCommit` and `remote` (no credentials).
- An approver refused for a change that grants them access (`own_access`), or someone completing another engineer's
  step (`not_your_step`), now leaves `request.denied` (S-12).
- **Pending sign-ins are capped at 5,000** (S-28): when full, the oldest one that has had two minutes makes room;
  starts are refused (503 `signin_busy`, nothing written) only beyond about 2,500 a minute; arming and schedule
  consent are never refused.
- **Content reads only declared settings** (S-29): expressions see the `AF_*` keys `config/example.env` declares,
  minus secret-looking names — an allow-list, where before it was a denylist over the whole environment. Run
  approvals' notifications likewise read only the delivery keys (sender, recipient lists, webhooks), as schedules'
  delivery does.
- **Env files must be private** (S-19): the API, the scheduler's one-shots and every CLI command but `env check`
  refuse an env file with any group or world permission, naming the file and `chmod 600` (never its contents);
  `/dev/null` and the pod's environment-only configuration are unaffected.
- The CLI reads `<env>.admin.env` only for `provision …`, `validate --scopes` and `env check` (key states only)
  (S-18): content commands, `audit verify` and `db` no longer hold the provisioner's credentials.
- `provision test-identities` re-reads the registration campaign after each write and stops with what differs
  (S-22).
- **Keyed audit chain** (S-10, optional until set): `AUDIT_CHAIN_KEY` (32 random bytes, base64, in the installation's
  Secret — never on the volume) makes the audit log an HMAC-SHA256 chain from a cut-over event the API appends at its
  next start (`audit.chain_keyed`, logged with its seq, hash and previous hash); earlier events keep their SHA-256
  links and the cut-over seals them. With `AUDIT_CHAIN_KEYED_SINCE` pinning the first cut-over, whoever holds only the
  volume can no longer change an event and re-hash the rest; without the pin they can still strip the cut-over and
  re-hash the whole log unkeyed, which only the shipped checkpoints show. Rotation: a new key with the old one in
  `AUDIT_CHAIN_PREVIOUS_KEYS`; a lost key is declared by id (`AUDIT_CHAIN_LOST_KEY_IDS`). Without a key nothing
  changes, and `/readyz` (`checks.auditChain`), Admin → Settings and `adminforge env check` say the chain is unkeyed;
  once keyed, the API doesn't start without the key, and `publish`, `db backup` and `db sign-out-everyone` refuse
  before changing anything. A malformed key, one equal to `TOKEN_CACHE_KEY`, or the other three settings without a key
  are refused at start.
- `adminforge audit verify --checkpoint <seq>:<hash>` checks a checkpoint from the shipped api container log (a
  rewritten, re-hashed unkeyed chain passes the walk but not this). Every verification handles both parts of the
  chain; events keyed with a key that isn't configured are reported as "can't be verified" (`audit_chain_key_missing`;
  the Audit page says "Can't verify from #N"), not as broken. Copies from `db backup` of a keyed log verify only with
  the key, which is never in the copy.
- **`adminforge db backup` is audited** (S-41): a `database.backup` event (account and machine, stdout or file,
  plaintext, bytes, the copy's audit tail) is written before the copy leaves — no event, no copy; a file copy takes
  its name only then; failed copies are recorded too. It now needs write access to the database.
- A schedule that names an app identity (ADR-014) ran its runs as the automation identity on SQLite: the run
  repository didn't store `identity_name`. Fixed. Runs created before the fix that are still queued, parked or
  waiting keep the automation identity: cancel them and run the schedule again.
- **Dependencies wait seven days** (S-04): `minimumReleaseAge` (strict, no missing publish times) in
  `pnpm-workspace.yaml` and a Dependabot `cooldown` on npm, GitHub Actions and both images' base images; an urgent
  fix excludes one exact version, with a comment saying why. dompurify 3.4.17 under monaco-editor clears two low
  advisories (S-30).
- Read-only runner scripts can't redirect output to a file (`>`, `>>`, `2>`, `*>`, also `> $null`); `2>&1` stays
  allowed (S-35).
- `.gitignore` keeps env files and their backups, key material (`*.key`, `*.pem`, `*.pfx`, `*.p12`, `*.jks`, SSH
  keys) and SQLite files out of git (S-20, `tests/guards/gitignore-secrets.test.ts`).
- **Egress to public addresses only** (S-40): the pod's 443 egress refuses every private and reserved range, an
  installation's exceptions live in a policy of the overlay's own
  (`tests/guards/networkpolicy-private-egress.test.ts`), and the loader pod gets no network at all.
- **Images pinned by digest** (S-37): both images' bases and the Dockerfile frontend name `image:tag@sha256:…`
  (`tests/guards/image-digests.test.ts`).

### Before the platform review

Closes the gaps found by comparing the build with the original plan (see the plan's "Revision 3" block and
`docs/decisions.md` → Plan review).

#### Added

- **Kubernetes deployment** (ADR-017, `portal/deploy/kubernetes`): the app image (API, web, `adminforge` CLI,
  content; non-root, read-only root file system), the runner as the pod's sidecar on loopback, kustomize base (one
  replica, `Recreate`, a ReadWriteOncePod PVC, NetworkPolicy without the metadata service, no service-account token)
  and an example overlay (Ingress with unbuffered Server-Sent Events, storage class, TRUST_PROXY), a loader pod for
  putting a database file on the volume, and `build-images.sh`, which records in the image whether its content was
  reviewed (`adminforge publish` in the pod reads that instead of git).
- `adminforge db backup <-|file --plaintext>`: a consistent copy of the database without sessions, sign-ins or
  tokens, checked (integrity, audit chain), mode 600 from its first byte; `-` streams it to stdout for encryption off
  the cluster, and a plaintext file needs `--plaintext`.
- `adminforge db import-postgres`: the one-time move from a Postgres release — every table but sessions, from one
  snapshot, into a new SQLite file; the audit chain is re-verified and its tail must equal Postgres'.
- `adminforge env check` names configuration keys of the Postgres releases that nothing reads any more.
- `adminforge db sign-out-everyone --yes [--schedule-grants]`: the emergency step that ends every session at once
  (sessions, pending sign-ins and their tokens; audited) while the portal keeps running — it replaces truncating the
  Postgres tables by hand.

- **Azure Virtual Desktop**, a parent section of its own: Overview, Host pools (capacity: hosts taking new sessions,
  slots in use, autoscale, Start VM on Connect), Session hosts (health, drain mode, agent and OS; Resource Graph, paged
  — thousands of hosts), User sessions (per pool or host, by UPN) and Connections (Log Analytics: success rate,
  failures, errors, round-trip time, one person's connections), with host pool and session host inspectors read live
  from Azure. Reports (area `avd`): session host health, host pool capacity, session hosts in drain mode, connection
  errors. Five checks (`group: avd`, with remedy and link): hosts that can't take connections, pools with no capacity
  or nearly full (every 15 minutes), hosts that need assistance and connection failures (hourly). Playbooks: drain
  mode on/off (one host or a selection), send a message, sign a user out — both session actions first check the
  session still belongs to the person the list showed, and sign-out asks for their sign-in name (in bulk, the count).
  New key `AF_AVD_LOG_ANALYTICS_WORKSPACE_ID` (falls back to `AF_LOG_ANALYTICS_WORKSPACE_ID`).
- **Hybrid Azure Arc servers at fleet size:** an Arc fleet dashboard (connection and time offline, OS, agent versions,
  regions, subscriptions, resource groups, failed extensions, patching, Defender coverage, ESU), and Arc extensions,
  Arc patching (Azure Update Manager: assessed and not-assessed servers) and Arc Defender coverage pages. Every list is
  filtered and paged in Resource Graph and every number counted there, so thousands of servers cost the same as ten.
  The server page gains Updates and Defender tabs. Four new configuration checks (failed extensions, critical or
  security updates overdue for 30 days, not assessed for 3 days, agents 6+ releases behind), each with a remedy and a
  link.
- **Resource Graph join limits in validate:** a query with more than three `join`/`union` operations, more than one
  join to another table (unless all are `resources` ↔ `resourcecontainers`) or a union across other tables is refused
  before Azure refuses it (`resourceGraphJoinProblem`, Resource Graph datasources and KQL probes).
- **A probe's result says what failed, why, and what to do.** Its detail on Synthetic monitoring shows **What it
  found** (the rows behind the result, e.g. which SAML apps' certificates expire and when; Operators only, since the
  automation identity collected them), **What to do** (new probe field `remedy`) with a button to the AdminForge page
  or Microsoft admin centre where it's fixed (new `link`, `/p/` targets validated), and **What this checks**. Sign-in
  checks name the most common error code and reason in their message. A dashboard's `probeStatus` row opens to the
  remedy and a link to the full result. Every active probe has a remedy (`tests/content/probe-remedies.test.ts`);
  `GET /api/probes` returns `summary`, `remedy` and `link`.
- **Synthetic monitoring of Microsoft 365, by service.** `/monitoring` groups probes by the service they watch
  (new probe `group:` — a navigation section key or `platform`; `GET /api/probes` returns `group` and `groups`), with
  a **By service / By check** switch and `?group=<key>` for one service; Exchange Online, SharePoint Online and Teams
  each get a "Service checks" item, and `probeStatus` widgets take `group:`. Every probe now names its group. New
  checks:
  - **Synthetic transactions** (ADR-015, `sweep.synthetic-transactions` every 15 minutes): **mail flow** from
    `AF_MAIL_SENDER` to a test mailbox (delivery seconds, Junk Email, cleanup), a **SharePoint file round trip**
    (upload, download from SharePoint, compare, delete) and a **Teams meeting** created and deleted for a test user.
    New built-in check kinds `mailFlow`, `fileRoundTrip`, `onlineMeeting`; their test objects come only from
    configuration (`AF_SYNTHETIC_MAILBOX`, `AF_SYNTHETIC_SITE_ID`, `AF_SYNTHETIC_USER_ID`), every change is a
    declared write (emergency stop, protected objects), and they report "not configured" until set up
    (docs/operations.md › Synthetic transactions).
  - **Read-only service checks:** Exchange Autodiscover, the Outlook (MAPI) and Outlook on the web front doors, the
    SharePoint front door, the Teams web app, the Microsoft 365 web portal, Entra realm discovery for the primary
    domain, open incidents per workload (Exchange, SharePoint, OneDrive, Teams, Entra, Intune), services in "service
    interruption", sign-in failure rates per workload (`signInHealth` gains `resourceId`), Intune through Graph and a
    test team's channels (`AF_SYNTHETIC_TEAM_ID`). `probes.m365-workload-incidents` is retired: one incident check per
    workload and `probes.m365-suite-incidents` say which service and which incident.
  - Hardening from review: transaction targets must be `AF_SYNTHETIC_*` keys (the sender may also be
    `AF_MAIL_SENDER`), checked again at run time; mailboxes are resolved to object ids so the protected-object guard
    applies; runs in which a transaction acted are audited as writes with their outcome codes; Run now is refused
    while the sweep is off; only stale test messages are swept, never a running check's; a probe job whose probes are
    all "not configured" succeeds with a note; HTTP probes name an unset setting in their URL instead of showing the
    expression error; `probeStatus` says "No results yet" instead of "All passing" before anything ran.
  - Provisioning grants `Sites.Selected` (and the `…SelectedOperations.Selected` permissions) without
    `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS`: they reach nothing until a site is granted; `Presence.Read.All` is now a
    sensitive read. Every section with probes has a "Service checks" item (Azure: "Configuration checks"); token
    probes are listed under AdminForge. `adminforge new probe` fills
    in `group`. The rail highlights one item when two link to the same page with different queries.
  - `adminforge validate` refuses content that names a setting content can never read (names that look like secrets:
    …_KEY, …TOKEN, …SECRET); the cost tag setting is `AF_COST_TAG_NAME`.
- **Azure Billing** — a new parent in the navigation for the people who manage Azure spend. Every view covers all
  subscriptions under a management group by default (`AF_COST_MANAGEMENT_GROUP_ID`, else the tenant root group), one
  picked subscription, or the billing account (`AF_BILLING_ACCOUNT_ID`); Cost Management answers are cached for an
  hour.
  - **Billing overview** (`billing.overview`): month to date, last month, Cost Management's forecast to month end
    (straight-line fallback), change against last month, daily actual vs forecast, top services and subscriptions,
    and cost per subscription with links. **Invoices** (`billing.invoices`): billing accounts and their invoices.
  - Reports (area `billing`, CSV/XLSX, schedulable; "Billing reports" in the rail): **cost analysis** (any period incl.
    custom; group by subscription, resource group, service, service family, meter category, region, resource type,
    resource, charge type, pricing model, publisher or a tag, with a second dimension; actual or amortized; total,
    daily or monthly), **monthly trend** (6 or 12 months), **chargeback by tag** (`AF_COST_TAG_NAME`, untagged share
    called out), **top resources**; **Azure cost this month and last** now spans every subscription and is active;
    **budgets** move to the billing area.
  - Finance schedules mailed to `AF_FINANCE_RECIPIENTS`: weekly cost by subscription, month close on the 4th, monthly
    chargeback — shipped off until the automation identity holds Cost Management Reader on the cost scope.
  - Exports and finance files carry every row Cost Management returned (pages list the 500 highest); totals, charts
    and counts add every row; the overview reads this month and last month in one query and projects to the last day
    with data. New native expression helpers `$tableRows` (columnar answers as objects) and `$withShare`.
    Invoices count every spelling of overdue, skip credit notes for "latest", and don't call the invoices API for
    Enterprise Agreement enrollments. The read policy also allows the Cost Management query/forecast at billing-account and billing-profile
    scope (invoice download and everything else under `Microsoft.Billing` stays refused).
- **Exchange Online, SharePoint Online and Teams are parents of their own** in the navigation. Mailboxes, shared
  mailboxes, distribution lists and mail forwarding move to Exchange Online; sites and sharing to SharePoint Online;
  teams and Teams user policies to Teams; Microsoft 365 keeps service health, Message center, licences, usage and
  groups. Page keys are unchanged, so links, schedules and inspectors keep working. Each workload has an **Overview**
  dashboard (`exchange.overview`, `sharepoint.overview`, `teams.overview`): its service health and open issues,
  storage or activity numbers, its synthetic checks and links to its pages and reports. In the Reports catalogue,
  Exchange, SharePoint/OneDrive and Teams reports appear under their workload (new optional `area:` on reports; keys
  unchanged).
- **Who a schedule runs as** (ADR-014): `identity: automation | { app: <name> } | { user: creator }`. Named app
  identities (`AF_SCHEDULE_IDENTITIES`, `AF_IDENTITY_<NAME>_CLIENT_ID` / `_CERT_PATH` / `_CLIENT_SECRET`) are
  provisioned, checked and pruned by `provision entra` / `status` with exactly the permissions of their schedules, and
  `validate --scopes` compares them one by one. Portal report schedules can run with their creator's own read access
  (one sign-in through the Read app, `POST /auth/schedule-consent`; "Needs sign-in" with **Sign in again** when
  Microsoft asks). Runs and audit events record "executed as …" (migration 0012: `schedule_grants`,
  `runs.identity_name`); the UI has a **Run as** field in the report schedule form and the schedule editor and a
  **Runs as** column; `GET /api/schedules/identities`.
  Hardening from review: a creator schedule's files open only for the creator (or a Portal Admin, audited); lost access
  removes the grant and turns the schedule off on either check; the sign-in requires a fresh `auth_time` (Read app
  claim) and lands in a temporary partition first; per-identity opt-ins `AF_IDENTITY_<NAME>_ALLOW_*` and
  `AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS` for tier-0 application permissions; retired identities stay protected
  and fail `provision status`; approvals and audit events name the identity.
- **Enterprise-scale performance tests** (`tests/perf/`, `pnpm test:perf`, `docs/performance.md`): a deterministic
  synthetic tenant (100k users, 50k groups incl. a 100k-member one, 30k managed devices, 20k apps, 1M sign-ins a day
  computed on demand), a fake Microsoft Graph that pages, caps, counts, searches and throttles like Graph and refuses
  what it doesn't model, every page/dashboard/report datasource run through the real engine against it with budgets
  (requests, bytes, transform time, heap, estimated live time, truncation) that fail when something gets slower or new
  content doesn't meet the default, and a load test (`tests/perf/load.ts`) with up to thousands of signed-in sessions.
  First results: 39 of 326 datasources fail at 100k users (transforms out of budget after fetching whole collections),
  and one API process with 16 Graph slots serves ~25–30 page loads a second before people get `outbound_busy`.
- **Engineer report library** (plan 2026-10-17, phase E): SAML signing certificate expiry (with a daily schedule and
  two probes: 30 days warn, 7 days or expired critical), subscription renewals and lapses (probe: grace period,
  suspended, trials ending), Intune connector and token health (Apple push certificate, ADE and VPP tokens, Managed
  Google Play, Autopilot sync — "Not configured" when unused; ADE and VPP probes), licence assignment errors (per group,
  the failed members with the reason, licensed users without a usage location), user attribute completeness (with an
  optional manager check), group lifecycle (expiring Microsoft 365 groups, single-owner, paused dynamic and restorable
  deleted groups), unused applications, authentication method strength, BitLocker recovery key escrow and Windows LAPS
  coverage (metadata only), and Conditional Access report-only impact (every sign-in through Log Analytics, a sample of
  the newest 300 from Graph otherwise; the Log Analytics path is optional and falls back to the sample). Weekly
  stale-devices and daily non-compliant-devices schedules, shipped off until those reports meet their perf budget; one
  licence-seat
  probe over every SKU the tenant has (replaces the fixed E3/E5 probes, retired); the duplicate identity licence
  utilisation report is retired in favour of Licence utilization and Licence assignment errors. Every list is filtered
  by Graph and capped where its transform fits the 250 ms budget (measured; scale tests in
  `tests/content/engineer-report-library.test.ts`).
- **Enterprise test fixtures** (plan 2026-10-17, phase F; opt-in in `AF_TEST_FIXTURES`, each its own module):
  `directory` (AF-Test-User-04…12 with departments, job titles, employee ids, four usage locations and one unset, a
  manager chain with a disabled manager, a disabled user licensed directly, one with no attributes, one whose password
  never expires; dynamic, nested, Microsoft 365 with and without an owner, empty and group-licensing groups; the
  administrative unit AF-Test-AU-01), `guest` (never redeemed, no email sent), `apps` (expiring, long-lived and many
  credentials kept true over time, a risky and an ownerless app, a SAML app with a signing certificate expiring within
  a month — never granted anything; secrets dropped at once, certificates throwaway), `auth-methods` (a fictitious SMS
  number, a Temporary Access Pass never shown), `intune-more` (iOS, Android and an unassigned macOS compliance policy,
  an update ring, app protection) and `sign-ins` (two accounts that only sign in, for the new
  `tests/live/scripts/generate-sign-ins.ts`: a success with MFA, a wrong password, a disabled account). Everything is
  marked, refused when someone else's, removed by `--remove-fixtures`; each operation fails on its own; licences only
  with free seats; `--disable` disables the sign-in accounts too. Graph's 409 "concurrent requests" is retried. `provision status` fails on anything a sign-in account holds, warns while one is enabled, fails on any service
  principal, grant or assignment on a fixture app (the risky app is ownerless), and shows fixtures no longer opted in
  as left over (`--remove-fixtures` removes them anyway, and exits 1 when something couldn't be read); the assigned
  Intune policies are refused while AF-Test-Group-01 has other members; a guest or SAML app that can't be marked is
  deleted again.
- **Schedule times in plain English** (plan 2026-10-17, phase D): one describer and a small closed grammar
  (`@adminforge/schemas` cadence.ts) shared by the API, the web app and content. Content schedules may say `every:
"first Monday of the month at 08:30"` instead of `cron:` (validation compiles it and names any word it doesn't
  understand; the zone stays in `timezone`). The schedule editor and the report schedule form gain every few hours,
  several days of the week, the Nth or last weekday of the month, the last day of the month and a "Type it in English"
  box that echoes what it understood (and takes a zone typed at the end); a searchable field offers every IANA time
  zone with its offset, defaulting to the browser's. Their next runs come from `POST /api/schedules/preview`, which
  now takes `cron` or `every` and answers with the cron, a sentence naming the zone and `tooFrequent`; the schedule
  editor's YAML says `every:` when given English. The report schedule form refuses anything more often than once an
  hour on the cadence field, before saving; a problem shows once, on the field, and screen readers hear what a
  sentence was understood as when typing pauses.
- **`provision entra --prune`:** removes application permissions on AdminForge's three apps that provisioning no longer
  grants (retired content, a dropped baseline permission, a ceiling turned back off, or added by hand) — only roles on
  the resources provisioning knows; review with `--dry-run --prune` first. Without it the plan counts them in one ⚠ line
  and `provision status` points at the flag; delegated consent was already converged both ways.
- **`AF_QUERY_SOURCES`:** an installation can switch off Query Studio sources (`resourceGraph`, `logAnalytics`,
  `advancedHunting`; empty = all). The API refuses a switched-off source before any call to Microsoft (403
  `source_off`), `/api/me` lists the enabled ones, Query Studio hides the rest (an old link opens the first enabled
  source and says why), and `adminforge env check` flags unknown names.
- **`ca-audit` test fixture:** 14 example Conditional Access policies (`AF-Audit: …`) modelled on Microsoft's baseline
  and templates, only ever report-only: creates are checked, updates never send a state and are read back, only
  report-only policies are updated, and ownership is re-checked before every write. Device and location examples on
  AF-Test-Group-01 only (refused if the group has other members or is dynamic); break-glass accounts
  (`AF_PROTECTED_USER_IDS`) and the Directory Synchronization Accounts role excluded; the policies that block all
  users also exclude the Global Administrator role. Needs `Application.Read.All` on the provisioner for app
  conditions.
- **Licensed test fixtures** for `adminforge provision test-identities` (opt-in from the admin file;
  `docs/plans/2026-10-16-m365-e5-unlock-and-tooling.md` Phase 1): `AF_TEST_LICENCE_SKU` licenses the validation user
  and AF-Test-User-01…03; `AF_TEST_FIXTURES` adds PIM eligibility (never active), the named location
  `AF-Test-Location` (192.0.2.0/24, not trusted), AF-Test Intune policies assigned to AF-Test-Group-01 only, and the
  approver account "AF Tester 2" (Portal.Reader + Playbook.Approver, its own marker) for two-account approval tests.
  Only objects provisioning created are changed; `--remove-fixtures` undoes them in any label; `provision status`
  lists them ✓/✗ with the seats used. A fixture Graph refuses prints `✗` with the Microsoft Graph application
  permission the provisioner needs, and the other fixtures still apply. Safeguards from the security review: the
  approver is enabled only with `--enable --approver` (`--disable` always disables both, each attempted), refused
  where `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true` or when its UPN is the validation user's, flagged when left over,
  and taken out of the registration campaign's exclusions before it is deleted; `provision status` warns while the
  provisioner still holds fixture permissions (they outlive its directory role), flags strangers in AF-Test-Group-01,
  and checks PIM-eligible roles of both validation accounts.
- **Engineer onboarding guide** (`docs/onboarding/`): a reading path for new contributors — setup, how AdminForge
  works, repository map, security for contributors, coding standards, API and web guides, content, testing, git and
  pull requests, documentation, Claude Code, releases — plus checklists (first day/week, PR author, reviewer, security
  review, definition of done), a glossary and templates (ADR, commit message). `CONTRIBUTING.md` points to it.
- **Commit message and pull request title check**: Conventional Commits with AdminForge's types and scopes
  (`tooling/git/commit-message.mjs`), enforced by a new `.githooks/commit-msg` hook and a `pr-title` workflow that
  re-runs when a pull request is retitled (the title is passed through the environment, never interpolated into the
  script). Merge, revert and autosquash commits pass locally; GitHub's `Revert "…"` titles pass when the reverted header
  is valid. Dependabot titles use `chore(deps)`, `ci(deps)` and `chore(runner)` prefixes. New
  `.github/pull_request_template.md`; CODEOWNERS now lists every path the onboarding guide sends to security review
  (scheduler, connectors, engine, expressions, probes, feeds, the news host list, hooks and tooling).
- **Reports catalogue and in-app report schedules** (user decision 2026-10-16, `docs/decisions.md` D9 note): the
  Reports section of the navigation is now one "All reports" entry (`/reports`) instead of every report — navigation
  sections can say `listDefinitions: false`. `GET /api/reports` lists the reports the caller may open with their area,
  tags, requirements, licence badge, params, export formats and the schedules that run them; `GET /api/reports/:key`
  adds the export columns. Operators can schedule a report right there (`POST /api/schedules`, edit with `PUT`, delete
  with `DELETE`, delivery choices from `GET /api/schedules/delivery-options`): report jobs only, at most hourly
  (`cron_too_frequent`), params validated as the automation identity, email/Teams only to configured recipient lists
  and webhooks, 25 per person and 200 in total, audited `schedule.created` / `schedule.updated` / `schedule.deleted`.
  They run at once (no git review), live in the database under the reserved `portal.` key namespace (content
  schedules may not use it) and are edited or deleted by their creator or a `Portal.Admin`; any Operator can turn one
  off. Schedule items gain `createdBy`, `canManage`, `job.params`, `delivery` and `notify` (key names only), and
  `GET /api/schedules/:key` returns one. The schedule editor and in-app creation share one document builder.
  Hardened after the security review: before every run the creator's account and portal roles are confirmed as the
  automation identity (`creator_access_removed` turns the schedule off; `creator_unverified` skips the run); only the
  params the form offers can be set (pickers, dates, hidden params and the query builder keep the report's default);
  names and summaries are plain single-line text, Teams cards escape Markdown and messages say "Scheduled in
  AdminForge by …"; approval keys are never destinations; `redact: true` params are masked in schedule items and JSON
  files (now streamed), and a schedule's details are shown only to people who may open its report; 50 creations per
  person in 24 hours, caps counted atomically; Run now on a portal schedule waits 15 minutes (`run_too_soon`);
  housekeeping removes deleted portal schedules once their history is gone. The read policy allows
  `checkMemberObjects`; provisioning lists User.Read.All and GroupMember.Read.All as built-in automation uses.
- **News and changes** (`/news`, `docs/news.md`): what Microsoft is changing in the services AdminForge manages, in a
  breaking-news layout — a Breaking strip (open incidents, urgent advisories, deadlines in the next 14 days), a
  day-by-day feed filtered by area, kind, source, tag and text, an unread badge in the navigation and a "breaking" pill
  in the top bar. Every item is cited and links back to its first-party source; only a headline, a short excerpt and
  a few facts are kept. 21 feeds (`portal/content/feeds`, new content kind `feed`): your tenant's Message Center and
  Microsoft 365 service health (Graph, automation identity), Azure Service Health (Resource Graph), Azure Updates, the
  Microsoft 365 Roadmap, the MSRC Security Update Guide, the Microsoft Graph changelog, seven product blogs on
  Microsoft Tech Community, five Learn what's-new pages and PowerShell Gallery releases of the modules the runner
  pins. Broad feeds keep only services AdminForge manages (`keep: matched` classification rules). Collected by the
  new hourly schedule `maintenance.news-refresh-hourly` (`job.kind: news`, each feed at most every `pollMinutes`).
  `adminforge new feed`, `validate` (allow-listed hosts, Microsoft citation domains, required permissions, news job
  references) and the `add-news-feed` skill. Security: feed connections are pinned to checked public addresses (no DNS
  rebinding), source text is reduced by a linear scanner (no regex backtracking on hostile markup), citation links
  must stay on the source's own host, future dates are clamped, a feed's portal roles apply when items are read, and
  the slowest-to-succeed feed is collected first within the schedule's time budget.
- HTTP probes and news feeds: documentation, translated, NAT64 local-use, Teredo, site-local and other reserved
  IPv4/IPv6 ranges now count as non-public addresses.
- **Report library** (~40 new reports, each with a delivery schedule): identity (application permissions, consent
  grants, apps and groups without owners, app credential hygiene, app registration risks, licensed disabled accounts,
  password age, high-impact directory changes, AdminForge role-group changes, tenant settings baseline); Microsoft 365,
  endpoint and security (inactive licensed users, mailbox, Teams, SharePoint and OneDrive usage, service health
  review, message center actions, device security and compliance gaps, Autopilot, Defender alerts, Secure Score,
  risky users); Azure (orphaned resources, budgets, monthly cost, storage, database and Key Vault security, VMs without
  backup, Defender plan coverage, privileged, orphaned and custom-role RBAC, Advisor, policy compliance, Arc agent
  health, App Service security). Every query was checked against a live tenant.
- **Count probes** (`kind: graphCount`): alert when a Graph list holds too many or too few items — Global
  Administrators (more than four, fewer than two users), changes to AdminForge's role groups, plus five Azure
  configuration checks and two Microsoft 365 / Defender probes.
- **Production-build smoke test** in CI (`pnpm test:e2e:prod`).
- **Delivery:** scheduled reports by email (Graph `sendMail` as the automation identity, from `AF_MAIL_SENDER`) and to
  Teams (Workflows webhooks on Microsoft hosts only); schedule failure/success alerts; approver notifications for run
  approvals and schedule enable requests. Recipients and webhooks are configuration keys, never content.
- **Schedule editor** (`/schedules/new`): build a schedule with a live cron preview (next five runs) and get its YAML
  to commit — schedules stay in git.
- **PIM indicator** in the session rail: active and eligible directory roles, with "Activate" opening
  `identity.pim-activate`; activation refreshes the person's tokens so new rights apply without signing out.
- **Live updates:** publishing content, arming and signing out elsewhere refresh open pages (server-sent events).
- **Organization defaults:** a default theme alongside default density and text size (Appearance).
- **Operations:** retention for runs, schedule runs, probe results and report files (`RETENTION_*`); worker and
  scheduler heartbeats in `/readyz`; `adminforge audit verify` and an hourly `probes.audit-chain` check; content
  publishes are audited; one structured log line per Microsoft call; history indexes (migration 0005); nightly
  database backups with a restore drill (`adminforge-backup.timer`).
- **Entra content:** assign/remove directory roles, add/remove PIM eligibility, assign/remove app access, revoke a
  consent grant, create Microsoft 365/security/dynamic groups (`identity.create-group` 2.0.0) and edit dynamic rules;
  new-subscription onboarding runbook; advanced filters on groups, enterprise apps, app registrations, sign-ins and
  audit logs.
- **Microsoft 365 content:** mailbox page with Full Access / Send As / Send on Behalf; grant/remove mailbox
  permissions, clear forwarding, automatic replies, address-list visibility; inbox-rule audit report; Teams policies
  per user; OneDrive access for a manager; Defender device vulnerabilities (advanced hunting); advanced filters on
  mailboxes and Intune devices.
- **Platform:** `selection: single` for tables; a `rows` advanced-filter dialect (`$applyAdvanced`) for runner and
  static lists; playbook `refreshTokens`; playbook tests may set `now` and `env`; Graph beta sources are badged
  "preview API".
- **Repository:** API reference (`docs/api.md`), Dependabot, CODEOWNERS, `pnpm audit` and an initial-bundle budget
  (`pnpm check:bundle`, 250 KB gzip) in CI.

- Navigation sections (Identity, Microsoft 365, Azure, …) open and close from their headings; the choice is saved per
  person, and a closed section still shows the page you're on.
- **Live validation tooling:** `provision test-identities` excludes the validation user — and nobody else — from
  Entra's authentication-methods registration campaign (the Microsoft-managed "Sign in faster with your face,
  fingerprint, or PIN" nudge stopped its unattended sign-in); the rest of the campaign is sent back unchanged, and
  `provision status` checks the exclusion ✓/✗. A live sign-in that lands on the nudge anyway fails at once and names
  the fix. `run-playbook.ts` placeholders now cover mailboxes, distribution lists, teams and sites (`@mailbox:`,
  `@dl:`, `@team:`, `@site:`, `…#field`; `tests/live/lib/placeholders.ts`, `check-placeholders.ts`).
  `tests/live/scripts/run-schedule-once.ts` runs a schedule or probes once as the automation identity against the dev
  database (never the host overlay) with email and Teams delivery suppressed, or email sent only to `AF_MAIL_SENDER`
  itself; `check-mail-sender.ts` checks report email through the notifier (the sender mails itself; sending as another
  mailbox must be refused). `docs/operations.md`: Exchange RBAC for Applications needs
  `Enable-OrganizationCustomization` first, and it can take hours to apply.
- **Create Exchange recipients:** `m365.create-shared-mailbox` (high risk: people get Full Access and optionally Send
  As — never the engineer, only user mailboxes in the organization; sign-in to its account blocked unless allowed —
  1.1.0 changes sign-in through Microsoft Graph, because Exchange accepted `Set-Mailbox -AccountDisabled $false` live
  without enabling the account; allowing it needs User Administrator),
  `m365.create-room-mailbox` (capacity, auto-accept, overlaps, booking window, longest booking) and
  `m365.create-distribution-list` (owners required — user mailboxes; members; internal senders only by default; the
  engineer, who needs a mailbox, is a temporary owner and steps down once everything worked). Each checks the accepted
  domain and that the address and alias are free first (`exchange/Get-RecipientAvailability.ps1`; a failed lookup
  never counts as free), plans one write in a dry run, needs the address typed to confirm, passes people as Entra
  object ids the script checks before anything changes, and marks what it creates straight away. A second run for the
  same address says it changes the existing recipient and finishes it. `m365.remove-created-recipient` removes only
  recipients carrying that mark (a guard rail against mistakes, not a permission — SECURITY.md → Known gaps), and
  lists only for their owners. Offered on the Mailboxes, Shared mailboxes and Distribution lists pages; removal only on
  marked recipients (`Get-MailboxConfiguration` and `Get-DistributionLists` now return `createdByAdminForge`). Pester
  (`RecipientProvisioning.Tests.ps1`), content tests (`exchange-recipient-provisioning.test.ts`) and mock-mode
  fixtures.

#### Changed

- **One SQLite file on a persistent volume holds all state** (ADR-016; supersedes ADR-004): better-sqlite3 with
  synchronous `BEGIN IMMEDIATE` write transactions, a new migration baseline with the append-only triggers, and SQLite
  replacements for what Postgres provided — the `run_jobs` queue (pg-boss), `leases` (advisory locks; a run's lock now
  tells its holder when it lapses), `signals` (LISTEN/NOTIFY across processes). Configuration: `DATABASE_PATH` and
  `DATABASE_BUSY_TIMEOUT_MS` replace `DATABASE_URL`, the pool and timeout keys, `DATABASE_MIGRATION_URL`,
  `POSTGRES_PASSWORD` and the owner files. The API migrates the database at startup; production refuses a database
  file others can read or write, or one on NFS, SMB/Azure Files or FUSE.
- **The API is the run worker and the scheduler** — one process owns the database. The worker service and the
  scheduler service are gone (and `RUN_WORKER_IN_PROCESS` / `SCHEDULER_IN_PROCESS` with them); the scheduler app runs
  one-shots only. Show-once secrets never leave the API process.
- Development needs no Docker database: `init:local` writes `DATABASE_PATH=~/.local/share/adminforge/dev.db`, and
  every database-backed test suite runs on a temporary file (none skips).
- Probe remedies follow the move to Kubernetes: `probes.portal-readiness` 1.0.4 tells a degraded portal (runs or
  schedules not processed) from one that can't be reached, and points at the api container's log, the database volume
  and the Ingress; `probes.portal-tls-certificate` 1.0.4 at the Ingress's certificate; eleven reachability checks
  (Graph, ARM, Intune, Entra, Exchange, SharePoint, Teams, the Microsoft 365 portal) at the cluster's outbound network
  instead of "this host".

- **Docs and skills for extending consistently:** CLAUDE.md non-negotiables 12–14 (no eval in the browser; checks
  explain themselves; Resource Graph limits, live checks, retire don't delete) and the deploy runbook (a build in the
  services' checkout is served at once); `docs/extending.md` covers new parent sections and retiring content; the
  onboarding guides cover the security policy, scale and production-build tests, committing per feature and bigger
  Claude Code sessions with parallel agents; the skills (pages, probes, playbooks, widgets, API routes, tenant
  validation) and the content, security and design reviewers check the new rules; SECURITY.md, widgets, architecture
  and decisions are current.
- `azure.arc-servers` 2.0.0 pages in Resource Graph with no transform and new filters (not connected, agent, failed
  extensions, ESU, query builder); `azure.arc-disconnected` 1.1.0 counts in Resource Graph;
  `probes.arc-machines-disconnected` 1.1.0 gives Disconnected servers an hour's grace, shows hours offline and days to
  expiry and is critical at 25 servers; `azure.overview` 1.1.0 counts Arc servers instead of Function Apps. A failed
  Arc extension means the same everywhere (provisioning failed or it reports an error), including
  `azure.arc-agent-health` 1.1.0. Free text reaches the Arc and AVD queries only as `$kql()` literals.
- KQL probes that watch service health may run on the 15-minute or hourly sweeps, and a Log Analytics probe may name
  its workspace as an env key with a fallback.
- A bulk run's `run.created` audit event records the inputs every item shares (`inputsTemplate`, redacted), so the
  reason for a bulk change is kept.
- **Shared mailbox sign-in state comes from Microsoft Entra ID:** the Shared mailboxes page (1.4) and the Shared
  mailboxes with sign-in allowed report (1.1) read each mailbox's account `accountEnabled` from Graph
  (`/directoryObjects/getByIds`, 1,000 accounts a call — five calls for the page's 5,000 mailboxes, ten for the
  report's 10,000; each skipped when its slice is empty) instead of Exchange's `AccountDisabled`, which still said
  blocked more than 20 minutes after Entra enabled an account (live, 2026-10-17). A mailbox whose account Entra didn't
  return, or couldn't be read, keeps Exchange's state and says so (hidden column "Sign-in state from", a note with the
  count). Both now declare Graph `User.Read.All` (the weekly schedule too — the automation identity holds it). Content
  tests (`shared-mailbox-sign-in-state.test.ts`, `content-at-scale-shared-mailboxes.test.ts`) and the live accuracy
  check cover it.
- **More reports fit an enterprise tenant:** the endpoint device reports (OS versions, security gaps, non-compliant,
  stale, Autopilot), the Intune apps page, inactive guests, directory changes, message center actions, the risky-users
  review and app credential expiry filter, sort and group natively instead of mapping every row with JSONata and say
  "Partial data" when a read or a list stopped at its cap. Device security gaps, non-compliant and stale devices and
  app registration risks export every row while the page shows a capped list; where a row still needs JSONata the
  list and its export are capped and the report and its schedule say so — directory changes (the newest 500 events),
  the risky-users review (1,000 users), app credential expiry (400 apps, credentials ending within 7 days first). App
  registration risks report one true/false field per finding. Inactive guests (2.0) key on the last _successful_
  sign-in, like inactive users: a guest with only older interactive sign-ins is listed as "No successful sign-in
  recorded". The stale and non-compliant device schedules are on again.

- **Content rewritten for large tenants** (100k users; measured with `pnpm test:perf`): the licence page, teams page
  and app registrations page page through Graph with server-side search and filters (one request instead of 50–350);
  the identity health and Microsoft 365 dashboards count at the source (`$count`, batched windows) instead of reading
  whole collections; inactive users read only inactive accounts (Graph's sign-in filter); password age, mailbox storage,
  OneDrive, SharePoint site usage, SharePoint sites, teams activity and inactive licensed users use native filters on
  Graph's own rows (they failed beyond ~1,500 accounts before), with storage totals from Microsoft's daily summary
  reports. Past their caps they say the data is partial (derived report data included); the counts stay complete where
  Graph can count. Tables over 10,000 rows show the first 10,000 (sorted first) and the CSV/XLSX export has every row
  read. Inactive users count accounts with no successful sign-in recorded (failed-only sign-ins included).
- **Owners: people and apps.** `GET /groups/{id}/owners` leaves service principals out, so the group and team pages
  read people and apps apart and agree with the owner count; the groups and teams owner reports list "Owned by an app
  only" apart from "No owners", and the teams list labels each team accordingly. "Remove group owner" finds app owners
  too and keeps a person accountable (it won't remove the last person who owns a group).
- **Expressions:** the grouping constructor (`rows{ key: value }`) runs natively — it failed past ~500 keys ("nested or
  recursing too deeply"); `$applyAdvanced` is compiled once per call and takes filters written in content (`notEmpty`,
  `notContains`, `notIn`, field-to-field comparisons, paths through lists); new `$withFields` and `$take`. The native
  grouping and sorting share the expression's single time budget, read own properties only, and leave sources they
  can't reproduce exactly (function results, blocks, conditions) to JSONata; `$__af*` variables are reserved.

- **Database connections** carry per-connection limits and a name (`DATABASE_STATEMENT_TIMEOUT_MS` [60 s],
  `DATABASE_LOCK_TIMEOUT_MS` [15 s], `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` [60 s], `application_name
adminforge-<process>`) and a configurable pool size (`DATABASE_POOL_MAX` [10]); migrations run without a time limit.
- **Local setup:** `init:local` writes your dev database URL for the non-superuser `adminforge_dev` and puts the
  container's superuser password in `dev.owner.env`; `pnpm db:up` / `db:down` go through `portal/deploy/db/compose.sh`
  (it adds the owner file); then `pnpm db:harden` before `db:migrate`. `adminforge env check` reads the owner files
  (states only) and says when owner keys still sit in a file the services read.

- **Cadence wording:** every schedule sentence now names its time zone ("Every 15 minutes (UTC)", "Every weekday
  (Mon–Fri) at 07:00 Europe/London"); the API's `cronText` and the web app use the same describer (they differed),
  and the web app shows times with the browser's 12- or 24-hour clock. Form field errors that wrap keep their icon
  on the first line at full size (`field` recipe).
- **Page loads at enterprise scale** (plan 2026-10-17, phase A):
  - Microsoft calls take a concurrency slot per attempt (each page, each retry) and release it while a throttled call
    waits; a person waits at most `OUTBOUND_QUEUE_WAIT_MS` (503 `outbound_busy`); schedules queue. The overview's
    `$batch` goes through the same slots.
  - A timed-out attempt is tried once more, not four times; the slow reads (`OUTBOUND_TIMEOUT_OVERRIDES`: sign-in and
    audit logs, usage reports, Log Analytics) get one 2-minute attempt. A person's datasource stops after
    `DATASOURCE_DEADLINE_MS` (504 `datasource_timeout`), and a page left while it loads stops calling Microsoft.
  - Identical concurrent loads of one session share one execution; the cache is capped by size
    (`DATASOURCE_CACHE_MAX_MB`) as well as entries, keys on the params a datasource uses and on its dependencies' keys
    (a cached dependent no longer re-runs its dependencies), and drops only the republished page's results. A transform
    that failed is tried again on the data already fetched.
  - `paging: all` and `$batch` collections say when they're partial (`truncated`).
  - Order-by (`^( … )`) and a constant slice after it run natively: 100k rows sort in a few hundred ms (JSONata's
    own sort took over a second for 10k rows and ran out of memory at 50k).
  - Joins and per-item rows run natively too: new `$pluck`, `$unnest`, `$attach`, `$pick` and `$withCount`, and
    `$applyAdvanced` compares a date with another field shifted by `days` (dates it parses are cached across calls).
    With them, the app permissions, consent grants, app credential hygiene, ownerless apps, users without MFA,
    disabled users with licences and privileged role assignments reports fit the transform budget at enterprise scale
    (they failed or timed out). Their rows show Graph's own fields, so columns, row keys and the export changed (major
    versions); the permission, consent and credential lists export every row read and the page shows the first 2,000
    with a "Partial data" note, and a "Partial read" note says when Graph's read stopped at its cap (scale tests in
    `tests/content/content-at-scale-round3.test.ts`). The helpers never read into or copy function values, check the
    time budget by work done, and a result is bounded by the values it holds.
  - Request limits count per session (background requests apart, `RATE_LIMIT_BACKGROUND_PER_MINUTE`) with a coarse
    per-address cap (`RATE_LIMIT_PER_ADDRESS_PER_MINUTE`): behind a NAT, one busy engineer no longer locks out the rest.
  - Retried throttling shows in the `microsoft call` log line (`retries`, `throttledRetries`). Sizing:
    `docs/operations.md` → Sizing for a large tenant.
  - **Lanes for Microsoft calls**: list pages, entity reads, batches, writes and the first two pages of a crawl are
    served first; the rest of a `paging: all` holds at most `OUTBOUND_CRAWL_SHARE` (half) of the slots; schedules have
    their own (`OUTBOUND_AUTOMATION_CONCURRENCY`). `OUTBOUND_CONCURRENCY` defaults to 48 (was 16: within Graph's
    directory budget for one app in a large tenant). Load test at 200 engineers: no `outbound_busy` (users list p50
    1.3 s, was 4.6 s); `docs/performance.md`.
  - Only a person's read can be refused as busy, and only before it is sent: writes, retries, further pages and
    long-running-operation polls always wait.
- The inspector drawer is three times wider, never over the navigation: it covers the list (with a scrim that closes
  it) when too little would be left, and lays out the entity page's widgets and KPIs in columns. "Open full page"
  moved to its header and keeps the current tab.
- `check-page-datasources.ts` takes entity-page params after `?` (placeholders or literal values, never printed).
- **Tooling reorganised so each tool can be maintained on its own** (plan: `docs/plans/2026-10-16-m365-e5-unlock-and-tooling.md`):
  - one rule, one place: the tenant-value rule (`tenantValues` in `@adminforge/config`), the design-token patterns
    (`tooling/lint/design-token-patterns.mjs`, used by ESLint, the guard and the after-edit hook), and runner-script
    sha256 pins (now checked by `adminforge validate` for every definition);
  - the `adminforge` CLI: one module per command, layered `shared → provision → content/env → commands` without
    cycles, header comments throughout and a command reference in `portal/tools/cli/README.md`;
  - tools use the API through `@adminforge/api/tooling` and `@adminforge/api/tooling/scheduler` instead of deep
    imports; the scheduler's one-shot run is a reusable module (`@adminforge/scheduler/one-shot`);
  - the runner's PowerShell module is split by concern (events, errors, inputs, connections, read-only policy) with an
    unchanged export list; Pester and the module installer share one install routine;
  - deploy defaults (container, user, database, port) in `portal/deploy/defaults.env`; `portal/deploy/install-units.sh`
    installs the systemd units (replaces the `sed` step; refuses checkout paths that aren't safe in a unit file, and the
    defaults file accepts only `AF_PG_*` keys);
  - live tooling masks every printed message, shares preview/run/poll and credential helpers, and writes to
    `AF_LIVE_OUT` (default `~/.cache/adminforge/live`; refused inside the repository, also through symlinks); `pnpm live:*`
    aliases; the after-edit hook, bundle check and commit-message check also run when started through a symlinked path;
  - test harness: one app/session builder and one people list for API tests (unique object ids), shared helpers under
    `tests/support/` and `tests/lib/`, content fixtures out of code;
  - READMEs for the CLI, `tooling/`, the runner, content scripts, the scheduler, hooks and test folders; tests for the
    bundle check, the after-edit hook, the module installer, the runner health probe and commit-scope sync; CI and the
    pre-commit hook use `pnpm guard` and `pnpm check:bundle`; the root `lint` script runs the lint package (it had
    been linting nothing from that folder).
- **Navigation sections start collapsed.** Every section of the left rail starts closed; a closed section still shows
  the page you're on and pages with something new (the unread-news count), and its heading says how many pages it
  hides. Opened sections are remembered per person (`navOpenSections` in `PUT /api/me/prefs`; the older
  `navSections` — the sections people had closed — is no longer read, so everyone starts collapsed once).
- `identity.offboard-user` 1.1.0 converts the mailbox to shared, sets an automatic reply, hides it from address lists
  and gives the manager OneDrive access when those workloads are licensed; `identity.leaver` 1.1.0 now only lists what
  offboarding couldn't do.
- `identity.compromised-account` 2.0.0 merges `security.compromised-account-response` (retired).
- **Defender on Office 365 E5 tenants (checked live 2026-10-16).**
  - New licence feature `defenderEndpoint`: Defender for Endpoint Plan 2 device data (`WINDEFATP` or the
    `TVM_PREMIUM_1` add-on). `security.device-vulnerabilities` 1.0.1 is gated on it. Before, page gates mapped
    `WINDEFATP` to `defender`, which Office 365 E5 satisfies; a service plan now resolves to the most specific feature
    that lists it.
  - Defender XDR's 403 "Account is not provisioned" now reads "Microsoft Defender XDR isn't set up for this tenant yet",
    with the fix: an admin opens security.microsoft.com once. It used to say "licence missing". Probes report it as
    `not_configured`.
  - Secure Score (`security.secure-score` 1.1.0, `security.secure-score-summary` 1.1.0, `security.overview` 1.0.1):
    improvement actions come from the controls in the latest score. The control catalogue lists hundreds that don't
    apply to the tenant; on the live tenant the old approach showed 462 actions worth 2,626 points against a maximum
    of 8. Other fixes:
    - The comparison with other tenants is read as the percentage it is.
    - Cost and impact are normalised (Microsoft mixes `low`, `Low`, `Medium`, `Moderate` and `Unknown`).
    - A tenant without a score yet shows empty values and a note, not 0 %.
  - `security.incident` / `security.alert` 1.1.0 name the email evidence types Defender for Office 365 produces (email
    cluster, user-reported email, mailbox configuration, Teams message, OAuth app, …).
  - Licence-gate text ends each reason with a full stop.
- **Teams, SharePoint and OneDrive on Office 365 E5 (checked live 2026-10-16).**
  - `m365.teams-without-owners` 1.1.0 reads Microsoft Graph instead of Teams PowerShell, so its weekly schedule is
    enabled and runs as the automation identity. The archive state comes from Graph's Teams API, which answers only
    people with a Teams licence: without it every team is listed and the report says so. Only people count as team
    owners there, on `m365.teams` 1.0.1 and on the Microsoft 365 overview (apps can own a group, not manage a team).
  - New datasource option `optional: true`: datasources that use a failed optional one see `null` instead of failing,
    and carry the failure in `errors["ds.<name>"]` (limits under Security).
  - `m365.team` 1.1.1 loads team settings and channels again (its `when` named the group datasource without `ds.`);
    `adminforge validate` now refuses that mistake. Microsoft's "Failed to get license information for the user" now
    explains that the signed-in person needs a Teams licence, instead of claiming the tenant lacks one.
  - OneDrive handover: `m365.grant-onedrive-access` 1.1.0 reads the grant back and undoes it when SharePoint doesn't
    show it, refuses giving the access to yourself, and new `m365.remove-onedrive-access` takes it away
    (`sharepoint/Set-SiteCollectionAdmin.ps1`, tenant admin API).
  - SharePoint sharing (`m365.sharepoint-sharing` 1.1.0, `m365.anyone-link-sites` 1.1.0): readable link settings
    ("Anyone with the link", "Never" for links without expiry), untitled sites show their URL, group-connected sites
    link to their group (the site list has no owner for them).
  - Usage reports: concealed site names fall back to the site id (`m365.sharepoint-sites`,
    `m365.sharepoint-site-usage`); a newly licensed tenant's 404 `UnknownTenantId` says the reports start 24–48 hours
    after the first subscription. Service health KPIs count every unresolved issue whatever the table filters.
  - The runner connects Teams without `-TenantId` (MicrosoftTeams 8 refused it with access tokens: "Not supported
    tenant type").
- Write-app permissions trimmed to what content declares (removed `Policy.ReadWrite.ConditionalAccess`,
  `DeviceManagementManagedDevices.ReadWrite.All`, `IdentityRiskyUser.Read.All`); new ones added for the new playbooks.

- Recent pages and closed navigation sections are saved without an audit event; every page visit used to add a
  `prefs.updated` entry. Settings changes (theme, density, pins) are still audited.

#### Removed

- The host deployment (ADR-008, superseded by ADR-017): the systemd units and their hardening drop-ins, Caddy's
  configuration, `install-service-account.sh`, `install-units.sh`, the Postgres container (`pnpm db:up` / `db:down`),
  `pnpm db:harden` and the role scripts, and the encrypted backup timer. Postgres, pg-boss and the Postgres migrations.

- **Function Apps and Azure Arc-enabled Kubernetes retired** (not needed for now): their pages, report and weekly
  schedule (turned off), triage runbook, trigger-sync playbook, the example HR-sync connection and probe, and Log
  Analytics' "Function App errors" query. The generic `functionHealth` probe kind and `function` datasource stay;
  `docs/backlog.md` says how to bring the content back.
- **Microsoft Defender portal content retired:** AdminForge no longer reads security.microsoft.com. Incidents, alerts,
  advanced hunting, Secure Score and device vulnerabilities (6 pages), the incident playbooks, the alerts, incidents and
  Secure Score reports with their schedules and the two Defender probes are `status: retired` (kept for run and audit
  history); the Defender XDR news feeds stay (public web pages, not portal data). The security overview (2.0.0) keeps users at risk and Defender for
  Cloud; `identity.compromised-account` 3.0.0 drops the optional Defender incident comment. Retired content no longer
  earns permissions (the Read app and automation baselines lose `SecurityIncident.Read.All` and
  `SecurityAlert.Read.All` too): `provision entra` drops the delegated `SecurityIncident.*`, `SecurityAlert.Read.All`,
  `SecurityEvents.Read.All` and `ThreatHunting.Read.All` from the Read and Write apps, and the automation identity's
  Defender application permissions are removed with `provision entra --prune` (run `--dry-run --prune` first). Query Studio's advanced hunting can be switched off with
  `AF_QUERY_SOURCES` (above). A content test keeps active definitions from linking to retired ones.

#### Security

- The database's protection moves from Postgres roles to the file (ADR-016): 0600 file, 0700 folder, local block
  storage only, a volume only one pod can mount. The audit log's triggers no longer hold against the service itself
  (SQLite has no roles); the hash chain and its checkpoints — now in the api container's log, to be shipped off the
  cluster — remain the tamper evidence. Deleted sessions and tokens are overwritten in the file (`secure_delete`).

- **Dedicated service accounts** (Postgres finding C1): `portal/deploy/install-service-account.sh` (dry run by default;
  `--apply`, `--release`, `--rollback` and `--sync-config` need root) moves the api, worker and scheduler from the
  owner's login account — in the docker/sudo groups, so any of its processes could reach Postgres as superuser — to the
  `adminforge` system account, and the runner to `adminforge-runner`, which gets only its own `RUNNER_*` file (read by
  systemd) and can't see the API's configuration or state. Sandboxed system units (`ProtectSystem=strict`,
  `ProtectHome`, no capabilities, `StateDirectory` the only writable path, no Docker socket, only the API and the runner
  may bind), a read-only release per deploy under `/opt/adminforge` (newest three kept, `--rollback` to the previous),
  node and PowerShell copied out of the owner's home. `/etc/adminforge` gets only keys documented in
  `config/example.env` (never admin, test-account or database-owner keys, or the owner's `DATABASE_URL`), with
  certificates from the owner's home copied next to them. Root never writes through a path the services control and
  reads owner files as the owner, never through symlinks; later modes run the root-owned released copy. `--firewall`
  adds an nftables loopback policy for both accounts; the backup archives their report files (`state.tgz`) and fails
  when it can't read them. Nothing starts until the printed switch-over is run; a verification checklist and a
  rollback are printed. The runbook's incident and rotation steps now name the system-unit commands and
  `--sync-config`.
- **Rate limits and sign-in**: `/auth/login` and `/auth/callback` count per client address whatever cookie comes
  with them (`RATE_LIMIT_SIGNIN_PER_ADDRESS_PER_MINUTE`), requests without a valid session share
  `RATE_LIMIT_ANONYMOUS_PER_ADDRESS_PER_MINUTE`, IPv6 counts per /64, and the background allowance no longer doubles a
  route's own limit — invented cookies buy no fresh allowance. Failed-sign-in audit events are written at most 10 a
  minute per address, then a `suppressed` count. `TRUST_PROXY=true` is refused in production.
- **Expression budget**: a sort term or group key evaluated per row shares the whole evaluation's 250 ms (each row
  used to get its own); keys JSONata compares only pair by pair fall back to its own sort, and constant slices follow
  its index rules exactly. Datasource cache keys count all params whenever an expression reaches them through the root
  scope or a wildcard, and the query lint treats those as user data. A cached result is refused when a role a
  dependency needs is gone; a closed page is never swallowed as an optional failure.
- **Postgres hardening** (`docs/operations.md` → Postgres hardening, `pnpm db:harden [--dry-run] [--rotate]
[--rotate-superuser]`): the services' database and the dev/test databases get **non-superuser owners**
  (`adminforge_owner`, `adminforge_dev`) and everything the bootstrap superuser owned moves to them; the superuser can
  sign in over the container's socket only (`pg_hba.conf` rejects it over TCP; new clusters get the rule and password
  TCP auth at initdb); databases are closed to `PUBLIC`; `adminforge_app` gets per-role `statement_timeout`,
  `lock_timeout` and `idle_in_transaction_session_timeout` and a connection cap. The owner's URL and the superuser
  password live in owner files (`<env>.owner.env`, `<env>.<overlay>.owner.env`) that only migrations and the database
  scripts read; `create-app-role.sh` writes the owner URL there and runs as the container superuser. Passwords are
  sent only as client-side SCRAM-SHA-256 verifiers (`portal/deploy/db/scram.mjs`) in sessions that log no statements,
  and Postgres never logs bind parameters; each new credential is saved as soon as its role has it; scripts run as one
  transaction with a lock timeout and refuse while the services still use the superuser. The API, worker and scheduler
  refuse to start in production (fail closed) when their role — `current_user` or `session_user` — is a superuser or
  `BYPASSRLS`, can change audit events, belongs to the audit table's owner, can create in `public` or holds a
  `pg_*_server_*` role (development warns about superuser or `BYPASSRLS`), and a database on another host needs
  `sslmode=verify-full` (judged as node-postgres parses the URL; migrations too).
- **Database integrity:** foreign keys between runs, steps, events, schedules, schedule runs and probe results, and
  CHECK constraints on every status column (migration 0009, added `NOT VALID` then validated); **approval decisions
  are append-only** in the database (migrations 0010–0011): approvals start pending, a recorded decision never changes
  (`sessionHash` may be rebound only to a session of the person who decided — the run worker acts only through such a
  session too), a decided approval is final, an approval is deleted only together with its run or schedule, and the
  trigger functions run with a fixed `search_path`.
- **Audit chain:** verification walks the chain in batches (memory stays flat) and records the verified tail
  (`seq`, `hash`) in the services' journal as an external checkpoint; `adminforge audit verify` prints the tail to
  compare.
- **Token-cache key rotation:** envelopes carry a key id and a pinned 16-byte GCM tag; `TOKEN_CACHE_PREVIOUS_KEYS`
  keeps blobs sealed before a rotation readable (older `1.` envelopes still open).
- **Backups refuse to run unencrypted** unless `AF_BACKUP_ALLOW_PLAINTEXT=1`, and never contain the database owner's
  credentials (owner files, and owner keys an older env file still has).
- **Postgres container:** image pinned by digest; connection, DDL, lock-wait and slow-statement logging; rotated
  container logs; `no-new-privileges`, memory and process limits (applied when `pnpm db:up` recreates the container).

Platform evaluation (2026-10-16) — organization and security best practices (OWASP ASVS 5.0, NIST SSDF, Microsoft
identity platform guidance, systemd hardening, OpenSSF Scorecard). Fixed:

- **Protected objects, enforced centrally.** The executor refuses every write (REST or PowerShell) that names
  AdminForge's own apps and service principals, any principal holding an AdminForge app role (the `SG-AdminForge-*`
  groups), `AF_PROTECTED_APP_IDS` or the new `AF_PROTECTED_USER_IDS` (break-glass accounts) — by id, read from Graph
  and cached for 10 minutes (`protected_object`, `protected_objects_unavailable`). Previously only some playbooks
  checked group names: `identity.create-user` could add a new account to an approver group and hand its creator the
  TAP, and nothing stopped removing other approvers.
- **Separation of duties.** Approval gates exclude the people a change grants access to (`approval.excludes`,
  `own_access`): the principal getting a directory or Azure role, people added to a role-assignable group, a new app
  owner. Group and app-owner playbooks refuse adding yourself; role-assignable groups and app owners need approval.
  Approvals expire after 72 hours by default. Only the person a manual step waits for can confirm it.
- **Runs follow the current rules.** Resuming re-checks roles and — before anything was changed — the current version
  (`run_outdated`); child playbooks run their current version only; runs waiting for arming or sign-in stop after 24
  hours (`run_expired`); a confirmed change with a preview older than 15 minutes stops before writing. The run worker
  re-checks the initiator's roles every 5 minutes (shared with the API through `sessions.roles_checked_at`, migration
  0007), so removing someone from Operator stops their unattended writes too.
- **Emergency stop.** Admin → Settings pauses all changes (`writes_paused`) or all automation (`automation_paused`,
  including Run now) with a reason; approvers and admins can pause, admins resume; audited and shown in a banner.
  AdminForge's own notification mail still goes out.
- **Publishing.** `adminforge publish` runs the `validate` checks and the playbook tests, and refuses content that isn't
  committed and on `origin/main` unless `--allow-unreviewed` (recorded with its reasons in the audit event).
- **Injection lint.** User data in OData `$filter`, `$search` and `$orderby` (query or body) must go through
  `$odata()` / `$odataSearch()` / `$guid()`, even inside a quoted literal (previously only `&` concatenation was caught).
- **Sessions.** Background polling no longer keeps a session alive (`X-AdminForge-Background`), and an idle tab no
  longer signs itself back in; live run streams and show-once secret delivery stop when the session ends; at most 5
  event streams per session; every `/api` route needs `Portal.Reader` (with a few exemptions); a token without the
  `acct` claim is refused (`account_status_missing`).
- **Step-up visibility.** `session.armed` records whether arming proved an authentication context or only a fresh
  sign-in; Admin → Settings shows it and `adminforge env check` warns without `WRITE_AUTH_CONTEXT`.
- **Audit and logs.** Refused security-relevant requests are audited (`request.denied`, rate-limited); sign-in and arm
  failures keep only the OAuth error code and AADSTS number (an unauthenticated caller could previously write free text
  into the audit log); request logs carry the user's object id and never `/api` query values.
- **Browser.** `Permissions-Policy`; production source maps are no longer served; Query Studio's Copy neutralises
  spreadsheet formulas; key-value links without `href` no longer evaluate tenant data as a template; `/readyz` no
  longer names configuration keys; the example Caddyfile drops `Via`.
- **Host and supply chain.** The services' configuration loader drops the database owner URL and `POSTGRES_PASSWORD`;
  backups leave out the rows of `sessions`, `preauth` and `token_cache` and the backup unit gets the hardening drop-in;
  PowerShell workers start with a settings file that keeps script-block and module logging (module source at warning
  level, ~120 MB a day) out of the journal; CI actions are pinned to commit SHAs.
- Docs: SECURITY.md now states the host requirement (an account of its own, not in `docker`/`sudo`), the step-up gap
  without `WRITE_AUTH_CONTEXT`, and the remaining known gaps; ADR-013 records the News feed egress decision; the master
  plan is marked historical. Deferred findings are in `docs/backlog.md` → Platform evaluation.

- **Mailbox, inbox-rule and OneDrive writes** (security and content review 2026-10-16):
  - `m365.set-mailbox-forwarding` 1.1.0 needs a second engineer's approval; the person receiving the mail and the
    mailbox's owner can't approve it. It forwards only to user and shared mailboxes (no groups — they can include
    guests and outside contacts), never to a mailbox that forwards on, to the mailbox itself or to yourself; the script
    (`Set-MailboxForwarding.ps1`) refuses the same. A hybrid mail user is explained as "no mailbox in Exchange Online",
    and an unconfirmed change says "submitted; Exchange doesn't show it yet".
  - `m365.grant-mailbox-permission` 1.1.1 refuses giving yourself access; it and `m365.remove-mailbox-permission`
    1.1.1 name permissions as "Full Access", "Send As" and "Send on Behalf".
  - `m365.set-inbox-rule` 1.0.1 never turns on a rule that forwards or redirects outside the organization (script,
    playbook, and the audit's row actions in `m365.inbox-rules` 1.1.1).
  - `Set-SiteCollectionAdmin.ps1` works on OneDrives only, requires the owner and confirms it from their SharePoint
    profile, reads back whether or not it sent anything, and fails loudly if a removal drops anyone else.
    `m365.grant-onedrive-access` 1.1.1 never takes away access the person already had.
  - The four PowerShell writes take the Entra object ids of the accounts they change and check them against Exchange
    or SharePoint, so the protected-object guard (`AF_PROTECTED_USER_IDS`, AdminForge's own principals) covers them.
  - `identity.leaver` 1.2.1 declares what its Offboard user step needs; `identity.compromised-account` 2.0.1 links the
    inbox rule audit and Clear forwarding.
- News and changes fetches public feeds only over https from a code allow-list of Microsoft hosts (public addresses
  only, redirects only within the list, time and size limits, conditional requests), refuses XML with DOCTYPE or entity
  declarations, renders source text as plain text only and keeps citation links only on Microsoft domains. Tenant feeds
  use the automation identity's read-only ServiceMessage.Read.All / ServiceHealth.Read.All and Reader; data-privacy
  Message Center posts are Portal.Admin only; feed errors are Operator only.
- Second security review (API, runs, runner, identity and RBAC) fixed: connection token scopes and audience allow-list;
  sessions end on `invalid_grant`; guests refused (`acct`); step-up always forces a fresh sign-in; control characters
  in paths; response size caps; HTTP-probe SSRF; expression limits; query parameters kept out of logs; mock mode fenced;
  current-version-only data and exports; email recipients from configuration only; manual-step values only from the
  person asked; scheduled-run outputs need the schedule's roles; connections in approval fingerprints; redaction after
  resume; safe Markdown links; approver and child playbook roles; drafts can't run; single-use previews; runner tokens
  sealed and answers signed; a read-only command policy for PowerShell read jobs.
- Provisioning ceilings for tier-0 Write scopes (`AF_ALLOW_PRIVILEGED_WRITE_SCOPES`) and sensitive automation reads
  (`AF_AUTOMATION_ALLOW_SENSITIVE_READS`); `provision status` fails on privilege it didn't grant; automation identity
  requires assignment and can use a certificate; the validation user drops Groups Administrator and stays disabled
  between live runs.
- AdminForge's playbooks refuse to change its own role groups, its own apps and `AF_PROTECTED_APP_IDS` (the provisioner).
- The services use a least-privilege database role (`adminforge_app`) that can't change the audit log; backups no
  longer include the admin env file or private keys unless encrypted (`AF_BACKUP_GPG_RECIPIENT`).
- `requires.portalRoles` now means **every** listed role everywhere (pages and datasources previously accepted any
  one of them).
- Shared saved views are listed only for pages the caller can open.
- Extending write access re-checks the Operator role.

Security review of the licensed build-out (2026-10-16) fixed:

- **`optional` datasources never hide a denial.** `dependency_failed` keeps its cause, and the whole chain is checked:
  a missing portal role, `policy_denied`, `licence_required` or a sign-in / arming problem anywhere behind an optional
  datasource still fails its dependents. What `optional` does suppress is recorded in the dependents' `errors`
  (`ds.<name>`, also further down the chain) and logged; exports audit it (`incomplete`), and a scheduled report built
  without it writes and delivers the file marked "Incomplete: …" and ends `failed` with `report_incomplete` (not
  retried), so it never succeeds silently on a refused call.
- **Validation user privilege is opt-in and limited to provisioning's own account.** Exchange Recipient Administrator
  and SharePoint Administrator (tenant-wide) are given only with `AF_TEST_SERVICE_ADMIN_ROLES=true` in the admin file
  (default off; licensed tenants list them as withheld, and re-provisioning removes them). Provisioning refuses, before
  changing anything, an existing account it didn't create (UPN not `af-…`, or neither the new `employeeType` marker
  "AdminForge validation" nor the display name "AF Tester"): no password reset, roles, groups, registration-campaign
  exclusion, `--enable` or `--disable`, and no Azure test roles. `provision status` also fails on any other directory
  role the validation user holds — roles outside AdminForge's catalogue, narrower scopes, roles through a group — by
  name only.
- **Live scripts.** `run-schedule-once.ts` refuses a `DATABASE_URL` from the process environment, a dev database that is
  also the host services' (the `host` overlay resolving to the same URL) and playbook schedules;
  `check-mail-sender.ts` sends only as `AF-Test-*` mailboxes or the configured sender; `run-playbook.ts` prints error
  codes and masks ids and addresses in messages (`tests/live/lib/mask.ts`); `tests/live/scripts/.tmp-*` is ignored.
- The tenant-data guard and `fixtures` sanitiser exempt `AF_LICENCE_SKU_<n>` values only when they look like a SKU part
  number (`^[A-Z0-9_]{2,64}$`). The runner's read-only policy classifies `Format-AdminForgeMessage` as internal.

#### Fixed

- Every page load logged a Content-Security-Policy violation in the browser console ("blocked a JavaScript eval …
  params-….js"): Zod 4 probes `Function('')` to decide whether to compile its validators, which `script-src 'self'`
  forbids. The web app turns compilation off before anything validates (`disableEvalProbe`); a production-build test
  now loads a page under the API's script policy and fails on any violation.
- VMs without backup (1.0.1) and App Service security (1.0.1) joined two other tables in one Resource Graph query,
  which Azure refuses: subscription names now come from a small lookup joined with `$attach`. The same limit is fixed
  in the new AVD and Arc views before release.
- Opening a sign-in event in the inspector froze the browser: the drawer's title flipped hundreds of times a second
  (no requests, no URL change). An entity page whose header title is an expression reported it to the inspector, the
  inspector rebuilt the page's params on every render, and the new data scope evaluated the title again. The inspector
  page now gets new params only when the URL changes, and the header reports a title once it has one
  (`tests/e2e/inspector-sign-in-event.spec.ts`; replayed with 60 real sign-ins).
- The inspector no longer gets stuck in a sign-in/refresh loop when Microsoft keeps asking for a fresh sign-in: the
  app follows a 401 to sign-in at most once per tab per minute, then says "Sign-in didn't finish" with "Sign in again";
  capabilities lookups never start a sign-in themselves.
- When a page's data needs a fresh sign-in, one "Sign in again" banner replaces repeated widget errors with dead "Try
  again" buttons, and the `reauth` error says what to do.
- Closing the inspector returns focus to the row (the list no longer re-mounts when the inspector opens), and a
  header whose data failed no longer shows a guessed status such as "Sign-in blocked".
- The sign-in page (and the inspector) loads in seconds: it filters the sign-ins list on the id, bounded to five
  minutes around the sign-in's time, instead of `GET /auditLogs/signIns/{id}`, which took minutes and timed out
  (`identity.sign-in` 1.1.0; the sign-ins, user and enterprise app pages pass the time). Links without the time search
  the last 7 days, and a sign-in that isn't in the log says so.
- Intune apps loads on Graph v1.0: assignment state comes from `assignments` (`isAssigned` is beta-only)
  (`endpoint.apps` 1.0.1).
- Dismiss and confirm-compromised, and the compromised-account runbooks, read only the requested user's risk
  (filtering `riskyUsers` instead of `riskyUsers/{id}`, an unreadable 404). Dismiss says there's nothing to dismiss,
  confirm no longer skips real errors, and the response summary says whether the MFA methods were removed.
- Live sign-in no longer times out when Entra skips the authenticator registration's confirmation page and goes
  straight to "Stay signed in?" (`tests/live/lib/entra-login.ts`).
- **Published pages lost their authored key order.** Definitions were stored as Postgres `jsonb`, which sorts object
  keys, so in production (`CONTENT_SOURCE=db`) 15 reports and pages whose datasources reference one declared
  "above" them failed with a content error (e.g. orphaned role assignments, groups without owners, consent grants,
  app registration risks, risky users review, Teams without owners), and 61 parameter forms and 64 playbook input forms
  showed their fields in a different order than in development. The executor now orders datasources by their
  `ds.<name>` references (a loop is the only content error); `adminforge validate` still requires dependencies to be
  declared first; migration 0008 stores definitions as `json`, and `adminforge publish` restores the authored order of
  bodies stored before (reported as "restored to their authored key order", without a new version).
- Development hot reload could go quiet for minutes: Node's recursive file watcher on Linux stops reporting a file once
  it has been replaced by a rename (atomic saves, formatters, `sed -i`), and a content change made while a reload was
  running was dropped. The file source now also compares file stamps every 2 s and runs a reload again when one was
  asked for mid-reload.
- `init:local` replaces the `CHANGE_ME` placeholders of a copied `config/example.env` instead of reusing `CHANGE_ME` as
  the Postgres password (the documented setup path left `env check` complaining).
- `docs/api.md` no longer says a client may choose its `X-Correlation-Id`; the API always generates it.
- Two load-sensitive tests: a Postgres purge test mixed a fixed date with the database clock (failed from the day after
  it was written); the 250 ms transform-budget test retries under a saturated machine; the reports catalogue component
  tests have a larger timeout.
- Azure pages read Resource Graph flags correctly: computed booleans arrive as 1/0, so the Privileged KPI showed 0, the
  resource Access tab never offered "Remove assignment", and several flag columns and facets were wrong (8 pages).
- `identity.*` reports: a one-item id list was sent to Graph as a plain string.
- Error messages never show Microsoft's raw JSON (e.g. usage reports on a tenant without Microsoft 365).
- Graph requests send `Accept-Language: en-US` (direct PIM requests failed with `CultureNotFoundException`).
- Built-in email delivery can get `Mail.Send` (provisioning requests it when `AF_MAIL_SENDER` is set, behind the write
  opt-in; prefer scoping it to that mailbox with Exchange RBAC for Applications).
- Playbook preflight checked licences by SKU name instead of feature key, so licensed features could show as missing.
- An admin's default density never applied to people without their own preference.
- The PIM menu and the page renderer shared a query key, so one could overwrite the other's data.
- `adminforge validate --scopes` didn't read the provisioner credentials from the admin env file.
- Collapse/Expand did nothing in windows narrower than 1024 px: the button treated the rail as collapsed while it
  was drawn expanded. Your own choice now wins; without one, narrow windows start collapsed.
- Opening an Azure resource or resource group failed with "Query is invalid": Resource Graph doesn't accept a leading
  `union a, b` (`azure.resource` 1.1.0). `adminforge validate` now rejects that form in Resource Graph queries.
- Bar, line and area charts stayed empty in production builds (`… is not a constructor`): the bundler dropped the chart
  runtime's top-level registrations. Registration is now explicit, and a production-build smoke test
  (`pnpm test:e2e:prod`, in CI) covers it.

## 0.1.0 — 2026-10-15

First release: an admin portal for Microsoft Entra ID, Microsoft 365, Intune, Defender and Azure that runs on its own
host, signs engineers in with their own identity, and works read-only until they arm write access.

### Added

- **Sign-in and roles**
  - Single sign-on with Microsoft Entra ID. Microsoft tokens stay on the server; the browser holds only a session
    cookie.
  - Read-only by default. Operators arm time-boxed write access (default 60 minutes, extendable once) with a step-up
    sign-in to a separate Write app. Armed mode is shown in ember with a countdown, extend and disarm.
  - Five portal roles (Reader, Operator, Playbook Approver, Playbook Author, Admin), granted through
    `SG-AdminForge-<label>-<Role>` groups.
- **Portal**
  - Web shell with navigation generated from content, command palette, pins and recents, and three themes (Steel,
    Daylight, Contrast) with density options.
  - Content-driven pages (dashboard, list-detail, entity, report and settings templates) built from widgets: KPI,
    table, chart, list, key-value, status grid, timeline, markdown, action bar, licence gate and probe status.
  - Saved views, CSV/XLSX export, an inspector drawer and an advanced query builder on list pages.
  - Licence gates that explain what a missing licence hides ("Requires …").
- **Content** (71 pages, 5 dashboards, 17 reports, 44 playbooks, 6 runbooks, 16 schedules, 33 probes)
  - Identity: users, groups, directory roles and PIM, app registrations and enterprise apps, Entra devices,
    Conditional Access, named locations, authentication methods, MFA registration, sign-in and audit logs.
  - Microsoft 365: service health, message center, licences, usage, Exchange mailboxes and distribution lists,
    Microsoft 365 groups and Teams, SharePoint sites.
  - Endpoint and Security: Intune devices, compliance, configuration, apps and Autopilot; Defender incidents and alerts,
    Secure Score, risky users, Defender for Cloud.
  - Azure: subscriptions, Resource Graph inventory, resource detail, Azure Arc, Monitor alerts and metrics, Log
    Analytics, Function Apps, RBAC.
  - Playbooks for user lifecycle, MFA and Temporary Access Pass, groups, licences, PIM, apps and devices (wipe with
    approval), and Azure resources (start, stop, restart, tags, resource groups, RBAC with approval).
- **Playbooks and runs**
  - Preview (dry run), then confirm; risky changes need a matching recent preview, and some a typed confirmation.
  - Approvals by a second person, bulk runs, live run timelines, and resume after re-arming or signing in again.
  - Show-once secret outputs (temporary access passes, passwords, app secrets) that are never stored.
  - Runbooks: guided procedures that mix instructions, manual checklist steps and child playbooks. Run forms can be
    prefilled from a link.
- **Schedules and monitoring**
  - Scheduler on the host running as a separate automation identity: probe sweeps, report files (CSV/XLSX), scheduled
    playbooks and content health checks, with a hot standby.
  - Synthetic probes for every check kind, including 10 KQL configuration checks: public blob access, insecure storage
    transport, open NSG management ports, Key Vault purge protection, disconnected Arc machines, policy
    non-compliance, Defender recommendations, missing required tags, failed-write spikes and risky OAuth consents.
  - Weekly inactive guests report (Mondays 06:15 UTC, XLSX, 26 files kept).
  - Monitoring page, and a Schedules page with run history, **Run now** and report downloads.
- **Query Studio**: a KQL workbench for Resource Graph, Log Analytics and Defender advanced hunting, with a starter
  gallery, charts, history, and save as report, probe or schedule (YAML for review).
- **PowerShell runner** for Exchange Online, Teams and SharePoint: single-use `pwsh` workers, pinned scripts and
  modules, and read-mode guards.
- **Audit**: an append-only, hash-chained audit log with filters, event detail, CSV export and chain verification.
- **Administration**: appearance editor with contrast checks, and settings.
- **CLI** (`pnpm adminforge`): `env check`; `provision entra`, `test-identities`, `azure-test` and `status`;
  `validate [--scopes]`, `test`, `publish`, `new`, and `fixtures record`.
- **Deployment**: systemd user units for the API, run worker, scheduler and runner, plus a Caddy TLS proxy for LAN
  access; Postgres 18 in Docker.
- **Development**: mock sign-in with synthetic fixtures (no tenant needed), the Claude Code extension kit (`CLAUDE.md`,
  a skill per extension point, reviewer agents, a validation hook), and a live tenant validation suite.

### Security

- Default-deny outbound request policy: in read mode only reads leave the API, and writes happen only through
  published content that declares them. There is no generic write proxy.
- Sign-in uses PKCE, a single-use state that expires after 10 minutes, a nonce, and tenant and user checks. Each round
  trip is bound to the browser that started it, and return paths must be same-origin.
- Write step-up is proven on the server: a Conditional Access authentication context, or a fresh sign-in at most 5
  minutes old. A token without `auth_time` is refused.
- Roles are re-read from Entra every 5 minutes. Removing someone's access ends their session, and losing Operator ends
  write access.
- The token cache is sealed with AES-256-GCM. Every change needs a CSRF header. The API sends CSP (and, in
  production, HSTS) headers, rate-limits requests, and listens on loopback behind Caddy, whose admin API is off.
- Schedule approvals cover a fingerprint of the playbook and its child playbooks. A scheduled run whose playbook
  changed is refused and the schedule is switched off.
- The automation identity gets read-only application permissions unless you explicitly allow write ones.
- Advanced filters are compiled on the server to quoted OData or KQL, so they can't inject through URLs. Service paths
  can't carry `?` or `#`.
- Connections can't request tokens for Microsoft services, and they refuse redirects.
- Scheduled report files and probe results need Operator by default.
- Inputs marked `redact: true` are masked wherever runs, events and the audit log store them.
- Runner requests are HMAC-signed over the timestamp, method, path and body. The runner reads only its own key.
- Provisioner and test credentials are kept in a file the services never read. The services get their own database
  through the `host` overlay. A systemd hardening drop-in is included.
- Guard tests and a pre-commit hook block secrets, tenant-specific values and raw UI colours.

### Changed

- Sign-in and write-access failures open a designed problem page with a specific explanation instead of raw JSON. A
  real signed-out page no longer signs you straight back in, and **Use a different account** opens the account picker.
- Error messages now say what happened and what to do next, and show a Reference to give an administrator.
  Out-of-date pages refresh their CSRF token and retry once. A failed report download opens the problem page instead
  of saving the error as the file.
- Interactive runs always use the current published version of a playbook. Previews check the playbook's roles too.
- Provisioning grants the permissions that content declares, on top of the baseline. It registers redirect URIs for
  every origin in `AF_REDIRECT_BASE_URLS`.
- Microsoft 365 usage reports that answer `UnknownTenantId` are reported as a missing licence.
- Per-probe schedules are replaced by four tag sweeps.
- The mail domain and the licence SKUs that probes watch are configurable (`AF_MAIL_DOMAIN`, `AF_LICENCE_SKU_1`,
  `AF_LICENCE_SKU_2`).
- The CLI prints a single line with the fix for common failures (for example, Postgres down → `pnpm db:up`).
- The first page loads faster: the initial JavaScript bundle shrank from about 246 KB to 220 KB gzipped.

### Fixed

- `TRUST_PROXY=true` no longer stops the API at start-up.
- The runner's request signature now covers the HTTP method and path, so a signed request can't be replayed against
  another endpoint.
- Return paths such as `/.//host` can no longer redirect off-site.
- The create-security-group and delete-stale-device playbooks request the correct delegated permissions.
- Exports record the compiled filter in the audit log.
- Monitoring tiles show units and readable KQL column names.
- `pnpm dev` now passes settings such as `AUTH_MODE` through to the apps.

### Docs

- README, `CLAUDE.md`, `docs/extending.md` and the project skills: extending AdminForge with Claude Code (ADR-012).
- `SECURITY.md`, `docs/architecture.md`, `docs/access.md`, `docs/operations.md` and `docs/troubleshooting.md`.
- `portal/deploy/README.md`: host services, production drop-ins, and LAN access through Caddy.
- Widget reference (`docs/widgets.md`), ADR-001 to ADR-012, the decisions log, licensing review and backlog.
- `tests/README.md` and `tests/live/README.md`.
