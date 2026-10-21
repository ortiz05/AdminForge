import { mockConfig } from './helpers';
import { AVERY, BLAKE, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

// S-12, end to end: an approver trying to approve the change that grants them access is refused (own_access, ENG-02)
// and the refusal is in the audit log as request.denied, like approving one's own run.
const APPROVER_ROLES = ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver'];

describe('approving your own access is audited', () => {
  it('leaves a request.denied event naming own_access, without the run id or inputs', async () => {
    const t = await runsApp({
      config: mockConfig(),
      definitions: new StaticDefinitions().add({
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
      } as never),
      outbound: new FakeExecutor(() => ({ id: 'ra-1' })),
    });
    const avery = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator'], { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.grant-role', inputs: { principalId: BLAKE.oid } })
    ).json();
    await t.drain();

    const blake = await t.login(BLAKE, APPROVER_ROLES, { armed: true });
    const res = await blake.post(`/api/runs/${runId}/approvals/${encodeURIComponent('$approval')}`, {
      decision: 'approve',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('own_access');

    const denied = t.audit.rows.filter((r) => r.action === 'request.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      actorOid: BLAKE.oid,
      result: 'denied',
      targetType: 'route',
      targetId: 'POST /api/runs/:id/approvals/:stepId',
      details: { code: 'own_access', status: 403 },
      correlationId: res.headers['x-correlation-id'],
    });
    expect(JSON.stringify(denied[0])).not.toContain(runId);
    expect((await t.audit.verify()).ok).toBe(true);
    await t.close();
  });
});
