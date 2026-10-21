import { mockConfig } from './helpers';
import { AVERY, BLAKE, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

// Confirming a manual step that has writes after it needs write access, as approving such a gate does: the steps after
// it run as the person who confirms, so a read-only session (or a copied read-only id) can't let the writes go out.
// Declining needs nothing (it stops the run); a step with no writes after it confirms read-only.
const USER = '00000000-0000-4000-8000-000000000001';
const OPERATOR = ['Portal.Reader', 'Portal.Operator'];
const APPROVER = ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver'];
const base = { owner: 'tests', version: '1.0.0', risk: 'low', mode: 'write' } as const;
const disable = {
  id: 'disable',
  type: 'graph',
  mode: 'write',
  describe: 'Disable sign-in',
  request: { method: 'PATCH', path: '/users/${ $encode(inputs.userId) }', body: { accountEnabled: false } },
};
const check = { id: 'check', type: 'manual', instructions: 'Call the user first.' };
const look = { id: 'look', type: 'graph', mode: 'read', request: { method: 'GET', path: '/me' } };
const inputs = { userId: { type: 'string', format: 'guid' } };

function definitions() {
  return new StaticDefinitions()
    .add({
      kind: 'runbook',
      id: 'test.call-then-disable',
      title: 'Call, then disable',
      inputs,
      sections: [{ id: 's1', title: 'Do it', steps: [check, disable] }],
      ...base,
    } as never)
    .add({
      kind: 'runbook',
      id: 'test.approve-call-disable',
      title: 'Approve, call, then disable',
      inputs,
      sections: [{ id: 's1', title: 'Do it', steps: [{ id: 'ok', type: 'approval' }, check, disable] }],
      ...base,
    } as never)
    .add({
      kind: 'runbook',
      id: 'test.disable-then-call',
      title: 'Disable, then call',
      inputs,
      sections: [{ id: 's1', title: 'Do it', steps: [disable, check, look] }],
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

const writes = (t: Awaited<ReturnType<typeof setup>>) =>
  t.outbound.calls.filter((c) => c.call.method !== 'GET');

describe('confirming a manual step with writes after it needs write access', () => {
  it('a read-only session is refused (not_armed); armed, the same person confirms and the write runs', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.call-then-disable', inputs: { userId: USER } })
    ).json();
    await t.drain();
    const parked = (await avery.get(`/api/runs/${runId}`)).json();
    expect(parked.run.status).toBe('awaiting_input');
    // The task says writes follow, so the page asks for write access before Mark done.
    expect(parked.tasks).toEqual([
      expect.objectContaining({ kind: 'manual', policy: expect.objectContaining({ writesAfter: true }) }),
    ]);

    await avery.arm(false); // write access ran out while they were on the phone
    const refused = await avery.post(`/api/runs/${runId}/manual/check`, { confirmed: true });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({
      code: 'not_armed',
      message: 'The steps after this one change data and will run as you.',
      hint: 'Arm write access, then confirm.',
    });
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('awaiting_input');
    expect(writes(t)).toEqual([]);
    expect(t.audit.rows.some((r) => r.action === 'run.manual.confirmed')).toBe(false);

    await avery.arm();
    expect((await avery.post(`/api/runs/${runId}/manual/check`, { confirmed: true })).statusCode).toBe(200);
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('succeeded');
    expect(writes(t).map((c) => [c.call.method, c.user])).toEqual([['PATCH', AVERY.upn]]);
    await t.close();
  });

  it('the approver a step waits for must be armed to confirm it: the writes after it run as them', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const blake = await t.login(BLAKE, APPROVER, { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.approve-call-disable', inputs: { userId: USER } })
    ).json();
    await t.drain();
    expect((await blake.post(`/api/runs/${runId}/approvals/ok`, { decision: 'approve' })).statusCode).toBe(
      200,
    );
    await t.drain();
    expect((await blake.get(`/api/runs/${runId}`)).json().run.status).toBe('awaiting_input');

    await blake.arm(false);
    const refused = await blake.post(`/api/runs/${runId}/manual/check`, { confirmed: true });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('not_armed');
    expect(writes(t)).toEqual([]);
    await t.close();
  });

  it('declining needs no write access, and a step with no writes after it confirms read-only', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const declined = (
      await avery.post('/api/runs', { playbook: 'test.call-then-disable', inputs: { userId: USER } })
    ).json().runId as string;
    const later = (
      await avery.post('/api/runs', { playbook: 'test.disable-then-call', inputs: { userId: USER } })
    ).json().runId as string;
    await t.drain();
    await avery.arm(false);

    const no = await avery.post(`/api/runs/${declined}/manual/check`, {
      confirmed: false,
      notes: 'No answer.',
    });
    expect(no.statusCode).toBe(200);
    const yes = await avery.post(`/api/runs/${later}/manual/check`, { confirmed: true });
    expect(yes.statusCode).toBe(200);
    await t.drain();
    expect((await avery.get(`/api/runs/${declined}`)).json().run.status).toBe('failed');
    expect((await avery.get(`/api/runs/${later}`)).json().run.status).toBe('succeeded');
    await t.close();
  });
});
