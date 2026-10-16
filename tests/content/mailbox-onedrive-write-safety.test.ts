import path from 'node:path';
import {
  Engine,
  MemoryRunStore,
  validateInputs,
  VirtualClock,
  type AutomationDefinition,
  type ChildRunRequest,
  type OutboundPort,
  type RunnerJob,
  type RunnerPort,
  type ServiceCall,
} from '@adminforge/engine';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Write safety of the mailbox, inbox-rule and OneDrive playbooks (security and content review 2026-10-16):
// - every PowerShell write names the Entra object ids of the accounts it changes, so the executor's protected-object
//   guard (which matches ids in a runner write's parameters) sees them;
// - forwarding a mailbox needs a second engineer, and neither the person receiving the mail nor the mailbox's owner
//   may approve it;
// - a OneDrive grant SharePoint doesn't confirm is undone only when this run added it;
// - a rule that forwards outside the organization is never offered "Turn rule on";
// - the leaver runbook passes the automatic reply to Offboard user and declares what that child needs.
// Synthetic ids and addresses only.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const byId = (id: string): Def => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};

const INITIATOR = {
  kind: 'delegated' as const,
  oid: '00000000-0000-4000-8000-0000000000a1',
  upn: 'avery@example.com',
};
const APPROVER = {
  kind: 'delegated' as const,
  oid: '00000000-0000-4000-8000-0000000000a2',
  upn: 'blake@example.com',
};
const OWNER = '00000000-0000-4000-8000-000000000101';
const TARGET = '00000000-0000-4000-8000-000000000102';
const GROUP = '00000000-0000-4000-8000-000000000201';

type Graph = (call: ServiceCall) => unknown;
type Runner = (job: RunnerJob) => unknown;

/** Runs a definition against fake Graph and runner answers; records every runner job and child playbook. */
async function start(
  id: string,
  inputs: Record<string, unknown>,
  ports: { graph?: Graph; runner?: Runner; dryRun?: boolean },
) {
  const def = byId(id) as AutomationDefinition;
  const clock = new VirtualClock('2026-10-16T12:00:00.000Z');
  const store = new MemoryRunStore(clock.now);
  const v = await validateInputs(def.inputs, inputs, { now: clock.now(), env: {} });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  store.create({
    id: 'run-1',
    kind: def.kind,
    definitionKey: def.id,
    dryRun: ports.dryRun ?? false,
    inputs: v.values,
    initiator: INITIATOR,
  });
  const jobs: RunnerJob[] = [];
  const children: ChildRunRequest[] = [];
  const outbound: OutboundPort = {
    call: async (_i, call) => ({ data: ports.graph?.(call) ?? { value: [] } }),
  };
  const runner: RunnerPort = {
    run: async (_i, job) => {
      jobs.push(job);
      const out = ports.runner?.(job) as { $fail?: { message: string; category: string } } | undefined;
      if (out?.$fail) return { status: 'failed', output: null, error: out.$fail };
      return { status: 'succeeded', output: out ?? null };
    },
  };
  const engine = new Engine({
    store,
    clock,
    outbound,
    runner,
    children: {
      run: async (req) => {
        children.push(req);
        return {
          runId: `child-${children.length}`,
          status: 'succeeded',
          outputs: { summary: 'done' },
          error: null,
          plan: [],
        };
      },
    },
    identity: { resolve: async (_run, actor, mode) => ({ actor, mode, handle: null }) },
  });
  const execute = () => engine.execute('run-1', def);
  return { store, jobs, children, execute, first: await execute() };
}

const writes = (jobs: RunnerJob[]) => jobs.filter((j) => j.mode === 'write');

