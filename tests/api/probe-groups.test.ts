import { Navigation } from '@adminforge/schemas';
import { FakeDefinitions, probe, READER, schedulesApp } from './schedules-helpers';

// Synthetic monitoring groups probes by the service they watch: GET /api/probes carries each probe's `group` and the
// groups in navigation order (labels from navigation.yaml), AdminForge's own checks as "AdminForge", unknown keys last.
const navigation = Navigation.parse({
  kind: 'navigation',
  id: 'portal.navigation',
  version: '1.0.0',
  title: 'Navigation',
  owner: 'test',
  sections: [
    { key: 'identity', label: 'Identity', icon: 'identification-card', order: 20 },
    { key: 'teams', label: 'Teams', icon: 'microsoft-teams-logo', order: 36 },
    { key: 'exchange', label: 'Exchange Online', icon: 'envelope-simple', order: 32 },
  ],
});

describe('probe groups', () => {
  it('returns each probe’s group and the groups in navigation order', async () => {
    const defs = new FakeDefinitions()
      .set(navigation)
      .set(probe('probes.teams-channels', { group: 'teams' }))
      .set(probe('probes.exchange-mail-flow', { group: 'exchange' }))
      .set(probe('probes.audit-chain', { group: 'platform' }))
      .set(probe('probes.custom', { group: 'lab' }))
      .set(probe('probes.loose'));
    const t = await schedulesApp({ defs });
    const reader = await t.login(READER, ['Portal.Reader']);
    const body = (await reader.get('/api/probes')).json() as {
      items: Array<{ key: string; group: string | null }>;
      groups: Array<{ key: string; label: string; icon: string }>;
    };
    expect(Object.fromEntries(body.items.map((i) => [i.key, i.group]))).toEqual({
      'probes.audit-chain': 'platform',
      'probes.custom': 'lab',
      'probes.exchange-mail-flow': 'exchange',
      'probes.loose': null,
      'probes.teams-channels': 'teams',
    });
    expect(body.groups).toEqual([
      { key: 'exchange', label: 'Exchange Online', icon: 'envelope-simple' },
      { key: 'teams', label: 'Teams', icon: 'microsoft-teams-logo' },
      { key: 'platform', label: 'AdminForge', icon: 'gauge' },
      { key: 'lab', label: 'Lab', icon: 'pulse' },
    ]);
    await t.close();
  });
});
