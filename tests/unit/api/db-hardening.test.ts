import {
  assertDatabaseRole,
  connectionConfig,
  createDatabase,
  databaseOptions,
  type Database,
} from '@adminforge/api/src/db/client';
import {
  DB_APPROVAL_STATUSES,
  DB_PROBE_STATUSES,
  DB_RUN_STATUSES,
  DB_SCHEDULE_RUN_STATUSES,
  DB_STEP_STATUSES,
} from '@adminforge/api/src/db/schema';
import { databaseTlsProblem, loadConfig } from '@adminforge/api/src/config';
import { migrationTlsProblem } from '@adminforge/api/src/db/migrate';
import { SCHEDULE_RUN_STATUSES } from '@adminforge/api/src/schedules/types';
import { RUN_STATUSES, STEP_STATUSES } from '@adminforge/engine';

// Database hardening on the client side (docs/operations.md → Postgres hardening): per-connection limits and a name
// on every connection, the pool size from the configuration, the startup refusal of a superuser, verified TLS to a
// database on another host, and status CHECK constraints that follow the code's own lists.
const URL_ = 'postgres://app:pw@127.0.0.1:55432/adminforge';
const base = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  AUTH_MODE: 'mock',
  DATA_MODE: 'fixtures',
};

describe('connection limits', () => {
  it('sets statement, lock and idle-in-transaction limits and a name on every connection', () => {
    expect(connectionConfig(URL_, { name: 'worker' })).toMatchObject({
      application_name: 'adminforge-worker',
      statement_timeout: 60_000,
      lock_timeout: 15_000,
      idle_in_transaction_session_timeout: 60_000,
      connectionTimeoutMillis: 5_000,
    });
    // Never idle_session_timeout: LISTEN clients and the scheduler's session lock sit idle by design.
    expect(connectionConfig(URL_)).not.toHaveProperty('idle_session_timeout');
  });

  it('takes the pool size and limits from the configuration', async () => {
    const config = loadConfig({
      ...base,
      DATABASE_POOL_MAX: '25',
      DATABASE_STATEMENT_TIMEOUT_MS: '30000',
      DATABASE_LOCK_TIMEOUT_MS: '5000',
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '20000',
    });
    const opts = databaseOptions(config, 'scheduler');
    expect(opts).toEqual({
      name: 'scheduler',
      max: 25,
      statementTimeoutMs: 30_000,
      lockTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 20_000,
    });
    const db = createDatabase(URL_, opts);
    try {
      expect(db.pool.options).toMatchObject({
        max: 25,
        statement_timeout: 30_000,
        application_name: 'adminforge-scheduler',
      });
    } finally {
      await db.close();
    }
    expect(loadConfig(base)).toMatchObject({
      DATABASE_POOL_MAX: 10,
      DATABASE_STATEMENT_TIMEOUT_MS: 60_000,
      DATABASE_LOCK_TIMEOUT_MS: 15_000,
    });
    expect(() => loadConfig({ ...base, DATABASE_POOL_MAX: '0' })).toThrow(/DATABASE_POOL_MAX/);
  });
});

describe('startup role check', () => {
  const ok = {
    name: 'adminforge_app',
    superuser: false,
    bypassrls: false,
    audit_write: false,
    audit_owner: false,
    create_public: false,
    server_files: false,
  };
  const fake = (rows: Array<Partial<typeof ok>>): Database =>
    ({ pool: { query: async () => ({ rows: rows.map((r) => ({ ...ok, ...r })) }) } }) as unknown as Database;
  const check = async (rows: Array<Partial<typeof ok>>, production: boolean) => {
    const warned: string[] = [];
    try {
      await assertDatabaseRole(fake(rows), { production, warn: (m) => warned.push(m) });
      return { ok: true, warned };
    } catch (err) {
      return { ok: false, error: (err as Error).message, warned };
    }
  };

  it('refuses a superuser or a BYPASSRLS role in production and warns in development', async () => {
    for (const row of [{ superuser: true }, { bypassrls: true }]) {
      const prod = await check([row], true);
      expect(prod).toMatchObject({ ok: false, error: expect.stringMatching(/least-privilege role/) });
      expect(await check([row], false)).toMatchObject({ ok: true, warned: [expect.any(String)] });
    }
  });

  it('in production also refuses audit-log write or ownership, CREATE on public and server-file roles', async () => {
    for (const [row, said] of [
      [{ audit_write: true }, /can change or remove audit events/],
      [{ audit_owner: true }, /audit log's owner/],
      [{ create_public: true }, /create objects in schema public/],
      [{ server_files: true }, /files on the database host/],
    ] as const) {
      expect(await check([row], true)).toMatchObject({ ok: false, error: expect.stringMatching(said) });
      // A developer's own database is owned by their role: not worth a warning there.
      expect(await check([row], false)).toEqual({ ok: true, warned: [] });
    }
  });

  it('checks session_user as well as current_user (after SET ROLE they differ)', async () => {
    const r = await check([{}, { name: 'adminforge_owner', audit_owner: true }], true);
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/adminforge_owner acts as the audit/),
    });
  });

  it('accepts the least-privilege role; fails closed in production when the check can’t run', async () => {
    expect(await check([{}], true)).toEqual({ ok: true, warned: [] });
    const broken = { pool: { query: async () => Promise.reject(new Error('down')) } } as unknown as Database;
    await expect(assertDatabaseRole(broken, { production: true, warn: () => undefined })).rejects.toThrow(
      /could not be checked \(down\)\. Refusing to start/,
    );
    const warned: string[] = [];
    await assertDatabaseRole(broken, { production: false, warn: (m) => warned.push(m) });
    expect(warned).toEqual([expect.stringMatching(/could not be checked/)]);
  });
});