describe('m365.set-mailbox-forwarding', () => {
  const mailbox = (address: string, extra: Record<string, unknown> = {}) => ({
    displayName: address,
    primarySmtpAddress: address,
    userPrincipalName: address,
    recipientTypeDetails: 'UserMailbox',
    forwarding: { enabled: false, targets: [] },
    ...extra,
  });
  const graph: Graph = (call) =>
    call.path === '/users'
      ? {
          value: [
            {
              id: TARGET,
              displayName: 'Lee Gu',
              mail: 'lee@example.com',
              userPrincipalName: 'lee@example.com',
              userType: 'Member',
            },
          ],
        }
      : { id: OWNER, displayName: 'Adele Vance', userPrincipalName: 'adele@example.com' };
  const runner =
    (verified: boolean): Runner =>
    (job) => {
      if (job.script.endsWith('Get-MailboxConfiguration.ps1'))
        return mailbox(String(job.parameters.identity));
      return {
        identity: 'adele@example.com',
        target: { address: 'lee@example.com', recipientTypeDetails: 'UserMailbox' },
        changed: true,
        verified,
      };
    };
  const inputs = {
    mailbox: 'adele@example.com',
    target: 'lee@example.com',
    reason: 'Leaver HR-1001 manager covers the inbox',
  };

  it('waits for a second engineer; the person receiving the mail and the mailbox owner may not approve', async () => {
    const run = await start('m365.set-mailbox-forwarding', inputs, { graph, runner: runner(true) });
    expect(run.first.status).toBe('awaiting_approval');
    const tasks = [...run.store.tasks.values()] as Array<{ excludes?: string[]; expiresAt: string | null }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.excludes).toEqual([TARGET, OWNER]);
    expect(tasks[0]!.expiresAt).toBe('2026-10-17T12:00:00.000Z');
    expect(writes(run.jobs)).toEqual([]);
  });

  it('after approval forwards with both object ids and says when Exchange does not show it yet', async () => {
    const run = await start('m365.set-mailbox-forwarding', inputs, { graph, runner: runner(false) });
    run.store.decide('run-1', '$approval', {
      kind: 'approval',
      approved: true,
      actor: APPROVER,
      decidedAt: '2026-10-16T12:05:00.000Z',
    });
    const done = await run.execute();
    expect(done.status).toBe('succeeded');
    const [forward] = writes(run.jobs);
    expect(forward!.script).toBe('exchange/Set-MailboxForwarding.ps1');
    expect(forward!.parameters).toMatchObject({
      identity: 'adele@example.com',
      mailboxObjectId: OWNER,
      target: 'lee@example.com',
      targetObjectId: TARGET,
      deliverToMailboxAndForward: true,
    });
    expect(done.outputs?.summary).toBe(
      "Forwarding mail for adele@example.com to lee@example.com was submitted; Exchange doesn't show it yet. Open the mailbox in a few minutes to check, and use Clear forwarding there to stop it.",
    );
  });

  it('explains a target without a mailbox in Exchange Online (a hybrid mail user) without calling it outside the organization', async () => {
    const run = await start('m365.set-mailbox-forwarding', inputs, {
      graph,
      runner: (job) =>
        job.parameters.identity === 'lee@example.com'
          ? { $fail: { message: "Mailbox 'lee@example.com' was not found.", category: 'input' } }
          : mailbox('adele@example.com'),
    });
    expect(run.first.status).toBe('failed');
    expect(run.first.error).toMatchObject({ stepId: 'targetIsMailbox' });
    expect(run.first.error?.message).toContain('has no mailbox in Exchange Online');
    expect(run.first.error?.message).not.toContain('outside the organization (');
  });

  it('says what went wrong when Exchange could not be asked about the target', async () => {
    const run = await start('m365.set-mailbox-forwarding', inputs, {
      graph,
      runner: (job) =>
        job.parameters.identity === 'lee@example.com'
          ? { $fail: { message: 'Exchange Online is busy.', category: 'runner' } }
          : mailbox('adele@example.com'),
    });
    expect(run.first.error).toMatchObject({ stepId: 'targetIsMailbox' });
    expect(run.first.error?.message).toContain(
      "couldn't be checked in Exchange Online: Exchange Online is busy.",
    );
  });
});

