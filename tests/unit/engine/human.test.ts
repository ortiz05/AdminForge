import { IMPLICIT_APPROVAL, writesAfter } from '@adminforge/engine';
import { APPROVER, harness, INITIATOR, playbook, read, write } from './helpers';

describe('engine: approvals (ADR-010)', () => {
  const def = playbook([read('lookup'), { id: 'approve', type: 'approval', message: '${ "Approve disabling " & steps.lookup.output.upn }', approvers: ['Playbook.Approver'], minApprovals: 1, expiresIn: 'PT4H' }, write('disable'), write('revoke')]);

  it('parks awaiting_approval with a task, then runs later steps as the approver', async () => {
    const h = harness(def, { respond: (c) => (c.method === 'GET' ? { upn: 'a.lee@example.com' } : null) });
    h.identity.signIn(APPROVER, true);
    expect((await h.exec()).status).toBe('awaiting_approval');
    expect(h.status('approve')).toBe('waiting');
    expect([...h.store.tasks.values()]).toEqual([
      {
        kind: 'approval',
        path: 'approve',
        stepId: 'approve',
        message: 'Approve disabling a.lee@example.com',
        approvers: ['Playbook.Approver'],
        minApprovals: 1,
        expiresAt: new Date(h.clock.now().getTime() + 4 * 3_600_000).toISOString(),
        requestedBy: INITIATOR,
      },
    ]);
    // Re-executing without a decision keeps it parked (no duplicate task, no new calls).
    expect((await h.exec()).status).toBe('awaiting_approval');
    expect(h.store.tasks.size).toBe(1);
    expect(h.outbound.calls).toHaveLength(1);

    h.approve('approve', APPROVER, 'ok by me');
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.record('approve')).toMatchObject({ status: 'succeeded', actorOid: APPROVER.oid, output: { decision: 'approved', approver: { oid: APPROVER.oid, upn: APPROVER.upn }, comment: 'ok by me' } });
    expect(h.outbound.calls.map((c) => [c.call.path, c.identity.actor.oid])).toEqual([
      ['/users/lookup', INITIATOR.oid],
      ['/things/disable', APPROVER.oid],
      ['/things/revoke', APPROVER.oid],
    ]);
    expect(h.record('disable')?.actorOid).toBe(APPROVER.oid);
    expect(h.store.saves.find((s) => s.record.path === 'disable' && s.record.status === 'succeeded')?.actor).toEqual(APPROVER);
    expect(h.runEvents()).toEqual(['running', 'awaiting_approval', 'running', 'awaiting_approval', 'running', 'succeeded']);
  });

  it('parks awaiting_arm when the approver is not armed, and resumes as the approver once armed', async () => {
    const h = harness(def);
    h.identity.signIn(APPROVER, false);
    await h.exec();
    h.approve('approve');
    expect((await h.exec()).status).toBe('awaiting_arm');
    expect(h.record('disable')).toMatchObject({ status: 'waiting', error: { code: 'not_armed' } });
    const seq = h.record('disable')!.seq;
    h.identity.signIn(APPROVER, true);
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.record('disable')).toMatchObject({ status: 'succeeded', seq, actorOid: APPROVER.oid });
  });

  it('approver identity survives a resume (derived from the approval record)', async () => {
    const h = harness(def);
    h.identity.signIn(APPROVER, true);
    await h.exec();
    h.approve('approve');
    h.outbound.respond = (c) => {
      if (c.path === '/things/disable') h.identity.signOut(APPROVER); // approver signs out mid-run
      return null;
    };
    expect((await h.exec()).status).toBe('awaiting_reauth');
    h.identity.signIn(APPROVER, true);
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.calls.at(-1)!.identity.actor.oid).toBe(APPROVER.oid);
  });

  it('a rejection fails the run at the approval step', async () => {
    const h = harness(def);
    await h.exec();
    h.reject('approve', APPROVER, 'not today');
    const out = await h.exec();
    expect(out).toMatchObject({ status: 'failed', error: { code: 'approval_rejected', stepId: 'approve', message: `Rejected by ${APPROVER.upn}: not today` } });
    expect(h.status('disable')).toBeUndefined();
  });

  it('an approval that expires fails the run (approval_expired)', async () => {
    const h = harness(def);
    await h.exec();
    h.clock.advance(4 * 3_600_000 + 1);
    expect((await h.exec()).error).toMatchObject({ code: 'approval_expired' });
  });

  it('time parked on approvals does not count against the 4 h run limit', async () => {
    const h = harness(playbook([{ id: 'approve', type: 'approval' }, read('after')]));
    h.identity.signIn(APPROVER, true);
    await h.exec();
    h.clock.advance(10 * 3_600_000);
    h.approve('approve');
    expect((await h.exec()).status).toBe('succeeded');
  });

  it('automation runs keep the automation identity after an approval (ADR-011)', async () => {
    const h = harness(playbook([{ id: 'approve', type: 'approval' }, write('w')]), { run: { identity: 'automation', initiator: { kind: 'automation', oid: 'automation', upn: 'automation identity' } } });
    await h.exec();
    h.approve('approve');
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.calls[0]!.identity.actor.kind).toBe('automation');
  });

  it('approval: { required: true } adds an implicit gate before the first write', async () => {
    const gated = playbook([read('lookup'), write('w')], { risk: 'critical', confirm: { type: 'click' }, approval: { required: true, minApprovals: 2 } });
    const h = harness(gated);
    expect((await h.exec()).status).toBe('awaiting_approval');
    expect(h.status('lookup')).toBe('succeeded');
    expect(h.status(IMPLICIT_APPROVAL)).toBe('waiting');
    expect([...h.store.tasks.values()][0]).toMatchObject({ path: IMPLICIT_APPROVAL, minApprovals: 2, approvers: ['Playbook.Approver'] });
    h.identity.signIn(APPROVER, true);
    h.approve(IMPLICIT_APPROVAL);
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.calls.at(-1)!.identity.actor.oid).toBe(APPROVER.oid);
    // An explicit approval before the first write replaces the implicit gate.
    const explicit = playbook([{ id: 'ok', type: 'approval' }, write('w')], { risk: 'critical', confirm: { type: 'click' }, approval: { required: true } });
    const e = harness(explicit);
    await e.exec();
    expect([...e.store.tasks.values()].map((t) => t.path)).toEqual(['ok']);
  });

  it('writesAfter tells the API whether an approver must be armed', () => {
    expect(writesAfter(def, 'approve')).toBe(true);
    expect(writesAfter(playbook([write('w'), { id: 'last', type: 'approval' }, read('r')]), 'last')).toBe(false);
    expect(writesAfter(playbook([{ id: 'loop', type: 'forEach', items: '${ [1] }', steps: [write('w'), { id: 'a', type: 'approval' }] }]), 'loop[0].a')).toBe(true);
    expect(writesAfter(playbook([write('w')], { risk: 'critical', confirm: { type: 'click' }, approval: { required: true } }), IMPLICIT_APPROVAL)).toBe(true);
  });
});

