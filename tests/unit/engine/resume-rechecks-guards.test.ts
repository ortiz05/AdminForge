import {
  IdentityUnavailable,
  type Actor,
  type IdentityResolver,
  type ResolvedIdentity,
  type RunRecord,
  type StepRecord,
} from '@adminforge/engine';
import type { Mode } from '@adminforge/connectors';
import { APPROVER, FakeIdentity, harness, INITIATOR, playbook, read, write } from './helpers';

// A run that pauses before a write (an approval, input, write access, a sign-in, a `wait`, a restart) runs the reads,
// transforms and asserts since its last completed write again before it sends that write: the person a session
// number pointed at an hour ago may not be the one it points at now. Writes already done are never sent again, and
// what the run decided (approvals, input, `when`, branch arms, forEach items) stays as recorded.

const SESSION = '/sessions/3';
const OTHER = { userPrincipalName: 'k.osei@example.com' };
const SAME = { userPrincipalName: 'm.chen@example.com' };

/** The AVD sign-out shape: read the session, check it is still the expected person's, then sign it out. */
const signOut = (extra: unknown[] = [], logOff: Record<string, unknown> = {}) =>
  playbook(
    [
      read('lookup', SESSION),
      {
        id: 'sameUser',
        type: 'assert',
        that: "${ $lowercase(steps.lookup.output.userPrincipalName) = 'm.chen@example.com' }",
        message:
          "${ 'That session now belongs to ' & steps.lookup.output.userPrincipalName & '. Nothing was signed out.' }",
      },
      ...extra,
      write('logOff', {
        request: {
          method: 'DELETE',
          path: SESSION,
          headers: { 'x-user': '${ steps.lookup.output.userPrincipalName }' },
        },
        ...logOff,
      }),
    ],
    { mode: 'write' },
  );

/** Answers the session read with whoever `holder.now` says holds it; writes answer null. */
const sessionHolder = () => {
  const holder = { now: SAME as Record<string, unknown> };
  return {
    holder,
    respond: (c: { method: string; path: string }) => (c.method === 'GET' ? holder.now : null),
  };
};

const deletes = (h: ReturnType<typeof harness>) => h.outbound.paths('DELETE');
const reads = (h: ReturnType<typeof harness>) => h.outbound.paths('GET');

