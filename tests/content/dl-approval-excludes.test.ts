import path from 'node:path';
import { describe, expect, it } from 'vitest';
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

// Adding members to a mail-enabled security group waits for a second engineer (2026-10-22 owner decision), and the
// people picked can't be that engineer. Addresses typed have no object id: Exchange refuses the approver's own
// addresses at the write, which runs as the approver. Synthetic ids only.
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const def = loaded.definitions.find((d) => d.def.id === 'm365.add-distribution-list-members')!
  .def as unknown as AutomationDefinition;
const INITIATOR = {
  kind: 'delegated' as const,
  oid: '00000000-0000-4000-8000-0000000000a1',
  upn: 'avery@example.com',
};
const ALEX = '00000000-0000-4000-8000-0000000000B2';
const KIM = '00000000-0000-4000-8000-0000000000c3';

function respond(call: ServiceCall): unknown {
  const p = call.path ?? '';
  if (p === '/directoryObjects/getByIds')
    return {
      value: ((call.body as { ids?: string[] }).ids ?? []).map((id, i) => ({
        id,
        userPrincipalName: `user${i}@example.com`,
        mail: `user${i}@example.com`,
      })),
    };
  if (p === '/me')
    return { id: INITIATOR.oid, mail: 'avery@example.com', proxyAddresses: ['SMTP:avery@example.com'] };
  if (p === '/groups')
    return { value: [{ id: 'g1', displayName: 'Finance Access', mailEnabled: true, securityEnabled: true }] };
  return { value: [] };
}

async function approvalOf(inputs: Record<string, unknown>) {
  const clock = new VirtualClock('2026-10-22T12:00:00.000Z');
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
  expect(await engine.execute('run-1', def)).toMatchObject({ status: 'awaiting_approval' });
  const tasks = [...store.tasks.values()];
  expect(tasks).toHaveLength(1);
  return tasks[0] as { excludes?: string[]; message?: string };
}

describe('m365.add-distribution-list-members: approval for a mail-enabled security group', () => {
  it('excludes everyone picked, whatever the case of their id', async () => {
    const task = await approvalOf({ identity: 'finance-access@example.com', members: [ALEX, KIM] });
    expect(task.excludes).toEqual([ALEX.toLowerCase(), KIM]);
  });

  it('opens an approval with no exclusions when every member is a typed address', async () => {
    const task = await approvalOf({
      identity: 'finance-access@example.com',
      addresses: 'kim.lee@partner.example',
    });
    expect(task.excludes ?? []).toEqual([]);
  });
});
