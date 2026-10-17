/**
 * `pnpm db:harden [--dry-run] [--rotate] [--rotate-superuser]` (portal/deploy/db/harden-postgres.sh) — brings the local
 * Postgres container to the layout docs/operations.md → "Postgres hardening" describes. Idempotent: a second run
 * changes nothing.
 *
 *   - Non-superuser owners: AF_PG_OWNER (default adminforge_owner) owns the services' database (AF_PG_DATABASE) and
 *     everything in it except the run queue's schema (the services' role owns that), and runs its migrations;
 *     AF_PG_DEV_USER (adminforge_dev) owns the development and test databases (pnpm dev and the DB-backed tests use
 *     it; CREATEDB and CREATEROLE for the tests, never superuser). Objects the bootstrap superuser owns move to them.
 *   - The services' role (adminforge_app, portal/deploy/db/create-app-role.sh): row grants re-applied for the new owner
 *     (app-role-grants.sql), per-role limits (statement_timeout 60s, idle_in_transaction_session_timeout 60s,
 *     lock_timeout 15s — never idle_session_timeout: LISTEN clients and the scheduler lock idle by design) and a
 *     connection cap.
 *   - Databases are closed to PUBLIC (their owners and the services' role keep CONNECT).
 *   - The bootstrap superuser can't sign in over TCP (db/initdb/10-reject-superuser-tcp.sh, then pg_reload_conf()).
 *   - Credentials: the owner's URL goes to <env>.<overlay>.owner.env (DATABASE_MIGRATION_URL), the superuser password
 *     to <env>.owner.env (POSTGRES_PASSWORD) — files the services never read — and the dev role's URL to the env file
 *     (DATABASE_URL); the old copies (POSTGRES_PASSWORD in the env file, DATABASE_MIGRATION_URL in the overlay) are
 *     removed. `--rotate` issues new passwords for the owner roles, `--rotate-superuser` for the superuser.
 *
 * SQL runs as the bootstrap superuser over the container's local socket (`docker exec -i … psql`), passwords on stdin,
 * never on a command line. Output: role, database and key names and what changed — never a value. Tested in
 * tests/unit/deploy/harden-postgres.test.ts (planning and env files, against a fake psql).
 *
 * Settings (environment): ADMINFORGE_ENV_FILE / ADMINFORGE_ENV (the env file, as for every tool), AF_DB_OVERLAY (the
 * services' overlay, default host), AF_DB_CONTAINER (else AF_PG_CONTAINER), and the AF_PG_* names in
 * portal/deploy/defaults.env.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  envFilePath,
  overlayEnvFilePath,
  ownerEnvFilePaths,
  parseEnv,
  removeEnvKeys,
  updateEnvFile,
} from '../../packages/config/src/index';
import { scramVerifier } from './scram.mjs';

const DEPLOY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The DB-backed tests' database (tests/api/db.ts). */
export const TEST_DATABASE = 'adminforge_test';
export const APP_ROLE = 'adminforge_app';
/** Per-role limits for the services' role. */
export const APP_ROLE_SETTINGS = {
  statement_timeout: '60s',
  idle_in_transaction_session_timeout: '60s',
  lock_timeout: '15s',
} as const;
/**
 * The services' connection cap: the API, the worker and the scheduler each hold a pool (DATABASE_POOL_MAX), the run
 * queue's own pool (pg-boss, 4) and up to 3 LISTEN clients; the scheduler adds its lock connection; 10 more for the CLI
 * (`audit verify`, `publish --dry-run`) and reconnects. 62 with the default pool of 10.
 */
export const appConnectionLimit = (poolMax: number) => 3 * (poolMax + 4 + 3) + 1 + 10;
/** Every script waits at most this long for a lock (the services hold short ones; stop them for a large database). */
export const SCRIPT_LOCK_TIMEOUT = '10s';
/**
 * Sessions that set a password keep the statement out of the server log — belt and braces: the statement carries a
 * SCRAM verifier (scram.mjs), never the password itself.
 */
export const NO_STATEMENT_LOG = [
  "SET log_statement = 'none';",
  'SET log_min_duration_statement = -1;',
  'SET log_min_error_statement = panic;',
];
const DEV_SELF_GRANT = 'set, inherit';
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface Settings {
  container: string;
  superuser: string;
  servicesDb: string;
  owner: string;
  devUser: string;
  devDb: string;
  port: string;
  /** The services' env-file overlay (`host`): <env>.host.env, <env>.host.owner.env. */
  overlay: string;
}

