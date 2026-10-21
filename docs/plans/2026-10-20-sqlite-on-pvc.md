# SQLite on a persistent volume, Kubernetes-only deployment — design and implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** AdminForge keeps all of its state in one SQLite file on a Kubernetes PersistentVolumeClaim instead of
PostgreSQL, and ships as a container image plus Kubernetes manifests (the systemd host deployment is retired).

**Architecture:** One pod, one replica (`strategy: Recreate`): the `api` container runs the API, the run worker and the
scheduler in one Node process that owns the SQLite file (WAL mode) on a ReadWriteOnce block-storage PVC; the PowerShell
runner is a sidecar on `127.0.0.1`. Everything Postgres gave us across processes — pg-boss, LISTEN/NOTIFY, advisory
locks, plpgsql triggers, role separation — is replaced by SQLite tables (jobs, signals, leases), SQLite triggers, and
file-level checks. A one-time importer copies the current Postgres data (audit chain included) into a new SQLite file.

**Tech stack:** better-sqlite3 (synchronous, WAL) + drizzle-orm `sqlite-core` / `better-sqlite3` driver and migrator,
drizzle-kit (`dialect: 'sqlite'`), Node 24, kustomize manifests, the existing runner image.

**Owner decisions (2026-10-20):** SQLite on a PVC, not Postgres. Kubernetes only — the host's systemd units, Caddy,
service-account installer, Postgres container/hardening and backup timer are removed; this host stays on the current
Postgres build until the cluster exists. Existing data is imported once (`adminforge db import-postgres`).

---

## 1. Design

### 1.1 Why one process

- SQLite allows one writer at a time; a ReadWriteOnce disk attaches to one node. Two pods writing one file is not an
  option, so the Deployment is `replicas: 1`, `strategy: Recreate` (a deploy is a short outage, measured in seconds).