describe('engine: manual steps', () => {
  const def = playbook([{ id: 'check', type: 'manual', instructions: 'Call ${ inputs.who }', checklist: ['Verify identity'], inputs: { ticket: { type: 'string' } } }, { id: 'echo', type: 'transform', expression: '${ steps.check.output.values.ticket }' }], {
    inputs: { who: { type: 'string' } },
  });

  it('parks awaiting_input, then continues with the confirmed values', async () => {
    const h = harness(def, { inputs: { who: 'the user' } });
    expect((await h.exec()).status).toBe('awaiting_input');
    expect([...h.store.tasks.values()][0]).toMatchObject({ kind: 'manual', instructions: 'Call the user', checklist: ['Verify identity'] });
    h.store.decide('run-1', 'check', { kind: 'manual', confirmed: true, actor: INITIATOR, notes: 'done', values: { ticket: 'INC-1' }, decidedAt: h.clock.now().toISOString() });
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.record('echo')?.output).toBe('INC-1');
    expect(h.record('check')?.output).toMatchObject({ confirmed: true, notes: 'done', by: { oid: INITIATOR.oid } });
  });

  it('declining fails the step (manual_declined)', async () => {
    const h = harness(def, { inputs: { who: 'x' } });
    await h.exec();
    h.store.decide('run-1', 'check', { kind: 'manual', confirmed: false, actor: INITIATOR, notes: 'no answer', decidedAt: h.clock.now().toISOString() });
    expect((await h.exec()).error).toMatchObject({ code: 'manual_declined', message: `${INITIATOR.upn} did not confirm this step: no answer` });
  });
});

describe('engine: wait steps', () => {
  it('duration: parks with wakeAt (run stays running) and continues once the time has come', async () => {
    const h = harness(playbook([{ id: 'pause', type: 'wait', duration: 'PT15M' }, read('after')]));
    const first = await h.exec();
    expect(first.status).toBe('running');
    expect(first.wakeAt).toEqual(new Date(h.clock.now().getTime() + 15 * 60_000));
    expect((await h.run()).status).toBe('running');
    expect((await h.exec()).wakeAt).toEqual(first.wakeAt); // too early: same wake time
    h.clock.set(first.wakeAt!);
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.record('pause')?.output).toEqual({ waitedMs: 15 * 60_000 });
  });

  it('until: polls the condition every interval and times out', async () => {
    let ready = false;
    const def = playbook([{ id: 'poll', type: 'wait', until: '${ steps.probe.output.ready }', interval: '1m', timeout: '5m' }, read('after')]);
    // The condition reads a previous step; emulate it with a transform fed by a variable.
    const withProbe = playbook([{ id: 'probe', type: 'graph', mode: 'read', request: { method: 'GET', path: '/state' } }, ...def.steps]);
    const h = harness(withProbe, { respond: (c) => (c.path === '/state' ? { ready } : null) });
    let out = await h.exec();
    expect(out.wakeAt).toEqual(new Date(h.clock.now().getTime() + 60_000));
    h.clock.set(out.wakeAt!);
    out = await h.exec();
    expect(out.status).toBe('running');
    ready = true; // the probe output is pinned, so the condition stays false: time out
    for (let i = 0; i < 10 && out.status === 'running'; i++) {
      h.clock.set(out.wakeAt!);
      out = await h.exec();
    }
    expect(out).toMatchObject({ status: 'failed', error: { code: 'wait_timeout', stepId: 'poll' } });

    const quick = harness(playbook([{ id: 'w', type: 'wait', until: '${ true }' }]));
    expect((await quick.exec()).status).toBe('succeeded');
  });
});
