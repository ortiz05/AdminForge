import path from 'node:path';
import { fixtureRunner } from '@adminforge/api/src/datasources/executor';
import {
  Engine,
  MemoryRunStore,
  validateInputs,
  VirtualClock,
  type AutomationDefinition,
  type OutboundPort,
  type RunnerJob,
  type RunnerPort,
  type ServiceCall,
} from '@adminforge/engine';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Creating shared mailboxes, room mailboxes and distribution lists, and removing ones AdminForge created
// (m365.create-shared-mailbox, m365.create-room-mailbox, m365.create-distribution-list, m365.remove-created-recipient):
// - a dry run checks the address against Exchange (the runner fixture in DATA_MODE=fixtures) and plans one write;
// - every write names the Entra object ids of the people it gives access to or ownership of, and a re-run names the
//   existing recipient's id (the executor's protected-object guard matches ids in a runner write's parameters);
//   removal names the recipient's own id;
// - you can't give yourself mailbox access, and only a list's owners can finish or remove it;
// - a re-run says it changes the existing recipient and needs the address typed, like every create;
// - typed values travel as separate runner parameters — the scripts never build commands or filters from them;
// - the pages offer the create actions, and removal only on recipients carrying AdminForge's mark.
// Synthetic ids and addresses only.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const byId = (id: string): Def => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};
const fixtures = fixtureRunner(path.join(repoRoot, 'tests/fixtures'));

const INITIATOR = {
  kind: 'delegated' as const,
  oid: '00000000-0000-4000-8000-0000000000a1',
  upn: 'avery@example.com',
};
const BLAKE = '00000000-0000-4000-8000-000000000102';
const DANA = '00000000-0000-4000-8000-000000000103';
const SCANNER = '00000000-0000-4000-8000-000000000104';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const people: Record<string, { id: string; userPrincipalName: string; mail?: string }> = {
  [INITIATOR.oid]: { id: INITIATOR.oid, userPrincipalName: 'avery@example.com', mail: 'avery@example.com' },
  [BLAKE]: { id: BLAKE, userPrincipalName: 'blake@example.com', mail: 'Blake@example.com' },
  [DANA]: { id: DANA, userPrincipalName: 'dana@example.com', mail: 'dana@example.com' },
  [SCANNER]: { id: SCANNER, userPrincipalName: 'svc.scanner@example.com' },
};
const graph = (call: ServiceCall) => {
  const ids = ((call.body as { ids?: string[] } | undefined)?.ids ?? []) as string[];
  return { value: ids.map((id) => people[id]).filter(Boolean) };
};

/** Read steps answer from the runner fixture; writes answer what `write` returns (a live-shaped result). */
async function start(
  id: string,
  inputs: Record<string, unknown>,
  opts: { dryRun?: boolean; write?: (job: RunnerJob) => unknown; initiator?: typeof INITIATOR } = {},
) {
  const def = byId(id) as AutomationDefinition;
  const clock = new VirtualClock('2026-10-17T12:00:00.000Z');
  const store = new MemoryRunStore(clock.now);
  const v = await validateInputs(def.inputs, inputs, { now: clock.now(), env: {} });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  store.create({
    id: 'run-1',
    kind: def.kind,
    definitionKey: def.id,
    dryRun: opts.dryRun ?? false,
    inputs: v.values,
    initiator: opts.initiator ?? INITIATOR,
  });
  const jobs: RunnerJob[] = [];
  const outbound: OutboundPort = { call: async (_i, call) => ({ data: graph(call) }) };
  const runner: RunnerPort = {
    run: async (_i, job) => {
      jobs.push(job);
      if (job.mode === 'write') return { status: 'succeeded', output: [opts.write?.(job) ?? {}] };
      const { data } = await fixtures.run({ kind: 'automation', mode: 'read' } as never, job as never, {
        correlationId: 'content-test',
      });
      return { status: 'succeeded', output: data };
    },
  };
  const engine = new Engine({
    store,
    clock,
    outbound,
    runner,
    identity: { resolve: async (_run, actor, mode) => ({ actor, mode, handle: null }) },
  });
  const first = await engine.execute('run-1', def);
  const steps = await store.listSteps('run-1');
  const planned = steps.flatMap((s) => s.plan ?? []);
  return { first, jobs, planned, steps, writes: jobs.filter((j) => j.mode === 'write') };
}

