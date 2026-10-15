import type { ChildRunner } from '@adminforge/engine';
import { harness, playbook, read, USER_ID, write } from './helpers';

describe('engine: dry runs (§7.8)', () => {
  const def = playbook(
    [
      read('lookup', `/users/\${ $encode(inputs.userId) }`),
      {
        id: 'reset',
        type: 'graph',
        mode: 'write',
        describe: '${ "Reset the password of " & steps.lookup.output.upn }',
        request: { method: 'PATCH', path: '/users/${ $encode(inputs.userId) }', body: { passwordProfile: { password: '${ inputs.password }', forceChangePasswordNextSignIn: true }, note: 'temp' }, query: { $select: 'id' } },
        dryRunOutput: { id: '${ inputs.userId }', planned: true },
      },
      { id: 'after', type: 'transform', expression: '${ steps.reset.output }' },
      write('revoke'),
    ],
    {
      inputs: { userId: { type: 'string', format: 'guid' }, password: { type: 'string', redact: true } },
      outputs: { reset: '${ steps.reset.output.planned }', revoke: '${ steps.revoke.output }' },
    },
  );

  it('runs reads for real, plans writes with redacted bodies, and uses dryRunOutput (else null)', async () => {
    const h = harness(def, { dryRun: true, armed: false, inputs: { userId: USER_ID, password: 'Sup3r-Secret!' }, respond: () => ({ upn: 'a.lee@example.com' }) });
    const out = await h.exec();
    expect(out).toMatchObject({ status: 'succeeded', outputs: { reset: true } });
    expect(out.outputs).not.toHaveProperty('revoke'); // no dryRunOutput → no output
    expect(h.outbound.calls.map((c) => c.call.method)).toEqual(['GET']);
    expect(h.identity.resolves).toEqual([{ oid: h.identity.resolves[0]!.oid, mode: 'read' }]);
    const plan = await h.plan();
    expect(plan).toEqual([
      {
        stepId: 'reset',
        stepPath: 'reset',
        describe: 'Reset the password of a.lee@example.com',
        service: 'graph',
        method: 'PATCH',
        path: `/users/${USER_ID}`,
        query: { $select: 'id' },
        body: { passwordProfile: { password: '[redacted]', forceChangePasswordNextSignIn: true }, note: 'temp' },
      },
      { stepId: 'revoke', stepPath: 'revoke', describe: 'Write revoke', service: 'graph', method: 'PATCH', path: '/things/revoke', body: { value: 'revoke' } },
    ]);
    expect(h.status('reset')).toBe('planned');
    expect(h.record('reset')?.output).toEqual({ id: USER_ID, planned: true });
    expect(h.record('after')?.output).toEqual({ id: USER_ID, planned: true });
    expect(JSON.stringify(await h.all())).not.toContain('Sup3r-Secret!');
  });

  it('a dry run never needs write access (no awaiting_arm)', async () => {
    const h = harness(playbook([write('w')]), { dryRun: true, armed: false });
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.identity.resolves).toEqual([]);
  });

  it('skips approval, manual and wait steps in dry runs', async () => {
    const h = harness(
      playbook([
        { id: 'approve', type: 'approval', message: 'Go?' },
        { id: 'check', type: 'manual', instructions: 'Look at it' },
        { id: 'pause', type: 'wait', duration: 'PT1H' },
        write('w'),
      ]),
      { dryRun: true },
    );
    expect((await h.exec()).status).toBe('succeeded');
    expect(['approve', 'check', 'pause'].map(h.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(h.store.tasks.size).toBe(0);
    expect((await h.plan()).map((p) => p.stepId)).toEqual(['w']);
  });

  it('plans notify, runner, function, arm and http writes with their own shapes', async () => {
    const h = harness(
      playbook([
        { id: 'tell', type: 'notify', mode: 'write', describe: 'Tell the owner', channel: 'email', to: ['owner@example.com'], subject: 'Heads up', message: 'Done' },
        { id: 'ps', type: 'runner', mode: 'write', describe: 'Convert mailbox', script: 'exchange/Set-Thing.ps1', sha256: 'a'.repeat(64), parameters: { identity: 'x@example.com', password: 'p' }, services: ['exchange'] },
        { id: 'fn', type: 'function', mode: 'write', describe: 'Call HR', connection: 'connections.hr-sync', operation: 'syncUser', body: { id: 1 } },
        { id: 'vm', type: 'arm', mode: 'write', describe: 'Restart', request: { method: 'POST', path: '/subscriptions/s/providers/Microsoft.Web/sites/f/restart', apiVersion: '2023-01-01' } },
        { id: 'hook', type: 'http', mode: 'write', describe: 'Webhook', request: { method: 'POST', url: 'https://hooks.example.com/x', body: { a: 1 } } },
      ]),
      { dryRun: true },
    );
    expect((await h.exec()).status).toBe('succeeded');
    const plan = await h.plan();
    expect(plan.map((p) => [p.stepId, p.service, p.method, p.path])).toEqual([
      ['tell', 'notify', 'SEND', 'email'],
      ['ps', 'runner', 'RUN', 'exchange/Set-Thing.ps1'],
      ['fn', 'function', 'CALL', 'connections.hr-sync/syncUser'],
      ['vm', 'arm', 'POST', '/subscriptions/s/providers/Microsoft.Web/sites/f/restart'],
      ['hook', 'http', 'POST', '/x'],
    ]);
    expect(plan[1]!.body).toEqual({ identity: 'x@example.com', password: '[redacted]' });
    expect(plan[4]!.url).toBe('https://hooks.example.com/x');
    expect(h.outbound.calls).toHaveLength(0);
  });

  it('a write child playbook is planned as one entry, followed by the entries of its own dry run', async () => {
    const children: ChildRunner = {
      run: async (req) => ({
        runId: 'child-1',
        status: 'succeeded',
        outputs: { ok: req.inputs.userId },
        error: null,
        plan: [{ stepId: 'disable', stepPath: 'disable', describe: 'Disable', service: 'graph', method: 'PATCH', path: '/users/u' }],
      }),
    };
    const h = harness(playbook([{ id: 'child', type: 'playbook', mode: 'write', describe: 'Disable', ref: 'identity.disable-user', inputs: { userId: 'u' } }]), {
      dryRun: true,
      engine: { children },
    });
    expect((await h.exec()).status).toBe('succeeded');
    expect(await h.plan()).toEqual([
      { stepId: 'child', stepPath: 'child', describe: 'Disable', service: 'playbook', method: 'RUN', path: 'identity.disable-user', body: { userId: 'u' } },
      { stepId: 'disable', stepPath: 'child>disable', describe: 'Disable', service: 'graph', method: 'PATCH', path: '/users/u', childRunId: 'child-1' },
    ]);
    expect(h.record('child')).toMatchObject({ status: 'planned', output: { runId: 'child-1', outputs: { ok: 'u' } } });
  });

  it('without dry-running children (dryRunChildren: false) a write child step is planned like any write', async () => {
    let called = false;
    const children: ChildRunner = { run: async () => ((called = true), { runId: 'x', status: 'succeeded', outputs: null, error: null, plan: [] }) };
    const h = harness(playbook([{ id: 'child', type: 'playbook', mode: 'write', describe: 'Disable', ref: 'identity.disable-user', dryRunOutput: { ok: true } }]), {
      dryRun: true,
      engine: { children, dryRunChildren: false },
    });
    expect((await h.exec()).status).toBe('succeeded');
    expect(called).toBe(false);
    expect(h.record('child')).toMatchObject({ status: 'planned', output: { ok: true } });
  });
});