export interface RoleState {
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  replication: boolean;
  bypassrls: boolean;
  connectionLimit: number;
  /** rolconfig entries, e.g. statement_timeout=60s. */
  config: string[];
}

export interface DbState {
  owner: string;
  publicConnect: boolean;
  /** Objects the bootstrap superuser still owns there (schemas, relations, functions, types). */
  superuserObjects: number;
}

export interface State {
  roles: Record<string, RoleState>;
  databases: Record<string, DbState>;
  hbaRejectsSuperuser: boolean;
  /** The owner's default privileges already give the services' role row access on future tables. */
  appDefaultPrivileges: boolean;
}

/** The container's psql as the bootstrap superuser (a fake one in tests). */
export interface Psql {
  /** Read-only query: rows as arrays of fields (psql -At, `|` separated). */
  query(db: string, sql: string): string[][];
  /**
   * Runs a script (on stdin, so nothing secret reaches a command line), as one transaction unless `single` is false
   * (CREATE DATABASE can't run in one).
   */
  run(db: string, sql: string, opts?: { single?: boolean }): void;
  /** Runs a POSIX sh script in the container as the postgres OS user (pg_hba.conf edits). */
  shell(script: string, env: Record<string, string>): void;
}

export function dockerPsql(container: string, superuser: string): Psql {
  const exec = (args: string[], input?: string) => {
    const r = spawnSync('docker', ['exec', '-i', ...args], { input, encoding: 'utf8' });
    if (r.status !== 0)
      throw new Error(
        `docker exec ${container} failed (exit ${r.status}): ${(r.stderr ?? '').trim().slice(0, 400)}`,
      );
    return r.stdout;
  };
  const psql = (db: string) => [
    container,
    'psql',
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    superuser,
    '-d',
    db,
  ];
  return {
    query: (db, sql) =>
      exec([...psql(db), '-At', '-F', '|'], sql)
        .split('\n')
        .filter((l) => l.length)
        .map((l) => l.split('|')),
    run: (db, sql, opts = {}) => void exec([...psql(db), ...(opts.single === false ? [] : ['-1'])], sql),
    shell: (script, env) =>
      void exec(
        [
          '-u',
          'postgres',
          ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
          container,
          'sh',
          '-s',
        ],
        script,
      ),
  };
}

const quoteLiteral = (v: string) => `'${v.replace(/'/g, "''")}'`;
const ident = (name: string) => {
  if (!NAME.test(name)) throw new Error(`Unexpected role or database name: ${name}`);
  return `"${name}"`;
};

/** The development database: the env file's DATABASE_URL names it, unless that is the services' database. */
export function devDatabase(s: Settings, baseDatabaseUrl: string | undefined): string {
  const db = parseUrl(baseDatabaseUrl)?.pathname.slice(1);
  return db && db !== s.servicesDb ? db : s.devDb;
}

export function readState(psql: Psql, s: Settings, devDb: string = s.devDb): State {
  const names = [s.superuser, s.owner, s.devUser, APP_ROLE];
  const roles: State['roles'] = {};
  for (const r of psql.query(
    'postgres',
    `select rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit, coalesce(array_to_string(rolconfig, chr(31)), '')
       from pg_roles where rolname in (${names.map(quoteLiteral).join(', ')})`,
  )) {
    roles[r[0]!] = {
      superuser: r[1] === 't',
      createdb: r[2] === 't',
      createrole: r[3] === 't',
      replication: r[4] === 't',
      bypassrls: r[5] === 't',
      connectionLimit: Number(r[6]),
      config: r[7] ? r[7].split('\x1f') : [],
    };
  }
  const databases: State['databases'] = {};
  for (const r of psql.query(
    'postgres',
    `select datname, pg_get_userbyid(datdba), has_database_privilege('public', datname, 'CONNECT')
       from pg_database where datname in (${[s.servicesDb, devDb, TEST_DATABASE, 'postgres'].map(quoteLiteral).join(', ')})`,
  ))
    databases[r[0]!] = { owner: r[1]!, publicConnect: r[2] === 't', superuserObjects: 0 };
  for (const db of Object.keys(databases)) {
    if (db === 'postgres') continue;
    const [row] = psql.query(db, ownedObjectsSql(s.superuser, 'count', { keepQueue: db === s.servicesDb }));
    databases[db]!.superuserObjects = Number(row?.[0] ?? 0);
  }
  let appDefaultPrivileges = false;
  if (databases[s.servicesDb] && roles[s.owner] && roles[APP_ROLE]) {
    const [row] = psql.query(
      s.servicesDb,
      `select count(*) from pg_default_acl a
         where a.defaclrole = (select oid from pg_roles where rolname = ${quoteLiteral(s.owner)}) and a.defaclobjtype = 'r'
           and exists (select 1 from aclexplode(a.defaclacl) x where x.grantee = (select oid from pg_roles where rolname = ${quoteLiteral(APP_ROLE)}))`,
    );
    appDefaultPrivileges = Number(row?.[0] ?? 0) > 0;
  }
  const [hba] = psql.query(
    'postgres',
    `select count(*) from pg_hba_file_rules where type = 'host' and auth_method = 'reject' and ${quoteLiteral(s.superuser)} = any(user_name)`,
  );
  return { roles, databases, hbaRejectsSuperuser: Number(hba?.[0] ?? 0) > 0, appDefaultPrivileges };
}

