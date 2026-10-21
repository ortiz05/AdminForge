/**
 * `adminforge db backup <file|->`, `adminforge db sign-out-everyone --yes [--schedule-grants]` and
 * `adminforge db import-postgres [--to <file>] [--from-env <KEY>] [--dry-run]` — the database file's housekeeping
 * (ADR-016).
 *
 * sign-out-everyone: the emergency step that ends every session at once (docs/operations.md → Emergency) — every
 * session, pending sign-in and session token is deleted, and with --schedule-grants the sealed tokens of schedules that
 * run with their creator's access too. Takes effect while the API runs. Audited; needs --yes.
 *
 * backup: a consistent copy of DATABASE_PATH without credential rows (sessions, sign-in round trips, the token cache),
 * checked (integrity, audit chain) and mode 600; `-` writes it to stdout, so a copy can leave the pod already
 * encrypted on the operator's machine: `kubectl exec deploy/adminforge -c api -- adminforge db backup - | gpg -e -r
 * <key> > adminforge.db.gpg`. The copy is the whole history, so it is itself recorded in it: before the copy leaves
 * the process, a `database.backup` audit event (who, stdout or file — never the path —, plaintext, bytes, the copy's
 * audit tail) goes to the live database; if that can't be written, the copy doesn't leave. A file copy is written under
 * a hidden name next to its destination and takes the operator's name only once it is recorded. A failed copy is
 * recorded too. Copies from a read-only connection; writes the new file and that one event.
 *
 * import-postgres: the one-time move from the Postgres releases. Reads the old database (its URL from DATABASE_URL in
 * the env file — never a command-line argument, so the password stays out of shell history and the process list; or
 * the variable named with --from-env) and copies every table into a new SQLite file (`--to`, default DATABASE_PATH):
 * settings, preferences, saved views, definitions, schedules and their grants, runs with steps and events, approvals,
 * schedule history, probe results, News and changes, and the audit log with its hash chain (re-verified, and its tail
 * compared with Postgres'). Not copied: signed-in sessions and sign-in round trips (everyone signs in again), session
 * token partitions; schedules' sealed grant tokens are kept (they need the same TOKEN_CACHE_KEY). Refuses a target that
 * already holds data. Nothing in the tenant; nothing is written to Postgres.
 */
