# ADR-016: One SQLite file on a persistent volume holds all state

Status: accepted (2026-10-20); supersedes ADR-004

## Context

The deployment target is Kubernetes, and the owner's requirement is that the database is a file on a PersistentVolume
— SQLite, not PostgreSQL. AdminForge's load is small (about 50 engineers at once), but it leaned on Postgres for more
than storage: pg-boss for the run queue, LISTEN/NOTIFY between the API, worker and scheduler processes, advisory locks
for the scheduler's leadership and per-run locks, plpgsql triggers for the append-only audit log and approvals, and
least-privilege roles so the services could not drop those triggers.

SQLite has one writer at a time, its locking needs a local file system, and a ReadWriteOnce disk attaches to one
node. So one process must own the file.

## Decision

- **One process owns the database.** The API process is also the run worker and the scheduler (the separate worker
  service and the scheduler service are gone; `RUN_WORKER_IN_PROCESS` / `SCHEDULER_IN_PROCESS` with them). The
  scheduler one-shots and the CLI may open the same file beside it (WAL mode, `busy_timeout`).
- **better-sqlite3** with drizzle `sqlite-core`: synchronous statements; write transactions are synchronous
  `BEGIN IMMEDIATE` (`writeTx`), so no await can interleave inside one and two processes never deadlock on a lock
  upgrade. Pragmas: WAL, `synchronous=FULL`, `foreign_keys`, `secure_delete`, `trusted_schema=OFF`.
- **Shapes** (db/schema.ts): text UUIDs, integer-millisecond instants, JSON text (authored key order kept), JSON array
  lists, 0/1 booleans. A new migration baseline replaces the Postgres migrations.
- **Replacements:** the `run_jobs` table is the queue (one queued + one active job per run, leases, backoff, earliest
  start wins); the `leases` table replaces advisory locks (the scheduler's leader lease; per-run locks that tell their
  holder when they lapse); the `signals` table plus in-process delivery replaces LISTEN/NOTIFY for what crosses
  processes (the CLI's `publish` → the API's definition cache; one-shots → browsers); show-once secrets never leave
  the process (they no longer cross to an API process, sealed or not).
- **Triggers** keep audit events append-only and approval decisions append-only and final, as in Postgres; the
  deferred "approval deleted only with its run" check became immediate, so retention deletes the run first.
- **The file's protection** replaces role separation: the directory 0700, the file and its -wal/-shm 0600, owned by
  the service user, on a local file system — production refuses to start otherwise (statfs refuses NFS, SMB/Azure
  Files, FUSE). In Kubernetes: ReadWriteOncePod, non-root, no service-account token, a NetworkPolicy (ADR-017).
- **Backups:** volume snapshots, and `adminforge db backup` (online backup, credential rows removed, verified, 0600;
  encrypted off-cluster). **Data from the Postgres releases** moves once with `adminforge db import-postgres`, which
  verifies the imported audit chain against Postgres' tail.

## Consequences

- No horizontal scaling and no rolling updates: one replica, `Recreate`. Fine for the expected load; a deploy is a
  short outage.
- **Weaker tamper resistance for the audit log.** In Postgres the services' role could not drop the append-only
  triggers; anyone who can write the SQLite file can. The triggers now only stop the application rewriting history by
  mistake. Tamper evidence is unchanged — the hash chain and its checkpoints in the container log — so those logs must
  be shipped off the cluster (SECURITY.md).
- Dev needs no Docker database: `init:local` writes `DATABASE_PATH=~/.local/share/adminforge/dev.db`, the API creates
  and migrates it. Every database-backed test suite runs everywhere on a temporary file.
- Restore needs the same things as before: the database (snapshot or copy), the env file / Secret with
  `TOKEN_CACHE_KEY` and the app credentials, report files (on the same volume), the automation certificate.
