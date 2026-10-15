import { mockConfig } from './helpers';
import { ALL_ROLES, AVERY, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

// Playbooks that change the caller's own permissions (PIM activation) refresh the caller's tokens when they succeed,
// so the new Entra roles apply right away.
const playbook = (refreshTokens: boolean) =>
  ({
    kind: 'playbook',
    id: 'test.activate',
    title: 'Activate a role',
    owner: 'tests',
    version: '1.0.0',
    risk: 'low',
    mode: 'read',
    refreshTokens,
    steps: [{ id: 'noop', type: 'transform', expression: '${ 1 }' }],
  }) as never;

async function setup(refreshTokens: boolean) {
  const refreshed: string[] = [];
  const t = await runsApp({
    config: mockConfig(),
    definitions: new StaticDefinitions().add(playbook(refreshTokens)),
    outbound: new FakeExecutor(() => null),
    runs: { refreshTokens: async (hash) => void refreshed.push(hash) },
  });
  return { t, refreshed };
}

describe('refreshTokens: true', () => {
  it('refreshes the initiator session after a successful run', async () => {
    const { t, refreshed } = await setup(true);
    const avery = await t.login(AVERY, ALL_ROLES);
    await avery.post('/api/runs', { playbook: 'test.activate', inputs: {} });
    await t.drain();
    expect(refreshed).toEqual([avery.record.idHash]);
  });

  it('does nothing for dry runs or playbooks without the flag', async () => {
    const flagged = await setup(true);
    const a = await flagged.t.login(AVERY, ALL_ROLES);
    await a.post('/api/runs', { playbook: 'test.activate', inputs: {}, dryRun: true });
    await flagged.t.drain();
    expect(flagged.refreshed).toEqual([]);
    const plain = await setup(false);
    const b = await plain.t.login(AVERY, ALL_ROLES);
    await b.post('/api/runs', { playbook: 'test.activate', inputs: {} });
    await plain.t.drain();
    expect(plain.refreshed).toEqual([]);
  });
});