describe('m365.create-shared-mailbox', () => {
  const base = {
    displayName: 'Sales team',
    address: 'Sales@example.com',
    members: [BLAKE, DANA],
    reason: 'Ticket REQ-1001 inbox for the sales team',
  };

  it('dry run: checks the address in Exchange, then plans one write and makes none', async () => {
    const run = await start('m365.create-shared-mailbox', base, { dryRun: true });
    expect(run.first.status).toBe('succeeded');
    expect(run.writes).toHaveLength(0);
    expect(run.jobs.map((j) => j.script)).toEqual(['exchange/Get-RecipientAvailability.ps1']);
    expect(run.planned.map((p) => p.stepId)).toEqual(['create']);
    expect(run.planned[0]!.describe).toBe(
      'Create the shared mailbox sales@example.com; give 2 people Full Access and Send As; sign-in to its account blocked',
    );
  });

  it('passes the people as addresses and Entra object ids, and sign-in off by default', async () => {
    const run = await start('m365.create-shared-mailbox', base, {
      write: (job) => ({
        address: job.parameters.primarySmtpAddress,
        created: true,
        accountDisabled: true,
        fullAccessAdded: job.parameters.memberAddresses,
        sendAsAdded: job.parameters.memberAddresses,
        skipped: [],
        failed: [],
        verified: true,
      }),
    });
    expect(run.first.status).toBe('succeeded');
    expect(run.writes).toHaveLength(1);
    const p = run.writes[0]!.parameters;
    expect(p).toMatchObject({
      displayName: 'Sales team',
      alias: 'Sales',
      primarySmtpAddress: 'sales@example.com',
      memberAddresses: ['blake@example.com', 'dana@example.com'],
      memberObjectIds: [BLAKE, DANA],
      sendAs: true,
      allowSignIn: false,
    });
    expect(p.existingObjectId ?? null).toBeNull();
    for (const id of p.memberObjectIds as string[]) expect(id).toMatch(GUID);
  });

  it('a re-run says it gives access on the existing mailbox and names it for the protected-object guard (fixture: events@)', async () => {
    const inputs = { ...base, address: 'events@example.com', members: [BLAKE] };
    const dry = await start('m365.create-shared-mailbox', inputs, { dryRun: true });
    expect(dry.first.status).toBe('succeeded');
    expect(dry.planned[0]!.describe).toBe(
      'Give 1 person Full Access and Send As on the existing shared mailbox events@example.com (created by AdminForge); sign-in to its account blocked',
    );
    const live = await start('m365.create-shared-mailbox', inputs, {
      write: () => ({
        address: 'events@example.com',
        created: false,
        accountDisabled: true,
        fullAccessAdded: [],
        sendAsAdded: [],
        skipped: [],
        failed: [],
        verified: true,
      }),
    });
    expect(live.writes[0]!.parameters.existingObjectId).toBe('30000000-0000-4000-8000-000000000001');
  });

  it('needs the address typed to confirm, and says so for an existing mailbox', () => {
    const def = byId('m365.create-shared-mailbox');
    expect(def.risk).toBe('high');
    expect(def.confirm).toMatchObject({ type: 'typed', value: '${ steps.plan.output.address }' });
  });

  it('refuses giving yourself access', async () => {
    const run = await start(
      'm365.create-shared-mailbox',
      { ...base, members: [INITIATOR.oid] },
      { dryRun: true },
    );
    expect(run.first.error).toMatchObject({ stepId: 'notYou' });
    expect(run.planned).toHaveLength(0);
  });

  it('refuses an address another recipient uses before planning anything (fixture: reception@)', async () => {
    const run = await start(
      'm365.create-shared-mailbox',
      { ...base, address: 'reception@example.com', members: [] },
      { dryRun: true },
    );
    expect(run.first.status).toBe('failed');
    expect(run.first.error).toMatchObject({ stepId: 'available' });
    expect(run.first.error?.message).toBe(
      'reception@example.com is already used by a shared mailbox (Reception). Pick another address or alias.',
    );
    expect(run.planned).toHaveLength(0);
  });

  it('refuses a person without a mailbox', async () => {
    const run = await start('m365.create-shared-mailbox', { ...base, members: [SCANNER] }, { dryRun: true });
    expect(run.first.error).toMatchObject({ stepId: 'everyoneHasMail' });
    expect(run.first.error?.message).toContain('svc.scanner@example.com');
  });

  it.each([
    ['a display name that could break out of a parameter', { displayName: 'Sales"; Remove-Mailbox x' }],
    ['an address with a wildcard', { address: 'sa*@example.com' }],
    ['an alias with stray dots', { alias: 'sales..team' }],
  ])('refuses %s', async (_what, over) => {
    const def = byId('m365.create-shared-mailbox') as AutomationDefinition;
    const v = await validateInputs(def.inputs, { ...base, ...over }, { now: new Date(), env: {} });
    expect(v.ok).toBe(false);
  });
});

