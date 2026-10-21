import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { ChainKeyring } from '../audit/keys';
import { SqliteAuditWriter, VERIFY_BATCH, type Checkpoint } from '../audit/writer';
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
  /**
   * The copy's audit chain, re-verified (the same walk as `adminforge audit verify`). `keyed`: it has HMAC-keyed events
   * (AUDIT_CHAIN_KEY), so the copy verifies only with that key — which is in the Secret, never in the copy.
   */
  audit: { count: number; tail?: Checkpoint; keyed: boolean };
}

/**
 * A consistent copy of the database (SQLite's online backup API: other connections keep working), without the rows
 * of BACKUP_EMPTIED_TABLES, rebuilt by VACUUM so nothing deleted survives in free pages, as a single self-contained
 * file (rollback journal, not WAL), mode 0600. The copy is checked (integrity_check, the audit chain) before it is
 * renamed into place; a failed backup leaves nothing behind. Plaintext: encrypt it before it leaves the cluster
 * (docs/operations.md → Backups). `keys` (AUDIT_CHAIN_KEY and the previous keys) check a keyed chain; without them a
 * keyed copy can't be checked, so it is refused.
 */
export async function backupDatabase(
  source: Pick<Database, 'sqlite'>,
  dest: string,
  opts: { keys?: ChainKeyring | null } = {},
): Promise<BackupResult> {
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
      const writer = new SqliteAuditWriter(
        drizzle({ client: copy, schema }),
        undefined,
        null,
        VERIFY_BATCH,
        opts.keys ?? null,
      );
      const verified = await writer.verify();
      if (!verified.ok)
        throw new Error(
          verified.missingKey
            ? `The audit chain is keyed from event #${verified.brokenAt} (seq ${verified.seq}) with a key this command doesn't have (id ${verified.missingKey}), so the copy can't be checked. Run it where AUDIT_CHAIN_KEY is set: in the pod, kubectl exec deploy/adminforge -c api -- adminforge db backup -.`
            : `The audit chain is broken at event #${verified.brokenAt} (seq ${verified.seq}) — in the database itself, not only the copy. Run adminforge audit verify.`,
        );
      audit = {
        count: verified.count,
        ...(verified.tail ? { tail: verified.tail } : {}),
        keyed: writer.chainState().keyed,
      };
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
