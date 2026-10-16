import { MINUTE, mockConfig } from './helpers';
import { AVERY, BLAKE, FakeExecutor, runsApp, StaticDefinitions, type OutboundCall } from './runs-helpers';

// IAM-02: a run that stopped (arming, sign-in, approval) continues only on the current published version and only for
// someone still allowed to run it; runs parked on arming or signing in are stopped after 24 hours; a confirmed change
// that hasn't written anything needs a recent preview to continue.
const USER = '00000000-0000-4000-8000-000000000001';
const OPERATOR = ['Portal.Reader', 'Portal.Operator'];
const APPROVER = ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver'];
const HOUR = 60 * MINUTE;

const disable = {
  id: 'disable',
  type: 'graph',
  mode: 'write',
  describe: 'Disable sign-in',
  request: { method: 'PATCH', path: '/users/${ $encode(inputs.userId) }', body: { accountEnabled: false } },
};
const playbook = (version: string, extra: Record<string, unknown> = {}, steps: unknown[] = [disable]) =>
  ({
    kind: 'playbook',
    id: 'test.disable',
    title: 'Disable sign-in',
    owner: 'tests',
    version,
    risk: 'low',
    mode: 'write',
    inputs: { userId: { type: 'string', format: 'guid' } },
    steps,
    ...extra,
  }) as never;

async function setup(first: never) {
  const definitions = new StaticDefinitions().add(first);
  const t = await runsApp({ config: mockConfig(), definitions, outbound: new FakeExecutor(() => null) });
  return { ...t, definitions };
}

const writes = (t: Awaited<ReturnType<typeof setup>>) =>
  t.outbound.calls.filter((c: OutboundCall) => c.call.method !== 'GET');

describe('resuming re-checks the version and the person (IAM-02)', () => {
  it('a run parked on an old version is ended when resumed after a new version adds a requirement', async () => {
    const t = await setup(playbook('1.0.0'));
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.disable', inputs: { userId: USER } })
    ).json();
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('awaiting_arm');

    t.definitions.add(playbook('1.1.0', { requires: { portalRoles: ['Portal.Admin'] } }));
    t.clock.advance(5 * MINUTE);
    await avery.arm();
    const res = await avery.post(`/api/runs/${runId}/resume`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'run_outdated',
      message: 'This playbook changed after the run started.',
      hint: 'Start a new run.',
    });
    await t.drain();
    const run = (await avery.get(`/api/runs/${runId}`)).json().run;
    expect(run).toMatchObject({ status: 'failed', error: { code: 'run_outdated' } });
    expect(writes(t)).toHaveLength(0);
    expect(t.audit.rows.find((r) => r.action === 'run.resumed')).toMatchObject({
      result: 'denied',
      details: { refused: 'run_outdated' },
    });
    await t.close();
  });

  it('the worker ends a run approved after a new version was published (no write runs)', async () => {
    const approve = { id: 'approve', type: 'approval', message: 'Disable?' };
    const t = await setup(playbook('1.0.0', {}, [approve, disable]));
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const blake = await t.login(BLAKE, APPROVER, { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.disable', inputs: { userId: USER } })
    ).json();
    await t.drain();
    t.definitions.add(playbook('1.1.0', {}, [approve, disable]));
    expect(
      (await blake.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve' })).statusCode,
    ).toBe(200);
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run).toMatchObject({
      status: 'failed',
      error: { code: 'run_outdated', details: { version: '1.0.0', current: '1.1.0' } },
    });
    expect(writes(t)).toHaveLength(0);
    await t.close();
  });

  it('the same version keeps working: resume after arming runs the write', async () => {
    const t = await setup(playbook('1.0.0'));
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.disable', inputs: { userId: USER } })
    ).json();
    await t.drain();
    await avery.arm();
    expect((await avery.post(`/api/runs/${runId}/resume`)).statusCode).toBe(202);
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('succeeded');
    expect(writes(t)).toHaveLength(1);
    await t.close();
  });

  it('an initiator who lost the role to run it cannot resume it', async () => {
    const t = await setup(playbook('1.0.0'));
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.disable', inputs: { userId: USER } })
    ).json();
    await t.drain();
    await t.sessions.update(avery.record.idHash, { roles: ['Portal.Reader'] });
    await avery.arm();
    const res = await avery.post(`/api/runs/${runId}/resume`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('Portal.Operator'),
    });
    await t.drain();
    expect(writes(t)).toHaveLength(0);
    await t.close();
  });

  it('the worker ends an approved run whose initiator lost the role while it waited', async () => {
    const approve = { id: 'approve', type: 'approval', message: 'Disable?' };
    const t = await setup(playbook('1.0.0', {}, [approve, disable]));
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const blake = await t.login(BLAKE, APPROVER, { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.disable', inputs: { userId: USER } })
    ).json();
    await t.drain();
    await t.sessions.update(avery.record.idHash, { roles: ['Portal.Reader'] });
    await blake.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve' });
    await t.drain();
    expect((await blake.get(`/api/runs/${runId}`)).json().run).toMatchObject({
      status: 'failed',
      error: { code: 'forbidden', message: expect.stringContaining(AVERY.upn) },
    });
    expect(writes(t)).toHaveLength(0);
    await t.close();
  });
});

