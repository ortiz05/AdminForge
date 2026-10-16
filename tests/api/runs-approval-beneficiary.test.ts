import { mockConfig } from './helpers';
import { AVERY, BLAKE, CASEY, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

// ENG-02: whoever an approval grants access to can't approve it (`approval.excludes`), on top of "not your own run".
const APPROVER_ROLES = ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver'];

function definitions() {
  return new StaticDefinitions().add({
    kind: 'playbook',
    id: 'test.grant-role',
    title: 'Grant a role',
    owner: 'tests',
    version: '1.0.0',
    risk: 'low',
    mode: 'write',
    inputs: { principalId: { type: 'string', format: 'guid' } },
    approval: { required: true, excludes: '${ $uppercase(inputs.principalId) }' },
    steps: [
      {
        id: 'grant',
        type: 'graph',
        mode: 'write',
        describe: 'Grant the role',
        request: {
          method: 'POST',
          path: '/roleManagement/directory/roleAssignments',
          body: { principalId: '${ inputs.principalId }' },
        },
      },
    ],
  } as never);
}

async function parked() {
  const t = await runsApp({
    config: mockConfig(),
    definitions: definitions(),
    outbound: new FakeExecutor(() => ({ id: 'ra-1' })),
  });
  const avery = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator'], { armed: true });
  // Avery asks for Blake to get the role.
  const { runId } = (
    await avery.post('/api/runs', { playbook: 'test.grant-role', inputs: { principalId: BLAKE.oid } })
  ).json();
  await t.drain();
  return { t, runId };
}

describe('approvals: the beneficiary cannot approve (ENG-02)', () => {
  it('refuses the person the change grants access to, and shows them they cannot decide', async () => {
    const { t, runId } = await parked();
    const blake = await t.login(BLAKE, APPROVER_ROLES, { armed: true });
    const inbox = (await blake.get('/api/approvals?status=pending')).json().items;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ subjectId: runId, stepId: '$approval', canDecide: false });
    // The list of excluded ids stays on the server.
    expect(inbox[0].policy).not.toHaveProperty('excludes');

    for (const decision of ['approve', 'reject']) {
      const res = await blake.post(`/api/runs/${runId}/approvals/${encodeURIComponent('$approval')}`, {
        decision,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatchObject({
        code: 'own_access',
        message: "This change grants you access, so you can't approve it.",
        hint: 'Ask another approver.',
      });
    }
    expect(t.outbound.calls).toHaveLength(0);
    expect((await blake.get(`/api/runs/${runId}`)).json().run.status).toBe('awaiting_approval');
    await t.close();
  });

  it('another approver can approve, and the change then runs as them', async () => {
    const { t, runId } = await parked();
    const casey = await t.login(CASEY, APPROVER_ROLES, { armed: true });
    expect((await casey.get('/api/approvals?status=pending')).json().items[0].canDecide).toBe(true);
    const res = await casey.post(`/api/runs/${runId}/approvals/${encodeURIComponent('$approval')}`, {
      decision: 'approve',
    });
    expect(res.json()).toEqual({ status: 'approved', approvals: 1, required: 1 });
    await t.drain();
    expect((await casey.get(`/api/runs/${runId}`)).json().run.status).toBe('succeeded');
    expect(t.outbound.calls.map((c) => [c.call.method, c.user])).toEqual([['POST', CASEY.upn]]);
    await t.close();
  });
});
