import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// High and critical playbooks confirm by typing a value the person recognises (playbook skill, step 5): one click is
// easy to give without reading, and in a bulk run it would apply to every selected row — typed asks for the count
// there. `azure.remove-role-assignment` (1.1.0, also a bulk action) and `identity.add-app-owner` (1.3.0) were the two
// that still asked for a click.

type Confirm = { type?: string; value?: string; message?: string };
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const playbooks = loaded.definitions
  .map((d) => d.def as { id: string; kind: string; status?: string; risk?: string; confirm?: Confirm })
  .filter((d) => d.kind === 'playbook' && d.status !== 'retired' && d.status !== 'draft');
const byId = (id: string) => playbooks.find((p) => p.id === id)!;

describe('high and critical playbooks confirm by typing', () => {
  it('every one asks for a typed value', () => {
    const risky = playbooks.filter((p) => p.risk === 'high' || p.risk === 'critical');
    expect(risky.length).toBeGreaterThan(20);
    expect(risky.filter((p) => p.confirm?.type !== 'typed' || !p.confirm.value).map((p) => p.id)).toEqual([]);
  });

  it("azure.remove-role-assignment asks for the role's name (the assignment's GUID when the role can't be read)", async () => {
    const { confirm } = byId('azure.remove-role-assignment');
    const lookup = {
      name: '30000000-0000-4000-8000-000000000202',
      properties: {
        principalId: '30000000-0000-4000-8000-000000000102',
        principalType: 'User',
        scope: '/subscriptions/00000000-0000-4000-8000-0000000000a1',
      },
    };
    const readable = {
      steps: { lookup: { output: lookup }, role: { output: { properties: { roleName: 'Owner' } } } },
    };
    expect(await renderString(confirm!.value!, readable)).toBe('Owner');
    expect(await renderString(confirm!.message!, readable)).toBe(
      'Remove Owner from the user 30000000-0000-4000-8000-000000000102 at ' +
        '/subscriptions/00000000-0000-4000-8000-0000000000a1? They lose the access it grants within a few minutes. ' +
        'Type the role name to confirm.',
    );
    const unreadable = { steps: { lookup: { output: lookup }, role: {} } };
    expect(await renderString(confirm!.value!, unreadable)).toBe('30000000-0000-4000-8000-000000000202');
    expect(await renderString(confirm!.message!, unreadable)).toMatch(
      /^Remove this role from the user .* Type the assignment's GUID \(the end of its id\) to confirm\.$/,
    );
  });

  it("identity.add-app-owner asks for the app's name", async () => {
    const { confirm } = byId('identity.add-app-owner');
    const scope = {
      steps: {
        app: { output: { displayName: 'Example HR Sync' } },
        owner: { output: { userPrincipalName: 'm.chen@example.com' } },
      },
    };
    expect(await renderString(confirm!.value!, scope)).toBe('Example HR Sync');
    expect(await renderString(confirm!.message!, scope)).toMatch(/Type the app name to confirm\.$/);
  });
});
