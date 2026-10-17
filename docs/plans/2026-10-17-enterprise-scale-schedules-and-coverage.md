# Enterprise scale, schedule identities, plain-English times and coverage

Owner's goal (2026-10-17): every page that loads data from Microsoft Graph stays fast and correct for a large
enterprise and for thousands of engineers at once; the Postgres database is set up correctly for what it holds; a
schedule can run as a user or as an app registration; schedule times read and are entered as plain English; more
reports and schedules for engineers; a fuller test tenant; and the situations an enterprise meets are listed and
checked for accuracy. Out of scope: the Microsoft Defender portal (retired the same day, `docs/licensing-review.md`).

Inputs: four read-only surveys on 2026-10-17 (Graph data loading, schedules, Postgres, report and tenant inventory).
Their findings are summarised per phase below; file:line detail lives in the commits that act on them.

## How we work

Same rules as the earlier rounds: content first, tests under `tests/`, nothing tenant-specific in git, live writes only
on `AF-Test-*` objects provisioning created, `--dry-run` before every tenant change, one logical change per commit,
reviews (security, design, content) before each deploy. Phases A–D and E run in parallel streams with disjoint files;
F and G follow the areas they test.

## Phase A — Graph data loading at enterprise scale

Target tenant: 100k users, 50k groups, 30k managed devices, 1M sign-ins a day, groups of 100k members; 2,000 engineers
signed in, 200 of them loading pages at the same moment.

- **A1 Audit and fix every datasource.** Rank all page, dashboard and report datasources by risk at that scale:
  `paging: all` over big collections, transforms that filter or count whole collections (250 ms budget), filters in a
  transform instead of `$filter`, missing `$select` / `$top`, counting rows instead of `$count` (with
  `ConsistencyLevel: eventual`), per-row calls, unbounded sign-in or audit windows, dashboards that read a collection
  only for a KPI. Fix each one with the server-side form (Graph `$filter`/`$count`/`$search`, reports API, Resource
  Graph or KQL summaries) and record what can't be fixed in `docs/backlog.md`.
- **A2 A synthetic enterprise tenant.** A deterministic generator (seeded) and a fake Microsoft Graph that serves it
  with real paging (`@odata.nextLink`, 999-item pages), the OData subset content uses (`$filter`, `$select`, `$top`,
  `$count`, `$search`, `$orderby`, `$expand`), latency and throttling (429 with `Retry-After`). Every datasource runs
  against it in a new test project with budgets: Graph calls, bytes, wall time, transform time and peak memory per
  datasource. Regressions fail the build.
- **A3 Load.** Many concurrent signed-in sessions against the API (mock auth, the fake Graph) measuring p50/p95/p99,
  outbound concurrency queues, cache hit rates, request coalescing of identical concurrent reads, the rate limit, the
  database pool. Fix what saturates first; document the sizing guide in `docs/operations.md`.
- **A4 Browser.** Tables with 10k–100k rows stay virtualised and filter without blocking the main thread; bundle
  budgets hold (`tooling/ci/check-bundle.mjs`); page load timings recorded by the e2e suite.

Done when every datasource has a budget test against the synthetic tenant, the load test meets its targets on this
host, and the sizing guide is written.

## Phase B — Postgres set up for its intent

The repo design is sound (a separate runtime role, an append-only audit table enforced in the database, a sealed token
cache, retention jobs); the host undoes much of it. Findings, most severe first:

| #   | Finding                                                                                                                                                        | Where       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| C1  | The service account is in the `docker` (and `sudo`, `lxd`, `adm`) groups and the container trusts local connections: any process as that user is superuser    | Host        |
| C2  | The database owner is the bootstrap superuser, and its password and URL are in files the services read; `pg_hba` accepts it over TCP                           | Host + repo |
| H1  | Backups are unencrypted, on this host only, and include every secret in the env files                                                                          | Host + repo |
| H2  | The audit hash chain is unkeyed and not anchored outside the database                                                                                          | Repo        |
| M1  | No `statement_timeout` / `idle_in_transaction_session_timeout` / `lock_timeout`; one stuck transaction stalls every audited action                              | Repo        |
| M2  | Server logging minimal (connections, DDL, lock waits, slow statements)                                                                                         | Repo (compose) |
| M3  | The root disk is 93% full (database, WAL, backups, Docker logs on one disk)                                                                                     | Host        |
| M4  | No WAL archiving: up to 24 h of data loss on disk failure                                                                                                       | Host        |
| M5  | The app role can edit approvals, definitions and schedules freely                                                                                               | Repo        |
| L1–L9 | In-container `trust` auth, SSL off / `sslmode` not enforced off-host, PUBLIC database rights, no connection cap, no foreign keys or CHECKs, GCM tag length not pinned and no key id, audit verification in memory, image tag not pinned, no hardening section in the docs | Repo / host |

- **B1 Repo:** a dedicated non-superuser owner role in the deploy scripts (`adminforge_owner`), owner credentials in a
  file the services never read, a startup refusal when the API connects as a superuser, timeouts and
  `application_name` on every pool, a configurable pool size and a connection cap, logging and `no-new-privileges` /
  limits / a pinned digest in the compose file, `pg_hba` rejecting the superuser over TCP, `REVOKE ALL … FROM
  PUBLIC`, backups that refuse to run unencrypted unless explicitly allowed (and never include the owner keys), foreign
  keys and status CHECKs, approval decisions append-only, GCM tag length pinned plus a key id for `TOKEN_CACHE_KEY`
  rotation, streamed audit verification with an external anchor (journald line per checkpoint), and a "Postgres
  hardening" section in `docs/operations.md`.
