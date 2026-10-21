import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { Signals, type SignalsOptions } from './signals';

export type Db = BetterSQLite3Database<typeof schema>;
/** A transaction handle (`db.transaction((tx) => …)`); it accepts the same query builders as `Db`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type SqliteConnection = BetterSqlite3.Database;

/**
 * One process's connection to the SQLite file (ADR-016). better-sqlite3 is synchronous: a statement runs to completion
 * before the event loop continues, so a transaction (`immediate`) can't interleave with another request's queries.
 * Never `await` inside a transaction — better-sqlite3 refuses a transaction function that returns a promise.
 */
export interface Database {
  db: Db;
  sqlite: SqliteConnection;
  /** Absolute path of the database file (`:memory:` in some tests). */
  path: string;
  /** Cross-process notifications (replace LISTEN/NOTIFY): `signals` table + in-process delivery. */
  signals: Signals;
  /** Cheap check for /readyz. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  /** How long a writer waits for another process's write lock before SQLITE_BUSY (DATABASE_BUSY_TIMEOUT_MS). */
  busyTimeoutMs?: number;
  /** Open read-only (`adminforge audit verify`). The file must exist. */
  readonly?: boolean;
  /** Poll other processes' signals (default true; one-shot CLI commands pass false). */
  pollSignals?: boolean;
  /** Process name in logs and signal origins (api, cli, scheduler). */
  name?: string;
  /** Tests: the signal poller's timer (polls are then driven with `signals.poll()`). */
  signalTimers?: Pick<SignalsOptions, 'setInterval' | 'clearInterval' | 'intervalMs'>;
}

export const DEFAULT_BUSY_TIMEOUT_MS = 15_000;

/**
 * Creates the directory (0700) and an empty file (0600) before SQLite opens it, so the database never exists with
 * wider permissions (SQLite gives its -wal and -shm files the mode of the main file). An existing file is tightened
 * to 0600 when this process owns it (a volume mounted with fsGroup may have added group bits).
 */
function prepareFile(file: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) closeSync(openSync(file, 'wx', 0o600));
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (existsSync(f)) chmodSync(f, 0o600);
    } catch {
      // Not ours to change: checkDatabaseFile reports it.
    }
  }
}

/** Per-connection settings. WAL lets readers (and the CLI in another process) run while one writer commits. */
export function applyPragmas(sqlite: SqliteConnection, opts: { busyTimeoutMs?: number; readonly?: boolean }) {
  sqlite.pragma(`busy_timeout = ${Math.trunc(opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`);
  // Space retention frees can be handed back (`reclaimSpace`). Only takes effect on a new, empty file — which is what
  // the API and `db import-postgres` start from.
  if (!opts.readonly) sqlite.pragma('auto_vacuum = INCREMENTAL');
  if (!opts.readonly) sqlite.pragma('journal_mode = WAL');
  // FULL: a committed audit event or approval survives a power cut, not only a process crash.
  sqlite.pragma('synchronous = FULL');
  sqlite.pragma('foreign_keys = ON');
  // REPLACE (an upsert that deletes the old row) must fire DELETE triggers too, or it would get past the append-only
  // rules on audit_events and approvals; with this on, it is refused like any delete.
  sqlite.pragma('recursive_triggers = ON');
  // Schema objects (triggers, views) may not call application-defined functions; we define none.
  sqlite.pragma('trusted_schema = OFF');
  // Deleted rows (sessions, sealed tokens, sign-in round trips) are overwritten, not left in free pages.
  sqlite.pragma('secure_delete = ON');
  sqlite.pragma('temp_store = MEMORY');
  // The WAL file is truncated back to this size after a checkpoint.
  sqlite.pragma('journal_size_limit = 67108864');
}

