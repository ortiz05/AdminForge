import { desiredPermissions } from '@adminforge/cli/src/provision/entra-desired';
import { ceilingSettings } from '@adminforge/cli/src/provision/settings';

// Query Studio's advanced hunting is built-in code that runs as the signed-in user through the Read app. Provisioning
// grants its delegated ThreatHunting.Read.All exactly while AF_QUERY_SOURCES offers it (unset = every source, the
// API's default), so a switched-off installation holds no Defender hunting permission.
const readGraph = (env: Record<string, string | undefined>) =>
  desiredPermissions(ceilingSettings(env)).requests.read.flatMap((r) =>
    r.resource === 'graph' ? [...r.values] : [],
  );

describe('ThreatHunting.Read.All follows AF_QUERY_SOURCES', () => {
  it('is granted when every source is offered (unset or blank) or advancedHunting is listed', () => {
    for (const AF_QUERY_SOURCES of [undefined, '', '  ', 'resourceGraph, advancedHunting'])
      expect(readGraph({ AF_QUERY_SOURCES })).toContain('ThreatHunting.Read.All');
  });

  it('is not granted when advanced hunting is switched off', () => {
    expect(readGraph({ AF_QUERY_SOURCES: 'resourceGraph,logAnalytics' })).not.toContain(
      'ThreatHunting.Read.All',
    );
  });

  it('never goes to the automation identity or the Write app', () => {
    const { requests } = desiredPermissions(ceilingSettings({}));
    for (const app of ['automation', 'write'] as const)
      expect(requests[app].flatMap((r) => [...r.values])).not.toContain('ThreatHunting.Read.All');
  });
});
