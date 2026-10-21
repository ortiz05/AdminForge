import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Resource ids, scopes and role names go into Resource Graph as quoted KQL literals ($kql), not with characters
// stripped: `azure.resource` and `azure.role-assignments` dropped everything outside [A-Za-z0-9._()/-], so a resource
// group named with other letters (they are allowed) matched nothing, and a role name search lost characters (content
// review S3).

interface Def {
  id: string;
  datasources: Record<string, { query?: string }>;
}
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const page = (id: string) => loaded.definitions.find((d) => d.def.id === id)!.def as unknown as Def;

const SUB = '/subscriptions/00000000-0000-4000-8000-0000000000a1';
const GROUP = `${SUB}/resourceGroups/rg-Finanzbuchhaltung-Zürich`;
const group = GROUP.toLowerCase();
const RESOURCE = `${GROUP}/providers/Microsoft.Storage/storageAccounts/stexample01`;
const resource = RESOURCE.toLowerCase();

const render = (id: string, ds: string, params: Record<string, unknown>) =>
  renderString(page(id).datasources[ds]!.query!, { params });

describe('azure.resource', () => {
  it('looks the resource up by its whole id', async () => {
    const q = await render('azure.resource', 'resource', { id: RESOURCE });
    expect(q).toContain(`| where tolower(id) == "${resource}"`);
    expect(q).toContain(`| union (resourcecontainers | where tolower(id) == "${resource}")`);
  });

  it('finds the assignments at its scope and above, and marks the inherited ones', async () => {
    const q = await render('azure.resource', 'access', { id: GROUP, days: 7 });
    expect(q).toContain(`| where scope == "${group}" or "${group}" startswith strcat(scope, '/')`);
    expect(q).toContain(`| extend inherited = iff(scope != "${group}", 'true', 'false')`);
  });

  it('quotes what it is given', async () => {
    const q = await render('azure.resource', 'resource', { id: `${SUB}/x" | take 0 //` });
    expect(q).toContain(`== "${SUB.toLowerCase()}/x\\" | take 0 //"`);
  });

  it('strips no characters any more', () => {
    for (const [name, ds] of Object.entries(page('azure.resource').datasources))
      expect(ds.query ?? '', name).not.toMatch(/\$replace\(/);
  });
});

describe('azure.role-assignments', () => {
  const scoped = (include: string) =>
    render('azure.role-assignments', 'assignments', { scope: GROUP, include });

  it('filters by the whole scope', async () => {
    expect(await scoped('exact')).toContain(`| where scope == "${group}"\n`);
    expect(await scoped('above')).toContain(
      `| where "${group}" == scope or "${group}" startswith strcat(scope, '/')`,
    );
    expect(await scoped('below')).toContain(`| where scope == "${group}" or scope startswith "${group}/"`);
  });

  it('searches the role name as typed', async () => {
    const q = await render('azure.role-assignments', 'assignments', {
      roleName: 'Contributor (Ärzte)',
      include: 'below',
    });
    expect(q).toContain('| where roleName contains "Contributor (Ärzte)"');
  });

  it('strips no characters any more', () => {
    expect(page('azure.role-assignments').datasources.assignments!.query).not.toMatch(/\$replace\(/);
  });
});
