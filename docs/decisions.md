# Decisions log

Decisions taken while building AdminForge, in addition to the ADRs in `docs/adr/`. Newest first within each group.

## Open decisions from the plan (D1–D9)

| #   | Decision                | Outcome                                                                                                                                                                                                           |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Git host                | GitHub (`ortiz05/AdminForge`), Actions CI on latest action majors                                                                                                                                                 |
| D2  | Network exposure        | A Kubernetes Ingress with TLS in front of the one pod (ADR-017; until 2026-10-20 this host through Caddy, `tls internal`) — TLS is required for any non-localhost origin (`__Host-` cookie, Entra redirect rules) |
| D3  | Region                  | `eastus` for test resources (`AF_TEST_LOCATION`)                                                                                                                                                                  |
| D4  | Naming prefix           | `adminforge` / `AF_`                                                                                                                                                                                              |
| D5  | Write step-up           | Conditional Access auth context when `WRITE_AUTH_CONTEXT` is set (needs Entra ID P1); validation tenant has no P1, so step-up is a fresh interactive sign-in (`prompt=login`, `max_age=0`) to the Write app       |
| D6  | Write session length    | 60 min default, `WRITE_SESSION_MAX_MINUTES` caps it, one extension                                                                                                                                                |
| D7  | Portal role groups      | `SG-AdminForge-<label>-<Role>` created by provisioning                                                                                                                                                            |
| D8  | Live validation         | Automated: dedicated test user signs in with password + TOTP (registered once by the live helper); writes only on `AF-Test-*` objects                                                                             |
| D9  | Content source of truth | Git (`portal/content`) → the app image → `adminforge publish` in the pod → the database (SQLite since 2026-10-20, ADR-016); production reads the database, dev reads the files with hot reload                    |

## Plan review (2026-10-15)

The implementation was compared with the master plan section by section; the plan's "Revision 3" block lists the
outcome. Decisions taken in that review:

- **Content stays in git.** The in-portal YAML editor, drafts and in-app two-person publish (plan §7.9, task 7.3, half of
  gate G7) are superseded by D9 + R7/ADR-012: content is reviewed in pull requests (`.github/CODEOWNERS` + branch
  protection — both need a second person to mean anything), published with the CLI, and `adminforge publish` is
  audited. Since 2026-10-16 `publish` also runs the `validate` checks and playbook tests and refuses content that
  isn't committed and on `origin/main` unless `--allow-unreviewed` (audited). The **schedule editor** therefore produces
  YAML for review rather than saving schedules. **Amended 2026-10-16 (user decision):** _report_ schedules can be
  created in the portal (Reports → Schedule) and run at once, without git review — they only run a published, reviewed
  report read-only as the automation identity, at most hourly, deliver only to recipient lists and webhooks named in
  the installation's configuration, are capped (25 per person, 200 in total) and audited; the creator or a
  `Portal.Admin` edits or deletes them, any Operator can turn one off. They live in the database (`source: portal`,
  reserved `portal.` key namespace). Every other schedule kind stays content (YAML through review).
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
  the audit log is never purged); applied by the API every 6 hours and audited, 2,000 rows at a time and at most 2 s a
  pass (the rest at the next 10-minute housekeeping pass), so it never holds requests for long.
- **Delivery:** email through Graph `sendMail` as the automation identity from `AF_MAIL_SENDER`; Teams through
  Workflows webhooks on Microsoft hosts only; recipients and webhooks are always `${ env.X }` configuration. Failure
  alerts fire only when no retry is left. Approval requests notify `AF_APPROVALS_EMAIL` / `AF_APPROVALS_TEAMS_WEBHOOK`.
- **Self-monitoring:** the run worker and the scheduler (both in the API process since ADR-016) write heartbeats when
  they make progress (the scheduler from its ticks, the run worker from its queue polls); `/readyz` reports `degraded`
  when either goes quiet, which the portal-readiness probe catches. `probes.audit-chain` checks the events since the
  last verified checkpoint hourly, and the whole chain at start, once a day and after any break. Every Microsoft call
  is logged as one structured line (template path, status, duration, throttling, request id). OpenTelemetry export is
  optional and not built.
- **Backups:** `adminforge-backup.timer` (daily, 14 days) with a recorded restore drill (docs/operations.md).
  Superseded 2026-10-20: volume snapshots and `adminforge db backup` (ADR-016).
- **Least privilege:** baseline Write-app scopes no content uses were removed; content declares what it needs.

## Platform

