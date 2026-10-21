/**
 * The database for the DB-backed API suites (`*-db.test.ts`, db-stores, definitions-db, part of views):
 * `testDatabasePath()` returns a migrated SQLite file of the suite's own in a fresh temporary directory — never a
 * developer's or a deployment's file, so test rows never reach a real audit chain — and `resetTables()` empties the
 * mutable tables between tests. Every suite runs everywhere: there is no database server to skip for.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from '@adminforge/api/src/db/client';
import { runMigrations } from '@adminforge/api/src/db/migrate';

/** A migrated, disposable database file (its directory is removed with the OS temp directory). */
export async function testDatabasePath(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'adminforge-test-'));
  const file = path.join(dir, 'adminforge.db');
  await runMigrations(file);
  return file;
}

/** Empties the mutable tables (audit_events is append-only, so its tests compare relative to the current tail). */
export async function resetTables(db: Database) {
  db.sqlite.exec(
    'delete from sessions; delete from preauth; delete from token_cache; delete from user_prefs; delete from settings;',
  );
}
