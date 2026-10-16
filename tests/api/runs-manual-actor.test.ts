import { mockConfig } from './helpers';
import { AVERY, BLAKE, DREW, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

// IAM-10: the steps after a manual step run as the person it waits for, so only they may confirm it; anyone else who
// may answer it (the initiator, an Operator) can only decline.
const USER = '00000000-0000-4000-8000-000000000001';
const base = { owner: 'tests', version: '1.0.0', risk: 'low', mode: 'write' } as const;
const disable = {
  id: 'disable',
  type: 'graph',
  mode: 'write',
  describe: 'Disable sign-in',
  request: { method: 'PATCH', path: '/users/${ $encode(inputs.userId) }', body: { accountEnabled: false } },
};
const check = { id: 'check', type: 'manual', instructions: 'Call the user first.' };

function definitions() {
  return new StaticDefinitions()
    .add({
      kind: 'runbook',
      id: 'test.call-then-disable',
      title: 'Call, then disable',
      inputs: { userId: { type: 'string', format: 'guid' } },
      sections: [{ id: 's1', title: 'Do it', steps: [check, disable] }],
      ...base,
    } as never)
    .add({
      kind: 'runbook',
      id: 'test.approve-call-disable',
      title: 'Approve, call, then disable',
      inputs: { userId: { type: 'string', format: 'guid' } },
      sections: [{ id: 's1', title: 'Do it', steps: [{ id: 'ok', type: 'approval' }, check, disable] }],
      ...base,
    } as never);
}

async function setup() {
  return runsApp({
    config: mockConfig(),
    definitions: definitions(),
    outbound: new FakeExecutor(() => null),
  });
}

describe('manual steps: only the person the step waits for confirms it (IAM-10)', () => {
  it('another Operator cannot confirm a step in someone else’s run, but can decline it', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator'], { armed: true });
    const drew = await t.login(DREW, ['Portal.Reader', 'Portal.Operator'], { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.call-then-disable', inputs: { userId: USER } })
    ).json();
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('awaiting_input');

    const res = await drew.post(`/api/runs/${runId}/manual/check`, { confirmed: true });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({
      code: 'not_your_step',
      message: 'Only the engineer this step is waiting for can confirm it: the steps after it run as them.',
      hint: expect.stringContaining(AVERY.upn),
    });
    await t.drain();
    expect(t.outbound.calls).toHaveLength(0);

    expect((await drew.post(`/api/runs/${runId}/manual/check`, { confirmed: false })).json()).toEqual({
      status: 'rejected',
    });
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('failed');
    expect(t.outbound.calls).toHaveLength(0);
    await t.close();
  });

  it('the initiator confirms their own step and the run continues as them', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator'], { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.call-then-disable', inputs: { userId: USER } })
    ).json();
    await t.drain();
    expect((await avery.post(`/api/runs/${runId}/manual/check`, { confirmed: true })).json()).toEqual({
      status: 'approved',
    });
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('succeeded');
    expect(t.outbound.calls.map((c) => c.user)).toEqual([AVERY.upn]);
    await t.close();
  });

  it('after an approval the step waits for the approver: the initiator may decline, not confirm', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator'], { armed: true });
    const blake = await t.login(BLAKE, ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver'], {
      armed: true,
    });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.approve-call-disable', inputs: { userId: USER } })
    ).json();
    await t.drain();
    expect((await blake.post(`/api/runs/${runId}/approvals/ok`, { decision: 'approve' })).statusCode).toBe(
      200,
    );
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('awaiting_input');

    const own = await avery.post(`/api/runs/${runId}/manual/check`, { confirmed: true });
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toMatchObject({
      code: 'not_your_step',
      hint: expect.stringContaining(BLAKE.upn),
    });

    expect((await blake.post(`/api/runs/${runId}/manual/check`, { confirmed: true })).json()).toEqual({
      status: 'approved',
    });
    await t.drain();
    expect((await blake.get(`/api/runs/${runId}`)).json().run.status).toBe('succeeded');
    expect(t.outbound.calls.map((c) => c.user)).toEqual([BLAKE.upn]);
    await t.close();
  });
});