- **TypeScript 7** (native compiler) for all packages; the lint toolchain lives in `tooling/lint` with TypeScript 6 because typescript-eslint needs the classic compiler API.
- **Latest majors everywhere** (React 19.3, Vite 8, Vitest 5, zod 4.6, Fastify 5, MSAL Node 7, ECharts 6). `pnpm outdated -r` is clean except the deliberate TS 6 in `tooling/lint`.
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
    `pnpm dev` use separate databases. (Since 2026-10-20 the pod reads only its environment — a Secret without the
    admin-only keys, and a ConfigMap — and `pnpm dev` has a database file of its own.)
  - Failed browser navigations (sign-in, arming, report downloads) land on a public problem page with only a code,
    reference and Microsoft code in the URL; the copy lives in the web app.
  - Deferred (backlog): session-id rotation on arm, keyed audit anchor, re-validating definitions on load — all three
    done in the platform review (2026-10-21, below).

- **Two delegated apps** (Read, Write) plus an **automation** app for schedules (ADR-002, ADR-011).
- **Provisioning grants exactly the baseline ∪ content-declared scopes**; `adminforge validate --scopes` reports drift. Remaining drift is limited to unlicensed workloads (Exchange, Teams, SharePoint).
- **Preview-then-confirm** for risky playbooks is enforced by the API (not only the UI).
- **Show-once secrets** (TAPs, passwords, app secrets) are never persisted.
- **Advanced filters** are structured data compiled server-side to quoted OData/KQL.
- **Runner** requests are HMAC-signed over timestamp, method, path, and body hash.

## Content and monitoring (2026-10-17)

- **A failed check explains itself.** Probes carry `remedy` (what to do) and `link` (where to act); their detail on
  Synthetic monitoring shows the rows behind the result. Those rows were collected with application permissions, so
  they stay Operator-only and never go into the message every Reader sees (an aggregate such as the most common
  sign-in error code is allowed). Rejected: naming the items in the message — it would hand app-permission data to
  Readers. Every active probe must have a remedy (content test).
- **Services get parent sections.** Exchange Online, SharePoint Online and Teams moved out of Microsoft 365 (their
  pages keep `m365.*` ids so links, schedules and saved views keep working); Azure Virtual Desktop and Azure Billing
  are sections of their own. A section's checks are probes with `group: <section>`.
- **Retire, don't delete.** Function Apps and Azure Arc-enabled Kubernetes were retired (owner: the estate is AVD and
  thousands of hybrid Arc servers): `status: retired` with a version bump keeps their history in git and the database,
  publishing retires them, and `docs/backlog.md` says how to bring them back. The generic `functionHealth` probe and
  `function` datasource stay.
- **Resource Graph's join limit is enforced before Azure sees the query.** Azure allows three `join`/`union`
  operations and one join to another table unless all are `resources` ↔ `resourcecontainers`. When rows already join
  another table, subscription names come from a small `resourcecontainers` datasource joined with `$attach`. Trade-off:
  that list now has a transform, so its export is no longer streamed — it is complete up to the datasource's
  `maxItems` (50,000 / 20,000), and a scale test holds the join to the 250 ms budget at that size. Rejected: showing
  subscription ids only.
- **No eval in the browser, Zod included.** The CSP keeps `script-src 'self'` without `unsafe-eval`; Zod 4 probes
  `Function('')` to decide whether to compile validators, so the web app sets `jitless` before anything validates
  (`disableEvalProbe`). Validators run interpreted in the browser (fast enough for its payloads); the API keeps
  compiled ones. Rejected: allowing `unsafe-eval`.

## Storage and deployment (2026-10-20)

- **One SQLite file on a PersistentVolume, owned by one process** (ADR-016; owner decision — PostgreSQL rejected). The
  API process is also the run worker and the scheduler; the separate services and `RUN_WORKER_IN_PROCESS` /
  `SCHEDULER_IN_PROCESS` are gone. What Postgres did between processes became tables: `run_jobs` (pg-boss),
  `signals` (LISTEN/NOTIFY), `leases` (advisory locks); append-only rules are SQLite triggers. Trade-off: SQLite has
  no roles, so whoever can write the volume can drop the triggers — tamper evidence is the hash chain and its
  checkpoints in the container log, which must be shipped off the cluster.
- **Write transactions are synchronous** (`writeTx`, `BEGIN IMMEDIATE`): nothing is awaited inside one, so writers
  never interleave, also across processes. `tests/guards/sqlite-only.test.ts` refuses async transaction functions,
  Postgres-only SQL and the `pg` driver outside the one-time importer.
