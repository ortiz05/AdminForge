import { loadEnv } from '@adminforge/config';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { runMigrations } from '@adminforge/api/src/db/migrate';

const TEST_DB = 'adminforge_test';

/**
 * A migrated, disposable database for DB-backed tests, or null when Postgres isn't reachable
 * (the tests then skip). Uses TEST_DATABASE_URL as-is, or creates `adminforge_test` next to the
 * dev DATABASE_URL so test rows never land in the dev audit chain.
 */
export async function testDatabaseUrl(): Promise<string | null> {
  const explicit = process.env.TEST_DATABASE_URL;
  const base = explicit ?? loadEnv().DATABASE_URL;
  if (!base) return null;
  let target = base;
  const admin = createDatabase(base, { max: 1 });
  try {
    await withTimeout(admin.ping(), 3_000);
    if (!explicit) {
      const exists = await admin.pool.query('select 1 from pg_database where datname = $1', [TEST_DB]);
      if (!exists.rowCount) await admin.pool.query(`create database ${TEST_DB}`);
      const url = new URL(base);
      url.pathname = `/${TEST_DB}`;
      target = url.toString();
    }
  } catch {
    return null;
  } finally {
    await admin.close().catch(() => undefined);
  }
  await runMigrations(target);
  return target;
}

/** Empties the mutable tables (audit_events is append-only, so its tests compare relative to the current tail). */
export async function resetTables(db: Database) {
  await db.pool.query('truncate sessions, preauth, token_cache, user_prefs, settings');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);
}
