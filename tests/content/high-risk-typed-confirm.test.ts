import path from 'node:path';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// High and critical playbooks confirm by typing a value the person recognises (playbook skill, step 5): one click is
// easy to give without reading, and in a bulk run it would apply to every selected row — typed asks for the count
// there. `azure.remove-role-assignment` (1.1.0, also a bulk action) and `identity.add-app-owner` (1.3.0) were the two
// that still asked for a click. What they ask for (a name, or the object id when the name can't be typed):
// typed-confirm-fallback.test.ts.

type Confirm = { type?: string; value?: string; message?: string };
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const playbooks = loaded.definitions
  .map((d) => d.def as { id: string; kind: string; status?: string; risk?: string; confirm?: Confirm })
  .filter((d) => d.kind === 'playbook' && d.status !== 'retired' && d.status !== 'draft');

describe('high and critical playbooks confirm by typing', () => {
  it('every one asks for a typed value', () => {
    const risky = playbooks.filter((p) => p.risk === 'high' || p.risk === 'critical');
    expect(risky.length).toBeGreaterThan(20);
    expect(risky.filter((p) => p.confirm?.type !== 'typed' || !p.confirm.value).map((p) => p.id)).toEqual([]);
  });
});
