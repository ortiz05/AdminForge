import { ApiError } from '@adminforge/connectors';
import { DEFAULT_LIMITS, isParked, isTerminal } from '@adminforge/engine';
import { harness, INITIATOR, playbook, read, runbook, USER_ID, write } from './helpers';

describe('engine: run lifecycle', () => {
  it('queued → running → succeeded, executing steps in order with outputs and expressions', async () => {
    const def = playbook(
      [
        read('lookup', `/users/\${ $encode(inputs.userId) }`),
        { id: 'shape', type: 'transform', expression: '${ { "upn": steps.lookup.output.upn, "by": user.upn, "run": run.id } }' },
        write('disable', { request: { method: 'PATCH', path: '/users/${ $encode(inputs.userId) }', body: { accountEnabled: false } } }),
      ],
      { inputs: { userId: { type: 'string', format: 'guid' } }, outputs: { summary: '${ "Disabled " & steps.shape.output.upn }' } },
    );
    const h = harness(def, { inputs: { userId: USER_ID }, respond: (c) => (c.method === 'GET' ? { upn: 'a.lee@example.com' } : null) });
    const out = await h.exec();
    expect(out).toMatchObject({ status: 'succeeded', outputs: { summary: 'Disabled a.lee@example.com' } });
    expect(h.outbound.calls.map((c) => `${c.call.method} ${c.call.path}`)).toEqual([`GET /users/${USER_ID}`, `PATCH /users/${USER_ID}`]);
    expect(h.outbound.calls[1]!.call).toMatchObject({ service: 'graph', declaredWrite: true, body: { accountEnabled: false } });
    expect(h.outbound.calls[0]!.call.declaredWrite).toBeUndefined();
    expect(h.record('shape')?.output).toEqual({ upn: 'a.lee@example.com', by: INITIATOR.upn, run: 'run-1' });
    expect(h.runEvents()).toEqual(['running', 'succeeded']);
    const run = await h.run();
    expect(run.status).toBe('succeeded');
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(run.endedAt).toBeInstanceOf(Date);
    expect([...h.latest().values()].map((r) => [r.path, r.status, r.actorOid])).toEqual([
      ['lookup', 'succeeded', INITIATOR.oid],
      ['shape', 'succeeded', INITIATOR.oid],
      ['disable', 'succeeded', INITIATOR.oid],
    ]);
    expect(h.record('disable')).toMatchObject({ msRequestId: 'req-2', mode: 'write', request: { method: 'PATCH', path: `/users/${USER_ID}` } });
  });

  it('checkpoints every step: running is saved before the call, the result after', async () => {
    const def = playbook([read('a')]);
    const h = harness(def);
    let seenRunning = false;
    h.outbound.respond = async () => {
      seenRunning = h.store.latest('run-1').get('a')?.status === 'running';
      return 1;
    };
    await h.exec();
    expect(seenRunning).toBe(true);
    expect(h.store.saves.filter((s) => s.record.path === 'a').map((s) => s.record.status)).toEqual(['running', 'succeeded']);
  });

  it('is idempotent on terminal runs and refuses unknown runs', async () => {
    const h = harness(playbook([read('a')]));
    await h.exec();
    const calls = h.outbound.calls.length;
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.calls.length).toBe(calls);
    await expect(h.engine.execute('nope', playbook([read('a')]))).rejects.toThrow(/not found/);
  });

  it('does not start a run that was cancelled while queued', async () => {
    const h = harness(playbook([read('a')]));
    await h.store.updateRun('run-1', { status: 'cancelled' });
    expect((await h.exec()).status).toBe('cancelled');
    expect(h.outbound.calls).toHaveLength(0);
  });

  it('stops before the next step when the run is cancelled meanwhile', async () => {
    const def = playbook([read('a'), read('b')]);
    const h = harness(def);
    h.outbound.respond = async (c) => {
      if (c.path === '/users/a') {
        await h.store.updateRun('run-1', { status: 'cancelled' });
        h.clock.advance(5_000); // past the cancel-check throttle
      }
      return null;
    };
    const out = await h.exec();
    expect(out.status).toBe('cancelled');
    expect(h.outbound.paths()).toEqual(['/users/a']);
    expect(h.status('b')).toBeUndefined();
  });

  it('aborting the signal cancels the in-flight step', async () => {
    const def = playbook([read('slow'), read('next')]);
    const ac = new AbortController();
    const h = harness(def, {
      respond: (_c, _n, { signal }) =>
        new Promise((_r, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(() => ac.abort(), 1);
        }),
    });
    const out = await h.exec(ac.signal);
    expect(out.status).toBe('cancelled');
    expect(h.status('slow')).toBe('cancelled');
    expect(h.status('next')).toBeUndefined();
    expect((await h.run()).status).toBe('cancelled');
  });

  it('skips steps whose when is false and exposes their status', async () => {
    const def = playbook([
      read('a', '/a', { when: false }),
      read('b', '/b', { when: '${ inputs.go }' }),
      { id: 'c', type: 'transform', expression: '${ [steps.a.status, steps.b.status] }' },
    ], { inputs: { go: { type: 'boolean' } } });
    const h = harness(def, { inputs: { go: false } });
    await h.exec();
    expect(h.status('a')).toBe('skipped');
    expect(h.status('b')).toBe('skipped');
    expect(h.record('c')?.output).toEqual(['skipped', 'skipped']);
    expect(h.outbound.calls).toHaveLength(0);
  });

  it('fails the run on an assertion with failedStep and message', async () => {
    const def = playbook([read('lookup'), { id: 'guard', type: 'assert', that: '${ steps.lookup.output.enabled = true }', message: '${ steps.lookup.output.upn & " is already disabled." }' }, write('disable')]);
    const h = harness(def, { respond: () => ({ enabled: false, upn: 'x@example.com' }) });
    const out = await h.exec();
    expect(out.status).toBe('failed');
    expect(out.error).toMatchObject({ code: 'assertion_failed', stepId: 'guard', message: 'x@example.com is already disabled.' });
    expect(h.status('disable')).toBeUndefined();
  });

  it('fails a step whose expression cannot be evaluated', async () => {
    const def = playbook([{ id: 'bad', type: 'transform', expression: '${ $number("abc") + 1 }' }]);
    const out = await harness(def).exec();
    expect(out).toMatchObject({ status: 'failed', error: { code: 'expression_error', stepId: 'bad' } });
  });

  it('fails the run when the definition exceeds the step limit', async () => {
    const steps = Array.from({ length: DEFAULT_LIMITS.maxSteps + 1 }, (_, i) => ({ id: `t${i}`, type: 'transform', expression: '${ 1 }' }));
    const out = await harness(playbook(steps)).exec();
    expect(out).toMatchObject({ status: 'failed', error: { code: 'limit_exceeded' } });
  });

  it('fails the run when it exceeds the run-time limit (4 h by default)', async () => {
    const def = playbook([read('a'), read('b')]);
    const h = harness(def);
    h.outbound.respond = () => {
      h.clock.advance(4 * 3_600_000 + 1);
      return null;
    };
    const out = await h.exec();
    expect(out).toMatchObject({ status: 'failed', error: { code: 'run_timeout' } });
    expect(h.status('b')).toBeUndefined();
  });

  it('records outputs as $error when the outputs block cannot render (the run still succeeded)', async () => {
    const out = await harness(playbook([read('a')], { outputs: { x: '${ $number("nope") }' } })).exec();
    expect(out.status).toBe('succeeded');
    expect(out.outputs).toHaveProperty('$error');
  });

  it('runs runbook sections in order like one step list', async () => {
    const def = runbook([
      { id: 'triage', title: 'Triage', body: 'Look first', steps: [read('one')] },
      { id: 'contain', title: 'Contain', steps: [write('two')] },
    ]);
    const h = harness(def);
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.paths()).toEqual(['/users/one', '/things/two']);
  });

  it('exposes env, now and user in expressions', async () => {
    const def = playbook([{ id: 'x', type: 'transform', expression: '${ [env.AF_PRIMARY_DOMAIN, now, user.oid, user.roles[0], $count(user.roles)] }' }]);
    const h = harness(def, { engine: { env: { AF_PRIMARY_DOMAIN: 'example.com' }, rolesOf: () => ['Portal.Operator'] } });
    await h.exec();
    expect(h.record('x')?.output).toEqual(['example.com', h.clock.now().toISOString(), INITIATOR.oid, 'Portal.Operator', 1]);
  });

  it('classifies statuses', () => {
    expect(isTerminal('compensated')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isParked('awaiting_arm')).toBe(true);
    expect(isParked('queued')).toBe(false);
  });

  it('a failed upstream call carries status and request id into the run error', async () => {
    const h = harness(playbook([read('a')]), {
      respond: () => {
        throw new ApiError(404, 'Request_ResourceNotFound', 'User not found', 'req-404');
      },
    });
    const out = await h.exec();
    expect(out.error).toMatchObject({ code: 'Request_ResourceNotFound', status: 404, requestId: 'req-404', stepId: 'a' });
  });
});
