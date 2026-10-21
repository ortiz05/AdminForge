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
  the audit log is never purged); applied by the API every 6 hours and audited.
- **Delivery:** email through Graph `sendMail` as the automation identity from `AF_MAIL_SENDER`; Teams through
  Workflows webhooks on Microsoft hosts only; recipients and webhooks are always `${ env.X }` configuration. Failure
  alerts fire only when no retry is left. Approval requests notify `AF_APPROVALS_EMAIL` / `AF_APPROVALS_TEAMS_WEBHOOK`.
- **Self-monitoring:** the run worker and the scheduler (both in the API process since ADR-016) write heartbeats; `/readyz` reports `degraded` when either goes quiet,
  which the portal-readiness probe catches. `probes.audit-chain` re-walks the audit chain hourly. Every Microsoft call
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
  - Deferred (backlog): session-id rotation on arm, keyed audit anchor, re-validating definitions on load.

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

## Validation tenant specifics (not tenant identifiers)

- No Microsoft 365 / Entra P1/P2 / Intune / Defender licences; see `docs/licensing-review.md`.
- Security Defaults on → TOTP registration for the validation user.
- A capped Log Analytics workspace (0.1 GB/day) and activity-log export were provisioned for KQL validation (`adminforge provision azure-test --destroy` removes them).
