import { mockConfig } from './helpers';
import { AVERY, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

// A bulk run's audit event keeps the inputs every item shares — the reason an engineer gave for signing 400 people
// out — redacted like a single run's, since the per-item runs don't record inputs.
const USER = '00000000-0000-4000-8000-000000000001';
const definitions = () =>
  new StaticDefinitions().add({
    kind: 'playbook',
    id: 'test.disable',
    title: 'Disable sign-in',
    risk: 'low',
    mode: 'write',
    owner: 'tests',
    version: '1.0.0',
    inputs: {
      userId: { type: 'string', format: 'guid' },
      reason: { type: 'string', required: false },
      secret: { type: 'string', required: false, redact: true },
    },
    steps: [
      {
        id: 'disable',
        type: 'graph',
        mode: 'write',
        describe: 'Disable sign-in',
        request: {
          method: 'PATCH',
          path: '/users/${ $encode(inputs.userId) }',
          body: { accountEnabled: false },
        },
      },
    ],
  } as never);

describe('bulk run audit', () => {
  it('records the shared inputs, redacted, on the bulk run.created event', async () => {
    const t = await runsApp({
      config: mockConfig(),
      definitions: definitions(),
      outbound: new FakeExecutor(() => ({ id: USER })),
    });
    const avery = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator'], { armed: true });
    const res = await avery.post('/api/runs/bulk', {
      playbook: 'test.disable',
      items: ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012'].map(
        (userId) => ({
          userId,
        }),
      ),
      inputsTemplate: { reason: 'INC-5521 compromised accounts', secret: 'shared-secret-value' },
    });
    expect(res.statusCode).toBe(202);
    const created = t.audit.rows.find((r) => r.action === 'run.created' && r.targetId === res.json().runId)!;
    expect(created.details).toMatchObject({
      trigger: 'bulk',
      items: 2,
      inputs: { reason: 'INC-5521 compromised accounts', secret: '[redacted]' },
    });
    expect(JSON.stringify(t.audit.rows)).not.toContain('shared-secret-value');
    await t.close();
  });

  it('leaves inputs out when the items share none', async () => {
    const t = await runsApp({
      config: mockConfig(),
      definitions: definitions(),
      outbound: new FakeExecutor(() => ({ id: USER })),
    });
    const avery = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator'], { armed: true });
    const res = await avery.post('/api/runs/bulk', {
      playbook: 'test.disable',
      items: [{ userId: '00000000-0000-4000-8000-000000000011' }],
    });
    const created = t.audit.rows.find((r) => r.action === 'run.created' && r.targetId === res.json().runId)!;
    expect(created.details).not.toHaveProperty('inputs');
    await t.close();
  });
});
