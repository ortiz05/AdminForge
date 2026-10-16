import { mockConfig } from './helpers';
import { AVERY, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

// ENG-07: a child playbook starts on its current published version only, like a run started directly or a bulk item.
const USER = '00000000-0000-4000-8000-000000000001';
const base = { owner: 'tests', risk: 'low', mode: 'read' } as const;
const child = (version: string, path: string) =>
  ({
    kind: 'playbook',
    id: 'test.child',
    title: 'Look up a user',
    version,
    inputs: { userId: { type: 'string', format: 'guid' } },
    steps: [{ id: 'lookup', type: 'graph', mode: 'read', request: { method: 'GET', path } }],
    ...base,
  }) as never;
const parent = (id: string, pin?: string) =>
  ({
    kind: 'playbook',
    id,
    title: `Parent ${id}`,
    version: '1.0.0',
    steps: [
      {
        id: 'sub',
        type: 'playbook',
        ref: 'test.child',
        ...(pin ? { version: pin } : {}),
        inputs: { userId: USER },
      },
    ],
    ...base,
  }) as never;

async function setup() {
  const definitions = new StaticDefinitions()
    .add(child('1.0.0', '/users/old'))
    .add(child('1.1.0', '/users/current'))
    .add(parent('test.pins-old', '1.0.0'))
    .add(parent('test.pins-current', '1.1.0'))
    .add(parent('test.no-pin'));
  return runsApp({ config: mockConfig(), definitions, outbound: new FakeExecutor(() => ({ id: USER })) });
}

describe('child playbooks run their current version (ENG-07)', () => {
  it('a pin to a superseded version fails the step with a friendly error and never runs the old child', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator']);
    const { runId } = (await avery.post('/api/runs', { playbook: 'test.pins-old', inputs: {} })).json();
    await t.drain();
    const detail = (await avery.get(`/api/runs/${runId}`)).json();
    expect(detail.run).toMatchObject({
      status: 'failed',
      error: { code: 'version_superseded', stepId: 'sub' },
    });
    expect(detail.run.error.message).toContain('1.1.0');
    expect(detail.run.error.hint).toMatch(/pinned version/);
    expect(detail.children).toEqual([]);
    expect(t.outbound.calls).toHaveLength(0);
    await t.close();
  });

  it('a pin to the current version, or no pin, runs the current child', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator']);
    for (const key of ['test.pins-current', 'test.no-pin']) {
      const { runId } = (await avery.post('/api/runs', { playbook: key, inputs: {} })).json();
      await t.drain();
      const detail = (await avery.get(`/api/runs/${runId}`)).json();
      expect(detail.run.status).toBe('succeeded');
      expect(detail.children).toEqual([expect.objectContaining({ definitionVersion: '1.1.0' })]);
    }
    expect(t.outbound.calls.map((c) => c.call.path)).toEqual(['/users/current', '/users/current']);
    await t.close();
  });
});