- **Kubernetes only, one pod** (ADR-017): one replica, `Recreate`, the runner as a sidecar on the pod's loopback, a
  ReadWriteOncePod volume on block storage. Trade-off: a deploy is a short outage, and there is no scaling out — fine
  for about 50 engineers at once. Rejected: keeping the systemd host deployment as a second path to maintain.
- **Content is published from the image** (`kubectl exec … adminforge publish`); the image's `BUILD.json` records
  whether its content was reviewed, since there is no git checkout in the pod.
- **The data moves once** with `adminforge db import-postgres`: the audit chain is re-verified and its tail must equal
  Postgres'; signed-in sessions are not copied, so everyone signs in again.

## Platform review (2026-10-21)

The review's plans and their full decision table are in `docs/plans/2026-10-21-platform-review-implementation.md`.
The ones that change how AdminForge behaves for people and operators:

- **Restarts don't cancel runs** (D-01). A stop lets each run reach its next checkpoint (10 s, then the step in flight
  is interrupted); the next process resumes it — an interrupted step is retried, or the run ends `needs_review` if the
  step is `idempotent: false`. A person's cancel still cancels. Rejected: cancelling on every deploy (runs lost to
  routine upgrades).
- **At most 5 open runs per person** (F-08, `RUN_MAX_OPEN_PER_USER`): previews count, a bulk run counts once, runs
  parked on an approval, input, write access or a sign-in don't; the worker default rose from 4 to 8.
- **Missed and file-only schedule runs** (F-09, F-10). A time missed by more than an hour is a `skipped` run with code
  `schedule_missed` (the status list is unchanged, so no table rebuild), audited. Run now on a disabled schedule writes
  the file only — no email, Teams post or notification — and says so.
