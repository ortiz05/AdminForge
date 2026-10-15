import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { testDatabaseUrl } from './db';

// The host services' least-privilege role (portal/deploy/db/app-role-grants.sql): row access on every table, no DDL,
// and the audit log is insert/select only — a compromised service can't rewrite history or drop the triggers.
const url = await testDatabaseUrl();
const GRANTS = readFileSync(
  path.resolve(import.meta.dirname, '../../portal/deploy/db/app-role-grants.sql'),
  'utf8',
);

describe.skipIf(!url)('services database role (app-role-grants.sql)', () => {
  const role = `af_app_test_${randomBytes(4).toString('hex')}`;
  // A schema of its own stands in for pg-boss's `pgboss` (the run queue manages its own tables there).
  const queueSchema = `af_queue_test_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(16).toString('hex');
  let owner: Database;
  let app: Database;

  beforeAll(async () => {
    owner = createDatabase(url!, { max: 1 });
    const target = new URL(url!);
    const db = target.pathname.slice(1);
    await owner.pool.query(`create role ${role} with login nosuperuser password '${password}'`);
    const sql = GRANTS.replaceAll('{{APP_ROLE}}', role)
      .replaceAll('{{OWNER}}', decodeURIComponent(target.username))
      .replaceAll('{{DB}}', db)
      .replaceAll('{{QUEUE_SCHEMA}}', queueSchema);
    await owner.pool.query(sql);
    target.username = role;
    target.password = password;
    app = createDatabase(target.toString(), { max: 1 });
  });

  afterAll(async () => {
    await app?.close();
    await owner?.pool.query(`drop owned by ${role}`).catch(() => undefined);
    await owner?.pool.query(`drop role if exists ${role}`).catch(() => undefined);
    await owner?.close();
  });

  const denied = (sql: string) =>
    expect(app.pool.query(sql)).rejects.toMatchObject({ code: '42501' /* insufficient_privilege */ });

  it('reads and writes ordinary rows', async () => {
    const key = `test:${role}`;
    await app.pool.query('insert into settings (key, value) values ($1, $2)', [
      key,
      JSON.stringify({ ok: true }),
    ]);
    await app.pool.query('update settings set value = $2 where key = $1', [
      key,
      JSON.stringify({ ok: false }),
    ]);
    await app.pool.query('delete from settings where key = $1', [key]);
    await expect(app.pool.query('select count(*) from audit_events')).resolves.toBeTruthy();
  });

  it('cannot change or remove audit events, whatever the triggers say', async () => {
    await denied('update audit_events set result = result where false');
    await denied('delete from audit_events where false');
    await denied('truncate audit_events');
    await denied('alter table audit_events disable trigger all');
    await denied('drop trigger audit_events_no_update_delete on audit_events');
  });

  it('cannot create objects in public', async () => {
    await denied('create table af_role_probe (id int)');
  });

  it('owns the run queue schema, so pg-boss can install and partition its tables', async () => {
    await app.pool.query(`create table ${queueSchema}.job (id int, name text) partition by list (name)`);
    await app.pool.query(
      `create table ${queueSchema}.j1 partition of ${queueSchema}.job for values in ('runs')`,
    );
    await app.pool.query(`insert into ${queueSchema}.job values (1, 'runs')`);
    const { rows } = await owner.pool.query<{ owner: string }>(
      'select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = $1',
      [queueSchema],
    );
    expect(rows[0]?.owner).toBe(role);
  });
});
