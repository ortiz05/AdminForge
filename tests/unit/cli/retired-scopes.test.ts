import path from 'node:path';
import { declaredScopes } from '@adminforge/cli/src/content/scopes';
import { loadContentDir, type LoadedDefinition } from '@adminforge/schemas';
import { repoRoot } from '../../lib/repo';

// A retired definition stays published only for run and audit history, so its `requires.scopes` no longer earn a
// permission: `provision entra` drops them from the apps and `validate --scopes` stops expecting them.
const page = (id: string, status: string | undefined, graph: string[]) =>
  ({
    file: `pages/${id}.page.yaml`,
    def: {
      kind: 'page',
      id,
      version: '1.0.0',
      ...(status ? { status } : {}),
      requires: { scopes: { graph } },
      datasources: { rows: { source: 'graph', requires: { scopes: { graph: [`${graph[0]}.Extra`] } } } },
    },
  }) as unknown as LoadedDefinition;

describe('declaredScopes skips retired definitions', () => {
  it('counts active, draft and deprecated definitions but not retired ones (page or datasource level)', () => {
    const d = declaredScopes([
      page('a.active', undefined, ['User.Read.All']),
      page('a.draft', 'draft', ['Group.Read.All']),
      page('a.deprecated', 'deprecated', ['Reports.Read.All']),
      page('a.retired', 'retired', ['SecurityIncident.Read.All']),
    ]);
    const graph = [...(d.scopes.read.graph ?? [])];
    expect(graph).toEqual(
      expect.arrayContaining(['User.Read.All', 'Group.Read.All', 'Reports.Read.All', 'Group.Read.All.Extra']),
    );
    expect(graph.filter((s) => s.startsWith('SecurityIncident'))).toEqual([]);
    expect([...d.files.keys()].some((k) => k.includes('SecurityIncident'))).toBe(false);
  });

  it('the retired Defender portal content no longer asks for Defender XDR permissions', async () => {
    const { definitions } = await loadContentDir(path.join(repoRoot, 'portal/content'));
    const d = declaredScopes(definitions);
    const defender = /^(SecurityIncident|SecurityAlert|SecurityEvents|ThreatHunting)\./i;
    for (const app of ['read', 'write', 'automation'] as const)
      expect([...(d.scopes[app].graph ?? [])].filter((s) => defender.test(s))).toEqual([]);
  });
});