- **A new session id at every arm** (S-08). Arming moves the session, its unfinished runs, round trips, token
  partitions and held secrets to a new id and CSRF token in one transaction; extending and disarming keep the id. Runs
  bound while the session was read-only ask to be resumed before they write, and their page says why; they aren't
  asked for a typed confirmation again (a confirmed run that hasn't written is refused `preview_stale` 15 minutes
  after its preview anyway, and resuming needs the person's own armed session). Confirming a manual step with writes
  after it needs write access, as approving does.
- **A run that paused reads and checks again before its next write** (`engine.ts` › `recheck`). After an approval,
  input, arming, a sign-in, a `wait` or a restart, the reads, transforms and asserts since the last write sent in
  their scope run again right before the next write — as who ran them, their reads with the access of the person the
  write runs as — and the write's own `when` and the approvals' `excludes` are worked out again. What the run decided
  stays decided (input, approvals, the `when` of reads and checks, branch arms, forEach items), so guards are `assert`
  steps; writes already sent and what was read before them are never repeated. A check that fails stops the write;
  one that fails before a write that may already have gone out ends `needs_review`, since the first send may be why it
  fails. Approvals can't be stepped over (`onError: continue` is refused on them).
- **Keyed audit chain, optional until the owner sets it** (S-10). `AUDIT_CHAIN_KEY` (in the Secret, never on the
  volume) makes the chain HMAC-SHA256 from a cut-over event; `AUDIT_CHAIN_KEYED_SINCE` pins the cut-over; the shipped
  container log's checkpoints stay the anchor for the newest events, so log shipping is required. Once set, the key can
  be rotated, not removed. Without it nothing changes, and `/readyz`, Settings and `env check` say so.
- **Someone else's run shows what ran, not what it found** (S-25). A delegated run collected its data with one person's
  rights, so its inputs, outputs, requests, logs and error details go only to its initiator, its approvers, the person
  a manual step waits for, and Portal Admins; others see metadata. "Asked to approve" means a pending, unexpired gate
  the person may decide (with the default `approvers: [Playbook.Approver]`, every Approver who may open the run);
  "decided" includes rejecting, and someone who decided keeps full access. Scheduled runs stay whole for every viewer.
- **A read-mode POST must say so** (S-23): a connection's `mode: read` operation may POST unarmed only with
  `readPost: true`, reviewed as a loosening; read operations can no longer PUT, PATCH or DELETE, and content can't set
  method-override headers.
- **Write actions stay clickable while unarmed** (D-18): a lock glyph and "Arm write access to run this" — the drawer's
  preview works without write access. The eight "Service checks" navigation items folded into a status mark on each
  section's row (D-14), and the content Probe dashboard is retired in favour of `/monitoring` (B-3).
- **Bulk actions confirm by typing from medium risk up** (whole-branch content review S6): one click is easy to give
  without reading and applies to every selected row, so a playbook offered as a bulk action of risk `medium` or higher
  asks for a typed value — in bulk, the number of items; low-risk bulk actions may click
  (`tests/content/high-risk-typed-confirm.test.ts`). Rejected: typing only from high risk (`endpoint.restart-device`
  restarted up to 100 devices on one click).
- **Content folders follow ids** (O-05): `validate` refuses a definition outside the folder its id prefix names, and
  `adminforge list` finds a section's content wherever it is filed; nothing moved.

- **A retired key says so.** `GET /api/definitions/:kind/:key` and a page's data answer 409 `definition_retired` for
  a key whose latest version is retired (on the files and in the database), with the retirement note — the first
  sentence of a summary written `Retired — <why, or what replaced it (its id)>. …` — and where to go instead, only to
  people whose roles may open it (others get the 403 a current version would give); exact versions still load for
  run history. No `successor` field: the note names the replacement, which is enough for the person. A key never
  published is 404 with a hint for the person (no CLI command).
- **Browsers learn that content changed, not what.** `definitions.changed` carries `{all: true}`, never the keys:
  they named definitions the person's roles may not open. The web app refetches its content on any change anyway.
  Rejected: filtering keys per session by `requires.portalRoles` (an async lookup per change and per key for no gain
  in the browser).
- **One content schema version, bumped only for breaking schema changes.** `CONTENT_SCHEMA_VERSION`
  (`@adminforge/schemas`, `schema-version.ts`) is a single integer for every kind; `adminforge publish` stamps it on
  each definition row (`definitions.schema_version`, a plain `ADD COLUMN … DEFAULT 1`: no table rebuild, rows from
  before are version 1) and `publish --dry-run` lists the rows stamped with an older one. **Bump it in the same change
  when a schema change is not backward-compatible** — a definition that validated before may no longer validate (a
  field removed, renamed, narrowed or made required, an enum value dropped, a default whose meaning changes); additive,
  optional changes keep it. After such an upgrade, publish the content again. Rejected: a version per kind (more to
  keep in step for no gain at this size) and refusing every row under an older version (the load-time check below
  already refuses exactly the rows that no longer pass).
- **Published rows are re-validated when loaded.** The API parses each row with its kind's current schema the first
  time it loads it (remembered by sha256 and body) and requires the body to name its own row's kind, id, version and
  retired-or-not status; a row that fails is refused — one log line, a `problems()` entry the content health check
  reports, and 500 `definition_unavailable` for the person — and never runs. The sha256 is of the YAML source, so it
  can't be recomputed from the body: the check is the schema, not the hash. It covers what bypasses `publish`
  (`db import-postgres`, a restored file, anything with the volume), not an attacker who writes a valid weaker
  definition there — the audit chain and volume access are the controls for that. Schedule approvals fingerprint the
  source sha256, so a schema-version bump alone doesn't ask for them again.
- **Publish checks review against origin as it is now.** On a checkout `adminforge publish` asks origin
  (`git ls-remote origin refs/heads/main`) instead of trusting a local `origin/main`, which may be stale or set by
  hand; origin out of reach counts as unreviewed. `build-images.sh` runs `git fetch origin refs/heads/main`
  (read-only; the full ref, so a tag called `main` can't stand in) before it computes `reviewed`, stops when the fetch
  fails, and records the fetched commit (`mainCommit`) and origin's URL without credentials (`remote`) in
  `BUILD.json`; a record without `mainCommit` is not trusted. Both ignore local replace refs and grafts. `BUILD.json`
  is still self-asserted by whoever builds the image (a hand-run `docker build` can claim anything), hence the CI
  decision below. The `content.published` audit event carries the content commit, `mainCommit` and `remote`. In the
  pod the actor is the image's user: **`pods/exec` on the AdminForge namespace is the publish boundary**, and the
  Kubernetes audit log names the person. Later (owner decision): images built and pushed only by CI from `main`.

## Validation tenant specifics (not tenant identifiers)

- No Microsoft 365 / Entra P1/P2 / Intune / Defender licences; see `docs/licensing-review.md`.
- Security Defaults on → TOTP registration for the validation user.
- A capped Log Analytics workspace (0.1 GB/day) and activity-log export were provisioned for KQL validation (`adminforge provision azure-test --destroy` removes them).
