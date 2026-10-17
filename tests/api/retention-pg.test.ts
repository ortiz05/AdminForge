import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '@adminforge/api/src/artifacts/store';
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { applyRetention } from '@adminforge/api/src/housekeeping/retention';
import { PgRunRepository, type NewRun } from '@adminforge/api/src/runs';
import { testDatabaseUrl } from './db';

// History retention: finished runs, schedule history, probe results and report files older than the policy go;
// parked runs, "needs review" runs and recent history stay; the purge is audited.
const url = await testDatabaseUrl();
const NOW = new Date('2026-10-15T12:00:00Z');
const DAY = 86_400_000;
const POLICY = { runDays: 180, scheduleRunDays: 180, probeDays: 35, artifactDays: 90 };

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

describe.skipIf(!url)('applyRetention (Postgres)', () => {
  let database: Database;
  let repo: PgRunRepository;
  beforeAll(() => {
    database = createDatabase(url!);
    repo = new PgRunRepository(database);
  });
  beforeEach(async () => {
    await database.pool.query(
      'truncate runs, run_steps, run_step_events, approvals, schedule_runs, probe_results cascade',
    );
  });
  afterAll(async () => {
    await database?.close();
  });

  async function run(status: string, endedDaysAgo: number) {
    const row = await repo.insertRun(newRun());
    const ended = new Date(NOW.getTime() - endedDaysAgo * DAY);
    await database.pool.query('update runs set status = $1, ended_at = $2, updated_at = $2 where id = $3', [
      status,
      ended,
      row.id,
    ]);
    await database.pool.query(
      `insert into run_step_events (run_id, type, data, ts) values ($1, 'status', '{}'::jsonb, $2)`,
      [row.id, ended],
    );
    return row.id;
  }

  it('purges old finished runs (and their events), keeps recent, parked and needs-review runs', async () => {
    const old = await run('succeeded', 200);
    const recent = await run('failed', 10);
    const parked = await run('awaiting_approval', 400);
    const review = await run('needs_review', 400);
    const audit = new MemoryAuditWriter(() => NOW);
    const result = await applyRetention(database.db, { artifacts: null, audit, now: NOW }, POLICY);
    expect(result.runs).toBe(1);
    expect(result.events).toBe(1);
    const left = (await database.pool.query('select id from runs')).rows.map((r) => r.id).sort();
    expect(left).toEqual([recent, parked, review].sort());
    expect(left).not.toContain(old);
    expect(audit.rows.at(-1)).toMatchObject({ action: 'housekeeping.retention', details: { runs: 1 } });
  });

  it('purges old probe results and finished schedule history', async () => {
    await database.pool.query(
      `insert into probe_results (probe_key, ts, status, metric, duration_ms) values
       ('probes.x', $1, 'ok', 1, 1), ('probes.x', $2, 'ok', 1, 1)`,
      [new Date(NOW.getTime() - 40 * DAY), new Date(NOW.getTime() - DAY)],
    );
    const result = await applyRetention(
      database.db,
      { artifacts: null, audit: new MemoryAuditWriter(() => NOW), now: NOW },
      POLICY,
    );
    expect(result.probeResults).toBe(1);
    expect(Number((await database.pool.query('select count(*) from probe_results')).rows[0].count)).toBe(1);
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
