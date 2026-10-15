import { mockConfig } from './helpers';
import { ALL_ROLES, AVERY, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

// Interactive runs use the current published version: an older one may lack approvals or confirmations added since.
const USER = '00000000-0000-4000-8000-000000000001';
const playbook = (version: string, approval: boolean) =>
  ({
    kind: 'playbook',
    id: 'test.disable',
    title: 'Disable sign-in',
    owner: 'tests',
    version,
    risk: 'low',
    mode: 'write',
    inputs: { userId: { type: 'string', format: 'guid' } },
    steps: [
      ...(approval ? [{ id: 'approve', type: 'approval', message: 'Disable this user?' }] : []),
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
  }) as never;

async function setup() {
  const definitions = new StaticDefinitions().add(playbook('1.0.0', false)).add(playbook('1.1.0', true));
  return runsApp({ config: mockConfig(), definitions, outbound: new FakeExecutor(() => null) });
}

describe('runs use the current version', () => {
  it('asking for a superseded version is refused with a reload hint', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ALL_ROLES);
    const res = await avery.post('/api/runs', {
      playbook: 'test.disable',
      version: '1.0.0',
      inputs: { userId: USER },
      dryRun: true,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'version_superseded',
      hint: expect.stringMatching(/Reload/),
    });
  });

  it('the current version (explicit or implied) runs', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ALL_ROLES);
    for (const version of ['1.1.0', undefined]) {
      const res = await avery.post('/api/runs', {
        playbook: 'test.disable',
        ...(version ? { version } : {}),
        inputs: { userId: USER },
        dryRun: true,
      });
      expect(res.statusCode).toBe(202);
    }
  });
});
