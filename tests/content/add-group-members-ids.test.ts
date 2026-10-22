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

// identity.add-group-members checks that every id is a user before adding anyone (POST /directoryObjects/getByIds).
// Graph takes `ids` as a list: one person (the user page's "Add to group", every bulk child run) must still send
// a list of one, not a bare string. Playbook test mocks don't look at request bodies, so this runs the engine.
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const def = loaded.definitions.find((d) => d.def.id === 'identity.add-group-members')!
  .def as unknown as AutomationDefinition;
const GROUP = '00000000-0000-4000-8000-000000000201';
const A = '00000000-0000-4000-8000-000000000102';
const B = '00000000-0000-4000-8000-000000000103';

async function run(userIds: string[]) {
  const calls: ServiceCall[] = [];
  const clock = new VirtualClock('2026-10-22T12:00:00.000Z');
  const store = new MemoryRunStore(clock.now);
  const v = await validateInputs(def.inputs, { groupId: GROUP, userIds }, { now: clock.now(), env: {} });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  store.create({
    id: 'run-1',
    kind: def.kind,
    definitionKey: def.id,
    dryRun: true,
    inputs: v.values,
    initiator: { kind: 'delegated', oid: '00000000-0000-4000-8000-0000000000a1', upn: 'avery@example.com' },
  });
  const outbound: OutboundPort = {
    call: async (_i, call) => {
      calls.push(call);
      if (call.path === '/directoryObjects/getByIds') {
        const ids = (call.body as { ids: unknown }).ids;
        if (!Array.isArray(ids)) throw new Error(`ids must be a list, got ${JSON.stringify(ids)}`);
        return { data: { value: ids.map((id) => ({ id })) } };
      }
      return {
        data: {
          id: GROUP,
          displayName: 'SG-App-Payroll-Users',
          groupTypes: [],
          mailEnabled: false,
          securityEnabled: true,
          onPremisesSyncEnabled: null,
          isAssignableToRole: false,
        },
      };
    },
  };
  const engine = new Engine({
    store,
    clock,
    outbound,
    identity: { resolve: async (_run, actor, mode) => ({ actor, mode, handle: null }) },
  });
  const out = await engine.execute('run-1', def);
  return { out, lookup: calls.find((c) => c.path === '/directoryObjects/getByIds')! };
}

describe('identity.add-group-members id check', () => {
  it('sends one person as a list of one', async () => {
    const { out, lookup } = await run([A]);
    expect(out.status).toBe('succeeded');
    expect(lookup.body).toEqual({ ids: [A], types: ['user'] });
  });

  it('sends several people as a list', async () => {
    const { out, lookup } = await run([A, B.toUpperCase()]);
    expect(out.status).toBe('succeeded');
    expect(lookup.body).toEqual({ ids: [A, B], types: ['user'] });
  });
});
