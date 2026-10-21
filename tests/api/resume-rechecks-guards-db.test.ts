import path from 'node:path';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import type { ExecutionIdentity, ServiceCall } from '@adminforge/api/src/execution/types';
import { SqliteRunQueue, SqliteRunRepository } from '@adminforge/api/src/runs';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';
import { testDatabasePath } from './db';
import { mockConfig } from './helpers';
import { AVERY, BLAKE, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';
import { playbook, restartKit, until, write } from './runs-restart-helpers';

// A run that pauses before a write and continues later runs the reads and checks before that write again, so it acts
// on what is true now: `avd.log-off-user-session` checks that the session still belongs to the person the list
// showed, waits for write access, and — when someone else holds that session number by then — signs nobody out.
// Covered here on SQLite through the API: arming, an approval, and a restart (D-01).

const OPERATOR = ['Portal.Reader', 'Portal.Operator'];
const APPROVER = ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver'];
const SESSION_ID =
  '/subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg-example-avd/providers/Microsoft.DesktopVirtualization/hostPools/hp-example-pooled/sessionHosts/avd-ex-0001.example.com/userSessions/3';
const SESSION_TYPE = 'Microsoft.DesktopVirtualization/hostPools/sessionHosts/userSessions';

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const logOff = loaded.definitions.find((d) => (d.def as { id: string }).id === 'avd.log-off-user-session')!
  .def as never;

/** Azure, faked: the user session read answers whoever `holder` says signed in; writes answer null. */
function sessionFake() {
  const holder = { upn: 'm.chen@example.com' };
  const outbound = new FakeExecutor((call: ServiceCall) =>
    call.method === 'GET'
      ? {
          name: 'hp-example-pooled/avd-ex-0001.example.com/3',
          type: SESSION_TYPE,
          properties: { userPrincipalName: holder.upn, sessionState: 'Active' },
        }
      : null,
  );
  return { holder, outbound };
}

async function sqliteApp(definitions: StaticDefinitions, outbound: FakeExecutor) {
  const file = await testDatabasePath();
  const database: Database = createDatabase(file);
  // The repository keeps time with the API's test clock (previews are dated by it, and checked against it).
  const clock: { now: () => Date } = { now: () => new Date() };
  const repository = new SqliteRunRepository(database, () => clock.now());
  const queue = new SqliteRunQueue(database, undefined, { pollMs: 20, busyDelayMs: 20, retryDelayMs: 20 });
  const t = await runsApp({
    config: mockConfig({ DATABASE_PATH: file }),
    definitions,
    outbound,
    database,
    repository,
    runs: { queue, inProcessWorker: true },
  });
  clock.now = t.clock.now;
  const status = async (id: string) => (await repository.getRun(id))!.status;
  return {
    ...t,
    repository,
    status,
    settled: (id: string, want: string) => until(async () => (await status(id)) === want),
    close: async () => {
      await t.close();
      await database.close();
    },
  };
}

describe('a resumed run checks again before its next write (SQLite)', () => {
  it('avd.log-off-user-session parked on arming signs nobody out when the session changed hands', async () => {
    const { holder, outbound } = sessionFake();
    const t = await sqliteApp(new StaticDefinitions().add(logOff), outbound);
    try {
      const avery = await t.login(AVERY, OPERATOR); // not armed yet
      const inputs = { userSessionId: SESSION_ID, expectedUser: 'm.chen@example.com', reason: 'ticket 5521' };
      const preview = (
        await avery.post('/api/runs', { playbook: 'avd.log-off-user-session', inputs, dryRun: true })
      ).json() as { runId: string };
      await t.settled(preview.runId, 'succeeded');
      const confirm = (await avery.get(`/api/runs/${preview.runId}`)).json().run.confirm as { value: string };
      expect(confirm.value).toBe('m.chen@example.com');

      const started = await avery.post('/api/runs', {
        playbook: 'avd.log-off-user-session',
        inputs,
        previewRunId: preview.runId,
        confirmation: confirm.value,
      });
      expect(started.statusCode).toBe(202);
      const { runId } = started.json() as { runId: string };
      await t.settled(runId, 'awaiting_arm');

      holder.upn = 'k.osei@example.com'; // the session number now belongs to someone else
      t.clock.advance(5 * 60_000);
      await avery.arm();
      expect((await avery.post(`/api/runs/${runId}/resume`)).statusCode).toBe(202);
      await t.settled(runId, 'failed');

      const run = (await avery.get(`/api/runs/${runId}`)).json().run;
      expect(run.error).toMatchObject({
        code: 'assertion_failed',
        stepId: 'sameUser',
        message:
          'That session now belongs to k.osei@example.com, not m.chen@example.com (session numbers are reused on a host). Nothing was signed out: refresh the list and try again.',
        hint: expect.stringMatching(/paused/),
      });
      expect(outbound.calls.filter((c) => c.call.method === 'DELETE')).toEqual([]);
      // The session was read again, as the person continuing the run, before the sign-out would have gone out.
      expect(outbound.calls.map((c) => [c.call.method, c.user])).toEqual([
        ['GET', AVERY.upn], // preview
        ['GET', AVERY.upn], // the run
        ['GET', AVERY.upn], // again, before the sign-out
      ]);
      const steps = await t.repository.listSteps(runId);
      expect(steps.map((s) => [s.stepId, s.status, s.attempt])).toEqual([
        ['lookup', 'succeeded', 1],
        ['isUserSession', 'succeeded', 1],
        ['sameUser', 'succeeded', 1],
        ['logOff', 'skipped', 1],
        ['lookup', 'succeeded', 2],
        ['isUserSession', 'succeeded', 2],
        ['sameUser', 'failed', 2],
      ]);
      // Audited: the resume, and the run ending on the check.
      expect(t.audit.rows.find((r) => r.action === 'run.resumed' && r.targetId === runId)).toMatchObject({
        result: 'success',
      });
      expect(t.audit.rows.find((r) => r.action === 'run.completed' && r.targetId === runId)).toMatchObject({
        result: 'failure',
        details: { status: 'failed', error: { code: 'assertion_failed', stepId: 'sameUser' } },
      });
      expect(t.audit.rows.some((r) => r.action === 'run.step.write' && r.targetId === runId)).toBe(false);
    } finally {
      await t.close();
    }
  });

  it('the same run signs the person out when the session is still theirs', async () => {
    const { outbound } = sessionFake();
    const t = await sqliteApp(new StaticDefinitions().add(logOff), outbound);
    try {
      const avery = await t.login(AVERY, OPERATOR);
      const inputs = { userSessionId: SESSION_ID, expectedUser: 'm.chen@example.com', reason: 'ticket 5522' };
      const preview = (
        await avery.post('/api/runs', { playbook: 'avd.log-off-user-session', inputs, dryRun: true })
      ).json() as { runId: string };
      await t.settled(preview.runId, 'succeeded');
      const { runId } = (
        await avery.post('/api/runs', {
          playbook: 'avd.log-off-user-session',
          inputs,
          previewRunId: preview.runId,
          confirmation: 'm.chen@example.com',
        })
      ).json() as { runId: string };
      await t.settled(runId, 'awaiting_arm');
      await avery.arm();
      expect((await avery.post(`/api/runs/${runId}/resume`)).statusCode).toBe(202);
      await t.settled(runId, 'succeeded');
      expect(outbound.calls.map((c) => c.call.method)).toEqual(['GET', 'GET', 'GET', 'DELETE']);
    } finally {
      await t.close();
    }
  });

  it('after an approval the checks run again as the approver, and a broken one stops the write', async () => {
    const def = playbook('test.approved-change', [
      { id: 'lookup', type: 'graph', mode: 'read', request: { method: 'GET', path: '/things/target' } },
      { id: 'stillOk', type: 'assert', that: '${ steps.lookup.output.ok }', message: 'The target changed.' },
      { id: 'approve', type: 'approval', message: 'Change the target?' },
      write('change'),
    ]);
    let ok = true;
    const outbound = new FakeExecutor((c) => (c.method === 'GET' ? { ok } : null));
    const t = await sqliteApp(new StaticDefinitions().add(def), outbound);
    try {
      const avery = await t.login(AVERY, OPERATOR, { armed: true });
      const blake = await t.login(BLAKE, APPROVER, { armed: true });
      const { runId } = (
        await avery.post('/api/runs', { playbook: 'test.approved-change', inputs: {} })
      ).json() as { runId: string };
      await t.settled(runId, 'awaiting_approval');
      ok = false;
      expect(
        (await blake.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve' })).statusCode,
      ).toBe(200);
      await t.settled(runId, 'failed');
      expect((await avery.get(`/api/runs/${runId}`)).json().run.error).toMatchObject({
        stepId: 'stillOk',
        message: 'The target changed.',
      });
      expect(outbound.calls.map((c) => [c.call.method, c.user])).toEqual([
        ['GET', AVERY.upn],
        ['GET', BLAKE.upn],
      ]);
    } finally {
      await t.close();
    }
  });
});

describe('a run resumed after a restart checks again before it retries its write (D-01)', () => {
  const look = { id: 'look', type: 'graph', mode: 'read', request: { method: 'GET', path: '/things/look' } };
  const definitions = () =>
    new StaticDefinitions().add(
      playbook('test.restart-checked', [
        look,
        { id: 'stillOk', type: 'assert', that: '${ steps.look.output.ok }', message: 'The target changed.' },
        write('two'),
      ]),
    );
  let k: Awaited<ReturnType<typeof restartKit>>;
  beforeEach(async () => {
    k = await restartKit(definitions);
  });
  afterEach(async () => {
    await k.close();
  });

  it('a write in flight at the stop is not sent again when its check now fails: the run ends needs_review', async () => {
    const first = await k.boot({ graceMs: 300 });
    const { runId } = await k.startHeld(first, 'test.restart-checked', 'two');
    await first.app.close(); // SIGTERM: `two` is still in flight after the grace
    expect(k.latest(runId)).toEqual({ look: 'succeeded', stillOk: 'succeeded', two: 'running' });

    // After the restart the target reads differently.
    const answer = k.outbound.execute.bind(k.outbound);
    k.outbound.execute = async <T>(
      identity: ExecutionIdentity,
      call: ServiceCall,
      opts?: { signal?: AbortSignal },
    ) => {
      const res = await answer<T>(identity, call, opts);
      return call.method === 'GET' ? { ...res, data: { ok: false } as T } : res;
    };
    k.outbound.hold = null;
    const second = await k.boot();
    try {
      // The first send may have gone through before the stop: nothing is sent again, and someone checks the target.
      await until(() => k.run(runId).status === 'needs_review');
      expect(JSON.parse(k.run(runId).error!)).toMatchObject({
        code: 'needs_review',
        stepId: 'two',
        details: { check: { stepId: 'stillOk', message: 'The target changed.' } },
      });
      expect(k.outbound.calls).toEqual(['GET /things/look', 'PATCH /things/two', 'GET /things/look']);
      expect(k.latest(runId)).toEqual({ look: 'succeeded', stillOk: 'failed', two: 'needs_review' });
    } finally {
      await second.app.close();
    }
  });

  it('a write in flight at the stop is retried once its check still holds', async () => {
    const first = await k.boot({ graceMs: 300 });
    const { runId } = await k.startHeld(first, 'test.restart-checked', 'two');
    await first.app.close();
    k.outbound.hold = null;
    const second = await k.boot();
    try {
      await until(() => k.run(runId).status === 'succeeded');
      expect(k.outbound.calls).toEqual([
        'GET /things/look',
        'PATCH /things/two',
        'GET /things/look',
        'PATCH /things/two',
      ]);
    } finally {
      await second.app.close();
    }
  });
});