describe('mailbox access playbooks pass the object ids', () => {
  const permissions = (rows: unknown[]) => ({
    mailbox: {
      displayName: 'Sales',
      primarySmtpAddress: 'sales@example.com',
      userPrincipalName: 'sales@example.com',
    },
    permissions: rows,
  });

  it('m365.grant-mailbox-permission: the mailbox owner and the person, also when undoing', async () => {
    const run = await start(
      'm365.grant-mailbox-permission',
      {
        mailbox: 'sales@example.com',
        person: TARGET,
        permission: 'SendOnBehalf',
        reason: 'REQ-2216 assistant sends for the team',
      },
      {
        graph: (call) =>
          call.path.startsWith('/users/sales')
            ? { id: OWNER, displayName: 'Sales', userPrincipalName: 'sales@example.com' }
            : {
                id: TARGET,
                displayName: 'Lee Gu',
                userPrincipalName: 'lee@example.com',
                mail: 'lee@example.com',
                accountEnabled: true,
                userType: 'Member',
              },
        runner: (job) =>
          job.mode === 'read'
            ? permissions([])
            : {
                mailbox: 'sales@example.com',
                changed: ['SendOnBehalf'],
                skipped: [],
                failed: [],
                verified: true,
              },
      },
    );
    expect(run.first.status).toBe('succeeded');
    expect(writes(run.jobs)[0]!.parameters).toMatchObject({
      mailboxObjectId: OWNER,
      trusteeObjectId: TARGET,
      action: 'add',
    });
    expect(run.first.outputs?.summary).toBe('Lee Gu now has Send on Behalf on sales@example.com.');
    const undo = byId('m365.grant-mailbox-permission').steps.find((s: Def) => s.id === 'grant').compensate
      .parameters;
    expect(undo).toMatchObject({
      mailboxObjectId: '${ steps.owner.output.id }',
      trusteeObjectId: '${ steps.person.output.id }',
    });
  });

  it('m365.remove-mailbox-permission: a group trustee by its group id, and readable permission names', async () => {
    const run = await start(
      'm365.remove-mailbox-permission',
      {
        mailbox: 'sales@example.com',
        trustee: 'sales-team@example.com',
        permission: 'SendOnBehalf',
        reason: 'REQ-2237 team moved to the new inbox',
      },
      {
        graph: (call) =>
          call.path === '/users'
            ? { value: [] }
            : call.path === '/groups'
              ? { value: [{ id: GROUP, displayName: 'Sales team', mail: 'sales-team@example.com' }] }
              : { id: OWNER, displayName: 'Sales', userPrincipalName: 'sales@example.com' },
        runner: (job) =>
          job.mode === 'read'
            ? permissions([
                {
                  permission: 'SendOnBehalf',
                  trustee: 'sales-team@example.com',
                  inherited: false,
                  deny: false,
                },
              ])
            : {
                mailbox: 'sales@example.com',
                changed: ['SendOnBehalf'],
                skipped: [],
                failed: [],
                verified: true,
              },
      },
    );
    expect(run.first.status).toBe('succeeded');
    expect(writes(run.jobs)[0]!.parameters).toMatchObject({
      mailboxObjectId: OWNER,
      trusteeObjectId: GROUP,
      action: 'remove',
    });
    expect(run.first.outputs?.summary).toBe(
      'sales-team@example.com no longer has Send on Behalf on sales@example.com.',
    );
  });
});