describe('engine: a resumed run checks again before its next write', () => {
  it('arming: the session changed hands while the run waited → failed with the assert’s message, nothing sent', async () => {
    const { holder, respond } = sessionHolder();
    const h = harness(signOut(), { armed: false, respond });
    expect((await h.exec()).status).toBe('awaiting_arm');
    expect(h.record('logOff')).toMatchObject({ status: 'waiting', error: { code: 'not_armed' } });

    holder.now = OTHER; // the session number now belongs to someone else
    h.identity.signIn(INITIATOR, true);
    const out = await h.exec();
    expect(out).toMatchObject({
      status: 'failed',
      error: {
        code: 'assertion_failed',
        stepId: 'sameUser',
        message: 'That session now belongs to k.osei@example.com. Nothing was signed out.',
        hint: expect.stringMatching(/paused/),
      },
    });
    expect(deletes(h)).toEqual([]);
    expect(reads(h)).toEqual([SESSION, SESSION]);
    // The write that waited for write access is closed: it was never sent.
    expect(h.record('logOff')).toMatchObject({ status: 'skipped', error: null });
    // The read and the assert ran again as new attempts; the first pass's records are kept.
    const lookups = (await h.all()).filter((r) => r.path === 'lookup');
    expect(lookups.map((r) => [r.status, r.attempt])).toEqual([
      ['succeeded', 1],
      ['succeeded', 2],
    ]);
    expect(h.record('sameUser')).toMatchObject({ status: 'failed', attempt: 2 });
    expect(h.runEvents()).toEqual(['running', 'awaiting_arm', 'running', 'failed']);
    const logs = h.store.events.filter((e) => e.type === 'log').map((e) => String(e.data.message));
    expect(logs.some((m) => /paused.*again/i.test(m))).toBe(true);
  });

  it('arming: the check still holds → the write is sent once, rendered from what was read now', async () => {
    const { holder, respond } = sessionHolder();
    const h = harness(signOut(), { armed: false, respond });
    expect((await h.exec()).status).toBe('awaiting_arm');
    holder.now = { userPrincipalName: 'M.Chen@example.com' }; // same person, other spelling
    h.identity.signIn(INITIATOR, true);
    expect((await h.exec()).status).toBe('succeeded');
    expect(reads(h)).toEqual([SESSION, SESSION]);
    expect(deletes(h)).toEqual([SESSION]);
    expect(h.outbound.calls.at(-1)!.call.headers).toEqual({ 'x-user': 'M.Chen@example.com' });
    // The waiting record became the sent one (same seq), as before.
    const waits = (await h.all()).filter((r) => r.path === 'logOff');
    expect(waits.map((r) => r.status)).toEqual(['succeeded']);
  });

  it('a new sign-in (awaiting_reauth) checks again too', async () => {
    const { holder, respond } = sessionHolder();
    const h = harness(signOut(), { respond });
    let first = true;
    h.outbound.respond = (c) => {
      if (c.method === 'DELETE' && first) {
        first = false;
        throw new IdentityUnavailable('reauth'); // a claims challenge on the write
      }
      return respond(c);
    };
    expect((await h.exec()).status).toBe('awaiting_reauth');
    holder.now = OTHER;
    expect(await h.exec()).toMatchObject({ status: 'failed', error: { stepId: 'sameUser' } });
    expect(deletes(h)).toEqual([SESSION]); // only the attempt the claims challenge refused
    expect(reads(h)).toEqual([SESSION, SESSION]);
  });

  it('approval: the reads before the gate run again as the approver, and a broken check stops the write', async () => {
    const { holder, respond } = sessionHolder();
    const def = signOut([{ id: 'approve', type: 'approval', approvers: ['Playbook.Approver'] }]);
    const h = harness(def, { respond });
    h.identity.signIn(APPROVER, true);
    expect((await h.exec()).status).toBe('awaiting_approval');
    h.identity.signOut(INITIATOR); // the initiator went home: the check must not need them
    holder.now = OTHER;
    h.approve('approve');
    expect(await h.exec()).toMatchObject({ status: 'failed', error: { stepId: 'sameUser' } });
    expect(h.outbound.calls.map((c) => [c.call.method, c.identity.actor.oid])).toEqual([
      ['GET', INITIATOR.oid],
      ['GET', APPROVER.oid],
    ]);
  });

  it('approval: a check that still holds lets the approved write through as the approver', async () => {
    const { respond } = sessionHolder();
    const h = harness(signOut([{ id: 'approve', type: 'approval' }]), { respond });
    h.identity.signIn(APPROVER, true);
    await h.exec();
    h.approve('approve');
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.calls.map((c) => [c.call.method, c.identity.actor.oid])).toEqual([
      ['GET', INITIATOR.oid],
      ['GET', APPROVER.oid],
      ['DELETE', APPROVER.oid],
    ]);
  });

  it('a rejected approval fails at the gate without reading again', async () => {
    const { respond } = sessionHolder();
    const h = harness(signOut([{ id: 'approve', type: 'approval' }]), { respond });
    await h.exec();
    h.reject('approve');
    expect(await h.exec()).toMatchObject({ status: 'failed', error: { code: 'approval_rejected' } });
    expect(reads(h)).toEqual([SESSION]);
  });

  it('manual input (awaiting_input) checks again before the next write', async () => {
    const { holder, respond } = sessionHolder();
    const def = signOut([{ id: 'tell', type: 'manual', instructions: 'Tell them first.' }]);
    const h = harness(def, { respond });
    expect((await h.exec()).status).toBe('awaiting_input');
    holder.now = OTHER;
    h.store.decide('run-1', 'tell', {
      kind: 'manual',
      confirmed: true,
      actor: INITIATOR,
      decidedAt: h.clock.now().toISOString(),
    });
    expect(await h.exec()).toMatchObject({ status: 'failed', error: { stepId: 'sameUser' } });
    expect(deletes(h)).toEqual([]);
  });

  it('a `wait` checks again when it wakes', async () => {
    const { holder, respond } = sessionHolder();
    const h = harness(signOut([{ id: 'pause', type: 'wait', duration: 'PT5M' }]), { respond });
    const parked = await h.exec();
    expect(parked).toMatchObject({ status: 'running', wakeAt: expect.any(Date) });
    holder.now = OTHER;
    h.clock.set(parked.wakeAt!);
    expect(await h.exec()).toMatchObject({ status: 'failed', error: { stepId: 'sameUser' } });
    expect(deletes(h)).toEqual([]);
  });

  it('restart: a write in flight is checked again before it is retried; when the check fails it ends needs_review', async () => {
    const { holder, respond } = sessionHolder();
    const h = harness(signOut(), { respond });
    const at = new Date('2026-10-15T11:59:00.000Z');
    const rec = (r: Partial<StepRecord> & Pick<StepRecord, 'seq' | 'stepId' | 'status'>): StepRecord => ({
      path: r.stepId,
      type: 'graph',
      attempt: 1,
      actorOid: INITIATOR.oid,
      mode: 'read',
      request: null,
      plan: null,
      output: null,
      error: null,
      msRequestId: null,
      startedAt: at,
      endedAt: at,
      ...r,
    });
    for (const r of [
      rec({ seq: 1, stepId: 'lookup', status: 'succeeded', output: SAME }),
      rec({ seq: 2, stepId: 'sameUser', type: 'assert', status: 'succeeded', output: true }),
      rec({ seq: 3, stepId: 'logOff', mode: 'write', status: 'running', endedAt: null }),
    ])
      await h.store.saveStep('run-1', r, { actor: INITIATOR, dryRun: false });
    await h.store.updateRun('run-1', { status: 'running', startedAt: h.clock.now() });
    holder.now = OTHER;
    // The first send may have gone through before the stop (and changed what the check reads): not sent again, and the
    // run doesn't claim nothing happened.
    const out = await h.exec();
    expect(out).toMatchObject({
      status: 'needs_review',
      error: { code: 'needs_review', stepId: 'logOff', details: { check: { stepId: 'sameUser' } } },
    });
    expect(out.error!.message).toBe(
      'Step logOff was in flight when the worker stopped, and the check sameUser before it no longer holds, so it was not sent again — check whether it took effect.',
    );
    expect(h.outbound.calls.map((c) => c.call.method)).toEqual(['GET']);
    expect(h.record('logOff')).toMatchObject({ status: 'needs_review', error: { code: 'needs_review' } });
    expect(h.record('sameUser')).toMatchObject({ status: 'failed', attempt: 2 });
  });

  it('writes already done are never sent again, and the reads before them are not read again', async () => {
    const def = playbook([
      read('first', '/users/first'),
      write('one'),
      read('second', '/users/second'),
      { id: 'check', type: 'assert', that: '${ steps.second.output.ok }', message: 'Second is not ok.' },
      write('two'),
    ]);
    let ok = true;
    const h = harness(def, {
      respond: (c) => {
        if (c.path === '/things/one') h.identity.signIn(INITIATOR, false); // write access lapses after `one`
        return c.method === 'GET' ? { ok } : null;
      },
    });
    expect((await h.exec()).status).toBe('awaiting_arm');
    ok = false;
    h.identity.signIn(INITIATOR, true);
    expect(await h.exec()).toMatchObject({
      status: 'failed',
      error: { stepId: 'check', message: 'Second is not ok.' },
    });
    expect(h.outbound.paths()).toEqual(['/users/first', '/things/one', '/users/second', '/users/second']);
  });

  it('a run that passes its checks again finishes, each write sent once', async () => {
    const def = playbook([
      read('first', '/users/first'),
      write('one'),
      read('second', '/users/second'),
      write('two'),
      write('three'),
    ]);
    const h = harness(def, {
      respond: (c) => {
        if (c.path === '/things/one') h.identity.signIn(INITIATOR, false);
        return null;
      },
    });
    expect((await h.exec()).status).toBe('awaiting_arm');
    h.identity.signIn(INITIATOR, true);
    expect((await h.exec()).status).toBe('succeeded');
    // `second` is read again once, before `two`; `three` follows a write done in this pass, so nothing more is read.
    expect(h.outbound.paths()).toEqual([
      '/users/first',
      '/things/one',
      '/users/second',
      '/users/second',
      '/things/two',
      '/things/three',
    ]);
  });

  it('a forEach of reads before the write is read again, and what is built from it is built again', async () => {
    // The create-user shape: look up each group, gather the privileged ones, assert there are none, then write.
    const def = playbook(
      [
        {
          id: 'groups',
          type: 'forEach',
          items: '${ inputs.ids }',
          as: 'g',
          concurrency: 2,
          steps: [read('lookupGroup', '/groups/${ g }')],
        },
        {
          id: 'privileged',
          type: 'transform',
          expression: '${ [steps.groups.output.outputs.lookupGroup[privileged = true].id] }',
        },
        {
          id: 'none',
          type: 'assert',
          that: '${ $count(steps.privileged.output) = 0 }',
          message: "${ 'Privileged: ' & $join(steps.privileged.output, ', ') }",
        },
        { id: 'approve', type: 'approval' },
        write('create'),
      ],
      { inputs: { ids: { type: 'enum', values: ['g1', 'g2'], multiple: true } } },
    );
    const privileged = new Set<string>();
    const h = harness(def, {
      inputs: { ids: ['g1', 'g2'] },
      respond: (c) => {
        const id = c.path.split('/').pop()!;
        return { id, privileged: privileged.has(id) };
      },
    });
    h.identity.signIn(APPROVER, true);
    expect((await h.exec()).status).toBe('awaiting_approval');
    privileged.add('g2');
    h.approve('approve');
    expect(await h.exec()).toMatchObject({
      status: 'failed',
      error: { stepId: 'none', message: 'Privileged: g2' },
    });
    expect(h.outbound.paths('PATCH')).toEqual([]);
    expect(h.outbound.paths('GET').sort()).toEqual(['/groups/g1', '/groups/g1', '/groups/g2', '/groups/g2']);
  });

  it('inside a loop, only the iteration whose write comes next is checked again', async () => {
    const def = playbook(
      [
        {
          id: 'loop',
          type: 'forEach',
          items: '${ inputs.ids }',
          steps: [
            read('get', '/users/${ item }'),
            { id: 'ok', type: 'assert', that: '${ steps.get.output.ok }', message: "${ item & ' changed' }" },
            write('w', { request: { method: 'PATCH', path: '/things/${ item }' } }),
          ],
        },
      ],
      { inputs: { ids: { type: 'enum', values: ['a', 'b'], multiple: true } } },
    );
    const broken = new Set<string>();
    const h = harness(def, {
      inputs: { ids: ['a', 'b'] },
      respond: (c) => {
        if (c.path === '/things/a') h.identity.signIn(INITIATOR, false);
        return c.method === 'GET' ? { ok: !broken.has(c.path.split('/').pop()!) } : null;
      },
    });
    expect((await h.exec()).status).toBe('awaiting_arm');
    expect(h.outbound.paths()).toEqual(['/users/a', '/things/a', '/users/b']);
    broken.add('b');
    h.identity.signIn(INITIATOR, true);
    expect(await h.exec()).toMatchObject({
      status: 'failed',
      error: { stepId: 'ok', path: 'loop[1].ok', message: 'b changed' },
    });
    expect(h.outbound.paths()).toEqual(['/users/a', '/things/a', '/users/b', '/users/b']);
  });

  it('reads inside a loop are not read again once a write after the loop was sent', async () => {
    const def = playbook(
      [
        { id: 'loop', type: 'forEach', items: '${ inputs.ids }', steps: [read('get', '/users/${ item }')] },
        write('one'),
        write('two'),
      ],
      { inputs: { ids: { type: 'enum', values: ['a', 'b'], multiple: true } } },
    );
    const h = harness(def, {
      inputs: { ids: ['a', 'b'] },
      respond: (c) => {
        if (c.path === '/things/one') h.identity.signIn(INITIATOR, false);
        return null;
      },
    });
    expect((await h.exec()).status).toBe('awaiting_arm');
    h.identity.signIn(INITIATOR, true);
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.paths()).toEqual(['/users/a', '/users/b', '/things/one', '/things/two']);
  });

  it('decisions stay as recorded: a check skipped by `when` stays skipped, the branch taken stays taken', async () => {
    const def = playbook([
      read('lookup', '/users/x'),
      {
        id: 'onlyIfAdmin',
        type: 'assert',
        when: '${ steps.lookup.output.admin }',
        that: '${ false }',
        message: 'Admins are refused.',
      },
      {
        id: 'pick',
        type: 'branch',
        if: '${ steps.lookup.output.admin }',
        then: [write('adminPath')],
        else: [write('userPath')],
      },
    ]);
    let admin = false;
    const h = harness(def, { armed: false, respond: (c) => (c.method === 'GET' ? { admin } : null) });
    expect((await h.exec()).status).toBe('awaiting_arm');
    admin = true;
    h.identity.signIn(INITIATOR, true);
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.status('onlyIfAdmin')).toBe('skipped');
    expect(h.outbound.paths()).toEqual(['/users/x', '/users/x', '/things/userPath']);
  });

  it('an assert with onError: continue keeps its policy when it fails on the second look', async () => {
    const { holder, respond } = sessionHolder();
    const def = playbook([
      read('lookup', SESSION),
      {
        id: 'soft',
        type: 'assert',
        that: '${ steps.lookup.output.userPrincipalName = "m.chen@example.com" }',
        message: 'Someone else holds the session.',
        onError: 'continue',
      },
      write('note'),
    ]);
    const h = harness(def, { armed: false, respond });
    await h.exec();
    holder.now = OTHER;
    h.identity.signIn(INITIATOR, true);
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.status('soft')).toBe('failed');
    expect(h.outbound.paths('PATCH')).toEqual(['/things/note']);
  });

  it('a read run again that needs a new sign-in parks the write it guards, not itself, and checks again later', async () => {
    const { holder, respond } = sessionHolder();
    let refuseReads = false;
    const sessions = new FakeIdentity().signIn(INITIATOR, false);
    const identity: IdentityResolver = {
      async resolve(run: RunRecord, actor: Actor, mode: Mode): Promise<ResolvedIdentity> {
        if (refuseReads && mode === 'read') throw new IdentityUnavailable('reauth');
        return sessions.resolve(run, actor, mode);
      },
    };
    const h = harness(signOut(), { respond, engine: { identity } });
    expect((await h.exec()).status).toBe('awaiting_arm');
    sessions.signIn(INITIATOR, true);
    refuseReads = true;
    expect((await h.exec()).status).toBe('awaiting_reauth');
    expect(h.record('logOff')).toMatchObject({ status: 'waiting', error: { code: 'reauth' } });
    expect(h.record('lookup')).toMatchObject({ status: 'succeeded', attempt: 1 });
    refuseReads = false;
    holder.now = OTHER;
    expect(await h.exec()).toMatchObject({ status: 'failed', error: { stepId: 'sameUser' } });
    expect(deletes(h)).toEqual([]);
  });

  it('a restart in the middle of a second look keeps the first result and looks again', async () => {
    const { holder, respond } = sessionHolder();
    const h = harness(signOut(), { armed: false, respond });
    expect((await h.exec()).status).toBe('awaiting_arm');
    // The next pass was stopped while reading again: its attempt was left in flight.
    const first = h.record('lookup')!;
    await h.store.saveStep(
      'run-1',
      { ...first, seq: 50, attempt: 2, status: 'running', output: null, endedAt: null },
      { actor: INITIATOR, dryRun: false },
    );
    holder.now = OTHER;
    h.identity.signIn(INITIATOR, true);
    expect(await h.exec()).toMatchObject({ status: 'failed', error: { stepId: 'sameUser' } });
    expect(deletes(h)).toEqual([]);
    const lookups = (await h.all()).filter((r) => r.path === 'lookup');
    expect(lookups.map((r) => r.status)).toEqual(['succeeded', 'retried', 'succeeded']);
  });

  it('previews never read twice: a dry run resumed after a sign-in goes on from where it stopped', async () => {
    const def = playbook([read('a', '/users/a'), read('b', '/users/b'), write('w')]);
    const h = harness(def, { dryRun: true });
    let n = 0;
    h.outbound.respond = (c) => {
      if (c.path === '/users/b' && n++ === 0) throw new IdentityUnavailable('reauth');
      return null;
    };
    expect((await h.exec()).status).toBe('awaiting_reauth');
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.paths()).toEqual(['/users/a', '/users/b', '/users/b']);
  });

  it('a check that first runs after the pause, on what was read before it, runs again too', async () => {
    // lookup → approval → sameUser → logOff: sameUser runs fresh after the approval, on the old lookup.
    const { holder, respond } = sessionHolder();
    const def = playbook([
      read('lookup', SESSION),
      { id: 'approve', type: 'approval' },
      {
        id: 'sameUser',
        type: 'assert',
        that: "${ $lowercase(steps.lookup.output.userPrincipalName) = 'm.chen@example.com' }",
        message: 'Someone else holds the session.',
      },
      write('logOff', { request: { method: 'DELETE', path: SESSION } }),
    ]);
    const h = harness(def, { respond });
    h.identity.signIn(APPROVER, true);
    expect((await h.exec()).status).toBe('awaiting_approval');
    holder.now = OTHER;
    h.approve('approve');
    expect(await h.exec()).toMatchObject({ status: 'failed', error: { stepId: 'sameUser' } });
    expect(deletes(h)).toEqual([]);
  });

  it('steps before an approval keep who they ran as (user.*), though reads go out with the approver’s access', async () => {
    const def = playbook([
      { id: 'me', type: 'transform', expression: '${ user.oid }' },
      read('mine', '/users/${ user.oid }'),
      read('whoami', '/me'),
      { id: 'approve', type: 'approval' },
      write('addMe', {
        request: { method: 'POST', path: '/groups/g1/members', body: { id: '${ steps.me.output }' } },
      }),
    ]);
    const h = harness(def);
    h.identity.signIn(APPROVER, true);
    await h.exec();
    h.approve('approve');
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.calls.map((c) => [c.call.method, c.call.path, c.identity.actor.oid])).toEqual([
      ['GET', `/users/${INITIATOR.oid}`, INITIATOR.oid],
      ['GET', '/me', INITIATOR.oid],
      // Read again with the approver's access, for the initiator as before; `/me` would be someone else: kept.
      ['GET', `/users/${INITIATOR.oid}`, APPROVER.oid],
      ['POST', '/groups/g1/members', APPROVER.oid],
    ]);
    expect(h.outbound.calls.at(-1)!.call.body).toEqual({ id: INITIATOR.oid });
  });

  it('a read that is not safe to repeat (idempotent: false) is not run again', async () => {
    const def = playbook([
      read('once', '/things/once', { request: { method: 'POST', path: '/things/once' }, idempotent: false }),
      write('w'),
    ]);
    const h = harness(def, { armed: false });
    expect((await h.exec()).status).toBe('awaiting_arm');
    h.identity.signIn(INITIATOR, true);
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.paths()).toEqual(['/things/once', '/things/w']);
  });

  it('a write retried after a failure that may have taken effect ends needs_review when its check fails', async () => {
    const { holder, respond } = sessionHolder();
    const h = harness(signOut(), { respond });
    const at = new Date('2026-10-15T11:59:00.000Z');
    const base = {
      attempt: 1,
      actorOid: INITIATOR.oid,
      request: null,
      plan: null,
      msRequestId: null,
      startedAt: at,
    };
    for (const r of [
      {
        ...base,
        seq: 1,
        stepId: 'lookup',
        path: 'lookup',
        type: 'graph',
        mode: 'read',
        status: 'succeeded',
        output: SAME,
        error: null,
        endedAt: at,
      },
      {
        ...base,
        seq: 2,
        stepId: 'sameUser',
        path: 'sameUser',
        type: 'assert',
        mode: 'read',
        status: 'succeeded',
        output: true,
        error: null,
        endedAt: at,
      },
      // A 503 (it may still have happened), then the worker stopped during the backoff.
      {
        ...base,
        seq: 3,
        stepId: 'logOff',
        path: 'logOff',
        type: 'graph',
        mode: 'write',
        status: 'retried',
        output: null,
        endedAt: at,
        error: { code: 'HTTP503', message: 'Service unavailable', stepId: 'logOff', path: 'logOff' },
      },
    ] as StepRecord[])
      await h.store.saveStep('run-1', r, { actor: INITIATOR, dryRun: false });
    await h.store.updateRun('run-1', { status: 'running', startedAt: h.clock.now() });
    holder.now = OTHER;
    const out = await h.exec();
    expect(out).toMatchObject({ status: 'needs_review', error: { code: 'needs_review', stepId: 'logOff' } });
    expect(out.error!.message).toMatch(
      /^Step logOff was sent before the run stopped and may have taken effect/,
    );
    expect(deletes(h)).toEqual([]);
  });

  it('write access is checked again after the re-check, before the write goes out', async () => {
    const { respond } = sessionHolder();
    const h = harness(signOut(), { armed: false, respond });
    expect((await h.exec()).status).toBe('awaiting_arm');
    h.identity.signIn(INITIATOR, true);
    h.outbound.respond = (c) => {
      if (c.method === 'GET') h.identity.signIn(INITIATOR, false); // disarmed while the session is read again
      return respond(c);
    };
    expect((await h.exec()).status).toBe('awaiting_arm');
    expect(deletes(h)).toEqual([]);
    expect(h.record('logOff')).toMatchObject({ status: 'waiting', error: { code: 'not_armed' } });
  });
});
