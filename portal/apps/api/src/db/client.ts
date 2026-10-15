import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

export interface Database {
  db: Db;
  pool: pg.Pool;
  /** Cheap connectivity check for /readyz. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(url: string, opts: { max?: number } = {}): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client erroring (e.g. Postgres restarted) must not crash the process; the pool replaces it.
  pool.on('error', () => {});
  const db = drizzle({ client: pool, schema });
  return {
    db,
    pool,
    ping: async () => {
      await pool.query('select 1');
    },
    close: () => pool.end(),
  };
}
