import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { SqliteAuditWriter, type Checkpoint } from '../audit/writer';
import type { Database } from './client';
import * as schema from './schema';

/**
 * Tables whose rows are credentials or process state, not history: a backup keeps their definitions but not their
 * rows. Signed-in sessions, sign-in round trips and the sealed MSAL token cache (refresh tokens — also schedules'
 * grants: their creators consent again after a restore) never leave the volume; leases and signals mean nothing to
 * another process.
 */
export const BACKUP_EMPTIED_TABLES = ['sessions', 'preauth', 'token_cache', 'leases', 'signals'] as const;

export interface BackupResult {
  file: string;
  bytes: number;
  /** The copy's audit chain, re-verified (the same walk as `adminforge audit verify`). */
  audit: { count: number; tail?: Checkpoint };
}

/**
 * A consistent copy of the database (SQLite's online backup API: other connections keep working), without the rows
 * of BACKUP_EMPTIED_TABLES, rebuilt by VACUUM so nothing deleted survives in free pages, as a single self-contained
 * file (rollback journal, not WAL), mode 0600. The copy is checked (integrity_check, the audit chain) before it is
 * renamed into place; a failed backup leaves nothing behind. Plaintext: encrypt it before it leaves the cluster
 * (docs/operations.md → Backups).
 */
export async function backupDatabase(source: Pick<Database, 'sqlite'>, dest: string): Promise<BackupResult> {
  const file = path.resolve(dest);
  if (existsSync(file)) throw new Error(`${file} already exists; choose a new file name.`);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const partial = `${file}.partial-${randomUUID()}`;
  try {
    // Private from the first byte: until the credential rows are gone, the copy holds them.
    closeSync(openSync(partial, 'wx', 0o600));
    await source.sqlite.backup(partial);
    chmodSync(partial, 0o600);
    const copy = new BetterSqlite3(partial);
    let audit: BackupResult['audit'];
    try {
      copy.pragma('journal_mode = DELETE');
      copy.pragma('secure_delete = ON');
      copy.pragma('recursive_triggers = ON');
      copy.transaction(() => {
        for (const table of BACKUP_EMPTIED_TABLES) copy.prepare(`delete from ${table}`).run();
      })();
      copy.exec('VACUUM');
      const integrity = copy.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok')
        throw new Error(`The copy failed SQLite's integrity check (${String(integrity)}).`);
      const verified = await new SqliteAuditWriter(
        drizzle({ client: copy, schema }),
        undefined,
        null,
      ).verify();
      if (!verified.ok)
        throw new Error(
          `The audit chain is broken at event #${verified.brokenAt} (seq ${verified.seq}) — in the database itself, not only the copy. Run adminforge audit verify.`,
        );
      audit = { count: verified.count, ...(verified.tail ? { tail: verified.tail } : {}) };
    } finally {
      copy.close();
    }
    renameSync(partial, file);
    return { file, bytes: statSync(file).size, audit };
  } finally {
    for (const f of [partial, `${partial}-journal`, `${partial}-wal`, `${partial}-shm`])
      rmSync(f, { force: true });
  }
}
