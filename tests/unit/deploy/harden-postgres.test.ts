import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  APP_ROLE,
  appConnectionLimit,
  envChanges,
  main,
  ownedObjectsSql,
  planHardening,
  TEST_DATABASE,
  type Psql,
  type Settings,
  type State,
} from '../../../portal/deploy/db/harden-postgres';
import { scramVerifier } from '../../../portal/deploy/db/scram.mjs';
import { parseEnvFile } from '../../lib/repo';

// portal/deploy/db/harden-postgres.ts (`pnpm db:harden`) against a fake psql (never a real database): what it plans
// for a cluster in the older layout (the superuser owns everything and its credentials sit in the services' files),
// where each credential goes, that no value is ever printed, and that a hardened cluster needs nothing more. Values
// are synthetic. (The SQL itself was exercised once against a throwaway postgres:18 container; see the operations doc.)
const S: Settings = {
  container: 'pg-test',
  superuser: 'adminforge',
  servicesDb: 'adminforge',
  owner: 'adminforge_owner',
  devUser: 'adminforge_dev',
  devDb: 'adminforge_dev',
  port: '55432',
  overlay: 'host',
};
const SUPER_URL = 'postgres://adminforge:super-secret@127.0.0.1:55432/adminforge_dev';
const APP_URL = 'postgres://adminforge_app:app-secret@127.0.0.1:55432/adminforge';
const SERVICES_SUPER_URL = 'postgres://adminforge:super-secret@127.0.0.1:55432/adminforge';
const role = (over: Partial<State['roles'][string]> = {}) => ({
  superuser: false,
  createdb: false,
  createrole: false,
  replication: false,
  bypassrls: false,
  connectionLimit: -1,
  config: [],
  ...over,
});

/** The host before hardening: the superuser owns every database and object; the app role exists. */
const olderLayout = (): State => ({
  roles: {
    adminforge: role({
      superuser: true,
      createdb: true,
      createrole: true,
      replication: true,
      bypassrls: true,
    }),
    [APP_ROLE]: role(),
  },
  databases: {
    adminforge: { owner: 'adminforge', publicConnect: true, superuserObjects: 21 },
    adminforge_dev: { owner: 'adminforge', publicConnect: true, superuserObjects: 25 },
    postgres: { owner: 'adminforge', publicConnect: true, superuserObjects: 0 },
  },
  hbaRejectsSuperuser: false,
  appDefaultPrivileges: false,
});

/** The same cluster after a run. */
const hardened = (): State => ({
  roles: {
    adminforge: role({ superuser: true }),
    adminforge_owner: role(),
    adminforge_dev: role({
      createdb: true,
      createrole: true,
      config: ['createrole_self_grant=set, inherit'],
    }),
    [APP_ROLE]: role({
      connectionLimit: 62,
      config: ['statement_timeout=60s', 'idle_in_transaction_session_timeout=60s', 'lock_timeout=15s'],
    }),
  },
  databases: {
    adminforge: { owner: 'adminforge_owner', publicConnect: false, superuserObjects: 0 },
    adminforge_dev: { owner: 'adminforge_dev', publicConnect: false, superuserObjects: 0 },
    [TEST_DATABASE]: { owner: 'adminforge_dev', publicConnect: false, superuserObjects: 0 },
    postgres: { owner: 'adminforge', publicConnect: false, superuserObjects: 0 },
  },
  hbaRejectsSuperuser: true,
  appDefaultPrivileges: true,
});

function configDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'af-harden-'));
  const files = {
    base: path.join(dir, 'dev.env'),
    overlay: path.join(dir, 'dev.host.env'),
    baseOwner: path.join(dir, 'dev.owner.env'),
    overlayOwner: path.join(dir, 'dev.host.owner.env'),
  };
  const read = (f: string) => {
    try {
      return parseEnvFile(f);
    } catch {
      return {};
    }
  };
  return {
    dir,
    files,
    write: (f: string, lines: string[]) => writeFileSync(f, `${lines.join('\n')}\n`, { mode: 0o600 }),
    contents: () => ({
      base: read(files.base),
      overlay: read(files.overlay),
      baseOwner: read(files.baseOwner),
      overlayOwner: read(files.overlayOwner),
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Records what would run; answers readState's queries from a fixed state. */
function fakePsql(state: State) {
  const ran: Array<{ db: string; sql: string; single: boolean }> = [];
  const shells: string[] = [];
  const psql: Psql = {
    query: (db, sql) => {
      if (sql.includes('from pg_roles where rolname in'))
        return Object.entries(state.roles).map(([n, r]) => [
          n,
          r.superuser ? 't' : 'f',
          r.createdb ? 't' : 'f',
          r.createrole ? 't' : 'f',
          r.replication ? 't' : 'f',
          r.bypassrls ? 't' : 'f',
          String(r.connectionLimit),
          r.config.join('\x1f'),
        ]);
      if (sql.includes('from pg_database'))
        return Object.entries(state.databases).map(([n, d]) => [n, d.owner, d.publicConnect ? 't' : 'f']);
      if (sql.includes('pg_hba_file_rules where type')) return [[state.hbaRejectsSuperuser ? '1' : '0']];
      if (sql.includes('pg_hba_file_rules where error')) return [['0']];
      if (sql.includes('pg_default_acl')) return [[state.appDefaultPrivileges ? '1' : '0']];
      if (sql.startsWith('select count(*) from ('))
        return [[String(state.databases[db]?.superuserObjects ?? 0)]];
      return [];
    },
    run: (db, sql, opts = {}) => void ran.push({ db, sql, single: opts.single !== false }),
    shell: (script) => void shells.push(script),
  };
  return { psql, ran, shells };
}

let n = 0;
const newPassword = () => `generated-${++n}-secret`;

describe('pnpm db:harden', () => {
  it('plans owners, limits, PUBLIC and pg_hba for a cluster in the older layout', () => {
    const c = configDir();
    try {
      c.write(c.files.base, [
        'DATABASE_URL=' + SUPER_URL,
        'POSTGRES_PASSWORD=super-secret',
        'AF_ENV_LABEL=dev',
      ]);
      c.write(c.files.overlay, ['DATABASE_URL=' + APP_URL, 'DATABASE_MIGRATION_URL=' + SERVICES_SUPER_URL]);
      const plan = planHardening(S, olderLayout(), c.files, c.contents(), { newPassword });
      const titles = plan.actions.map((a) => a.title);
      expect(titles).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^create role adminforge_owner \(no superuser; owns adminforge\), new password$/,
          ),
          expect.stringMatching(
            /^create role adminforge_dev \(no superuser; owns adminforge_dev and adminforge_test\)/,
          ),
          'database adminforge: owner adminforge → adminforge_owner',
          'database adminforge: 21 object(s) of adminforge → adminforge_owner',
          'database adminforge_dev: owner adminforge → adminforge_dev',
          'create database adminforge_test (owner adminforge_dev)',
          'adminforge_app: statement_timeout=60s, idle_in_transaction_session_timeout=60s, lock_timeout=15s',
          'adminforge_app: connection limit 62 (3 processes at DATABASE_POOL_MAX=10, queue, listeners, CLI)',
          'database postgres: no access for PUBLIC',
          'pg_hba.conf: adminforge may not sign in over TCP',
        ]),
      );
      const sql = plan.actions.map((a) => a.sql?.text ?? '').join('\n');
      // Passwords only ever as SCRAM-SHA-256 verifiers: the server (and its log) never sees one.
      expect(sql).toMatch(
        /CREATE ROLE "adminforge_owner" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'SCRAM-SHA-256\$4096:/,
      );
      for (const secret of ['generated-', 'super-secret']) expect(sql).not.toContain(secret);
      expect(sql).toMatch(
        /CREATE ROLE "adminforge_dev" WITH LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS/,
      );
      expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "adminforge_owner"');
      expect(sql).not.toContain('idle_session_timeout');
      // Only statements that carry a password are marked secret.
      for (const a of plan.actions)
        if (a.sql && /PASSWORD '/.test(a.sql.text)) expect(a.sql.secret).toBe(true);
      // Credentials: the owner's URL to the overlay's owner file, the superuser's password to the base owner file, the
      // dev role's URL to the env file; the old copies removed.
      const env = Object.fromEntries(envChanges(plan).map((e) => [path.basename(e.file), e]));
      expect(new URL(env['dev.host.owner.env']!.set.DATABASE_MIGRATION_URL!)).toMatchObject({
        username: 'adminforge_owner',
        pathname: '/adminforge',
      });
      expect(env['dev.owner.env']!.set).toEqual({ POSTGRES_PASSWORD: 'super-secret' });
      const devSave = envChanges(plan).find((e) => e.file === c.files.base && e.set.DATABASE_URL)!;
      expect(new URL(devSave.set.DATABASE_URL!)).toMatchObject({
        username: 'adminforge_dev',
        pathname: '/adminforge_dev',
        host: '127.0.0.1:55432',
      });
      expect(plan.env.find((e) => e.file === c.files.base)!.remove).toEqual(['POSTGRES_PASSWORD']);
      expect(env['dev.host.env']!.remove).toEqual(['DATABASE_MIGRATION_URL']);
    } finally {
      c.cleanup();
    }
  });

  it('applies it without printing a value, moves the credentials and leaves the files private', () => {
    const c = configDir();
    try {
      c.write(c.files.base, ['DATABASE_URL=' + SUPER_URL, 'POSTGRES_PASSWORD=super-secret']);
      c.write(c.files.overlay, ['DATABASE_URL=' + APP_URL, 'DATABASE_MIGRATION_URL=' + SERVICES_SUPER_URL]);
      const fake = fakePsql(olderLayout());
      const lines: string[] = [];
      main([], { ADMINFORGE_ENV_FILE: c.files.base, AF_DB_CONTAINER: 'pg-test' }, (l) => lines.push(l), {
        psql: fake.psql,
      });
      const output = lines.join('\n');
      expect(output).toContain('✓ pg_hba.conf: adminforge may not sign in over TCP');
      expect(fake.shells).toHaveLength(1);
      expect(fake.ran.some((r) => r.sql.endsWith('SELECT pg_reload_conf();'))).toBe(true);
      // Every script waits at most 10 s for a lock and runs as one transaction — except CREATE DATABASE.
      for (const r of fake.ran) {
        expect(r.sql.startsWith("SET lock_timeout = '10s';")).toBe(true);
        expect(r.single).toBe(!r.sql.includes('CREATE DATABASE'));
      }
      // Sessions that set a password log no statements; the password itself is never sent.
      const secrets = fake.ran.filter((r) => /PASSWORD '/.test(r.sql));
      expect(secrets.length).toBeGreaterThanOrEqual(2);
      for (const r of secrets) {
        expect(r.sql).toContain("SET log_statement = 'none';");
        expect(r.sql).toContain('SET log_min_error_statement = panic;');
        expect(r.sql).toMatch(/PASSWORD 'SCRAM-SHA-256\$4096:/);
      }
      const after = c.contents();
      for (const secret of [
        'super-secret',
        'app-secret',
        new URL(after.overlayOwner.DATABASE_MIGRATION_URL!).password,
        new URL(after.base.DATABASE_URL!).password,
      ])
        expect(output).not.toContain(secret);
      expect(after.base).not.toHaveProperty('POSTGRES_PASSWORD');
      expect(after.overlay).toEqual({ DATABASE_URL: APP_URL });
      expect(after.baseOwner).toEqual({ POSTGRES_PASSWORD: 'super-secret' });
      for (const f of Object.values(c.files)) expect(statSync(f).mode & 0o777).toBe(0o600);
      // The dev role is created with (a verifier of) the password the env file now holds.
      const devPassword = decodeURIComponent(new URL(after.base.DATABASE_URL!).password);
      const all = fake.ran.map((r) => r.sql).join('\n');
      expect(all).toContain(`CREATE ROLE "adminforge_dev"`);
      expect(all).not.toContain(devPassword);
      const m = /CREATE ROLE "adminforge_dev" [^']+'(SCRAM-SHA-256\$4096:([^$]+)\$[^']+)'/.exec(all)!;
      expect(scramVerifier(devPassword, { salt: Buffer.from(m[2]!, 'base64') })).toBe(m[1]);
      // Each credential is saved right after its role statement, before the next statement runs.
      const ownerSaved = lines.findIndex((l) => l.includes('dev.host.owner.env: DATABASE_MIGRATION_URL set'));
      const ownerCreated = lines.findIndex((l) => l.includes('create role adminforge_owner'));
      expect(ownerSaved).toBe(ownerCreated + 1);
    } finally {
      c.cleanup();
    }
  });

  it('needs nothing more on a hardened cluster (idempotent)', () => {
    const c = configDir();
    try {
      c.write(c.files.base, [
        'DATABASE_URL=postgres://adminforge_dev:dev-secret@127.0.0.1:55432/adminforge_dev',
      ]);
      c.write(c.files.overlay, ['DATABASE_URL=' + APP_URL]);
      c.write(c.files.overlayOwner, [
        'DATABASE_MIGRATION_URL=postgres://adminforge_owner:owner-secret@127.0.0.1:55432/adminforge',
      ]);
      c.write(c.files.baseOwner, ['POSTGRES_PASSWORD=super-secret']);
      const plan = planHardening(S, hardened(), c.files, c.contents(), { newPassword });
      expect(plan).toEqual({ actions: [], env: [], notes: [] });
      const lines: string[] = [];
      main(['--dry-run'], { ADMINFORGE_ENV_FILE: c.files.base }, (l) => lines.push(l), {
        psql: fakePsql(hardened()).psql,
      });
      expect(lines).toEqual([
        'AdminForge Postgres hardening — container adminforge-dev-postgres-1 (dry run)',
        '  ✓ nothing to change',
      ]);
    } finally {
      c.cleanup();
    }
  });

  it('creates the dev role with the password init:local wrote, and rotates only on request', () => {
    const c = configDir();
    try {
      const devUrl = 'postgres://adminforge_dev:from-init-local@127.0.0.1:55432/adminforge_dev';
      c.write(c.files.base, ['DATABASE_URL=' + devUrl]);
      const fresh = hardened();
      delete fresh.roles.adminforge_dev;
      const plan = planHardening(S, fresh, c.files, c.contents(), { newPassword });
      const create = plan.actions.find((a) => a.title.startsWith('create role adminforge_dev'))!;
      expect(create.sql!.text).not.toContain('from-init-local');
      const m = /PASSWORD '(SCRAM-SHA-256\$4096:([^$]+)\$[^']+)'/.exec(create.sql!.text)!;
      expect(scramVerifier('from-init-local', { salt: Buffer.from(m[2]!, 'base64') })).toBe(m[1]);
      expect(envChanges(plan).find((e) => e.file === c.files.base)).toBeUndefined();
      const rotated = planHardening(S, hardened(), c.files, c.contents(), { newPassword, rotate: true });
      expect(envChanges(rotated).find((e) => e.file === c.files.base)?.set.DATABASE_URL).toMatch(
        /^postgres:\/\/adminforge_dev:generated-\d+-secret@/,
      );
      const su = planHardening(S, hardened(), c.files, c.contents(), { newPassword, rotateSuperuser: true });
      expect(su.actions.map((a) => a.title)).toContain('role adminforge: new password');
      expect(envChanges(su).find((e) => e.file === c.files.baseOwner)?.set.POSTGRES_PASSWORD).toMatch(
        /^generated-/,
      );
    } finally {
      c.cleanup();
    }
  });

  it('refuses while the services still connect as the superuser, or to a database other than AF_PG_DATABASE', () => {
    const c = configDir();
    try {
      c.write(c.files.base, ['DATABASE_URL=' + SUPER_URL]);
      c.write(c.files.overlay, ['DATABASE_URL=' + SERVICES_SUPER_URL]);
      expect(() => planHardening(S, olderLayout(), c.files, c.contents(), { newPassword })).toThrow(
        /services still connect as the superuser .*create-app-role\.sh/,
      );
      c.write(c.files.overlay, ['DATABASE_URL=postgres://adminforge_app:x@127.0.0.1:55432/other']);
      expect(() => planHardening(S, olderLayout(), c.files, c.contents(), { newPassword })).toThrow(
        /names database other, not adminforge \(AF_PG_DATABASE\)/,
      );
    } finally {
      c.cleanup();
    }
  });

  it('reads the development database the env file names, and derives the app role connection cap from the pool', () => {
    const c = configDir();
    try {
      c.write(c.files.base, ['DATABASE_URL=postgres://adminforge_dev:dev-secret@127.0.0.1:55432/my_dev']);
      c.write(c.files.overlay, ['DATABASE_URL=' + APP_URL, 'DATABASE_POOL_MAX=20']);
      const queried: string[] = [];
      const fake = fakePsql(hardened());
      const spy: Psql = { ...fake.psql, query: (db, sql) => (queried.push(sql), fake.psql.query(db, sql)) };
      const lines: string[] = [];
      main(['--dry-run'], { ADMINFORGE_ENV_FILE: c.files.base }, (l) => lines.push(l), { psql: spy });
      expect(queried.find((q) => q.includes('from pg_database'))).toContain("'my_dev'");
      expect(appConnectionLimit(10)).toBe(62);
      expect(lines.join('\n')).toContain(
        `connection limit ${appConnectionLimit(20)} (3 processes at DATABASE_POOL_MAX=20`,
      );
    } finally {
      c.cleanup();
    }
  });

  it('keeps the run queue schema with the services role in their database only', () => {
    expect(ownedObjectsSql('adminforge', 'count', { keepQueue: true })).toContain("'pgboss'");
    expect(ownedObjectsSql('adminforge', 'count')).not.toContain("'pgboss'");
    expect(ownedObjectsSql('adminforge', 'reassign', { to: 'adminforge_owner' })).toContain(
      `' OWNER TO "adminforge_owner"'`,
    );
    expect(() => ownedObjectsSql('adminforge', 'reassign', { to: 'x"; drop' })).toThrow(/Unexpected/);
    // Standalone composite types (CREATE TYPE … AS) live in pg_class and move too.
    expect(ownedObjectsSql('adminforge', 'count')).toContain("when 'c' then 'TYPE '");
  });

  it('is wired to pnpm db:harden', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['db:harden']).toBe('bash portal/deploy/db/harden-postgres.sh');
  });
});