- The API process already could run the worker (`RUN_WORKER_IN_PROCESS`) and the scheduler (`SCHEDULER_IN_PROCESS`).
  These become the only mode: with a database the API always runs both. The separate worker entry (`worker.ts`) and
  the scheduler's service mode are removed; the scheduler's one-shots (`--once`, `--probe`, `--schedule`) stay (they
  enqueue into the shared job table and the API's worker runs them).
- Show-once secrets never touch disk: the secret broker becomes in-memory only (the worker is in the same process).
- About 50 concurrent users (memory: expected-concurrency) is well within one process.

### 1.2 Storage

| Postgres feature                         | SQLite replacement                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pg.Pool`, drizzle `node-postgres`       | one better-sqlite3 connection per process, drizzle `better-sqlite3`                              |
| `uuid` / `timestamptz` / `jsonb` / `json` | `text` (randomUUID) / `integer` ms (`timestamp_ms`) / `text` JSON (`mode: 'json'`) — key order kept |
| `text[]` + GIN                           | JSON text arrays, queried with `json_each`                                                       |
| `bigserial`                              | `integer primary key autoincrement` (never reused — audit seq stays monotonic)                   |
| async transactions + advisory xact locks | synchronous `BEGIN IMMEDIATE` transactions (serialised writers; no `await` inside)               |
| pg-boss (`stately`, retries, heartbeats) | `run_jobs` table: one queued + one active row per run, leases, backoff, earliest `startAfter` wins |
| `pg_try_advisory_lock` (scheduler, runs) | `leases` table (name, holder, expires_at) renewed while held                                    |
| LISTEN/NOTIFY                            | in-process delivery + `signals` table polled via `PRAGMA data_version` (CLI publish → API, one-shots) |
| plpgsql append-only triggers             | SQLite `BEFORE` triggers with `RAISE(ABORT)`; the deferred delete check becomes immediate (retention deletes the run first) |
| least-privilege roles, TLS to the DB     | file checks: absolute path, 0600 file / no world access, local filesystem (statfs refuses NFS/SMB/FUSE) |
| `pg_dump` backup timer                   | `adminforge db backup` (online backup API, credential tables emptied, VACUUM) + CSI volume snapshots |

Pragmas per connection: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout`
(`DATABASE_BUSY_TIMEOUT_MS`, default 15 000), `trusted_schema=OFF`, `secure_delete=ON` (deleted sessions/tokens are
zeroed), `temp_store=MEMORY`.

**Security trade-off (ADR-016, SECURITY.md):** a SQLite file has no roles — whatever can write the volume can drop the
triggers and rewrite rows. The triggers stop the application changing history by mistake; tamper evidence is the hash
chain and its checkpoints in the container log (forward it off-cluster). The volume is reachable only by the pod
(RWO/RWOP, non-root, fsGroup) and the file is 0600.

### 1.3 Configuration

- New: `DATABASE_PATH` (absolute path of the SQLite file; required in production and with `CONTENT_SOURCE=db`),
  `DATABASE_BUSY_TIMEOUT_MS`.
- Removed: `DATABASE_URL`, `DATABASE_POOL_MAX`, `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_LOCK_TIMEOUT_MS`,
  `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DATABASE_MIGRATION_URL`, `POSTGRES_PASSWORD` and the `*.owner.env`
  files, `RUN_WORKER_IN_PROCESS`, `SCHEDULER_IN_PROCESS`, `TEST_DATABASE_URL`.
- In the pod, configuration comes from the environment (`envFrom` a Secret made from the env file); process
  environment already wins over env files (`loadEnv`).

### 1.4 Kubernetes

`portal/deploy/kubernetes/` (kustomize):

- `base/`: Deployment `adminforge` (replicas 1, Recreate, `automountServiceAccountToken: false`, pod `fsGroup`,
  `seccompProfile: RuntimeDefault`; containers `api` and `runner`, both non-root, read-only root filesystem, all
  capabilities dropped; `/tmp` emptyDirs; startup/liveness `/healthz`, readiness `/readyz`; the `api` container runs
  migrations at start), PVC `adminforge-data` (ReadWriteOncePod, 10 Gi, block storage), Service (ClusterIP),
  ConfigMap (non-secret settings: `NODE_ENV`, `DATABASE_PATH`, artifacts dir, runner URL, ports), NetworkPolicy.
- `overlays/example/`: Ingress with TLS for `adminforge.example.com`, the storage class line for AKS
  (`managed-csi`), the image names — copied and edited per installation (nothing tenant-specific in git).
- Images: `portal/deploy/kubernetes/Dockerfile` (API + web + CLI + content, non-root, native better-sqlite3 built in
  the build stage) and the existing runner image. `build-images.sh` records the reviewed commit in the image
  (`/app/BUILD.json`), which `adminforge publish` inside the pod accepts as the review state (no `.git` there).
- Publishing content: `kubectl exec deploy/adminforge -c api -- adminforge publish`.
- Moving the data: `adminforge db import-postgres` on the old host writes `adminforge.db`; a loader pod (manifest in
  the overlay) mounts the PVC while the Deployment is scaled to 0; `kubectl cp` the file; scale back to 1.

### 1.5 What is removed

`portal/deploy/{systemd,caddy,backup,db,lib}`, `install-units.sh`, `install-service-account.sh`,
`docker-compose.dev.yml`, `defaults.env`, root scripts `db:up`/`db:down`/`db:harden`, the pg migrations
(`portal/apps/api/drizzle/*` — replaced by a new SQLite baseline), `pg`/`pg-boss` from the API, scheduler and runner
(the CLI keeps `pg` for the importer only), the pg-only tests (role/hardening/compose/installer/backup-script).

---

## 2. Tasks

Each task ends with its focused tests green and a commit (Conventional Commits; scopes from
`tooling/git/commit-message.mjs`).

### Task 1 — SQLite core: client, schema, migrations, triggers

**Files:** modify `portal/apps/api/src/db/{client,schema,migrate}.ts`, `portal/apps/api/drizzle.config.ts`,
`portal/apps/api/package.json`, `pnpm-workspace.yaml` (`allowBuilds: better-sqlite3`); replace
`portal/apps/api/drizzle/` with `0000_baseline.sql` (drizzle-kit generate) + `0001_append_only.sql` (custom).
Create `portal/apps/api/src/db/{signals,leases,file-check}.ts`.

- `openDatabase(path, { busyTimeoutMs, readonly })` → `{ db, sqlite, path, signals, ping, close }`; creates the
  directory 0700 and the file 0600 before SQLite opens it; tightens existing files to 0600.
- `checkDatabaseFile(path)` → problems (relative path, world access on file/dir, network filesystem by `statfs` type);
  `assertDatabaseFile` refuses to start in production, warns in development (replaces `assertDatabaseRole`).
- `Signals`: `publish(channel, payload)` (in-process listeners at once; a row in `signals` for other processes),
  `on(channel, fn)`, `onResync(fn)`, poller (`PRAGMA data_version`, 500 ms), `prune(olderThan)`.
- `Leases`: `tryAcquire(name, holder, ttlMs)`, `renew`, `release`.
- Triggers: audit append-only (UPDATE/DELETE), approvals insert-pending, fixed fields, decisions append-only/unchanged,
  rebind-own-session, decided-final, delete-only-with-subject.

**Tests:** `tests/api/db-sqlite-triggers.test.ts`, `tests/api/db-signals.test.ts`, `tests/api/db-leases.test.ts`,
`tests/unit/api/db-file-check.test.ts`, update `tests/unit/api/db-status-checks.test.ts`, new `tests/api/db.ts`
helper (temp file, migrated).

### Task 2 — Stores and repositories on SQLite

Port, renaming `Pg*` → `Sqlite*` and `pg-*.ts` → `sqlite-*.ts`: audit writer (sync immediate transaction, no lock
SQL), session store (token-cache purge with `exists`), preauth, token cache, prefs, settings, views, heartbeat,
definitions store (publish in one immediate transaction + `definitions_changed` signal), registry (signals instead of
LISTEN; resync drops the cache), run repository (recursive CTE kept; tasks upsert in an immediate transaction;
`tryLock` via leases; events + `run_events` signal in one transaction), schedule store (`count(*) filter`,
`row_number()` instead of `DISTINCT ON`), schedule grants, news store (JSON arrays via `json_each`, `LIKE … ESCAPE`,
dates as ms), retention (runs before their approvals), audit query (`like` is case-insensitive).

**Tests:** port every `tests/api/*-pg.test.ts` to `*-db.test.ts` on the temp SQLite helper (they no longer skip).

### Task 3 — Queue, events, secrets, topology

- `SqliteRunQueue` (`run_jobs`): `enqueue` (upsert queued row, earliest start wins), `work` (poll 1 s + immediate wake
  in-process, claim in an immediate transaction, lease 90 s renewed every 30 s, AbortSignal), retries with backoff
  (5 s doubling to 300 s, 50 attempts), expired leases requeued, `stop` graceful.
- `RunEventBus`, platform `EventBus`, `ScheduleEvents` on `Signals`; `SecretBroker` memory-only; `PgListener` removed.
- Leader election on a lease (`scheduler`, 30 s TTL, 5 s interval).
- API always consumes jobs and runs the scheduler with a database; remove `worker.ts`, the scheduler service mode,
  `RUN_WORKER_IN_PROCESS`, `SCHEDULER_IN_PROCESS`; one-shots stay.

**Tests:** `tests/api/run-queue-sqlite.test.ts` (dedupe, earliest start, retry/backoff, lease expiry, two consumers
never drive one run), port leader tests, events/secrets tests.

### Task 4 — Configuration and CLI

- `config.ts`: `DATABASE_PATH`, `DATABASE_BUSY_TIMEOUT_MS`; production rules; drop pg keys and TLS check.
- `@adminforge/config`: drop owner env files/keys. `config/example.env`, `adminforge env check`.
- CLI: `publish` and `audit verify` on `DATABASE_PATH`; errors for SQLite (`SQLITE_CANTOPEN`, `SQLITE_BUSY`, …);
  review state from `/app/BUILD.json` when there is no git checkout; new `adminforge db backup <file|->` and
  `adminforge db import-postgres --from <url> [--to <path>]` (refuses a non-empty target; skips sessions, sign-in
  round trips and session token partitions; keeps schedule grants' sealed tokens; recreates the append-only triggers
  from the migration; verifies the audit chain and prints its tail checkpoint).

**Tests:** config tests, `tests/unit/cli/db-backup.test.ts`, `tests/api/import-postgres.test.ts` (skips without a
reachable Postgres; uses a schema fixture), publish/audit CLI tests.

### Task 5 — Images and manifests

`portal/deploy/kubernetes/{Dockerfile,Dockerfile.dockerignore,build-images.sh,README.md,base/*,overlays/example/*}`;
CLI and scheduler bundles; entrypoint runs migrations then the API.

**Tests:** `tests/guards/kubernetes-manifests.test.ts` (single replica, Recreate, RWO/RWOP, non-root, read-only root,
no privilege escalation, runner on loopback, DATABASE_PATH on the volume, pinned images, no tenant values); a local
`docker build` + `docker run` smoke test (migrate, `/healthz`, `/readyz`, publish, backup) with a host directory as
the volume.

### Task 6 — Remove the host deployment and Postgres

Delete the files in §1.5 and their tests; drop `pg`/`pg-boss`; root scripts; `pnpm install` updates the lockfile.

### Task 7 — Documentation

ADR-016 (SQLite on a PVC; supersedes ADR-004), ADR-017 (Kubernetes, one pod; supersedes ADR-008), SECURITY.md,
`docs/{architecture,operations,troubleshooting,api,decisions,backlog,performance}.md`, onboarding, CLAUDE.md,
README.md, `.claude/skills/*` that mention Postgres, `tests/README.md`, `tests/live/README.md`, CHANGELOG.md.

### Task 8 — Verification

`pnpm typecheck`, `pnpm lint`, `pnpm format:check` (via `rtk proxy`), `pnpm test`, `pnpm guard`,
`pnpm adminforge validate`, `pnpm adminforge test`; import the dev Postgres (`adminforge_dev`, not the services'
database) into a scratch SQLite file and verify its chain; reviewer agents (`security-reviewer`, `content-reviewer`
where content changed). What could not be checked (a real cluster, AKS storage classes, Ingress) goes to
`docs/backlog.md`.

---

## 3. Outcome (2026-10-21)

All eight tasks done on branch `feat/sqlite-on-pvc`. Beyond the plan:

- `db import-postgres` reads Postgres in one `REPEATABLE READ` snapshot and pages on the table's own columns (a
  `seq::text` alias would have sorted `'99'` after `'679'` — found by importing the dev database).
- A run's lock lapsing now aborts the run at its next checkpoint (`lost` signal), so a stalled holder can't keep
  driving a run another worker took over.
- `RUN_WORKER_CONCURRENCY` reaches the API's own worker (it was read only by the removed worker entry).
- The API checks the database's location before it creates or migrates anything.
- New files get incremental auto-vacuum; housekeeping hands freed pages back after retention.
- The app image is 573 MB (production dependencies only, one prebuilt binary).

Verified: the test suites (every database-backed suite on SQLite), lint, types, the app image with `docker run`
(read-only root, no capabilities, named volume: migrate, `/readyz`, publish from another process reaching the API's
cache, backup to stdout, a one-shot probe, refusal of a world-writable volume), the importer against a synthetic
Postgres and the dev database. Not verified (no cluster): see `docs/backlog.md` → "SQLite on a PersistentVolume,
Kubernetes".
