import { pathToFileURL } from 'node:url';
import { loadEnv } from '@adminforge/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { migrationsDir } from '../paths';
import { createDatabase } from './client';

/** Applies pending Drizzle migrations (portal/apps/api/drizzle) to `url`. */
export async function runMigrations(url: string): Promise<void> {
  const database = createDatabase(url, { max: 1 });
  try {
    await migrate(database.db, { migrationsFolder: migrationsDir() });
  } finally {
    await database.close();
  }
}

// CLI: `pnpm --filter @adminforge/api db:migrate` (DATABASE_URL from the env file or process.env).
const entry = process.argv[1];
if (entry && /migrate\.[cm]?[jt]s$/.test(entry) && import.meta.url === pathToFileURL(entry).href) {
  const url = loadEnv().DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Run `pnpm --filter @adminforge/api init:local` first.');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log('Migrations applied.'))
    .catch((err: unknown) => {
      console.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
