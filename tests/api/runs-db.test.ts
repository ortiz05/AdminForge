import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { HumanTask, StepRecord } from '@adminforge/engine';
import { SqliteAuditWriter } from '@adminforge/api/src/audit/writer';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import {
  RunEventBus,
  SqliteRunQueue,
  SqliteRunRepository,
  type NewRun,
  type RunNotification,
} from '@adminforge/api/src/runs';
import { testDatabasePath } from './db';
import { mockConfig, TEST_KEY } from './helpers';
import { AVERY, BLAKE, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

const file = await testDatabasePath();

const newRun = (over: Partial<NewRun> = {}): NewRun => ({
  id: randomUUID(),
  identityName: null,
  kind: 'playbook',
  definitionKey: 'test.pg',
  definitionVersion: '1.0.0',
  definitionSha256: 'a'.repeat(64),
  dryRun: false,
  trigger: 'interactive',
  identity: 'delegated',
  initiatorOid: AVERY.oid,
  initiatorUpn: AVERY.upn,
  sessionHash: 'hash-1',
  scheduleId: null,
  parentRunId: null,
  inputs: { userId: 'u1' },
  correlationId: randomUUID(),
  ...over,
});

const step = (seq: number, over: Partial<StepRecord> = {}): StepRecord => ({
  seq,
  stepId: `s${seq}`,
  path: `s${seq}`,
  type: 'graph',
  attempt: 1,
  status: 'running',
  actorOid: AVERY.oid,
  mode: 'read',
  request: { method: 'GET', path: '/users' },
  plan: null,
  output: null,
  error: null,
  msRequestId: null,
  startedAt: new Date('2026-10-15T12:00:00.000Z'),
  endedAt: null,
  ...over,
});

const approvalTask = (path: string): HumanTask => ({
  kind: 'approval',
  path,
  stepId: path,
  message: 'ok?',
  approvers: ['Playbook.Approver'],
  minApprovals: 1,
  expiresAt: null,
  requestedBy: { kind: 'delegated', ...AVERY },
});
const policy = (t: HumanTask) => {
  const { requestedBy: _r, ...rest } = t;
  return {
    ...rest,
    title: 'T',
    definitionKey: 'test.pg',
    definitionVersion: '1.0.0',
    requestedByUpn: AVERY.upn,
    initiatorOid: AVERY.oid,
  };
};

const waitFor = async (check: () => boolean, ms = 5000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('runs on SQLite', () => {
  let database: Database;
  let repo: SqliteRunRepository;
  beforeAll(() => {
    database = createDatabase(file);
    repo = new SqliteRunRepository(database);
  });
  beforeEach(() => {
    // Runs first (steps and events go with them): an approval may only be deleted once its run is gone.
    database.sqlite.exec(
      "delete from run_jobs; delete from leases; delete from runs; delete from approvals where subject_type = 'run';",
    );
  });
  afterAll(async () => {
    await database?.close();
  });

  it('runs: insert, idempotent insert, CAS update, list filters + keyset cursor, tree, stale', async () => {
    const parent = await repo.insertRun(newRun());
    expect(parent).toMatchObject({ status: 'queued', inputs: { userId: 'u1' }, outputs: null, error: null });
    const again = await repo.insertRunIfAbsent({ ...newRun(), id: parent.id, definitionKey: 'other' });
    expect(again.definitionKey).toBe('test.pg');
    const child = await repo.insertRun(newRun({ parentRunId: parent.id, trigger: 'child' }));
    const grandchild = await repo.insertRun(newRun({ parentRunId: child.id, trigger: 'child' }));
    expect((await repo.runTree(parent.id)).map((r) => r.id)).toEqual([parent.id, child.id, grandchild.id]);

    expect(await repo.updateRun(parent.id, { status: 'running' }, ['awaiting_arm'])).toBeNull();
    const running = await repo.updateRun(parent.id, { status: 'running', startedAt: new Date() }, ['queued']);
    expect(running?.status).toBe('running');
    const failed = await repo.updateRun(parent.id, {
      status: 'failed',
      error: { code: 'x', message: 'boom' },
      outputs: null,
    });
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'x', message: 'boom' } });

    for (let i = 0; i < 3; i++)
      await repo.insertRun(newRun({ initiatorOid: BLAKE.oid, definitionKey: 'test.other' }));
    expect(await repo.listRuns({ limit: 10 })).toHaveLength(4); // top level only
    expect(await repo.listRuns({ limit: 10, parentRunId: parent.id })).toHaveLength(1);
    expect(
      await repo.listRuns({
        limit: 10,
        initiatorOid: BLAKE.oid,
        definitionKey: 'test.other',
        statuses: ['queued'],
      }),
    ).toHaveLength(3);
    const page1 = await repo.listRuns({ limit: 2 });
    const last = page1.at(-1)!;
    const page2 = await repo.listRuns({ limit: 2, cursor: { createdAt: last.createdAt, id: last.id } });
    expect(new Set([...page1, ...page2].map((r) => r.id)).size).toBe(4);
    expect((await repo.staleRuns(['queued'], new Date(Date.now() + 60_000), 10)).length).toBe(5);
  });

  it('steps: upsert by seq, ordered, JSON nulls', async () => {
    const run = await repo.insertRun(newRun());
    await repo.saveStep(run.id, step(2));
    await repo.saveStep(run.id, step(1));
    await repo.saveStep(
      run.id,
      step(1, {
        status: 'succeeded',
        output: { value: [1, 2] },
        plan: [{ stepId: 's1', stepPath: 's1', describe: null, service: 'graph', method: 'PATCH' }],
        endedAt: new Date(),
      }),
    );
    const steps = await repo.listSteps(run.id);
    expect(steps.map((s) => [s.seq, s.status])).toEqual([
      [1, 'succeeded'],
      [2, 'running'],
    ]);
    expect(steps[0]).toMatchObject({
      output: { value: [1, 2] },
      plan: [{ stepId: 's1', method: 'PATCH' }],
      error: null,
    });
  });

  it('events: each recorded row goes out with its event id; the bus delivers per run; listEvents pages after an id', async () => {
    const run = await repo.insertRun(newRun());
    // What runs/module.ts wires: the worker and every stream live in the API process (ADR-016).
    const bus = new RunEventBus();
    repo.onNotify = (n) => bus.dispatch(n);
    const seen: RunNotification[] = [];
    const all: RunNotification[] = [];
    const otherRun: RunNotification[] = [];
    bus.subscribe(run.id, (n) => seen.push(n));
    bus.subscribe(randomUUID(), (n) => otherRun.push(n));
    bus.subscribe('*', (n) => all.push(n));
    const e1 = await repo.appendEvent(
      run.id,
      { type: 'status', data: { scope: 'run', status: 'running' } },
      { v: 1, runId: run.id, type: 'run', status: 'running', initiatorOid: AVERY.oid },
    );
    const e2 = await repo.appendEvent(
      run.id,
      { type: 'log', level: 'info', stepSeq: 1, data: { message: 'hi' } },
      { v: 1, runId: run.id, type: 'log' },
    );
    // Delivered in-process as each row is recorded, not on a later poll.
    expect(seen).toHaveLength(2);
    expect(all).toEqual(seen);
    expect(otherRun).toEqual([]);
    expect(seen[0]).toEqual({
      v: 1,
      runId: run.id,
      type: 'run',
      status: 'running',
      initiatorOid: AVERY.oid,
      eventId: e1.id,
    });
    expect((await repo.listEvents(run.id, 0, 10)).map((e) => e.id)).toEqual([e1.id, e2.id]);
    expect(await repo.listEvents(run.id, e1.id, 10)).toEqual([
      expect.objectContaining({ id: e2.id, type: 'log', level: 'info', stepSeq: 1, data: { message: 'hi' } }),
    ]);
    expect(seen[1]!.eventId).toBe(e2.id);
    repo.onNotify = null;
    await bus.stop();
  });

  it('tasks: idempotent upsert per (run, path), also from another connection; CAS decisions; filter by kind', async () => {
    const run = await repo.insertRun(newRun());
    const t = approvalTask('approve');
    // A second connection to the file (another process resuming the same run): still one row per (run, path).
    const other = createDatabase(file, { name: 'other' });
    let rows: Awaited<ReturnType<SqliteRunRepository['upsertTask']>>[];
    try {
      rows = await Promise.all([
        repo.upsertTask(run.id, t, policy(t)),
        new SqliteRunRepository(other).upsertTask(run.id, t, policy(t)),
        repo.upsertTask(run.id, t, policy(t)),
      ]);
    } finally {
      await other.close();
    }
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    const manual: HumanTask = {
      kind: 'manual',
      path: 'check',
      stepId: 'check',
      instructions: 'x',
      checklist: [],
      requestedBy: { kind: 'delegated', ...AVERY },
    };
    await repo.upsertTask(run.id, manual, policy(manual));
    expect((await repo.listTasks({ kind: 'approval', status: 'pending' })).map((r) => r.stepId)).toEqual([
      'approve',
    ]);
    expect((await repo.listTasks({ runIds: [run.id] })).length).toBe(2);
    expect(await repo.listTasks({ runIds: [] })).toEqual([]);
    const decided = await repo.updateTask(
      rows[0]!.id,
      {
        status: 'approved',
        decisions: [
          {
            oid: BLAKE.oid,
            upn: BLAKE.upn,
            decision: 'approve',
            sessionHash: 'h',
            at: new Date().toISOString(),
          },
        ],
        decidedAt: new Date(),
      },
      'pending',
    );
    expect(decided).toMatchObject({ status: 'approved', decisions: [{ oid: BLAKE.oid }] });
    expect(await repo.updateTask(rows[0]!.id, { status: 'rejected' }, 'pending')).toBeNull();
    expect(await repo.getTask(run.id, 'approve')).toMatchObject({
      status: 'approved',
      policy: { kind: 'approval', title: 'T' },
    });
    expect(await repo.getTaskById('not-a-uuid')).toBeNull();
  });

  it('tryLock: one executor per run (a lease), also across connections; released explicitly', async () => {
    const id = randomUUID();
    const a = await repo.tryLock(id);
    expect(a).not.toBeNull();
    expect(await repo.tryLock(id)).toBeNull();
    // Another process on the same file can't take it either.
    const otherDb = createDatabase(file, { name: 'other' });
    try {
      expect(await new SqliteRunRepository(otherDb).tryLock(id)).toBeNull();
    } finally {
      await otherDb.close();
    }
    expect(
      database.sqlite.prepare('select count(*) as n from leases where name = ?').get(`run:${id}`),
    ).toEqual({
      n: 1,
    });
    const other = await repo.tryLock(randomUUID());
    expect(other).not.toBeNull();
    await a!.release();
    const b = await repo.tryLock(id);
    expect(b).not.toBeNull();
    await b!.release();
    await other!.release();
    expect(database.sqlite.prepare('select count(*) as n from leases').get()).toEqual({ n: 0 });
  });

  it('tryLock: the lease of a holder that stopped renewing (its process died) is free after its TTL', async () => {
    const id = randomUUID();
    const dead = await repo.tryLock(id);
    expect(dead).not.toBeNull();
    // Two minutes later (RUN_LOCK_TTL_MS), with no renewal in between: another worker takes the run over.
    const later = new SqliteRunRepository(database, () => new Date(Date.now() + 121_000));
    const taken = await later.tryLock(id);
    expect(taken).not.toBeNull();
    // The old holder letting go doesn't free the new holder's lease.
    await dead!.release();
    expect(await repo.tryLock(id)).toBeNull();
    await taken!.release();
    const again = await repo.tryLock(id);
    expect(again).not.toBeNull();
    await again!.release();
  });

  it('end to end on SQLite: create → worker → succeeded, with steps, plan and events', async () => {
    const definitions = new StaticDefinitions().add({
      kind: 'playbook',
      id: 'test.pg',
      version: '1.0.0',
      title: 'PG run',
      owner: 'tests',
      risk: 'low',
      mode: 'write',
      steps: [
        { id: 'lookup', type: 'graph', mode: 'read', request: { method: 'GET', path: '/me' } },
        {
          id: 'patch',
          type: 'graph',
          mode: 'write',
          describe: 'Patch',
          request: { method: 'PATCH', path: '/me', body: { a: 1 } },
        },
      ],
    } as never);
    // The app closes its database on close: give it its own connection.
    const appDb = createDatabase(file);
    const t = await runsApp({
      config: mockConfig({ DATABASE_PATH: file }),
      definitions,
      outbound: new FakeExecutor(),
      database: appDb,
      repository: new SqliteRunRepository(appDb),
    });
    const avery = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator'], { armed: true });
    const { runId } = (await avery.post('/api/runs', { playbook: 'test.pg', inputs: {} })).json();
    await t.drain();
    const detail = (await avery.get(`/api/runs/${runId}`)).json();
    expect(detail.run.status).toBe('succeeded');
    expect(detail.steps.map((s: { stepId: string; status: string }) => [s.stepId, s.status])).toEqual([
      ['lookup', 'succeeded'],
      ['patch', 'succeeded'],
    ]);
    const sse = await avery.get(`/api/runs/${runId}/events`);
    expect(sse.body).toContain('"type":"run"');
    expect(sse.body.trimEnd().endsWith('event: end\ndata: {"status":"succeeded"}')).toBe(true);
    await t.close();
  });

  it('show-once secrets never reach the database: held in memory, fetched once, no row or file holds the value', async () => {
    const secret = `Tap-${randomUUID()}`;
    const definitions = new StaticDefinitions().add({
      kind: 'playbook',
      id: 'test.pg-tap',
      version: '1.0.0',
      title: 'TAP',
      owner: 'tests',
      risk: 'low',
      mode: 'write',
      steps: [
        {
          id: 'create',
          type: 'graph',
          mode: 'write',
          describe: 'Create TAP',
          request: { method: 'POST', path: '/users/u/authentication/temporaryAccessPassMethods' },
          secretOutputs: ['temporaryAccessPass'],
        },
      ],
    } as never);
    const appDb = createDatabase(file);
    const t = await runsApp({
      config: mockConfig({ DATABASE_PATH: file, TOKEN_CACHE_KEY: TEST_KEY }),
      definitions,
      outbound: new FakeExecutor((c) =>
        c.method === 'POST' ? { id: 'm1', temporaryAccessPass: secret } : null,
      ),
      database: appDb,
      repository: new SqliteRunRepository(appDb),
      audit: new SqliteAuditWriter(appDb.db, undefined, null),
    });
    try {
      const avery = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator'], { armed: true });
      const { runId } = (await avery.post('/api/runs', { playbook: 'test.pg-tap', inputs: {} })).json();
      await t.drain();
      // No stream was open: the worker (this process, ADR-016) holds it in memory for one fetch.
      await waitFor(() => t.runs.secrets.heldCount === 1);
      const got = await avery.get(`/api/runs/${runId}/secret/create`, {
        'x-adminforge-csrf': avery.record.csrf,
      });
      expect(got.json().values).toEqual({ temporaryAccessPass: secret });
      expect(
        (await avery.get(`/api/runs/${runId}/secret/create`, { 'x-adminforge-csrf': avery.record.csrf }))
          .statusCode,
      ).toBe(404);
      expect(t.runs.secrets.heldCount).toBe(0);
      // Every row of every table (runs, steps, events, approvals, audit, run_jobs, signals, …) as text.
      const tables = database.sqlite
        .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
        .all() as Array<{ name: string }>;
      expect(tables.map((r) => r.name)).toEqual(
        expect.arrayContaining([
          'runs',
          'run_steps',
          'run_step_events',
          'approvals',
          'audit_events',
          'signals',
        ]),
      );
      for (const { name } of tables) {
        const rows = database.sqlite.prepare(`select * from "${name}"`).all();
        expect([name, JSON.stringify(rows).includes(secret)]).toEqual([name, false]);
      }
      // Nor anywhere in the files themselves (free pages, the write-ahead log).
      for (const f of [file, `${file}-wal`])
        if (existsSync(f)) expect([f, readFileSync(f).includes(secret)]).toEqual([f, false]);
      const audited = database.sqlite
        .prepare("select action from audit_events where target_id = ? and action like 'run.secret.%'")
        .all(runId) as Array<{ action: string }>;
      expect(audited.map((r) => r.action)).toEqual(['run.secret.revealed']);
    } finally {
      await t.close();
    }
  });

  describe('the run queue (run_jobs)', () => {
    // Short polls and leases so the timers do their work within the test; ids are this test's own.
    const fast = { pollMs: 25, retryDelayMs: 50, gracefulMs: 1000 };
    const jobs = (runId: string) =>
      database.sqlite
        .prepare(
          'select state, attempts, start_after as startAfter from run_jobs where run_id = ? order by id',
        )
        .all(runId) as Array<{ state: string; attempts: number; startAfter: number }>;

    it('enqueue (coalesced per run) → work delivers the run id; startAfter defers; an earlier start wins', async () => {
      const queue = new SqliteRunQueue(database, undefined, fast);
      try {
        const got: string[] = [];
        const now = randomUUID();
        const later = randomUUID();
        await queue.enqueue(now);
        await queue.enqueue(now); // one queued job per run
        await queue.enqueue(later, { startAfter: new Date(Date.now() + 60_000) });
        expect(jobs(now)).toEqual([expect.objectContaining({ state: 'queued', attempts: 0 })]);
        await queue.work(async (runId) => void got.push(runId), { concurrency: 2 });
        await waitFor(() => got.includes(now));
        await new Promise((r) => setTimeout(r, 150));
        expect(got).toEqual([now]);
        // Done jobs are removed; the deferred one waits for its time.
        expect(jobs(now)).toEqual([]);
        expect(jobs(later)).toEqual([expect.objectContaining({ state: 'queued' })]);
        expect(jobs(later)[0]!.startAfter).toBeGreaterThan(Date.now() + 50_000);
        // A wait step's run that is resumed early (an approval came in): the earlier start replaces the later one.
        await queue.enqueue(later);
        await waitFor(() => got.includes(later));
        expect(got).toEqual([now, later]);
      } finally {
        await queue.stop();
      }
    });

    it('a failing job is retried with backoff, counting attempts', async () => {
      const warnings: string[] = [];
      const queue = new SqliteRunQueue(database, { warn: (_o, msg) => void warnings.push(msg) }, fast);
      try {
        const runId = randomUUID();
        let calls = 0;
        await queue.enqueue(runId);
        await queue.work(
          async () => {
            calls++;
            if (calls === 1) throw new Error('Graph was unavailable');
          },
          { concurrency: 1 },
        );
        await waitFor(() => calls === 2);
        expect(warnings).toEqual(['run job failed']);
        await waitFor(() => jobs(runId).length === 0);
      } finally {
        await queue.stop();
      }
    });

    it('a job whose process died (lease not renewed) is queued again and taken by another process', async () => {
      // Two processes on the same file. The first claims the job and then hangs without renewing its lease.
      const otherDb = createDatabase(file, { name: 'other' });
      const lease = { leaseMs: 400, renewMs: 60_000 };
      const first = new SqliteRunQueue(database, undefined, { ...fast, ...lease });
      const second = new SqliteRunQueue(otherDb, undefined, { ...fast, ...lease });
      let release!: () => void;
      const hung = new Promise<void>((r) => (release = r));
      try {
        const runId = randomUUID();
        const seen: string[] = [];
        await first.enqueue(runId);
        await first.work(
          async () => {
            seen.push('first');
            await hung;
          },
          { concurrency: 1 },
        );
        await waitFor(() => seen.length === 1);
        expect(jobs(runId)).toEqual([expect.objectContaining({ state: 'active' })]);
        await second.work(async () => void seen.push('second'), { concurrency: 1 });
        await waitFor(() => seen.includes('second'));
        expect(seen).toEqual(['first', 'second']);
        await waitFor(() => jobs(runId).length === 0);
        // The first process finishing late doesn't resurrect or duplicate the job.
        release();
        await new Promise((r) => setTimeout(r, 100));
        expect(jobs(runId)).toEqual([]);
        expect(seen).toEqual(['first', 'second']);
      } finally {
        release?.();
        await first.stop();
        await second.stop();
        await otherDb.close();
      }
    });
  });
});