describe('inbox rules', () => {
  const rule = (extra: Record<string, unknown>) => ({
    rules: [
      {
        ruleIdentity: '17542359837015228417',
        ruleName: 'Send to home',
        mailbox: 'adele@example.com',
        userPrincipalName: 'adele@example.com',
        ...extra,
      },
    ],
  });
  const graph: Graph = () => ({
    id: OWNER,
    displayName: 'Adele Vance',
    userPrincipalName: 'adele@example.com',
  });

  it('m365.set-inbox-rule passes the mailbox owner id to the script and to the undo', async () => {
    const run = await start(
      'm365.set-inbox-rule',
      {
        mailbox: 'adele@example.com',
        ruleIdentity: '17542359837015228417',
        action: 'Disable',
        reason: 'SEC-512 forwarding to a personal address',
      },
      {
        graph,
        runner: (job) =>
          job.mode === 'read'
            ? rule({ enabled: true, risk: 'high', externalTargets: ['adele.home@fabrikam.example'] })
            : {
                mailbox: 'adele@example.com',
                ruleName: 'Send to home',
                action: 'disable',
                changed: true,
                verified: true,
              },
      },
    );
    expect(run.first.status).toBe('succeeded');
    expect(writes(run.jobs)[0]!.parameters).toMatchObject({ mailboxObjectId: OWNER, action: 'disable' });
    const steps = byId('m365.set-inbox-rule').steps;
    for (const id of ['switchRule', 'removeRule'])
      expect(steps.find((s: Def) => s.id === id).parameters.mailboxObjectId).toBe(
        '${ steps.owner.output.id }',
      );
    expect(steps.find((s: Def) => s.id === 'switchRule').compensate.parameters.mailboxObjectId).toBe(
      '${ steps.owner.output.id }',
    );
  });

  it('m365.set-inbox-rule refuses turning on a rule that forwards outside before anything changes', async () => {
    const run = await start(
      'm365.set-inbox-rule',
      {
        mailbox: 'adele@example.com',
        ruleIdentity: '17542359837015228417',
        action: 'Enable',
        reason: 'SEC-519 user asks for the rule back',
      },
      {
        graph,
        runner: () =>
          rule({ enabled: false, risk: 'high', externalTargets: ['adele.home@fabrikam.example'] }),
      },
    );
    expect(run.first.status).toBe('failed');
    expect(run.first.error).toMatchObject({ stepId: 'notTurningOnOutsideForwarding' });
    expect(run.first.error?.message).toContain('adele.home@fabrikam.example');
    expect(writes(run.jobs)).toEqual([]);
  });

  it('the inbox rule audit never offers "Turn rule on" for a rule that forwards outside', async () => {
    const actions = byId('m365.inbox-rules')
      .layout.find((b: Def) => b.widget === 'table')
      .rowActions.filter((a: Def) => a.playbook === 'm365.set-inbox-rule');
    const shown = async (row: Record<string, unknown>) => {
      const out: string[] = [];
      for (const a of actions) if ((await renderString(a.when, { row })) === true) out.push(a.inputs.action);
      return out;
    };
    const row = {
      mailbox: 'adele@example.com',
      ruleIdentity: '17542359837015228417',
      enabled: false,
      hidden: false,
    };
    expect(await shown({ ...row, risk: 'high' })).toEqual(['Remove']);
    expect(await shown({ ...row, risk: 'medium' })).toEqual(['Enable', 'Remove']);
    expect(await shown({ ...row, risk: 'high', enabled: true })).toEqual(['Disable', 'Remove']);
  });
});