describe('runs parked on arming or signing in expire after 24 hours (IAM-02)', () => {
  it('the sweep stops them, audited as run.expired', async () => {
    const t = await setup(playbook('1.0.0'));
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.disable', inputs: { userId: USER } })
    ).json();
    await t.drain();
    t.clock.advance(23 * HOUR);
    await t.runs.worker.sweep();
    expect((await t.repository.getRun(runId))!.status).toBe('awaiting_arm');

    t.clock.advance(HOUR + MINUTE);
    await t.runs.worker.sweep();
    const run = (await t.repository.getRun(runId))!;
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'run_expired', hint: 'Start a new run.' });
    expect(t.audit.rows.find((r) => r.action === 'run.expired')).toMatchObject({
      actorUpn: AVERY.upn,
      targetId: runId,
      result: 'failure',
      details: { previousStatus: 'awaiting_arm', definition: 'test.disable' },
    });
    expect(t.audit.rows.find((r) => r.action === 'run.completed')).toMatchObject({
      details: { status: 'failed', error: { code: 'run_expired' } },
    });
    await t.close();
  });
});

describe('a confirmed change needs a recent preview to continue (IAM-02)', () => {
  const confirmed = playbook('1.0.0', { risk: 'high', confirm: { type: 'click' } });

  async function parkedConfirmed() {
    const t = await setup(confirmed);
    const avery = await t.login(AVERY, OPERATOR);
    const preview = (
      await avery.post('/api/runs', { playbook: 'test.disable', inputs: { userId: USER }, dryRun: true })
    ).json();
    await t.drain();
    const { runId } = (
      await avery.post('/api/runs', {
        playbook: 'test.disable',
        inputs: { userId: USER },
        previewRunId: preview.runId,
      })
    ).json();
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('awaiting_arm');
    return { t, avery, runId };
  }

  it('resuming more than 15 minutes after the preview ends the run before it changes anything', async () => {
    const { t, avery, runId } = await parkedConfirmed();
    t.clock.advance(16 * MINUTE);
    await avery.arm();
    const res = await avery.post(`/api/runs/${runId}/resume`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'preview_stale', hint: 'Preview it again, then run it.' });
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run).toMatchObject({
      status: 'failed',
      error: { code: 'preview_stale' },
    });
    expect(writes(t)).toHaveLength(0);
    await t.close();
  });

  it('resuming within 15 minutes of the preview continues', async () => {
    const { t, avery, runId } = await parkedConfirmed();
    t.clock.advance(10 * MINUTE);
    await avery.arm();
    expect((await avery.post(`/api/runs/${runId}/resume`)).statusCode).toBe(202);
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('succeeded');
    expect(writes(t)).toHaveLength(1);
    await t.close();
  });
});
