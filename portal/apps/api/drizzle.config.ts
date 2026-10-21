import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` only diffs the schema; it never opens a database. Migrations are applied by src/db/migrate.ts.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