describe('OneDrive access', () => {
  const DRIVE = 'https://example-my.sharepoint.com/personal/adele_example_com';
  const graph: Graph = (call) =>
    call.path.includes(OWNER)
      ? { id: OWNER, displayName: 'Adele Vance', userPrincipalName: 'adele@example.com', userType: 'Member' }
      : {
          id: TARGET,
          displayName: 'Lee Gu',
          userPrincipalName: 'lee@example.com',
          userType: 'Member',
          accountEnabled: true,
        };
  const grant = (answer: Record<string, unknown>) =>
    start(
      'm365.grant-onedrive-access',
      { ownerId: OWNER, granteeId: TARGET, reason: 'Leaver HR-1001 handover' },
      {
        graph,
        runner: (job) =>
          job.mode === 'read'
            ? { owner: 'adele@example.com', oneDriveUrl: DRIVE, exists: true }
            : job.parameters.action === 'add'
              ? {
                  siteUrl: DRIVE,
                  user: 'lee@example.com',
                  action: 'add',
                  administrators: 1,
                  missingAdministrators: [],
                  ...answer,
                }
              : {
                  siteUrl: DRIVE,
                  user: 'lee@example.com',
                  action: 'remove',
                  before: false,
                  after: false,
                  changed: true,
                  verified: true,
                },
      },
    );

  it('passes the owner and grantee ids; an unconfirmed grant this run added is undone with the same ids', async () => {
    const run = await grant({ before: false, after: false, changed: true, verified: false });
    expect(run.first.status).toBe('compensated');
    const [add, undo] = writes(run.jobs);
    const ids = {
      owner: 'adele@example.com',
      ownerObjectId: OWNER,
      user: 'lee@example.com',
      userObjectId: TARGET,
    };
    expect(add!.parameters).toMatchObject({ ...ids, siteUrl: DRIVE, action: 'add' });
    expect(undo!.parameters).toMatchObject({ ...ids, siteUrl: DRIVE, action: 'remove', force: true });
    expect(run.first.error?.message).toContain('check the');
    expect(run.first.error?.message).toContain('in a few minutes');
  });

  it('never takes away access the person already had', async () => {
    const run = await grant({ before: true, after: false, changed: false, verified: false });
    expect(run.first.status).toBe('succeeded');
    expect(writes(run.jobs).map((j) => j.parameters.action)).toEqual(['add']);
  });

  it('m365.remove-onedrive-access passes both ids', async () => {
    const run = await start(
      'm365.remove-onedrive-access',
      { ownerId: OWNER, userId: TARGET, reason: 'HR-1001 handover finished' },
      {
        graph,
        runner: (job) =>
          job.mode === 'read'
            ? { owner: 'adele@example.com', oneDriveUrl: DRIVE, exists: true }
            : {
                siteUrl: DRIVE,
                user: 'lee@example.com',
                action: 'remove',
                before: true,
                after: false,
                changed: true,
                verified: true,
              },
      },
    );
    expect(run.first.status).toBe('succeeded');
    expect(writes(run.jobs)[0]!.parameters).toMatchObject({
      ownerObjectId: OWNER,
      userObjectId: TARGET,
      action: 'remove',
    });
  });
});

describe('identity.leaver', () => {
  const graph: Graph = (call) =>
    call.path.endsWith(OWNER)
      ? {
          id: OWNER,
          displayName: 'Sam Patel',
          userPrincipalName: 's.patel@example.com',
          userType: 'Member',
          accountEnabled: true,
          manager: { id: TARGET, displayName: 'Avery Lee', mail: 'a.lee@example.com' },
        }
      : { value: [] };
  const leave = (extra: Record<string, unknown>) =>
    start(
      'identity.leaver',
      { userId: OWNER, ticket: 'HR-9002', lastWorkingDay: '2026-01-10', ...extra },
      { graph, dryRun: true },
    );

  it('passes the automatic reply to Offboard user', async () => {
    const message = 'Sam has left Example Org. Please write to sales@example.com instead.';
    const run = await leave({ autoReplyMessage: message });
    expect(run.first.status).toBe('succeeded');
    const offboard = run.children.find((c) => c.ref === 'identity.offboard-user');
    expect(offboard?.inputs).toMatchObject({ userId: OWNER, autoReplyMessage: message, ticket: 'HR-9002' });
  });

  it('passes no automatic reply when none was given', async () => {
    const run = await leave({});
    const offboard = run.children.find((c) => c.ref === 'identity.offboard-user');
    expect(offboard).toBeDefined();
    expect(offboard!.inputs.autoReplyMessage ?? '').toBe('');
  });

  it('declares everything its Offboard user step needs', () => {
    const leaver = byId('identity.leaver').requires;
    const child = byId('identity.offboard-user').requires;
    for (const [service, scopes] of Object.entries(child.scopes as Record<string, string[]>))
      expect(leaver.scopes[service]).toEqual(expect.arrayContaining(scopes));
    expect(leaver.entraRoles).toEqual(expect.arrayContaining(child.entraRoles));
  });
});
