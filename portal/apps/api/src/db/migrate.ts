import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '@adminforge/config';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { migrationsDir } from '../paths';
import { createDatabase, type Database } from './client';

/**
 * Applies pending Drizzle migrations (portal/apps/api/drizzle) in one transaction. The API runs this at startup — one
 * pod, `strategy: Recreate`, so no older version is running against the file (ADR-017) — and `db:migrate` runs it by
 * hand. Take a volume snapshot (or `adminforge db backup`) before an upgrade that changes the schema.
 */
export function migrateDatabase(database: Pick<Database, 'db'>): void {
  migrate(database.db, { migrationsFolder: migrationsDir() });
}

/**
 * The CREATE TRIGGER statement for `name`, from the migration that defines it — so `adminforge db import-postgres`,
 * which lifts one trigger while it copies decided approvals in, puts back exactly what the migration created.
 */
export function triggerStatement(name: string): string {
  const dir = migrationsDir();
  const create = new RegExp(`^\\s*CREATE TRIGGER \`${name}\``, 'm');
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    for (const stmt of readFileSync(path.join(dir, f), 'utf8').split('--> statement-breakpoint')) {
      const m = create.exec(stmt);
      if (m) return stmt.slice(m.index).trim();
    }
  }
  throw new Error(`No migration creates trigger ${name}.`);
}

/** Opens `file` (creating it 0600 if needed), migrates it and closes it. */
export async function runMigrations(file: string): Promise<void> {
  const database = createDatabase(file, { name: 'migrate', pollSignals: false });
  try {
    migrateDatabase(database);
  } finally {
    await database.close();
  }
}

/** Where `db:migrate` writes: DATABASE_PATH from the environment or the env file. */
export function migrationPath(processEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  return loadEnv(processEnv).DATABASE_PATH || undefined;
}

// CLI: `pnpm --filter @adminforge/api db:migrate`.
const entry = process.argv[1];
if (entry && /migrate\.[cm]?[jt]s$/.test(entry) && import.meta.url === pathToFileURL(entry).href) {
  const file = migrationPath();
  if (!file) {
    console.error('DATABASE_PATH is not set. Run `pnpm --filter @adminforge/api init:local` first.');
    process.exit(1);
  }
  runMigrations(file)
    .then(() => console.log('Migrations applied.'))
    .catch((err: unknown) => {
      console.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