/**
 * Objects owned by `from` outside the system schemas — and, in the services' database, outside the run queue's schema
 * (`pgboss`, which the services' role owns there): schemas, relations including partitions (not indexes, toast, or
 * sequences linked to a column — those follow their table), functions and standalone types (enums, domains, ranges,
 * and composite types created with CREATE TYPE … AS — those live in pg_class), extension members excluded. `count` → one row; `reassign` → a DO block that gives them to `to`.
 */
export function ownedObjectsSql(
  from: string,
  mode: 'count' | 'reassign',
  opts: { to?: string; keepQueue?: boolean } = {},
): string {
  const skip = `('pg_catalog', 'information_schema', 'pg_toast'${opts.keepQueue ? ", 'pgboss'" : ''})`;
  const owner = `(select oid from pg_roles where rolname = ${quoteLiteral(from)})`;
  const objects = `
    select 'SCHEMA ' || quote_ident(n.nspname) as obj from pg_namespace n
      where n.nspowner = ${owner} and n.nspname not in ${skip} and n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast_temp%' and n.nspname <> 'public'
    union all
    select case c.relkind when 'S' then 'SEQUENCE ' when 'v' then 'VIEW ' when 'm' then 'MATERIALIZED VIEW ' when 'f' then 'FOREIGN TABLE ' when 'c' then 'TYPE ' else 'TABLE ' end || c.oid::regclass::text
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relowner = ${owner} and n.nspname not in ${skip} and n.nspname not like 'pg_temp%'
        and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c')
        and not (c.relkind = 'S' and exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype in ('a', 'i')))
        and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
    union all
    select case p.prokind when 'p' then 'PROCEDURE ' when 'a' then 'AGGREGATE ' else 'FUNCTION ' end || p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proowner = ${owner} and n.nspname not in ${skip}
        and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    union all
    select (case t.typtype when 'd' then 'DOMAIN ' else 'TYPE ' end) || t.oid::regtype::text
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where t.typowner = ${owner} and n.nspname not in ${skip} and t.typtype in ('e', 'd', 'r', 'm') and t.typrelid = 0
        and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')`;
  if (mode === 'count') return `select count(*) from (${objects}) o`;
  return `DO $af$
DECLARE r record;
BEGIN
  FOR r IN ${objects} LOOP
    EXECUTE 'ALTER ' || r.obj || ' OWNER TO ${ident(opts.to!)}';
  END LOOP;
END $af$;`;
}

export interface Action {
  title: string;
  /**
   * SQL to run in a database (as the superuser, on stdin). `secret`: it sets a password (as a SCRAM verifier) — the
   * session keeps its statements out of the server log. `single: false`: not in a transaction (CREATE DATABASE).
   */
  sql?: { db: string; text: string; secret?: boolean; single?: boolean };
  /** A pg_hba.conf edit followed by pg_reload_conf(). */
  hba?: true;
  /** The credential this action set, saved as soon as it succeeds (so a later failure can't lose it). */
  save?: EnvChange;
}

export interface EnvChange {
  file: string;
  set: Record<string, string>;
  remove: string[];
}

export interface Plan {
  actions: Action[];
  env: EnvChange[];
  notes: string[];
}