import { createReadStream, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import {
  backupDatabase,
  createDatabase,
  migrateDatabase,
  signOutEveryone,
  SqliteAuditWriter,
  triggerStatement,
  type Database,
} from '../content/api-bridge';
import { databasePath } from '../shared/database-path';
import { ConfigError } from '../shared/errors';
import type { Out } from '../shared/output';

/**
 * Who ran a `db` command, for the audit log: the account and machine (in the pod, the image's user and the pod's name;
 * `kubectl exec` doesn't say who is behind it — the cluster's audit log does).
 */
function cliActor(): { actorOid: string; actorUpn: string } {
  let user: string;
  try {
    user = userInfo().username;
  } catch {
    user = `uid-${process.getuid?.() ?? 'unknown'}`; // no passwd entry for the uid (an arbitrary uid in a container)
  }
  return { actorOid: 'cli', actorUpn: `${user}@${hostname()}` };
}

/** DATABASE_BUSY_TIMEOUT_MS as the API reads it: how long the CLI's write waits for the running API's write lock. */
function cliDatabaseOptions(env: Record<string, string | undefined>) {
  const ms = Number(env.DATABASE_BUSY_TIMEOUT_MS);
  return { name: 'cli', ...(Number.isInteger(ms) && ms >= 100 ? { busyTimeoutMs: ms } : {}) };
}

/** `adminforge db backup <file|->`. With `-`, the file goes to stdout and messages to stderr. */
export async function dbBackup(
  env: Record<string, string | undefined>,
  target: string,
  io: { out: Out; err: Out; stdout?: NodeJS.WritableStream },
  opts: { plaintext?: boolean } = {},
): Promise<void> {
  const toStdout = target === '-';
  // A copy written to a file stays unencrypted on that disk: only when the operator says so (as the old backup timer
  // refused plaintext without AF_BACKUP_ALLOW_PLAINTEXT). `-` is meant for a pipe into gpg.
  if (!toStdout && !opts.plaintext)
    throw new ConfigError(
      'The copy is not encrypted. Write it to stdout and encrypt it on the way out (adminforge db backup - | gpg --encrypt --recipient <key> > …), or pass --plaintext to write it to the file as it is.',
    );
  const file = databasePath(env);
  if (!existsSync(file)) throw new ConfigError(`There is no database at ${file} (DATABASE_PATH).`);
  const say = toStdout ? io.err : io.out;
  const final = toStdout ? null : databasePath({}, target);
  if (final && existsSync(final)) throw new ConfigError(`${final} already exists; choose a new file name.`);
  const scratch = toStdout ? mkdtempSync(path.join(tmpdir(), 'adminforge-backup-')) : null;
  // A process stopped before the copy is recorded (Ctrl-C while the write waits for the API's lock) leaves at most an
  // unfinished-looking leftover, never a finished-looking copy that the audit log doesn't know.
  const dest = final
    ? path.join(path.dirname(final), `.${path.basename(final)}.unrecorded-${randomUUID()}`)
    : path.join(scratch!, 'adminforge.db');
  const where = { destination: toStdout ? 'stdout' : 'file', plaintext: !!opts.plaintext };
  /** The record of this copy, through the normal audit writer on a connection of its own (the copy's is read-only). */
  const record = async (result: 'success' | 'failure', details: Record<string, unknown>) => {
    const database = createDatabase(file, { ...cliDatabaseOptions(env), pollSignals: false });
    try {
      await new SqliteAuditWriter(database.db, undefined, null).append({
        ...cliActor(),
        mode: 'read',
        action: 'database.backup',
        targetType: 'database',
        result,
        correlationId: randomUUID(),
        details,
      });
    } finally {
      await database.close();
    }
  };
  const source = createDatabase(file, { ...cliDatabaseOptions(env), readonly: true });
  /** The copy while it is not handed out: removed on any failure. */
  let unrecorded: string | undefined;
  try {
    let result: Awaited<ReturnType<typeof backupDatabase>>;
    try {
      result = await backupDatabase(source, dest);
    } catch (err) {
      // The attempt is history too. Its own failure must not hide why the copy failed, so it is only reported.
      await record('failure', where).catch(() =>
        say('  The failed attempt could not be recorded in the audit log either.'),
      );
      throw err;
    }
    unrecorded = result.file;
    // Before the copy leaves the process: no record, no copy.
    await record('success', {
      ...where,
      bytes: result.bytes,
      auditEvents: result.audit.count,
      ...(result.audit.tail ? { tailSeq: result.audit.tail.seq } : {}),
    });
    if (final) {
      if (existsSync(final)) throw new ConfigError(`${final} already exists; choose a new file name.`);
      renameSync(result.file, final);
    } else await pipeline(createReadStream(result.file), io.stdout ?? process.stdout);
    unrecorded = undefined;
    say(
      `✓ Backup ${final ?? 'written to stdout'}: ${result.bytes} bytes, integrity ok, audit chain verified (${result.audit.count} event(s)${result.audit.tail ? `, tail seq ${result.audit.tail.seq}` : ''}); sessions, sign-ins and tokens left out; recorded in the audit log.`,
    );
    if (final)
      say('  It is not encrypted: encrypt it before it leaves this machine (docs/operations.md → Backups).');
  } finally {
    await source.close();
    if (unrecorded) rmSync(unrecorded, { force: true });
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/** `adminforge db sign-out-everyone --yes [--schedule-grants]` (see the module comment). */
export async function dbSignOutEveryone(
  env: Record<string, string | undefined>,
  out: Out,
  opts: { yes?: boolean; scheduleGrants?: boolean; now?: () => Date } = {},
): Promise<{ sessions: number; signIns: number; tokens: number }> {
  if (!opts.yes)
    throw new ConfigError(
      `This signs out everyone at once${opts.scheduleGrants ? " and voids schedules' grants" : ''}. Run it again with --yes.`,
    );
  const file = databasePath(env);
  if (!existsSync(file)) throw new ConfigError(`There is no database at ${file} (DATABASE_PATH).`);
  const database = createDatabase(file, { ...cliDatabaseOptions(env), pollSignals: false });
  try {
    const result = signOutEveryone(database.db, { scheduleGrants: opts.scheduleGrants });
    await new SqliteAuditWriter(database.db, opts.now, null).append({
      ...cliActor(),
      mode: 'write',
      action: 'sessions.signed_out_everyone',
      targetType: 'sessions',
      targetId: 'all',
      result: 'success',
      correlationId: randomUUID(),
      details: { ...result, scheduleGrants: !!opts.scheduleGrants },
    });
    out(
      `✓ Signed out everyone: ${result.sessions} session(s), ${result.signIns} pending sign-in(s) and ${result.tokens} stored token(s) deleted${opts.scheduleGrants ? ", schedules' grants included (their creators consent again)" : ''}. Open pages show "signed out" at their next request.`,
    );
    return result;
  } finally {
    await database.close();
  }
}

/** One table to copy: its key (for keyset paging, in order) and which rows. */
interface TableSpec {
  table: string;
  key: string[];
  where?: string;
}

/**
 * What is copied, in an order that keeps references valid (foreign keys are also deferred to the commit). Sessions and
 * sign-in round trips are not copied; of the token cache only schedules' grant partitions are.
 */
export const IMPORT_TABLES: readonly TableSpec[] = [
  { table: 'settings', key: ['key'] },
  { table: 'user_prefs', key: ['user_oid'] },
  { table: 'definitions', key: ['id'] },
  { table: 'saved_views', key: ['id'] },
  { table: 'schedules', key: ['id'] },
  { table: 'schedule_grants', key: ['schedule_id'] },
  { table: 'token_cache', key: ['partition_key'], where: "partition_key like 'schedule:%'" },
  { table: 'runs', key: ['id'] },
  { table: 'run_steps', key: ['run_id', 'seq'] },
  { table: 'run_step_events', key: ['id'] },
  { table: 'approvals', key: ['id'] },
  { table: 'schedule_runs', key: ['id'] },
  { table: 'probe_results', key: ['id'] },
  { table: 'news_items', key: ['id'] },
  { table: 'news_feed_state', key: ['feed_key'] },
  { table: 'audit_events', key: ['seq'] },
];

/** The trigger lifted while approvals are copied (an imported approval may already be decided). */
const INSERT_TRIGGER = 'approvals_insert_pending';
const PAGE = 2_000;
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** How a Postgres column is read so SQLite gets the stored shape (db/schema.ts): ms, JSON text, 0/1, text ids. */
function readAs(column: string, dataType: string): string {
  const c = ident(column);
  switch (dataType) {
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      // Milliseconds, truncated like a JS Date (the app wrote JS Dates; database defaults had microseconds).
      return `floor(extract(epoch from ${c}) * 1000)::bigint::text as ${c}`;
    case 'ARRAY':
      return `to_json(${c})::text as ${c}`;
    case 'json':
    case 'jsonb':
    case 'uuid':
      return `${c}::text as ${c}`;
    case 'boolean':
      return `${c}::int as ${c}`;
    case 'bigint':
      return `${c}::text as ${c}`;
    default:
      return c;
  }
}

const NUMERIC_TEXT = new Set(['timestamp with time zone', 'timestamp without time zone', 'bigint']);

export interface ImportReport {
  tables: Array<{ table: string; postgres: number; sqlite: number }>;
  audit: {
    count: number;
    tail?: { seq: number; hash: string };
    postgresTail?: { seq: number; hash: string };
  };
  queuedRuns: number;
}

/** Opens the target: a new file, or an existing one with no AdminForge data in it yet. */
function openTarget(file: string): Database {
  const database = createDatabase(file, { name: 'import', pollSignals: false });
  migrateDatabase(database);
  for (const { table } of IMPORT_TABLES) {
    const r = database.sqlite.prepare(`select exists (select 1 from ${ident(table)}) as any`).get() as {
      any: number;
    };
    if (r.any) {
      void database.close();
      throw new ConfigError(
        `${file} already holds data (${table}): import into a new file (--to) — an import never merges into a used database.`,
      );
    }
  }
  return database;
}

/** `adminforge db import-postgres` (see the module comment). */
export async function importPostgres(
  env: Record<string, string | undefined>,
  out: Out,
  opts: { to?: string; fromEnv?: string; dryRun?: boolean; now?: () => number; pageSize?: number } = {},
): Promise<ImportReport | null> {
  const page = Math.max(1, opts.pageSize ?? PAGE);
  const key = opts.fromEnv ?? 'DATABASE_URL';
  const url = env[key];
  if (!url)
    throw new ConfigError(`${key} is not set: it must hold the URL of the Postgres database to import.`);
  const target = databasePath(env, opts.to);
  const client = new pg.Client({ connectionString: url, application_name: 'adminforge-import' });
  client.on('error', () => undefined);
  await client.connect();
  try {
    // One snapshot for everything read below (counts, the audit tail, every row): the old installation may still be
    // running while it is copied — what it writes after this point is simply not part of the import.
    await client.query('begin isolation level repeatable read read only');
    // The last Postgres release's schema (migration 0012: schedule grants, runs.identity_name).
    const ready = await client.query<{ grants: string | null; identity: number }>(
      `select to_regclass('public.schedule_grants')::text as grants,
              (select count(*)::int from information_schema.columns
                where table_schema = 'public' and table_name = 'runs' and column_name = 'identity_name') as identity`,
    );
    if (!ready.rows[0]?.grants || !ready.rows[0].identity)
      throw new ConfigError(
        'The Postgres database is older than the last Postgres release (migration 0012). Upgrade that installation first, then import.',
      );
    const columnsOf = async (table: string) =>
      (
        await client.query<{ column_name: string; data_type: string }>(
          `select column_name, data_type from information_schema.columns
            where table_schema = 'public' and table_name = $1 order by ordinal_position`,
          [table],
        )
      ).rows;
    const counts = new Map<string, number>();
    for (const t of IMPORT_TABLES) {
      const r = await client.query<{ n: string }>(
        `select count(*)::text as n from ${ident(t.table)}${t.where ? ` where ${t.where}` : ''}`,
      );
      counts.set(t.table, Number(r.rows[0]!.n));
    }
    const pgTail = (
      await client.query<{ seq: string; hash: string }>(
        'select a.seq::text as seq, a.hash from audit_events a order by a.seq desc limit 1',
      )
    ).rows[0];
    const postgresTail = pgTail ? { seq: Number(pgTail.seq), hash: pgTail.hash } : undefined;

    if (opts.dryRun) {
      out(`Would import into ${target}:`);
      for (const t of IMPORT_TABLES) out(`  ${t.table.padEnd(18)} ${counts.get(t.table)} row(s)`);
      out('  (signed-in sessions and sign-in round trips are not imported: everyone signs in again)');
      return null;
    }

    const database = openTarget(target);
    const sqlite = database.sqlite;
    const report: ImportReport = { tables: [], audit: { count: 0 }, queuedRuns: 0 };
    try {
      sqlite.exec('BEGIN IMMEDIATE');
      // References are checked once, at commit: a child run can arrive before its parent, a run before its schedule.
      sqlite.pragma('defer_foreign_keys = ON');
      for (const t of IMPORT_TABLES) {
        const local = new Set(
          (sqlite.prepare(`pragma table_info(${ident(t.table)})`).all() as Array<{ name: string }>).map(
            (c) => c.name,
          ),
        );
        const cols = (await columnsOf(t.table)).filter((c) => local.has(c.column_name));
        const names = cols.map((c) => c.column_name);
        const numeric = new Set(cols.filter((c) => NUMERIC_TEXT.has(c.data_type)).map((c) => c.column_name));
        if (t.table === 'approvals') sqlite.exec(`drop trigger ${ident(INSERT_TRIGGER)}`);
        const insert = sqlite.prepare(
          `insert into ${ident(t.table)} (${names.map(ident).join(', ')}) values (${names.map(() => '?').join(', ')})`,
        );
        // The key columns again, as Postgres has them, for keyset paging (`__k0`, …). Ordering and paging name the
        // table's own columns (`t.seq`), never an output alias: `seq::text as seq` would sort '99' after '679'.
        const keys = t.key.map((k, i) => `t.${ident(k)} as "__k${i}"`).join(', ');
        const select = `select ${cols.map((c) => readAs(c.column_name, c.data_type)).join(', ')}, ${keys} from ${ident(t.table)} t`;
        const order = t.key.map((k) => `t.${ident(k)}`).join(', ');
        let after: unknown[] | null = null;
        for (;;) {
          const conds: string[] = [
            ...(t.where ? [t.where] : []),
            ...(after ? [`(${order}) > (${t.key.map((_, i) => `$${i + 1}`).join(', ')})`] : []),
          ];
          const rows: pg.QueryResult<Record<string, unknown>> = await client.query<Record<string, unknown>>(
            `${select}${conds.length ? ` where ${conds.join(' and ')}` : ''} order by ${order} limit ${page}`,
            after ?? [],
          );
          for (const row of rows.rows)
            insert.run(
              names.map((n) => {
                const v = row[n];
                return v === null || v === undefined ? null : numeric.has(n) ? Number(v) : v;
              }),
            );
          if (rows.rows.length < page) break;
          const last: Record<string, unknown> = rows.rows.at(-1)!;
          after = t.key.map((_, i): unknown => last[`__k${i}`]);
        }
        if (t.table === 'approvals') sqlite.exec(triggerStatement(INSERT_TRIGGER));
        const n = (sqlite.prepare(`select count(*) as n from ${ident(t.table)}`).get() as { n: number }).n;
        report.tables.push({ table: t.table, postgres: counts.get(t.table)!, sqlite: n });
      }
      // Runs that were queued or running had pg-boss jobs, which are not copied: queue them again.
      const now = (opts.now ?? Date.now)();
      report.queuedRuns = sqlite
        .prepare(
          `insert into run_jobs (run_id, state, start_after, attempts, created_at)
           select id, 'queued', ?, 0, ? from runs where parent_run_id is null and status in ('queued', 'running')`,
        )
        .run(now, now).changes;
      const broken = sqlite.pragma('foreign_key_check') as unknown[];
      if (broken.length) throw new Error(`${broken.length} row(s) reference rows that don't exist.`);
      const short = report.tables.filter((r) => r.sqlite !== r.postgres);
      if (short.length)
        throw new Error(
          `Row counts differ: ${short.map((r) => `${r.table} ${r.sqlite}/${r.postgres}`).join(', ')}.`,
        );
      sqlite.exec('COMMIT');
    } catch (err) {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      await database.close();
      throw err;
    }
    try {
      const verified = await new SqliteAuditWriter(database.db, undefined, null).verify();
      if (!verified.ok)
        throw new Error(
          `The imported audit chain does not verify at event #${verified.brokenAt} (seq ${verified.seq}): the Postgres chain was already broken there (adminforge audit verify on the old installation).`,
        );
      report.audit = { count: verified.count, ...(verified.tail ? { tail: verified.tail } : {}) };
      if (postgresTail) report.audit.postgresTail = postgresTail;
      if (
        postgresTail &&
        (verified.tail?.seq !== postgresTail.seq || verified.tail?.hash !== postgresTail.hash)
      )
        throw new Error(
          `The imported audit chain ends at seq ${verified.tail?.seq ?? 'none'}, Postgres' at seq ${postgresTail.seq}: the copy is incomplete.`,
        );
    } finally {
      await database.close();
    }
    out(`✓ Imported into ${target}:`);
    for (const r of report.tables) out(`  ${r.table.padEnd(18)} ${r.sqlite} row(s)`);
    out(
      `  audit chain verified: ${report.audit.count} event(s)${report.audit.tail ? `, tail seq ${report.audit.tail.seq} hash ${report.audit.tail.hash} (the same as Postgres')` : ''}`,
    );
    if (report.queuedRuns) out(`  ${report.queuedRuns} open run(s) queued again for the run worker`);
    out(
      '  Not imported: signed-in sessions and sign-in round trips (everyone signs in again). Schedules that run with their creator’s access keep working only with the same TOKEN_CACHE_KEY.',
    );
    return report;
  } finally {
    await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