- **B2 Host:** create the owner role and move ownership, point migrations at it, apply timeouts/logging/`pg_hba`,
  rotate the superuser password, encrypt backups (needs the owner's GPG public key) and copy them off-host. C1 (a
  dedicated system user for the services, not in `docker`) and freeing disk space are host changes the owner decides.

## Phase C — Who a schedule runs as

Today every schedule runs as the one automation app registration. Add:

- **C1 Named app registrations.** `identity: automation | { app: <name> }`: more app-only identities, each with its
  own certificate (preferred) or secret, its own permission ceilings and protected ids, provisioned by `adminforge
  provision entra`, recorded on every run and audit event ("executed as app X"). A change of identity re-requires
  two-person approval for write schedules.
- **C2 A user account (delegated).** `identity: { user: creator }`: the schedule runs with the creator's own delegated
  read access through the Read app — never the Write app, so delegated schedules are read-only (reports, probes). The
  creator consents once per schedule; the refresh token is sealed in its own token-cache partition, kept while the
  schedule exists, and deleted with it or when the creator loses access. Roles are re-read before each run; a claims
  challenge, password reset or Conditional Access sign-in frequency puts the schedule in "needs sign-in" and tells the
  owner. ADR-014 records why (least privilege: the schedule sees only what the person may see) and the limits.
- **C3 The picker.** Schedule forms show "Run as": the automation identity, a named app registration, or "me" (with
  what each can read), and the schedule list shows who each runs as.

## Phase D — Times in plain English

- One shared describer (API and web today disagree and drop the time zone) that always names the zone and covers
  every shape the editor builds: every N minutes/hours, daily, weekdays, chosen weekdays, monthly on a day, the Nth or
  last weekday of the month, the last day of the month.
- The editor: those choices plus a free-text box with a small closed grammar ("every weekday at 7:00 am", "first
  Monday of the month at 8:30", "every 4 hours", "last Friday at 17:00") that produces cron, echoes the description back
  and shows the next five runs; a searchable list of every IANA time zone (default: the engineer's own).
- Content YAML may say `every: "weekdays at 07:00"` instead of `cron:`; validation compiles and rejects what the
  grammar can't express. Storage stays cron + time zone (no schema migration for existing schedules).

## Phase E — More reports and schedules for engineers

From the inventory (55 active reports) and the gap list, in value order: SAML signing certificate expiry, Intune
connector and token health (Apple push, ADE, VPP — the first endpoint probe), subscription renewals, BitLocker
recovery-key escrow, licence assignment errors per user, user attribute completeness, unused apps, group lifecycle,
Conditional Access report-only impact, Azure resource health, Windows update status, app protection coverage, Intune
deployment errors, access reviews, Windows LAPS coverage, authentication method strength, guest lifecycle, Microsoft 365
group activity, email authentication (DKIM) on every domain. Quick wins: schedules for stale and non-compliant
devices, one licence-utilisation report instead of two, one app-credential-expiry schedule, a probe for the tenant's
own SKUs instead of a fixed E3 one, and the subscription probe explaining itself while `AF_SUBSCRIPTION_ID` is unset.
Key Vault expiry, patch compliance and the other Azure items wait for a subscription (backlog).

## Phase F — A fuller test tenant

New opt-in fixtures for `provision test-identities` (`AF_TEST_FIXTURES`), all `AF-Test-*`, marked, removable with
`--remove-fixtures`, within the seat budget (11 of 25 at most):

- users with departments, job titles, usage locations, a manager chain (one disabled manager), disabled and
  attribute-less users, guests (one never redeemed);
- groups: dynamic, nested, Microsoft 365 with and without owners, empty, and a group-licensing group;
- an administrative unit (scopes the tester's User Administrator role);
- app registrations with expiring secrets and certificates, a risky configuration, no owner, and a SAML app whose
  signing certificate expires soon (credentials never stored);
- authentication methods (SMS-only with a fictitious number, a Temporary Access Pass);
- more Intune policies (iOS, Android, macOS, update ring, app protection), all assigned to AF-Test groups only;
- Exchange recipients through the runner (shared mailbox with sign-in enabled, room, distribution list with an owner);
- sign-in activity: scripted sign-ins of chosen test users (success, wrong password, disabled) so sign-in pages and the
  report-only Conditional Access results have data.

Not created (no API, tenant-wide, or the owner's call): real devices (needs an enrolled VM, plan 0.4), risk events,
hybrid sync, usage history, tenant-wide settings (sharing, group expiry, enrolment restrictions).

## Phase G — Enterprise situations and accuracy

- **A scenario catalogue** (`docs/enterprise-scenarios.md`): large and nested groups, guests, synced (hybrid)
  accounts, deleted objects, licences through groups, partial permissions (403 for one tab), Conditional Access and
  CAE challenges, throttling, eventual consistency right after a change, names with apostrophes and non-Latin
  characters, very long values, time zones and daylight saving, empty tenants and brand-new licences — each with the
  behaviour AdminForge must show and the test that covers it.
- **Synthetic checks:** every scenario that can be built in the synthetic tenant (A2) gets a test.
- **Live accuracy:** a script that, for every list page and report, compares what AdminForge shows with an independent
  Graph query against the validation tenant (counts, membership, flags) and reports differences by page — the Phase F
  fixtures make the answers known in advance.

## Owner decisions (none blocks the build)

1. Backups: the GPG public key to encrypt to, and where the off-host copy goes.
2. Host account separation (C1) and freeing disk space (Docker build cache and unused images hold about 11 GB).
3. `TeamSettings.Read.All` on the automation identity: remove it (`provision entra --prune`) or keep it.

## Order

Wave 1 in parallel: A1–A2, B1, D. Wave 2: C (after D, same forms), E, F. Wave 3: A3–A4, G, B2, deploy and live
validation. Each wave is reviewed, committed and deployed before the next one starts on the same files.