export interface EnvFiles {
  base: string;
  overlay: string;
  baseOwner: string;
  overlayOwner: string;
}

export function envFilesFor(processEnv: NodeJS.ProcessEnv, overlay: string): EnvFiles {
  const withOverlay = { ...processEnv, ADMINFORGE_ENV_OVERLAY: overlay };
  const [baseOwner, overlayOwner] = ownerEnvFilePaths(withOverlay);
  return {
    base: envFilePath(processEnv),
    overlay: overlayEnvFilePath(withOverlay)!,
    baseOwner: baseOwner!,
    overlayOwner: overlayOwner!,
  };
}

const readEnv = (file: string): Record<string, string> =>
  existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};

const password = () => randomBytes(32).toString('hex');

/** `PASSWORD '<SCRAM verifier>'`: the server stores the verifier as given and never sees the password. */
const passwordClause = (pass: string) => `PASSWORD ${quoteLiteral(scramVerifier(pass))}`;

/** Every env-file change of a plan: the credentials saved with their actions, then the moves. */
export const envChanges = (plan: Plan): EnvChange[] => [
  ...plan.actions.flatMap((a) => (a.save ? [a.save] : [])),
  ...plan.env,
];

function parseUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

const urlFor = (user: string, pass: string, hostPort: string, db: string) =>
  `postgres://${user}:${encodeURIComponent(pass)}@${hostPort}/${db}`;

