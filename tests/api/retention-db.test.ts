import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '@adminforge/api/src/artifacts/store';
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { applyRetention } from '@adminforge/api/src/housekeeping/retention';
import { SqliteRunRepository, type NewRun } from '@adminforge/api/src/runs';
import { testDatabasePath } from './db';

// History retention: finished runs, schedule history, probe results and report files older than the policy go;
// parked runs, "needs review" runs and recent history stay; the purge is audited.
const file = await testDatabasePath();
const NOW = new Date('2026-10-15T12:00:00Z');
const DAY = 86_400_000;
const POLICY = { runDays: 180, scheduleRunDays: 180, probeDays: 35, artifactDays: 90 };
// Children first; a run's approvals only once the run is gone (the approvals_delete_with_subject trigger).
const RESET = `delete from probe_results; delete from schedule_runs; delete from run_step_events; delete from run_steps;
  delete from runs; delete from approvals;`;

const newRun = (): NewRun => ({
  id: randomUUID(),
  identityName: null,
  kind: 'playbook',
  definitionKey: 'test.retention',
  definitionVersion: '1.0.0',
  definitionSha256: 'a'.repeat(64),
  dryRun: false,
  trigger: 'interactive',
  identity: 'delegated',
  initiatorOid: '00000000-0000-4000-8000-0000000000a1',
  initiatorUpn: 'avery@example.com',
  sessionHash: 'h',
  scheduleId: null,
  parentRunId: null,
  inputs: {},
  correlationId: randomUUID(),
});

describe('applyRetention (SQLite)', () => {
  let database: Database;
  let repo: SqliteRunRepository;
  beforeAll(() => {
    database = createDatabase(file);
    repo = new SqliteRunRepository(database);
  });
  beforeEach(() => {
    database.sqlite.exec(RESET);
  });
  afterAll(async () => {
    await database?.close();
  });

  async function run(status: string, endedDaysAgo: number) {
    const row = await repo.insertRun(newRun());
    const ended = NOW.getTime() - endedDaysAgo * DAY;
    database.sqlite
      .prepare('update runs set status = ?, ended_at = ?, updated_at = ? where id = ?')
      .run(status, ended, ended, row.id);
    database.sqlite
      .prepare(`insert into run_step_events (run_id, type, data, ts) values (?, 'status', '{}', ?)`)
      .run(row.id, ended);
    return row.id;
  }

  /** A decided approval of a run, written the way the triggers allow: inserted pending, then decided once. */
  function approval(runId: string, decidedDaysAgo: number) {
    const id = randomUUID();
    const at = NOW.getTime() - decidedDaysAgo * DAY;
    database.sqlite
      .prepare(
        `insert into approvals (id, subject_type, subject_id, step_id, policy, requested_by, created_at)
         values (?, 'run', ?, 'approve', '{"kind":"approval"}', 'a', ?)`,
      )
      .run(id, runId, at);
    database.sqlite
      .prepare(`update approvals set status = 'approved', decisions = ?, decided_at = ? where id = ?`)
      .run(
        JSON.stringify([
          { oid: 'b', upn: 'blake@example.com', decision: 'approve', at: new Date(at).toISOString() },
        ]),
        at,
        id,
      );
    return id;
  }

  it('purges old finished runs (and their events), keeps recent, parked and needs-review runs', async () => {
    const old = await run('succeeded', 200);
    const recent = await run('failed', 10);
    const parked = await run('awaiting_approval', 400);
    const review = await run('needs_review', 400);
    approval(old, 200);
    const kept = approval(recent, 10);
    const audit = new MemoryAuditWriter(() => NOW);
    const result = await applyRetention(database.db, { artifacts: null, audit, now: NOW }, POLICY);
    expect(result.runs).toBe(1);
    expect(result.events).toBe(1);
    // The old run's approval goes with it (after the run: the trigger refuses it while the run exists).
    expect(result.approvals).toBe(1);
    const left = (database.sqlite.prepare('select id from runs').all() as Array<{ id: string }>)
      .map((r) => r.id)
      .sort();
    expect(left).toEqual([recent, parked, review].sort());
    expect(left).not.toContain(old);
    expect(database.sqlite.prepare('select id from approvals').all()).toEqual([{ id: kept }]);
    expect(audit.rows.at(-1)).toMatchObject({ action: 'housekeeping.retention', details: { runs: 1 } });
  });

  it('purges old probe results and finished schedule history', async () => {
    database.sqlite
      .prepare(
        `insert into probe_results (probe_key, ts, status, metric, duration_ms) values
         ('probes.x', ?, 'ok', 1, 1), ('probes.x', ?, 'ok', 1, 1)`,
      )
      .run(NOW.getTime() - 40 * DAY, NOW.getTime() - DAY);
    const result = await applyRetention(
      database.db,
      { artifacts: null, audit: new MemoryAuditWriter(() => NOW), now: NOW },
      POLICY,
    );
    expect(result.probeResults).toBe(1);
    expect(database.sqlite.prepare('select count(*) as n from probe_results').get()).toEqual({ n: 1 });
  });

  it('removes report files older than the artifact window', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'af-artifacts-'));
    mkdirSync(path.join(dir, 'reports.weekly'));
    const oldFile = path.join(dir, 'reports.weekly', '2026-06-01T06-00-00Z.csv');
    const newFile = path.join(dir, 'reports.weekly', '2026-10-14T06-00-00Z.csv');
    writeFileSync(oldFile, 'x');
    writeFileSync(newFile, 'y');
    const oldTime = new Date(NOW.getTime() - 120 * DAY);
    utimesSync(oldFile, oldTime, oldTime);
    const result = await applyRetention(
      database.db,
      { artifacts: new ArtifactStore(dir), audit: new MemoryAuditWriter(() => NOW), now: NOW },
      POLICY,
    );
    expect(result.artifacts).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