export function createDatabase(file: string, opts: DatabaseOptions = {}): Database {
  const memory = file === ':memory:';
  const resolved = memory ? file : path.resolve(file);
  if (!memory && !opts.readonly) prepareFile(resolved);
  const sqlite = new BetterSqlite3(resolved, {
    readonly: opts.readonly ?? false,
    fileMustExist: !!opts.readonly,
  });
  applyPragmas(sqlite, opts);
  const db = drizzle({ client: sqlite, schema });
  const signals = new Signals(sqlite, {
    origin: `${opts.name ?? 'api'}:${process.pid}:${randomUUID()}`,
    poll: opts.pollSignals ?? !opts.readonly,
    readonly: opts.readonly ?? false,
    ...opts.signalTimers,
  });
  let closed = false;
  return {
    db,
    sqlite,
    path: resolved,
    signals,
    ping: async () => {
      sqlite.prepare('select 1').get();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      signals.stop();
      sqlite.close();
    },
  };
}

/**
 * Lets the event loop run (HTTP, runs, schedules) between batches of synchronous database work: better-sqlite3 runs
 * a statement to completion, so `await` on a query yields only to microtasks.
 */
export const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Pages per `incremental_vacuum` step (4 MiB at SQLite's default 4 KiB page). */
export const RECLAIM_PAGES_PER_STEP = 1_000;
/** Longest one reclaim pass runs; the rest goes at the next one. */
export const RECLAIM_BUDGET_MS = 2_000;

/**
 * Hands free pages back to the file system after retention, `pagesPerStep` at a time with the event loop let in
 * between, until none are left or `budgetMs` is spent (`pending`: the next pass goes on). A no-op on a file created
 * before `auto_vacuum` was set (its free pages are reused, never returned).
 */
export async function reclaimSpace(
  sqlite: SqliteConnection,
  opts: { pagesPerStep?: number; budgetMs?: number; clock?: () => number } = {},
): Promise<{ pages: number; pending: boolean }> {
  const step = Math.max(1, Math.trunc(opts.pagesPerStep ?? RECLAIM_PAGES_PER_STEP));
  const budgetMs = opts.budgetMs ?? RECLAIM_BUDGET_MS;
  const clock = opts.clock ?? (() => performance.now());
  const startedAt = clock();
  let pages = 0;
  // 2 = INCREMENTAL; on NONE or FULL `incremental_vacuum` does nothing and the free list would never shrink.
  if (sqlite.pragma('auto_vacuum', { simple: true }) !== 2) return { pages, pending: false };
  const free = () => sqlite.pragma('freelist_count', { simple: true }) as number;
  for (let before = free(); before > 0;) {
    sqlite.pragma(`incremental_vacuum(${step})`);
    const after = free();
    pages += before - after;
    if (after === 0 || after >= before) return { pages, pending: false };
    if (clock() - startedAt >= budgetMs) return { pages, pending: true };
    before = after;
    await yieldToLoop();
  }
  return { pages, pending: false };
}

/** The database settings from the API configuration (DATABASE_BUSY_TIMEOUT_MS). */
export function databaseOptions(
  config: { DATABASE_BUSY_TIMEOUT_MS?: number },
  name?: string,
): DatabaseOptions {
  return {
    ...(name ? { name } : {}),
    ...(config.DATABASE_BUSY_TIMEOUT_MS !== undefined
      ? { busyTimeoutMs: config.DATABASE_BUSY_TIMEOUT_MS }
      : {}),
  };
}

/** `never` for a promise: transaction functions must be synchronous (better-sqlite3 refuses them at run time). */
type Sync<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * A write transaction: `BEGIN IMMEDIATE` takes the write lock up front, so two processes never both read and then try
 * to upgrade (which SQLite answers with SQLITE_BUSY at once instead of waiting). `fn` must be synchronous — use the
 * builders' `.all()`, `.get()` and `.run()` inside it, never `await`.
 */
export function writeTx<T>(db: Db, fn: (tx: Tx) => Sync<T>): T {
  return db.transaction(fn, { behavior: 'immediate' }) as T;
}
