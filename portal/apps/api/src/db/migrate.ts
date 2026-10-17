import { pathToFileURL } from 'node:url';
import { loadEnv } from '@adminforge/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { databaseTlsProblem } from '../config';
import { migrationsDir } from '../paths';
import { createDatabase } from './client';

/**
 * Applies pending Drizzle migrations (portal/apps/api/drizzle) to `url`. No statement or lock time limit: a migration
 * that validates a constraint over a large table may legitimately run for minutes.
 */
export async function runMigrations(url: string): Promise<void> {
  const database = createDatabase(url, {
    max: 1,
    name: 'migrate',
    statementTimeoutMs: 0,
    lockTimeoutMs: 0,
    idleInTransactionTimeoutMs: 0,
  });
  try {
    await migrate(database.db, { migrationsFolder: migrationsDir() });
  } finally {
    await database.close();
  }
}

/**
 * Where `db:migrate` connects: as the owner — DATABASE_MIGRATION_URL when set (the non-superuser owner role, kept in
 * <env>[.<overlay>].owner.env by portal/deploy/db/harden-postgres.ts; the host services' DATABASE_URL is a
 * least-privilege role without DDL — portal/deploy/db/create-app-role.sh), else DATABASE_URL (`pnpm dev`: the dev
 * database's own owner). Only migrations ask loadEnv for the owner's credentials (`owner: true`); the services never
 * get them.
 */
export function migrationUrl(processEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  const env = loadEnv(processEnv, { owner: true });
  return env.DATABASE_MIGRATION_URL || env.DATABASE_URL || undefined;
}

/** Production migrations to a database on another host need verified TLS, like the services (config.ts). */
export function migrationTlsProblem(
  url: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return loadEnv(processEnv).NODE_ENV === 'production' ? databaseTlsProblem(url) : undefined;
}

// CLI: `pnpm --filter @adminforge/api db:migrate` (ADMINFORGE_ENV_OVERLAY=host for the services' database).
const entry = process.argv[1];
if (entry && /migrate\.[cm]?[jt]s$/.test(entry) && import.meta.url === pathToFileURL(entry).href) {
  const url = migrationUrl();
  if (!url) {
    console.error('DATABASE_URL is not set. Run `pnpm --filter @adminforge/api init:local` first.');
    process.exit(1);
  }
  const tls = migrationTlsProblem(url);
  if (tls) {
    console.error(`DATABASE_MIGRATION_URL: ${tls}.`);
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log('Migrations applied.'))
    .catch((err: unknown) => {
      console.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
