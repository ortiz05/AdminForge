import path from 'node:path';
import {
  Engine,
  MemoryRunStore,
  validateInputs,
  VirtualClock,
  type AutomationDefinition,
  type OutboundPort,
  type ServiceCall,
} from '@adminforge/engine';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// ENG-02 / ENG-01: the playbooks that grant access open their approval with `excludes` naming everyone who gets the
// access (the principal and the members of a group), so none of them can approve it. Synthetic ids only.
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const byId = (id: string): AutomationDefinition => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def as unknown as AutomationDefinition;
};

const INITIATOR = {
  kind: 'delegated' as const,
  oid: '00000000-0000-4000-8000-0000000000a1',
  upn: 'avery@example.com',
};
const GROUP = '00000000-0000-4000-8000-000000000208';
const MEMBER = '00000000-0000-4000-8000-0000000000b2';
const USER = '00000000-0000-4000-8000-0000000000c3';
const ROLE = 'fe930be7-5e62-47db-91af-98c3a49a38b1';

/** Graph/ARM answers by path: a role-assignable group with one member, an enabled role, nothing assigned yet. */
function respond(call: ServiceCall): unknown {
  const p = call.path ?? '';
  if (p.includes('/transitiveMembers/')) return { value: [{ id: MEMBER }] };
  if (p.startsWith('/roleManagement/directory/roleDefinitions/'))
    return { id: ROLE, displayName: 'User Administrator', isEnabled: true };
  if (p.includes('/roleDefinitions'))
    return {
      value: [
        {
          id: `/subscriptions/x/providers/Microsoft.Authorization/roleDefinitions/${ROLE}`,
          name: ROLE,
          properties: { roleName: 'Reader' },
        },
      ],
    };
  // Every id asked about is a user (add-group-members checks that before adding anyone).
  if (p === '/directoryObjects/getByIds')
    return { value: ((call.body as { ids?: string[] } | undefined)?.ids ?? []).map((id) => ({ id })) };
  if (p.startsWith('/directoryObjects/'))
    return {
      '@odata.type': '#microsoft.graph.group',
      id: GROUP,
      displayName: 'SG-PIM-Identity-Admins',
      isAssignableToRole: true,
    };
  if (p.startsWith('/groups/') && p.endsWith('/owners')) return { value: [] };
  if (p.startsWith('/groups/'))
    return {
      id: GROUP,
      displayName: 'SG-PIM-Identity-Admins',
      uniqueName: null,
      groupTypes: [],
      mailEnabled: false,
      securityEnabled: true,
      onPremisesSyncEnabled: null,
      isAssignableToRole: true,
    };
  if (p.startsWith('/users/'))
    return { id: USER, userPrincipalName: 'm.chen@example.com', accountEnabled: true, userType: 'Member' };
  if (p.startsWith('/applications/') && p.endsWith('/owners')) return { value: [] };
  if (p.startsWith('/applications/'))
    return { id: 'app-1', appId: '00000000-0000-4000-8001-000000000301', displayName: 'Example HR Sync' };
  return { value: [] };
}

async function gateOf(id: string, inputs: Record<string, unknown>) {
  const def = byId(id);
  const clock = new VirtualClock('2026-10-15T12:00:00.000Z');
  const store = new MemoryRunStore(clock.now);
  const v = await validateInputs(def.inputs, inputs, { now: clock.now(), env: {} });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  store.create({
    id: 'run-1',
    kind: def.kind,
    definitionKey: def.id,
    dryRun: false,
    inputs: v.values,
    initiator: INITIATOR,
  });
  const outbound: OutboundPort = { call: async (_i, call) => ({ data: respond(call) }) };
  const engine = new Engine({
    store,
    clock,
    outbound,
    identity: { resolve: async (_run, actor, mode) => ({ actor, mode, handle: null }) },
  });
  const out = await engine.execute('run-1', def);
  expect(out).toMatchObject({ status: 'awaiting_approval' });
  const tasks = [...store.tasks.values()];
  expect(tasks).toHaveLength(1);
  return tasks[0] as { excludes?: string[]; expiresAt: string | null };
}

describe('approval gates exclude whoever the change grants access to', () => {
  it.each([
    [
      'identity.assign-directory-role',
      { roleDefinitionId: ROLE, principalId: GROUP, reason: 'Identity admins REQ-1' },
    ],
    [
      'identity.add-role-eligibility',
      { roleDefinitionId: ROLE, principalId: GROUP, justification: 'Identity admins REQ-2' },
    ],
    [
      'azure.assign-role',
      {
        scope: '/subscriptions/00000000-0000-4000-8000-0000000000a1',
        principalId: GROUP,
        principalType: 'Group',
        roleName: 'Reader',
        reason: 'access request REQ-3',
      },
    ],
  ])('%s: the principal and the group’s members', async (id, inputs) => {
    const task = await gateOf(id, inputs);
    expect(task.excludes).toEqual([GROUP, MEMBER]);
    expect(task.expiresAt).not.toBeNull();
  });

  it('identity.add-group-members: everyone being added to a role-assignable group', async () => {
    expect(
      (await gateOf('identity.add-group-members', { groupId: GROUP, userIds: [USER, MEMBER] })).excludes,
    ).toEqual([USER, MEMBER]);
  });

  it('identity.add-group-owner: the new owner of a role-assignable group', async () => {
    expect((await gateOf('identity.add-group-owner', { groupId: GROUP, ownerId: USER })).excludes).toEqual([
      USER,
    ]);
  });

  it('identity.add-app-owner: the new owner of the app', async () => {
    expect(
      (
        await gateOf('identity.add-app-owner', {
          appObjectId: '00000000-0000-4000-8000-000000000301',
          ownerId: USER,
        })
      ).excludes,
    ).toEqual([USER]);
  });
});
