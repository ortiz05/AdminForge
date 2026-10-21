import path from 'node:path';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Restart, start and stop for App Service web apps stayed active when the Function App pages were retired
// (2026-10-17), but those pages were the only ones that offered them (content review N8). App Service security
// settings (`azure.app-service-security`) lists the apps, so it offers them now — for web apps only, as AdminForge
// doesn't manage Azure Functions at this time, and one app at a time (a bulk action from medium risk up would have to
// confirm by typing).
const APP_PLAYBOOKS = ['azure.restart-app', 'azure.start-app', 'azure.stop-app'];
interface Action {
  playbook?: string;
  inputs?: Record<string, string>;
  when?: string;
}
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const def = (id: string) => loaded.definitions.find((d) => d.def.id === id)!.def as Record<string, unknown>;

/** Every row and bulk action of an active definition that starts `playbook`, with where it sits. */
function offers(playbook: string) {
  const out: Array<{ id: string; kind: 'rowActions' | 'bulkActions'; action: Action }> = [];
  for (const d of loaded.definitions) {
    if ((d.def as { status?: string }).status === 'retired') continue;
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          if ((k === 'rowActions' || k === 'bulkActions') && Array.isArray(x))
            for (const a of x as Action[])
              if (a.playbook === playbook) out.push({ id: d.def.id, kind: k, action: a });
          walk(x);
        }
    };
    walk(d.def);
  }
  return out;
}

describe('App Service restart, start and stop', () => {
  it.each(APP_PLAYBOOKS)('%s is active and offered on App Service security settings', (id) => {
    expect(def(id).status ?? 'active').not.toBe('retired');
    const where = offers(id);
    expect(where.map((w) => `${w.id} ${w.kind}`)).toEqual(['azure.app-service-security rowActions']);
    const { action } = where[0]!;
    expect(action.inputs).toEqual({
      subscriptionId: '${ row.subscriptionId }',
      resourceGroup: '${ row.resourceGroup }',
      name: '${ row.name }',
    });
    expect(action.when).toMatch(/row\.appKind = 'Web app'/);
  });

  it('the report projects what the actions read', () => {
    const query = JSON.stringify(def('azure.app-service-security'));
    for (const field of ['appKind', 'state', 'resourceGroup', 'subscriptionId', 'name'])
      expect(query).toMatch(new RegExp(`project [^|]*\\b${field}\\b`));
  });
});