describe('verified TLS to a database on another host (production)', () => {
  it('needs sslmode=verify-full off this host, nothing on loopback or a Unix socket', () => {
    expect(databaseTlsProblem('postgres://a:b@127.0.0.1:5432/x')).toBeUndefined();
    expect(databaseTlsProblem('postgres://a:b@localhost/x')).toBeUndefined();
    expect(databaseTlsProblem('postgres://a:b@[::1]:5432/x')).toBeUndefined();
    expect(databaseTlsProblem('postgres://a:b@db.example.com/x?sslmode=verify-full')).toBeUndefined();
    expect(databaseTlsProblem('postgres://a:b@db.example.com/x')).toMatch(/verify-full/);
    expect(databaseTlsProblem('postgres://a:b@db.example.com/x?sslmode=require')).toMatch(/verify-full/);
    // Judged as node-postgres reads the URL: the last repeated parameter wins, and host= replaces the URL's host.
    expect(databaseTlsProblem('postgres://a:b@db.example.com/x?sslmode=verify-full&sslmode=disable')).toMatch(
      /verify-full/,
    );
    expect(
      databaseTlsProblem('postgres://a:b@db.example.com/x?sslmode=disable&sslmode=verify-full'),
    ).toBeUndefined();
    expect(databaseTlsProblem('postgres://a:b@127.0.0.1/x?host=db.example.com')).toMatch(/verify-full/);
    expect(
      databaseTlsProblem('postgres://a:b@db.example.com/x?host=%2Fvar%2Frun%2Fpostgresql'),
    ).toBeUndefined();
    expect(databaseTlsProblem('postgres://a:b@127.0.0.1/x?host=127.0.0.1,db.example.com')).toMatch(
      /verify-full/,
    );
    // DATABASE_MIGRATION_URL is held to the same rule (db/migrate.ts).
    expect(
      migrationTlsProblem('postgres://a:b@db.example.com/x', {
        ADMINFORGE_ENV_FILE: '/dev/null',
        NODE_ENV: 'production',
      }),
    ).toMatch(/verify-full/);
    expect(
      migrationTlsProblem('postgres://a:b@db.example.com/x', {
        ADMINFORGE_ENV_FILE: '/dev/null',
        NODE_ENV: 'development',
      }),
    ).toBeUndefined();
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        AUTH_MODE: 'entra',
        PUBLIC_BASE_URL: 'https://portal.example.com',
        DATABASE_URL: 'postgres://a:b@db.example.com/x',
      }),
    ).toThrow(/DATABASE_URL: a database on another host needs \?sslmode=verify-full/);
  });
});

describe('status CHECK constraints follow the code', () => {
  it('lists the same values as the engine, the scheduler and the approvals', () => {
    expect([...DB_RUN_STATUSES]).toEqual([...RUN_STATUSES]);
    expect([...DB_STEP_STATUSES]).toEqual([...STEP_STATUSES]);
    expect([...DB_SCHEDULE_RUN_STATUSES]).toEqual([...SCHEDULE_RUN_STATUSES]);
    expect([...DB_APPROVAL_STATUSES].sort()).toEqual([
      'approved',
      'cancelled',
      'expired',
      'pending',
      'rejected',
    ]);
    expect([...DB_PROBE_STATUSES]).toEqual(['ok', 'warn', 'crit', 'error']);
  });
});
