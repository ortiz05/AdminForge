import { randomUUID } from 'node:crypto';
import { PgAuditWriter, type Checkpoint } from '@adminforge/api/src/audit/writer';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertDatabaseRole,
  createDatabase,
  databaseRoleProblems,
  type Database,
} from '@adminforge/api/src/db/client';
import { testDatabaseUrl } from './db';

// Database hardening on a real Postgres (migrations 0009 and 0010, db/client.ts, audit/writer.ts): connection limits
// reach the server, foreign keys and status CHECKs hold, approval decisions are append-only, and the audit chain is
// verified in batches with its tail recorded outside the database.
const url = await testDatabaseUrl();

const code = (sqlState: string) => expect.objectContaining({ code: sqlState });

describe.skipIf(!url)('database hardening (Postgres)', () => {
  let database: Database;
  beforeAll(() => {
    database = createDatabase(url!, { name: 'test', statementTimeoutMs: 45_000, lockTimeoutMs: 7_000 });
  });
  beforeEach(async () => {
    await database.pool.query('truncate runs, run_steps, run_step_events, approvals, schedule_runs cascade');
  });
  afterAll(async () => {
    await database?.close();
  });

  const q = (sql: string, params: unknown[] = []) => database.pool.query(sql, params);
  const insertRun = async (status = 'succeeded', parent: string | null = null) => {
    const id = randomUUID();
    await q(
      `insert into runs (id, kind, definition_key, definition_version, definition_sha256, status, correlation_id, parent_run_id)
       values ($1, 'playbook', 'test.hardening', '1.0.0', $2, $3, $4, $5)`,
      [id, 'a'.repeat(64), status, randomUUID(), parent],
    );
    return id;
  };
  const insertApproval = async () => {
    const { rows } = await q(
      `insert into approvals (subject_type, subject_id, policy, requested_by) values ('run', $1, '{}'::jsonb, 'x') returning id`,
      [randomUUID()],
    );
    return rows[0]!.id as string;
  };

  it('sends the limits and the name with every connection', async () => {
    const { rows } = await q(
      "select current_setting('statement_timeout') as st, current_setting('lock_timeout') as lt, current_setting('idle_in_transaction_session_timeout') as it, current_setting('application_name') as app",
    );
    expect(rows[0]).toEqual({ st: '45s', lt: '7s', it: '1min', app: 'adminforge-test' });
    expect(Array.isArray(await databaseRoleProblems(database.pool))).toBe(true);
  });

  it('cascades a run to its steps and events, and refuses steps of a run that does not exist', async () => {
    const run = await insertRun();
    await q(
      `insert into run_steps (run_id, seq, step_id, path, type, status, mode) values ($1, 1, 's', 's', 'graph', 'succeeded', 'read')`,
      [run],
    );
    await q(`insert into run_step_events (run_id, type) values ($1, 'log')`, [run]);
    await expect(
      q(
        `insert into run_steps (run_id, seq, step_id, path, type, status, mode) values ($1, 1, 's', 's', 'graph', 'succeeded', 'read')`,
        [randomUUID()],
      ),
    ).rejects.toEqual(code('23503'));
    await q('delete from runs where id = $1', [run]);
    const { rows } = await q(
      'select (select count(*) from run_steps where run_id = $1) as steps, (select count(*) from run_step_events where run_id = $1) as events',
      [run],
    );
    expect(rows[0]).toEqual({ steps: '0', events: '0' });
  });

  it('keeps a child run when its parent is purged (the link is cleared)', async () => {
    const parent = await insertRun();
    const child = await insertRun('succeeded', parent);
    await q('delete from runs where id = $1', [parent]);
    const { rows } = await q('select parent_run_id from runs where id = $1', [child]);
    expect(rows[0]!.parent_run_id).toBeNull();
  });

  it('accepts only known status values', async () => {
    await expect(insertRun('finished')).rejects.toEqual(code('23514'));
    await expect(q(`insert into probe_results (probe_key, status) values ('x', 'green')`)).rejects.toEqual(
      code('23514'),
    );
    const pending = await insertApproval();
    await expect(q(`update approvals set status = 'maybe' where id = $1`, [pending])).rejects.toEqual(
      code('23514'),
    );
  });

  it('approvals: start pending, record decisions append-only, and are final once decided', async () => {
    // A forged approval can't be inserted already approved.
    await expect(
      q(
        `insert into approvals (subject_type, subject_id, policy, requested_by, status) values ('run', 'x', '{}', 'x', 'approved')`,
      ),
    ).rejects.toThrow(/starts pending/);
    const id = await insertApproval();
    const first = { oid: 'a', decision: 'approve', sessionHash: 's1' };
    await q(`update approvals set decisions = $2::jsonb where id = $1`, [id, JSON.stringify([first])]);
    // The same person resuming with a new session rebinds sessionHash — the only change allowed to a decision (0011:
    // only to a session of theirs).
    await session('s2', 'a');
    await q(`update approvals set decisions = $2::jsonb where id = $1`, [
      id,
      JSON.stringify([{ ...first, sessionHash: 's2' }]),
    ]);
    await expect(
      q(`update approvals set decisions = $2::jsonb where id = $1`, [
        id,
        JSON.stringify([{ ...first, oid: 'mallory', sessionHash: 's2' }]),
      ]),
    ).rejects.toThrow(/cannot change/);
    await expect(q(`update approvals set decisions = '[]'::jsonb where id = $1`, [id])).rejects.toThrow(
      /append-only/,
    );
    await expect(q(`update approvals set requested_by = 'y' where id = $1`, [id])).rejects.toThrow(
      /only the decision/,
    );
    await q(`update approvals set status = 'rejected', decided_at = now() where id = $1`, [id]);
    await expect(q(`update approvals set status = 'approved' where id = $1`, [id])).rejects.toThrow(/final/);
    await expect(
      q(
        `update approvals set decisions = decisions || '[{"oid":"b","decision":"approve"}]'::jsonb where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/final/);
    // Retention may still purge a decided approval.
    await q('delete from approvals where id = $1', [id]);
  });

  it('verifies the audit chain in batches and records the tail outside the database', async () => {
    const seen: Array<Checkpoint & { count: number }> = [];
    const writer = new PgAuditWriter(
      database.db,
      () => new Date(),
      (cp) => seen.push(cp),
      3,
    );
    for (let i = 0; i < 7; i++)
      await writer.append({ action: 'test.hardening', result: 'success', correlationId: randomUUID() });
    const { rows } = await q('select count(*)::int as n, max(seq)::int as tail from audit_events');
    const res = await writer.verify();
    // Other suites may append to the shared test database meanwhile: at least what was there a moment ago.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.count).toBeGreaterThanOrEqual(rows[0]!.n);
    expect(res.tail!.seq).toBeGreaterThanOrEqual(rows[0]!.tail);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      seq: res.tail!.seq,
      hash: res.tail!.hash,
      count: res.count,
    });
    expect(seen[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // Migration 0011.
  const session = async (idHash: string, userOid: string) =>
    q(
      `insert into sessions (id_hash, user_oid, upn, display_name, tenant_id, tenant_name, tenant_domain, csrf, expires_at)
       values ($1, $2, 'u@example.com', 'U', 't', 'T', 'example.com', 'c', now() + interval '1 hour') on conflict do nothing`,
      [idHash, userOid],
    );

  it('approvals: rebinding a decision needs a session of the person who made it', async () => {
    const id = await insertApproval();
    const mine = `s-${randomUUID()}`;
    const theirs = `s-${randomUUID()}`;
    await session(mine, 'avery');
    await session(theirs, 'mallory');
    const decision = { oid: 'avery', decision: 'approve', sessionHash: 'old' };
    await q(`update approvals set decisions = $2::jsonb where id = $1`, [id, JSON.stringify([decision])]);
    await expect(
      q(`update approvals set decisions = $2::jsonb where id = $1`, [
        id,
        JSON.stringify([{ ...decision, sessionHash: theirs }]),
      ]),
    ).rejects.toThrow(/session of the person who made it/);
    await q(`update approvals set decisions = $2::jsonb where id = $1`, [
      id,
      JSON.stringify([{ ...decision, sessionHash: mine }]),
    ]);
  });

  it('approvals: deleted only together with their run (so a rejection can’t be replaced by a fresh approval)', async () => {
    const run = await insertRun();
    const { rows } = await q(
      `insert into approvals (subject_type, subject_id, policy, requested_by) values ('run', $1, '{}'::jsonb, 'x') returning id`,
      [run],
    );
    const id = rows[0]!.id as string;
    await q(`update approvals set status = 'rejected', decided_at = now() where id = $1`, [id]);
    await expect(q('delete from approvals where id = $1', [id])).rejects.toThrow(
      /deleted only together with its run/,
    );
    // Retention's order — the approvals, then the run — in one transaction.
    const c = await database.pool.connect();
    try {
      await c.query('begin');
      await c.query('delete from approvals where id = $1', [id]);
      await c.query('delete from runs where id = $1', [run]);
      await c.query('commit');
    } finally {
      c.release();
    }
    expect((await q('select count(*)::int as n from approvals where id = $1', [id])).rows[0]!.n).toBe(0);
  });

  it('approvals: the checks run with a fixed search_path, so a shadowing operator changes nothing', async () => {
    const { rows } = await q(
      "select proname, proconfig from pg_proc where proname in ('approvals_append_only', 'approvals_delete_with_subject', 'audit_events_append_only') order by proname",
    );
    for (const r of rows) expect(r.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
    const schema = `af_shadow_${randomBytes(4).toString('hex')}`;
    const c = await database.pool.connect();
    try {
      await c.query(`create schema ${schema}`);
      await c.query(
        `create function ${schema}.never(text, text) returns boolean language sql immutable as 'select false'`,
      );
      await c.query(
        `create operator ${schema}.<> (leftarg = text, rightarg = text, function = ${schema}.never)`,
      );
      await c.query('begin');
      await c.query(`set local search_path = ${schema}, pg_catalog, public`);
      await expect(
        c.query(
          `insert into public.approvals (subject_type, subject_id, policy, requested_by, status) values ('run', 'x', '{}', 'x', 'approved')`,
        ),
      ).rejects.toThrow(/starts pending/);
      await c.query('rollback');
    } finally {
      await c.query(`drop schema if exists ${schema} cascade`).catch(() => undefined);
      c.release();
    }
  });

  it('startup role check: the least-privilege role passes in production, the owner does not', async () => {
    const role = `af_check_${randomBytes(4).toString('hex')}`;
    const queue = `af_queue_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(16).toString('hex');
    const target = new URL(url!);
    const grants = readFileSync(
      path.resolve(import.meta.dirname, '../../portal/deploy/db/app-role-grants.sql'),
      'utf8',
    )
      .replaceAll('{{APP_ROLE}}', role)
      .replaceAll('{{OWNER}}', decodeURIComponent(target.username))
      .replaceAll('{{DB}}', target.pathname.slice(1))
      .replaceAll('{{QUEUE_SCHEMA}}', queue);
    await q(`create role ${role} with login nosuperuser password '${password}'`);
    let app: Database | undefined;
    try {
      await q(grants);
      target.username = role;
      target.password = password;
      app = createDatabase(target.toString(), { max: 1 });
      await expect(
        assertDatabaseRole(app, { production: true, warn: () => undefined }),
      ).resolves.toBeUndefined();
      // The test database's owner owns the audit table and may create in public: refused in production.
      await expect(assertDatabaseRole(database, { production: true, warn: () => undefined })).rejects.toThrow(
        /audit log's owner|superuser/,
      );
    } finally {
      await app?.close();
      await q(`drop owned by ${role}`).catch(() => undefined);
      await q(`drop schema if exists ${queue} cascade`).catch(() => undefined);
      await q(`drop role if exists ${role}`).catch(() => undefined);
    }
  });
});
