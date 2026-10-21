import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { triggerStatement } from '@adminforge/api/src/db/migrate';
import { testDatabasePath } from './db';

// The append-only rules the database enforces whatever the application does (drizzle/0001_append_only.sql): audit
// events never change or disappear; approval decisions are append-only, a decided approval is final, a decision is
// rebound only to its maker's own session, and an approval goes only together with its run or schedule. Each rule
// answers with its own message (exactly one trigger fires for a given change).
describe('append-only triggers (SQLite)', () => {
  let database: Database;
  const run = (sql: string, ...params: unknown[]) => database.sqlite.prepare(sql).run(...params);

  beforeAll(async () => {
    database = createDatabase(await testDatabasePath());
  });
  afterAll(async () => {
    await database.close();
  });

  const newRun = (id: string) =>
    run(
      `insert into runs (id, kind, definition_key, definition_version, definition_sha256, status, correlation_id,
         created_at, updated_at) values (?, 'playbook', 'k', '1.0.0', 's', 'awaiting_approval', 'c', 1, 1)`,
      id,
    );
  const newApproval = (id: string, runId: string) =>
    run(
      `insert into approvals (id, subject_type, subject_id, policy, requested_by, created_at)
       values (?, 'run', ?, '{"kind":"approval"}', 'u-1', 1)`,
      id,
      runId,
    );
  const session = (idHash: string, oid: string) =>
    run(
      `insert into sessions (id_hash, user_oid, upn, display_name, tenant_id, tenant_name, tenant_domain, csrf,
         created_at, last_seen_at, expires_at) values (?, ?, 'a@example.com', 'A', 't', 'Example Org', 'example.com', 'c', 1, 1, 1)`,
      idHash,
      oid,
    );
  const decide = (id: string, decisions: unknown[]) =>
    run('update approvals set decisions = ? where id = ?', JSON.stringify(decisions), id);

  it('audit events: inserts only — no update, no delete (not even of every row)', () => {
    run(
      `insert into audit_events (ts, action, result, correlation_id, prev_hash, hash)
       values (1, 'test.event', 'success', 'c', 'p', 'h')`,
    );
    expect(() => run("update audit_events set result = 'tampered'")).toThrow(
      'audit_events is append-only (UPDATE blocked)',
    );
    expect(() => run('delete from audit_events')).toThrow('audit_events is append-only (DELETE blocked)');
    expect(database.sqlite.prepare('select count(*) as n from audit_events').get()).toEqual({ n: 1 });
  });

  it('REPLACE (a delete in disguise) is refused on both tables, as is a non-array decisions value', () => {
    run(
      `insert into audit_events (seq, ts, action, result, correlation_id, prev_hash, hash)
       values (100, 1, 'kept', 'success', 'c', 'p', 'h')`,
    );
    expect(() =>
      run(
        `insert or replace into audit_events (seq, ts, action, result, correlation_id, prev_hash, hash)
         values (100, 1, 'FORGED', 'success', 'c', 'p', 'h')`,
      ),
    ).toThrow('audit_events is append-only (DELETE blocked)');
    newRun('r-replace');
    newApproval('a-replace', 'r-replace');
    run("update approvals set status = 'rejected', decided_at = 5 where id = 'a-replace'");
    // Reopening a rejection by replacing the row with a fresh pending one.
    expect(() =>
      run(
        `insert or replace into approvals (id, subject_type, subject_id, policy, requested_by, created_at)
         values ('a-replace', 'run', 'r-replace', '{"kind":"approval"}', 'u-1', 1)`,
      ),
    ).toThrow(/approvals: an approval is deleted only together with its run or schedule/);
    expect(database.sqlite.prepare("select status from approvals where id = 'a-replace'").get()).toEqual({
      status: 'rejected',
    });
    // An object where the decisions array belongs (json_array_length would read it as 0 decisions).
    expect(() =>
      run(
        `insert into approvals (id, subject_type, subject_id, policy, decisions, requested_by, created_at)
         values ('a-obj', 'run', 'r-replace', '{}', '{"0":{"oid":"u-2","decision":"approve"}}', 'u-1', 1)`,
      ),
    ).toThrow(/CHECK constraint failed: approvals_decisions_array/);
  });

  it('a new approval starts pending, without decisions', () => {
    newRun('r-new');
    expect(() =>
      run(
        `insert into approvals (id, subject_type, subject_id, policy, status, requested_by, created_at)
         values ('a-x', 'run', 'r-new', '{}', 'approved', 'u-1', 1)`,
      ),
    ).toThrow('approvals: a new approval starts pending, with no decisions');
    expect(() =>
      run(
        `insert into approvals (id, subject_type, subject_id, policy, decisions, requested_by, created_at)
         values ('a-y', 'run', 'r-new', '{}', '[{"oid":"u-2"}]', 'u-1', 1)`,
      ),
    ).toThrow('approvals: a new approval starts pending, with no decisions');
  });

  it('decisions are appended, never changed or dropped; only the decision part of a row changes', () => {
    newRun('r-1');
    newApproval('a-1', 'r-1');
    session('s-1', 'u-2');
    session('s-2', 'u-2');
    session('s-other', 'u-9');
    const d = {
      oid: 'u-2',
      upn: 'b@example.com',
      decision: 'approve',
      at: '2026-10-20T00:00:00.000Z',
      sessionHash: 's-1',
    };
    decide('a-1', [d]);
    expect(() => decide('a-1', [{ ...d, decision: 'reject' }])).toThrow(
      'approvals: a recorded decision cannot change',
    );
    expect(() => decide('a-1', [])).toThrow('approvals: decisions are append-only');
    expect(() => run(`update approvals set policy = '{"kind":"none"}' where id = 'a-1'`)).toThrow(
      'approvals: only the decision of an approval can change',
    );
    expect(() => run("update approvals set requested_by = 'u-3' where id = 'a-1'")).toThrow(
      'approvals: only the decision of an approval can change',
    );
    // Rebinding: only to a live session of the same person (resuming with a new session).
    expect(() => decide('a-1', [{ ...d, sessionHash: 's-other' }])).toThrow(
      'approvals: a decision can be rebound only to a session of the person who made it',
    );
    expect(() => decide('a-1', [{ ...d, sessionHash: 'gone' }])).toThrow(/rebound only to a session/);
    expect(() => decide('a-1', [{ ...d, sessionHash: 's-2' }])).not.toThrow();
    // Appending a second decision keeps the first as it was.
    expect(() =>
      decide('a-1', [
        { ...d, sessionHash: 's-2' },
        { ...d, oid: 'u-3', sessionHash: null },
      ]),
    ).not.toThrow();
  });

  it('a decided approval is final', () => {
    newRun('r-2');
    newApproval('a-2', 'r-2');
    run("update approvals set status = 'rejected', decided_at = 5 where id = 'a-2'");
    expect(() => run("update approvals set status = 'approved' where id = 'a-2'")).toThrow(
      'approvals: a decided approval is final',
    );
    expect(() => run("update approvals set decided_at = 6 where id = 'a-2'")).toThrow(
      'approvals: a decided approval is final',
    );
  });

  it('an approval is deleted only once its run (or schedule) is gone — retention deletes the run first', () => {
    newRun('r-3');
    newApproval('a-3', 'r-3');
    expect(() => run("delete from approvals where id = 'a-3'")).toThrow(
      'approvals: an approval is deleted only together with its run or schedule (retention)',
    );
    run("delete from runs where id = 'r-3'");
    expect(() => run("delete from approvals where id = 'a-3'")).not.toThrow();
  });

  it('the importer can put a trigger back exactly as the migration wrote it', () => {
    const create = triggerStatement('approvals_insert_pending');
    expect(create).toMatch(/^CREATE TRIGGER `approvals_insert_pending` BEFORE INSERT ON `approvals`/);
    database.sqlite.exec('drop trigger approvals_insert_pending');
    database.sqlite.exec(create);
    newRun('r-4');
    expect(() =>
      run(
        `insert into approvals (id, subject_type, subject_id, policy, status, requested_by, created_at)
         values ('a-4', 'run', 'r-4', '{}', 'approved', 'u-1', 1)`,
      ),
    ).toThrow('approvals: a new approval starts pending, with no decisions');
    expect(() => triggerStatement('no_such_trigger')).toThrow(/No migration creates trigger no_such_trigger/);
  });
});
