import { randomUUID } from 'node:crypto';
import type { HumanTask, StepRecord } from '@adminforge/engine';
import { PgAuditWriter } from '@adminforge/api/src/audit/writer';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { PgListener } from '@adminforge/api/src/definitions/notify';
import { SECRETS_CHANNEL } from '@adminforge/api/src/runs/secrets';
import {
  PgBossRunQueue,
  PgRunRepository,
  RunEventBus,
  type NewRun,
  type RunNotification,
} from '@adminforge/api/src/runs';
import { testDatabaseUrl } from './db';
import { mockConfig, TEST_KEY } from './helpers';
import { AVERY, BLAKE, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

const url = await testDatabaseUrl();

const newRun = (over: Partial<NewRun> = {}): NewRun => ({
  id: randomUUID(),
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

describe.skipIf(!url)('runs on Postgres', () => {
  let database: Database;
  let repo: PgRunRepository;
  beforeAll(() => {
    database = createDatabase(url!);
    repo = new PgRunRepository(database);
  });
  beforeEach(async () => {
    await database.pool.query('truncate runs, run_steps, run_step_events, approvals');
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

  it('steps: upsert by seq, ordered, jsonb nulls', async () => {
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

  it('events: insert + NOTIFY run_events in one transaction; the bus delivers; listEvents pages after an id', async () => {
    const run = await repo.insertRun(newRun());
    const bus = new RunEventBus({ listenUrl: url! });
    const seen: RunNotification[] = [];
    bus.subscribe(run.id, (n) => seen.push(n));
    await bus.start();
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
    await waitFor(() => seen.length === 2);
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
    await bus.stop();
  });

  it('tasks: idempotent upsert per (run, path) even when concurrent; CAS decisions; filter by kind', async () => {
    const run = await repo.insertRun(newRun());
    const t = approvalTask('approve');
    const rows = await Promise.all([
      repo.upsertTask(run.id, t, policy(t)),
      repo.upsertTask(run.id, t, policy(t)),
      repo.upsertTask(run.id, t, policy(t)),
    ]);
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

  it('tryLock: one executor per run (advisory lock), released explicitly', async () => {
    const id = randomUUID();
    const a = await repo.tryLock(id);
    expect(a).not.toBeNull();
    expect(await repo.tryLock(id)).toBeNull();
    const other = await repo.tryLock(randomUUID());
    expect(other).not.toBeNull();
    await a!.release();
    const b = await repo.tryLock(id);
    expect(b).not.toBeNull();
    await b!.release();
    await other!.release();
  });

  it('end to end on Postgres: create → worker → succeeded, with steps, plan and events', async () => {
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
    // The app closes its database on close: give it its own pool.
    const appDb = createDatabase(url!);
    const t = await runsApp({
      config: mockConfig({ DATABASE_URL: url! }),
      definitions,
      outbound: new FakeExecutor(),
      database: appDb,
      repository: new PgRunRepository(appDb),
    });
    const avery = await t.login(AVERY, ['Portal.Operator'], { armed: true });
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

  it('show-once secrets never reach Postgres: sealed NOTIFY hand-off, fetch once, no row anywhere holds the value', async () => {
    const secret = `Tap-${randomUUID()}`;
    const definitions = new StaticDefinitions().add({
      kind: 'playbook',
      id: 'test.pg-tap',
      version: '1.0.0',
      title: 'PG TAP',
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
    const payloads: string[] = [];
    const spy = new PgListener(url!, SECRETS_CHANNEL, (p) => payloads.push(p));
    await spy.start();
    const appDb = createDatabase(url!);
    const t = await runsApp({
      config: mockConfig({ DATABASE_URL: url!, TOKEN_CACHE_KEY: TEST_KEY }),
      definitions,
      outbound: new FakeExecutor((c) =>
        c.method === 'POST' ? { id: 'm1', temporaryAccessPass: secret } : null,
      ),
      database: appDb,
      repository: new PgRunRepository(appDb),
      audit: new PgAuditWriter(appDb.db),
    });
    try {
      expect(t.runs.secrets.transport).toBe('notify');
      const avery = await t.login(AVERY, ['Portal.Operator'], { armed: true });
      const { runId } = (await avery.post('/api/runs', { playbook: 'test.pg-tap', inputs: {} })).json();
      await t.drain();
      await waitFor(() => t.runs.secrets.heldCount === 1);
      const got = await avery.get(`/api/runs/${runId}/secret/create`, {
        'x-adminforge-csrf': avery.record.csrf,
      });
      expect(got.json().values).toEqual({ temporaryAccessPass: secret });
      expect(
        (await avery.get(`/api/runs/${runId}/secret/create`, { 'x-adminforge-csrf': avery.record.csrf }))
          .statusCode,
      ).toBe(404);
      await waitFor(() => payloads.length >= 2); // the sealed secret, then the "revealed" notice
      expect(payloads.map((p) => JSON.parse(p).t)).toEqual(['secret', 'revealed']);
      expect(payloads.join('\n')).not.toContain(secret);
      for (const table of ['runs', 'run_steps', 'run_step_events', 'approvals', 'audit_events']) {
        const { rows } = await database.pool.query<{ n: string }>(
          `select count(*) as n from ${table} t where t::text like $1`,
          [`%${secret}%`],
        );
        expect([table, rows[0]!.n]).toEqual([table, '0']);
      }
      const { rows } = await database.pool.query<{ action: string }>(
        "select action from audit_events where target_id = $1 and action like 'run.secret.%'",
        [runId],
      );
      expect(rows.map((r) => r.action)).toEqual(['run.secret.revealed']);
    } finally {
      await spy.stop();
      await t.close();
    }
  });

  it(
    'pg-boss queue: enqueue (coalesced per run) → work delivers the run id; startAfter defers',
    { timeout: 30_000 },
    async () => {
      const queue = new PgBossRunQueue(url!);
      try {
        await queue.start();
        const got: string[] = [];
        const now = randomUUID();
        const later = randomUUID();
        await queue.enqueue(now);
        await queue.enqueue(now); // stately: one queued job per run
        await queue.enqueue(later, { startAfter: new Date(Date.now() + 60_000) });
        await queue.work(async (runId) => void got.push(runId), { concurrency: 2 });
        // The test database keeps pg-boss jobs between runs: only look at this test's ids.
        const mine = () => got.filter((id) => id === now || id === later);
        await waitFor(() => mine().length >= 1, 15_000);
        await new Promise((r) => setTimeout(r, 1500));
        expect(mine()).toEqual([now]);
      } finally {
        await queue.stop();
      }
    },
  );
});