describe('m365.create-room-mailbox', () => {
  it('dry run plans the room with every option it sets', async () => {
    const run = await start(
      'm365.create-room-mailbox',
      {
        displayName: 'Room 4.01',
        address: 'room401@example.com',
        capacity: 8,
        maximumDurationHours: 4,
        reason: 'Ticket REQ-2001 new room on floor 4',
      },
      { dryRun: true },
    );
    expect(run.first.status).toBe('succeeded');
    expect(run.writes).toHaveLength(0);
    expect(run.planned.map((p) => p.describe)).toEqual([
      'Create the room Room 4.01 (room401@example.com): 8 seats, invitations answered automatically, no overlapping bookings, bookable up to 180 days ahead, at most 4 hours per booking',
    ]);
  });

  it('refuses an existing room (fixture: room-atlas@)', async () => {
    const run = await start(
      'm365.create-room-mailbox',
      { displayName: 'Atlas', address: 'room-atlas@example.com', reason: 'Ticket REQ-2002 duplicate room' },
      { dryRun: true },
    );
    expect(run.first.error).toMatchObject({ stepId: 'available' });
  });
});

describe('m365.create-distribution-list', () => {
  const base = {
    displayName: 'Project Falcon',
    address: 'falcon@example.com',
    owners: [BLAKE],
    members: [DANA],
    addresses: 'Kim.Lee@partner.example\nkim.lee@partner.example',
    reason: 'Ticket REQ-3001 list for Project Falcon',
  };

  it('passes owners with their object ids and de-duplicated members; internal senders only by default', async () => {
    const run = await start('m365.create-distribution-list', base, {
      write: (job) => ({
        address: job.parameters.primarySmtpAddress,
        created: true,
        owners: job.parameters.ownerAddresses,
        membersAdded: job.parameters.memberAddresses,
        memberCount: 2,
        allowExternalSenders: false,
        youAreOwner: false,
        skipped: [],
        failed: [],
        verified: true,
      }),
    });
    expect(run.first.status).toBe('succeeded');
    expect(run.writes[0]!.parameters).toMatchObject({
      ownerAddresses: ['blake@example.com'],
      ownerObjectIds: [BLAKE],
      memberAddresses: ['dana@example.com', 'kim.lee@partner.example'],
      allowExternalSenders: false,
      keepMeAsOwner: false,
    });
    expect(run.first.outputs?.summary).toBe(
      'Created the distribution list falcon@example.com, owned by blake@example.com, with 2 members; internal senders only.',
    );
  });

  it('refuses an owner without a mailbox', async () => {
    const run = await start(
      'm365.create-distribution-list',
      { ...base, owners: [SCANNER] },
      { dryRun: true },
    );
    expect(run.first.error).toMatchObject({ stepId: 'ownersHaveMail' });
  });

  it('refuses an engineer without a mailbox (they own the list while it is set up)', async () => {
    const nobody = {
      kind: 'delegated' as const,
      oid: '00000000-0000-4000-8000-0000000000b2',
      upn: 'newhire@example.com',
    };
    const run = await start('m365.create-distribution-list', base, { dryRun: true, initiator: nobody });
    expect(run.first.error).toMatchObject({ stepId: 'youHaveMailbox' });
  });

  it('a re-run is refused once you are no longer an owner (fixture: office-lisbon@)', async () => {
    const other = {
      kind: 'delegated' as const,
      oid: '00000000-0000-4000-8000-0000000000b3',
      upn: 'blake@example.com',
    };
    people[other.oid] = { id: other.oid, userPrincipalName: 'blake@example.com', mail: 'blake@example.com' };
    const inputs = { ...base, address: 'office-lisbon@example.com', addresses: '' };
    const refused = await start('m365.create-distribution-list', inputs, { dryRun: true, initiator: other });
    expect(refused.first.error).toMatchObject({ stepId: 'stillOwner' });
    const owner = await start('m365.create-distribution-list', inputs, { dryRun: true });
    expect(owner.first.status).toBe('succeeded');
    expect(owner.planned[0]!.describe).toBe(
      'Add the missing owners and members (of 1 member) to the existing distribution list office-lisbon@example.com (created by AdminForge); internal senders only',
    );
  });

  it('needs at least one owner', async () => {
    const def = byId('m365.create-distribution-list') as AutomationDefinition;
    const v = await validateInputs(def.inputs, { ...base, owners: [] }, { now: new Date(), env: {} });
    expect(v.ok).toBe(false);
  });
});

