import { mockConfig } from './helpers';
import { AVERY, BLAKE, FakeExecutor, runsApp, StaticDefinitions, type OutboundCall } from './runs-helpers';

// IAM-02, the other side: publishing a new version must not strand work. A run that already sent a change finishes on
// the version that started it, and a runbook (a checklist) carries on — only parked runs that haven't changed anything
// end `run_outdated` (runs-resume-reauthorize.test.ts).
const USER = '00000000-0000-4000-8000-000000000001';
const OPERATOR = ['Portal.Reader', 'Portal.Operator'];
const APPROVER = ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver'];
const write = (id: string, accountEnabled: boolean) => ({
  id,
  type: 'graph',
  mode: 'write',
  describe: accountEnabled ? 'Enable sign-in' : 'Disable sign-in',
  request: { method: 'PATCH', path: '/users/${ $encode(inputs.userId) }', body: { accountEnabled } },
});
const definition = (kind: 'playbook' | 'runbook', id: string, version: string, steps: unknown[]) =>
  ({
    kind,
    id,
    title: id,
    owner: 'tests',
    version,
    risk: 'low',
    mode: 'write',
    inputs: { userId: { type: 'string', format: 'guid' } },
    ...(kind === 'runbook' ? { sections: [{ id: 's1', title: 'Do it', steps }] } : { steps }),
  }) as never;

async function setup(first: never) {
  const definitions = new StaticDefinitions().add(first);
  const t = await runsApp({ config: mockConfig(), definitions, outbound: new FakeExecutor(() => null) });
  return { ...t, definitions };
}
const writes = (t: Awaited<ReturnType<typeof setup>>) =>
  t.outbound.calls.filter((c: OutboundCall) => c.call.method !== 'GET');

describe('a publish never strands work that already started (IAM-02)', () => {
  it('a run that already changed something finishes on its version after a new one is published', async () => {
    const steps = [
      write('disable', false),
      { id: 'approve', type: 'approval', message: 'Enable again?' },
      write('enable', true),
    ];
    const t = await setup(definition('playbook', 'test.two-phase', '1.0.0', steps));
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const blake = await t.login(BLAKE, APPROVER, { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.two-phase', inputs: { userId: USER } })
    ).json();
    await t.drain();
    expect(writes(t)).toHaveLength(1);

    t.definitions.add(definition('playbook', 'test.two-phase', '1.1.0', steps));
    expect(
      (await blake.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve' })).statusCode,
    ).toBe(200);
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run).toMatchObject({
      status: 'succeeded',
      definitionVersion: '1.0.0',
    });
    expect(writes(t)).toHaveLength(2);
    await t.close();
  });

  it('a runbook waiting on a checklist step carries on after the runbook is republished', async () => {
    const steps = [
      { id: 'check', type: 'manual', instructions: 'Call the user first.' },
      write('disable', false),
    ];
    const t = await setup(definition('runbook', 'test.checklist', '1.0.0', steps));
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.checklist', inputs: { userId: USER } })
    ).json();
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('awaiting_input');

    t.definitions.add(definition('runbook', 'test.checklist', '1.0.1', steps));
    expect((await avery.post(`/api/runs/${runId}/manual/check`, { confirmed: true })).statusCode).toBe(200);
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('succeeded');
    expect(writes(t)).toHaveLength(1);
    await t.close();
  });
});