/** What to change (pure): from the cluster's state, the env files' contents and the options. */
export function planHardening(
  s: Settings,
  state: State,
  files: EnvFiles,
  contents: {
    base: Record<string, string>;
    overlay: Record<string, string>;
    baseOwner: Record<string, string>;
    overlayOwner: Record<string, string>;
  },
  opts: { rotate?: boolean; rotateSuperuser?: boolean; newPassword?: () => string } = {},
): Plan {
  const newPassword = opts.newPassword ?? password;
  const actions: Action[] = [];
  const env: EnvChange[] = [];
  const notes: string[] = [];
  const change = (file: string) => {
    let c = env.find((e) => e.file === file);
    if (!c) env.push((c = { file, set: {}, remove: [] }));
    return c;
  };
  const baseUrl = parseUrl(contents.base.DATABASE_URL);
  const hostPort = baseUrl ? baseUrl.host : `127.0.0.1:${s.port}`;
  const servicesUrl = parseUrl(contents.overlay.DATABASE_URL);
  const servicesHostPort = servicesUrl?.host ?? hostPort;
  // Refuse before anything changes: the superuser is about to lose TCP access, and the owner's URL must name the
  // database the services use.
  if (servicesUrl?.username === s.superuser)
    throw new Error(
      `the services still connect as the superuser (${path.basename(files.overlay)} DATABASE_URL): run portal/deploy/db/create-app-role.sh ${files.overlay} first`,
    );
  if (servicesUrl && servicesUrl.pathname.slice(1) !== s.servicesDb)
    throw new Error(
      `${path.basename(files.overlay)} DATABASE_URL names database ${servicesUrl.pathname.slice(1)}, not ${s.servicesDb} (AF_PG_DATABASE): set AF_PG_DATABASE to the services' database`,
    );

  // 1. The services' database owner.
  const ownerUrl = parseUrl(contents.overlayOwner.DATABASE_MIGRATION_URL);
  const ownerKnown = ownerUrl?.username === s.owner && Boolean(ownerUrl.password);
  const ownerExists = Boolean(state.roles[s.owner]);
  const ownerPass = ownerExists && ownerKnown && !opts.rotate ? undefined : newPassword();
  const ownerAttrs = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  const ownerRole = state.roles[s.owner];
  const ownerBad =
    ownerRole &&
    (ownerRole.superuser ||
      ownerRole.createdb ||
      ownerRole.createrole ||
      ownerRole.replication ||
      ownerRole.bypassrls);
  if (!ownerExists || ownerPass || ownerBad)
    actions.push({
      title: `${ownerExists ? 'update' : 'create'} role ${s.owner} (no superuser; owns ${s.servicesDb})${ownerPass ? ', new password' : ''}`,
      sql: {
        db: 'postgres',
        text: `${ownerExists ? 'ALTER' : 'CREATE'} ROLE ${ident(s.owner)} WITH ${ownerAttrs}${ownerPass ? ` ${passwordClause(ownerPass)}` : ''};`,
        secret: Boolean(ownerPass),
      },
      ...(ownerPass
        ? {
            save: {
              file: files.overlayOwner,
              set: { DATABASE_MIGRATION_URL: urlFor(s.owner, ownerPass, servicesHostPort, s.servicesDb) },
              remove: [],
            },
          }
        : {}),
    });

  // 2. The development and test databases' owner (pnpm dev, tests).
  const devAttrs = 'LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS';
  const devRole = state.roles[s.devUser];
  const devUrlIsDevRole = baseUrl?.username === s.devUser && Boolean(baseUrl.password);
  const devPass = devUrlIsDevRole && !opts.rotate ? decodeURIComponent(baseUrl!.password) : newPassword();
  const devDb = devDatabase(s, contents.base.DATABASE_URL);
  const devBad = devRole && (devRole.superuser || devRole.replication || devRole.bypassrls);
  const devNewUrl = !devUrlIsDevRole || opts.rotate;
  if (!devRole || devNewUrl || devBad)
    actions.push({
      title: `${devRole ? 'update' : 'create'} role ${s.devUser} (no superuser; owns ${devDb} and ${TEST_DATABASE})${devNewUrl ? ', new password' : ''}`,
      sql: {
        db: 'postgres',
        text: `${devRole ? 'ALTER' : 'CREATE'} ROLE ${ident(s.devUser)} WITH ${devAttrs} ${passwordClause(devPass)};`,
        secret: true,
      },
      ...(devNewUrl
        ? {
            save: {
              file: files.base,
              set: { DATABASE_URL: urlFor(s.devUser, devPass, hostPort, devDb) },
              remove: [],
            },
          }
        : {}),
    });
  // PostgreSQL 16+: a CREATEROLE role administers the roles it creates but can't act as them unless it grants itself
  // SET/INHERIT — the tests create throwaway roles and give them objects (app-role-grants.sql).
  if (!devRole?.config.includes(`createrole_self_grant=${DEV_SELF_GRANT}`))
    actions.push({
      title: `role ${s.devUser}: createrole_self_grant = '${DEV_SELF_GRANT}' (for the roles the tests create)`,
      sql: {
        db: 'postgres',
        text: `ALTER ROLE ${ident(s.devUser)} SET createrole_self_grant = ${quoteLiteral(DEV_SELF_GRANT)};`,
      },
    });
  if (baseUrl && baseUrl.pathname.slice(1) === s.servicesDb)
    notes.push(
      `the env file's DATABASE_URL pointed at the services' database (${s.servicesDb}); pnpm dev now uses ${devDb} — run \`pnpm --filter @adminforge/api db:migrate\` once`,
    );

  // 3. Databases and their owners.
  const wantOwner: Record<string, string> = {
    [s.servicesDb]: s.owner,
    [devDb]: s.devUser,
    [TEST_DATABASE]: s.devUser,
  };
  for (const [db, owner] of Object.entries(wantOwner)) {
    const d = state.databases[db];
    if (!d) {
      actions.push({
        title: `create database ${db} (owner ${owner})`,
        sql: { db: 'postgres', text: `CREATE DATABASE ${ident(db)} OWNER ${ident(owner)};`, single: false },
      });
      continue;
    }
    if (d.owner !== owner)
      actions.push({
        title: `database ${db}: owner ${d.owner} → ${owner}`,
        sql: { db: 'postgres', text: `ALTER DATABASE ${ident(db)} OWNER TO ${ident(owner)};` },
      });
    if (d.superuserObjects > 0)
      actions.push({
        title: `database ${db}: ${d.superuserObjects} object(s) of ${s.superuser} → ${owner}`,
        sql: {
          db,
          text: ownedObjectsSql(s.superuser, 'reassign', { to: owner, keepQueue: db === s.servicesDb }),
        },
      });
  }

  // 4. The services' role: grants for the new owner, limits, connection cap.
  const app = state.roles[APP_ROLE];
  if (!app) {
    notes.push(`${APP_ROLE} doesn't exist yet: run portal/deploy/db/create-app-role.sh, then this again`);
  } else {
    const grants = readFileSync(path.join(DEPLOY_DIR, 'db', 'app-role-grants.sql'), 'utf8')
      .replaceAll('{{APP_ROLE}}', APP_ROLE)
      .replaceAll('{{OWNER}}', s.owner)
      .replaceAll('{{DB}}', s.servicesDb)
      .replaceAll('{{QUEUE_SCHEMA}}', 'pgboss');
    // Re-applied when the services' database changed hands (or the owner's default privileges are missing).
    const servicesChanged = actions.some(
      (a) =>
        a.title.startsWith(`database ${s.servicesDb}:`) ||
        a.title.startsWith(`create database ${s.servicesDb} `) ||
        a.title.startsWith(`create role ${s.owner} `),
    );
    if (servicesChanged || !state.appDefaultPrivileges)
      actions.push({
        title: `${APP_ROLE}: row grants and default privileges for ${s.owner} (app-role-grants.sql)`,
        sql: { db: s.servicesDb, text: grants },
      });
    const missing = Object.entries(APP_ROLE_SETTINGS).filter(([k, v]) => !app.config.includes(`${k}=${v}`));
    if (missing.length)
      actions.push({
        title: `${APP_ROLE}: ${missing.map(([k, v]) => `${k}=${v}`).join(', ')}`,
        sql: {
          db: 'postgres',
          text: missing
            .map(([k, v]) => `ALTER ROLE ${ident(APP_ROLE)} SET ${k} = ${quoteLiteral(v)};`)
            .join('\n'),
        },
      });
    const poolMax = Number(contents.overlay.DATABASE_POOL_MAX || contents.base.DATABASE_POOL_MAX || 10);
    const limit = appConnectionLimit(Number.isInteger(poolMax) && poolMax > 0 ? poolMax : 10);
    if (app.connectionLimit !== limit)
      actions.push({
        title: `${APP_ROLE}: connection limit ${limit} (3 processes at DATABASE_POOL_MAX=${poolMax}, queue, listeners, CLI)`,
        sql: { db: 'postgres', text: `ALTER ROLE ${ident(APP_ROLE)} CONNECTION LIMIT ${limit};` },
      });
    if (app.superuser || app.bypassrls || app.createdb || app.createrole || app.replication)
      actions.push({
        title: `${APP_ROLE}: drop privileged attributes`,
        sql: {
          db: 'postgres',
          text: `ALTER ROLE ${ident(APP_ROLE)} WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
        },
      });
  }

  // 5. Databases closed to PUBLIC; the services' role keeps CONNECT on its database (app-role-grants.sql).
  for (const db of [s.servicesDb, devDb, TEST_DATABASE, 'postgres'])
    if (!state.databases[db] || state.databases[db]!.publicConnect)
      actions.push({
        title: `database ${db}: no access for PUBLIC`,
        sql: { db: 'postgres', text: `REVOKE ALL ON DATABASE ${ident(db)} FROM PUBLIC;` },
      });

  // 6. The superuser: socket only; optionally a new password (only a new cluster ever uses it).
  if (!state.hbaRejectsSuperuser)
    actions.push({ title: `pg_hba.conf: ${s.superuser} may not sign in over TCP`, hba: true });
  if (opts.rotateSuperuser) {
    const su = newPassword();
    actions.push({
      title: `role ${s.superuser}: new password`,
      sql: {
        db: 'postgres',
        text: `ALTER ROLE ${ident(s.superuser)} WITH ${passwordClause(su)};`,
        secret: true,
      },
      save: { file: files.baseOwner, set: { POSTGRES_PASSWORD: su }, remove: [] },
    });
  }

  // 7. Owner credentials out of the files the services read.
  if (contents.base.POSTGRES_PASSWORD) {
    if (!opts.rotateSuperuser && !contents.baseOwner.POSTGRES_PASSWORD)
      change(files.baseOwner).set.POSTGRES_PASSWORD = contents.base.POSTGRES_PASSWORD;
    change(files.base).remove.push('POSTGRES_PASSWORD');
  }
  if (contents.base.DATABASE_MIGRATION_URL) change(files.base).remove.push('DATABASE_MIGRATION_URL');
  if (contents.overlay.DATABASE_MIGRATION_URL) change(files.overlay).remove.push('DATABASE_MIGRATION_URL');
  return { actions, env: env.filter((e) => Object.keys(e.set).length || e.remove.length), notes };
}

const describe = (e: EnvChange) =>
  `${path.basename(e.file)}: ${[...Object.keys(e.set).map((k) => `${k} set`), ...e.remove.map((k) => `${k} removed`)].join(', ')}`;

function saveEnv(e: EnvChange, out: (line: string) => void) {
  if (Object.keys(e.set).length) updateEnvFile(e.set, e.file);
  if (e.remove.length) removeEnvKeys(e.remove, e.file);
  out(`  ✓ ${describe(e)} (values not shown)`);
}

export function applyPlan(plan: Plan, psql: Psql, s: Settings, out: (line: string) => void): void {
  const hbaScript = readFileSync(path.join(DEPLOY_DIR, 'db', 'initdb', '10-reject-superuser-tcp.sh'), 'utf8');
  for (const a of plan.actions) {
    if (a.sql)
      psql.run(
        a.sql.db,
        [
          `SET lock_timeout = '${SCRIPT_LOCK_TIMEOUT}';`,
          ...(a.sql.secret ? NO_STATEMENT_LOG : []),
          a.sql.text,
        ].join('\n'),
        { single: a.sql.single !== false },
      );
    if (a.hba) {
      psql.shell(hbaScript, { POSTGRES_USER: s.superuser });
      psql.run('postgres', `SET lock_timeout = '${SCRIPT_LOCK_TIMEOUT}';\nSELECT pg_reload_conf();`);
      const [errors] = psql.query(
        'postgres',
        'select count(*) from pg_hba_file_rules where error is not null',
      );
      if (Number(errors?.[0] ?? 0) > 0)
        throw new Error('pg_hba.conf has errors after the edit — fix it before reloading again');
    }
    out(`  ✓ ${a.title}`);
    // The role has its new password now: save it before anything else can fail.
    if (a.save) saveEnv(a.save, out);
  }
  // Then the moves (old copies out of the files the services read); values never printed.
  for (const e of plan.env) saveEnv(e, out);
}

export function settingsFrom(env: NodeJS.ProcessEnv): Settings {
  const defaults = parseEnv(readFileSync(path.join(DEPLOY_DIR, 'defaults.env'), 'utf8'));
  const get = (k: string) => env[k]?.trim() || defaults[k] || '';
  const s: Settings = {
    container: env.AF_DB_CONTAINER?.trim() || get('AF_PG_CONTAINER'),
    superuser: get('AF_PG_USER'),
    servicesDb: get('AF_PG_DATABASE'),
    owner: get('AF_PG_OWNER'),
    devUser: get('AF_PG_DEV_USER'),
    devDb: get('AF_PG_DEV_DATABASE'),
    port: get('AF_PG_PORT'),
    overlay: env.AF_DB_OVERLAY?.trim() || 'host',
  };
  for (const n of [s.superuser, s.servicesDb, s.owner, s.devUser, s.devDb]) ident(n);
  if (!/^[a-z0-9-]{1,32}$/.test(s.overlay))
    throw new Error('AF_DB_OVERLAY must be lower-case letters, digits and dashes');
  return s;
}

export function main(
  argv: string[],
  processEnv: NodeJS.ProcessEnv = process.env,
  out = (l: string) => console.log(l),
  deps: { psql?: Psql } = {},
) {
  const dryRun = argv.includes('--dry-run');
  const s = settingsFrom(processEnv);
  const files = envFilesFor(processEnv, s.overlay);
  const psql = deps.psql ?? dockerPsql(s.container, s.superuser);
  const base = readEnv(files.base);
  const state = readState(psql, s, devDatabase(s, base.DATABASE_URL));
  const plan = planHardening(
    s,
    state,
    files,
    {
      base,
      overlay: readEnv(files.overlay),
      baseOwner: readEnv(files.baseOwner),
      overlayOwner: readEnv(files.overlayOwner),
    },
    { rotate: argv.includes('--rotate'), rotateSuperuser: argv.includes('--rotate-superuser') },
  );
  out(`AdminForge Postgres hardening — container ${s.container}${dryRun ? ' (dry run)' : ''}`);
  if (!plan.actions.length && !plan.env.length) out('  ✓ nothing to change');
  if (dryRun) {
    if (plan.actions.length || plan.env.length) {
      out(
        '  Would change (stop the api, worker and scheduler first: ownership changes wait for their locks):',
      );
    }
    for (const a of plan.actions) out(`  · ${a.title}`);
    for (const e of envChanges(plan)) out(`  · ${describe(e)}`);
  } else applyPlan(plan, psql, s, out);
  for (const n of plan.notes) out(`  ℹ ${n}`);
  if (!dryRun && plan.actions.length)
    out('Restart the services (they reconnect as adminforge_app; the new limits apply to new connections).');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
}