describe('m365.remove-created-recipient', () => {
  it('plans removal of a mailbox AdminForge created, naming its object id (fixture: events@)', async () => {
    const inputs = {
      address: 'events@example.com',
      kind: 'sharedMailbox',
      reason: 'Ticket REQ-1009 no longer needed',
    };
    const run = await start('m365.remove-created-recipient', inputs, { dryRun: true });
    expect(run.first.status).toBe('succeeded');
    expect(run.planned.map((p) => p.describe)).toEqual([
      'Remove the shared mailbox Events (events@example.com); an Exchange administrator can restore it for 30 days',
    ]);
    const live = await start('m365.remove-created-recipient', inputs, {
      write: () => ({
        identity: 'events@example.com',
        kind: 'sharedMailbox',
        removed: true,
        note: 'Removed.',
      }),
    });
    expect(live.writes[0]!.parameters).toMatchObject({
      identity: 'events@example.com',
      kind: 'sharedMailbox',
      bypassSecurityGroupManagerCheck: false,
    });
    expect(live.writes[0]!.parameters.objectId).toMatch(GUID);
  });

  it('removes a list only for its owners (fixture: office-lisbon@ is owned by the initiator)', async () => {
    const inputs = {
      address: 'office-lisbon@example.com',
      kind: 'distributionList',
      reason: 'Ticket REQ-1013 office closed',
    };
    expect((await start('m365.remove-created-recipient', inputs, { dryRun: true })).planned).toHaveLength(1);
    const other = {
      kind: 'delegated' as const,
      oid: '00000000-0000-4000-8000-0000000000b3',
      upn: 'blake@example.com',
    };
    const refused = await start('m365.remove-created-recipient', inputs, { dryRun: true, initiator: other });
    expect(refused.first.error).toMatchObject({ stepId: 'listOwner' });
    const bypass = await start(
      'm365.remove-created-recipient',
      { ...inputs, bypassSecurityGroupManagerCheck: true },
      { dryRun: true, initiator: other },
    );
    expect(bypass.planned).toHaveLength(1);
  });

  it.each([
    ['reception@example.com', 'sharedMailbox', 'createdHere'],
    ['office-lisbon@example.com', 'sharedMailbox', 'rightKind'],
  ])('refuses %s as a %s at %s', async (address, kind, stepId) => {
    const run = await start(
      'm365.remove-created-recipient',
      { address, kind, reason: 'Ticket REQ-1010 clean-up attempt' },
      { dryRun: true },
    );
    expect(run.first.error).toMatchObject({ stepId });
    expect(run.planned).toHaveLength(0);
  });

  it('succeeds without a write when nothing uses the address (a re-run after removal)', async () => {
    const run = await start(
      'm365.remove-created-recipient',
      { address: 'nobody-here@example.com', kind: 'roomMailbox', reason: 'Ticket REQ-1010 already removed' },
      { dryRun: true },
    );
    expect(run.first.status).toBe('succeeded');
    expect(run.planned).toHaveLength(0);
    expect(run.first.outputs?.summary).toBe(
      'Nothing uses nobody-here@example.com; there was nothing to remove.',
    );
  });

  it('asks for the address to be typed and is high risk', () => {
    const def = byId('m365.remove-created-recipient');
    expect(def.risk).toBe('high');
    expect(def.confirm.type).toBe('typed');
  });
});

describe('Exchange recipient creation: declarations and pages', () => {
  const ids = [
    'm365.create-shared-mailbox',
    'm365.create-room-mailbox',
    'm365.create-distribution-list',
    'm365.remove-created-recipient',
  ];

  it.each(ids)(
    '%s writes through one idempotent runner step with a dry-run output, needs Exchange Recipient Administrator and a typed confirmation',
    (id) => {
      const def = byId(id);
      expect(def.mode).toBe('write');
      expect(def.requires.entraRoles).toContain('Exchange Recipient Administrator');
      expect(def.requires.scopes.exchange).toContain('Exchange.Manage');
      expect(def.confirm.type).toBe('typed');
      const writes = def.steps.filter((s: Def) => s.mode === 'write');
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ type: 'runner', idempotent: true });
      expect(writes[0].dryRunOutput).toBeDefined();
      expect(writes[0].describe).toBeTruthy();
    },
  );

  it('the pages offer the create actions, and removal only where AdminForge created the recipient', () => {
    const action = (pageId: string, playbook: string) =>
      (byId(pageId).actions ?? []).find((a: Def) => a.playbook === playbook);
    expect(action('m365.mailboxes', 'm365.create-shared-mailbox')).toBeDefined();
    expect(action('m365.mailboxes', 'm365.create-room-mailbox')).toBeDefined();
    expect(action('m365.shared-mailboxes', 'm365.create-shared-mailbox')).toBeDefined();
    expect(action('m365.distribution-lists', 'm365.create-distribution-list')).toBeDefined();
    expect(action('m365.mailbox', 'm365.remove-created-recipient').when).toContain(
      'mailbox.createdByAdminForge = true',
    );
    expect(action('m365.distribution-list', 'm365.remove-created-recipient').when).toContain(
      'dl.createdByAdminForge = true',
    );
  });
});
