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

/**
 * Per-connection limits (sent as startup parameters, so they hold for every statement on the connection). A stuck
 * statement or a transaction left open can't hold locks for long: every audited action waits on the audit chain's
 * advisory lock, so one stalled transaction would otherwise stall them all. 0 = no limit (migrations).
 * `idle_session_timeout` is deliberately not set: LISTEN clients and the scheduler's session lock sit idle by design.
 */
export interface ConnectionLimits {
  /** application_name in pg_stat_activity and the server log (`adminforge-<name>`). */
  name?: string;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
}

export interface DatabaseOptions extends ConnectionLimits {
  /** Pool size (DATABASE_POOL_MAX, default 10). */
  max?: number;
}

export const DEFAULT_LIMITS = {
  statementTimeoutMs: 60_000,
  lockTimeoutMs: 15_000,
  idleInTransactionTimeoutMs: 60_000,
} as const;

/** Connection settings shared by the pools and the LISTEN / lock clients (pg.Client). */
export function connectionConfig(url: string, limits: ConnectionLimits = {}): pg.ClientConfig {
  const l = { ...DEFAULT_LIMITS, ...limits };
  return {
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    application_name: `adminforge-${limits.name ?? 'api'}`,
    statement_timeout: l.statementTimeoutMs,
    lock_timeout: l.lockTimeoutMs,
    idle_in_transaction_session_timeout: l.idleInTransactionTimeoutMs,
  };
}

export function createDatabase(url: string, opts: DatabaseOptions = {}): Database {
  const pool = new pg.Pool({
    ...connectionConfig(url, opts),
    max: opts.max ?? 10,
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

/** The DB settings from the API configuration (DATABASE_POOL_MAX, DATABASE_*_TIMEOUT_MS). */
export function databaseOptions(
  config: {
    DATABASE_POOL_MAX?: number;
    DATABASE_STATEMENT_TIMEOUT_MS?: number;
    DATABASE_LOCK_TIMEOUT_MS?: number;
    DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS?: number;
  },
  name?: string,
): DatabaseOptions {
  return {
    ...(name ? { name } : {}),
    ...(config.DATABASE_POOL_MAX !== undefined ? { max: config.DATABASE_POOL_MAX } : {}),
    ...(config.DATABASE_STATEMENT_TIMEOUT_MS !== undefined
      ? { statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS }
      : {}),
    ...(config.DATABASE_LOCK_TIMEOUT_MS !== undefined
      ? { lockTimeoutMs: config.DATABASE_LOCK_TIMEOUT_MS }
      : {}),
    ...(config.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS !== undefined
      ? { idleInTransactionTimeoutMs: config.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS }
      : {}),
  };
}

/** A privilege the services' database role must not have, and whether it is serious enough to warn in development. */
export interface RoleProblem {
  role: string;
  problem: string;
  /** Superuser or BYPASSRLS: worth a warning even on a developer's own database. */
  severe: boolean;
}

/** The checks, as one read-only query over current_user and session_user (they differ after SET ROLE). */
const ROLE_CHECK_SQL = `
  with r(name) as (select distinct u from (values (current_user::text), (session_user::text)) v(u)),
       t(audit) as (select to_regclass('public.audit_events'))
  select r.name,
         p.rolsuper as superuser,
         p.rolbypassrls as bypassrls,
         coalesce(t.audit is not null and (has_table_privilege(r.name, t.audit, 'UPDATE')
           or has_table_privilege(r.name, t.audit, 'DELETE') or has_table_privilege(r.name, t.audit, 'TRUNCATE')), false)
           as audit_write,
         coalesce(t.audit is not null
           and pg_has_role(r.name, (select c.relowner from pg_class c where c.oid = t.audit), 'MEMBER'), false)
           as audit_owner,
         has_schema_privilege(r.name, 'public', 'CREATE') as create_public,
         pg_has_role(r.name, 'pg_execute_server_program', 'MEMBER')
           or pg_has_role(r.name, 'pg_write_server_files', 'MEMBER')
           or pg_has_role(r.name, 'pg_read_server_files', 'MEMBER') as server_files
    from r join pg_roles p on p.rolname = r.name cross join t`;

/**
 * What the role(s) the services connect as may do that they must not: superuser, BYPASSRLS, change or remove audit
 * events (UPDATE / DELETE / TRUNCATE on audit_events), act as the audit table's owner (who can disable its triggers),
 * create objects in `public`, or read, write or run files on the database host (pg_*_server_* roles).
 */
export async function databaseRoleProblems(pool: pg.Pool): Promise<RoleProblem[]> {
  const { rows } = await pool.query<{
    name: string;
    superuser: boolean;
    bypassrls: boolean;
    audit_write: boolean;
    audit_owner: boolean;
    create_public: boolean;
    server_files: boolean;
  }>(ROLE_CHECK_SQL);
  const out: RoleProblem[] = [];
  for (const r of rows) {
    const add = (yes: boolean, problem: string, severe = false) => {
      if (yes) out.push({ role: r.name, problem, severe });
    };
    add(r.superuser, 'is a superuser', true);
    add(r.bypassrls, 'bypasses row-level security (BYPASSRLS)', true);
    add(!r.superuser && r.audit_write, 'can change or remove audit events');
    add(!r.superuser && r.audit_owner, "acts as the audit log's owner (can disable its triggers)");
    add(!r.superuser && r.create_public, 'can create objects in schema public');
    add(!r.superuser && r.server_files, 'can read, write or run files on the database host');
  }
  return out;
}

/**
 * Startup check (API, worker, scheduler): the services must connect as the least-privilege role
 * (portal/deploy/db/create-app-role.sh) — never a superuser, which can drop the audit log's append-only triggers,
 * rewrite its hash chain and run programs on the database host. Production refuses to start on any problem above, and
 * also when the check itself can't run (fail closed). Development warns about a superuser or BYPASSRLS role, or a
 * check that couldn't run (a developer's own database is owned by their own role, so the other findings are expected).
 */
export async function assertDatabaseRole(
  database: Database,
  opts: { production: boolean; warn: (msg: string) => void },
): Promise<void> {
  let problems: RoleProblem[];
  try {
    problems = await databaseRoleProblems(database.pool);
  } catch (err) {
    const msg = `The database role in DATABASE_URL could not be checked (${(err as Error).message}).`;
    if (opts.production) throw new Error(`${msg} Refusing to start.`, { cause: err });
    opts.warn(msg);
    return;
  }
  const relevant = opts.production ? problems : problems.filter((p) => p.severe);
  if (!relevant.length) return;
  const what = relevant.map((p) => `${p.role} ${p.problem}`).join('; ');
  const msg = `The database role in DATABASE_URL must not have these privileges: ${what}. Connect the services as the least-privilege role (portal/deploy/db/create-app-role.sh; docs/operations.md → Postgres hardening).`;
  if (opts.production) throw new Error(msg);
  opts.warn(msg);
}
