import { IdentityUnavailable, VirtualClock, type StepRecord } from '@adminforge/engine';
import { deferred, harness, INITIATOR, playbook, read, tick, write } from './helpers';

const crashRecord = (
  r: Partial<StepRecord> & Pick<StepRecord, 'seq' | 'stepId' | 'path' | 'status'>,
): StepRecord => ({
  type: 'graph',
  attempt: 1,
  actorOid: INITIATOR.oid,
  mode: 'write',
  request: null,
  plan: null,
  output: null,
  error: null,
  msRequestId: null,
  startedAt: new Date('2026-10-15T11:59:00.000Z'),
  endedAt: null,
  ...r,
});

describe('engine: identity parking (§5.6, ADR-010)', () => {
  it('a write step refuses to run unless the actor is armed → awaiting_arm, then resumes on the same step', async () => {
    const h = harness(playbook([read('lookup'), write('disable'), write('revoke')]), { armed: false });
    expect((await h.exec()).status).toBe('awaiting_arm');
    expect(h.status('lookup')).toBe('succeeded');
    expect(h.record('disable')).toMatchObject({ status: 'waiting', error: { code: 'not_armed' } });
    expect(h.outbound.paths()).toEqual(['/users/lookup']);
    h.identity.signIn(INITIATOR, true);
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.paths()).toEqual(['/users/lookup', '/things/disable', '/things/revoke']);
    expect(h.runEvents()).toEqual(['running', 'awaiting_arm', 'running', 'succeeded']);
  });

  it('a lost session parks awaiting_reauth (reads too)', async () => {
    const h = harness(playbook([read('lookup')]));
    h.identity.signOut(INITIATOR);
    expect((await h.exec()).status).toBe('awaiting_reauth');
    h.identity.signIn(INITIATOR);
    expect((await h.exec()).status).toBe('succeeded');
  });

  it('token failures raised during the call (claims challenge, disarm) park instead of failing', async () => {
    let n = 0;
    const h = harness(playbook([write('w')]), {
      respond: () => {
        if (++n === 1) throw new IdentityUnavailable('reauth');
        return null;
      },
    });
    expect((await h.exec()).status).toBe('awaiting_reauth');
    expect(h.record('w')?.status).toBe('waiting');
    expect((await h.exec()).status).toBe('succeeded');
    expect((await h.all()).filter((r) => r.path === 'w')).toHaveLength(1);
  });
});

describe('engine: checkpoint resume after a crash', () => {
  it('does not repeat completed steps', async () => {
    const def = playbook([write('one'), write('two')]);
    const h = harness(def);
    await h.store.saveStep(
      'run-1',
      crashRecord({
        seq: 1,
        stepId: 'one',
        path: 'one',
        status: 'succeeded',
        output: { done: 1 },
        endedAt: new Date(),
      }),
      { actor: INITIATOR, dryRun: false },
    );
    await h.store.updateRun('run-1', { status: 'running', startedAt: h.clock.now() });
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.paths()).toEqual(['/things/two']);
    expect(h.record('two')?.seq).toBe(2);
  });

  it('an in-flight idempotent step is retried as a new attempt', async () => {
    const h = harness(playbook([write('one')]));
    await h.store.saveStep('run-1', crashRecord({ seq: 1, stepId: 'one', path: 'one', status: 'running' }), {
      actor: INITIATOR,
      dryRun: false,
    });
    await h.store.updateRun('run-1', { status: 'running', startedAt: h.clock.now() });
    expect((await h.exec()).status).toBe('succeeded');
    expect((await h.all()).map((r) => [r.seq, r.attempt, r.status, r.error?.code ?? null])).toEqual([
      [1, 1, 'retried', 'interrupted'],
      [2, 2, 'succeeded', null],
    ]);
  });

  it('an in-flight idempotent: false step becomes needs_review and is not retried', async () => {
    const h = harness(playbook([write('tap', { idempotent: false }), write('next')]));
    await h.store.saveStep('run-1', crashRecord({ seq: 1, stepId: 'tap', path: 'tap', status: 'running' }), {
      actor: INITIATOR,
      dryRun: false,
    });
    await h.store.updateRun('run-1', { status: 'running', startedAt: h.clock.now() });
    const out = await h.exec();
    expect(out).toMatchObject({ status: 'needs_review', error: { code: 'needs_review', stepId: 'tap' } });
    expect(h.status('tap')).toBe('needs_review');
    expect(h.outbound.calls).toHaveLength(0);
  });

  it('re-runs read steps whose stored output was truncated (writes are never re-run)', async () => {
    const big = 'x'.repeat(300 * 1024);
    const def = playbook([
      read('list'),
      { id: 'n', type: 'transform', expression: '${ $length(steps.list.output.blob) }' },
    ]);
    const h = harness(def, { respond: () => ({ blob: big }) });
    expect((await h.exec()).status).toBe('succeeded');
    const stored = (await h.all()).find((r) => r.path === 'list' && r.status === 'succeeded')!;
    expect(stored.output).toMatchObject({ $truncated: true, bytes: expect.any(Number) });
    expect(h.record('n')?.output).toBe(big.length); // the run itself used the whole output
  });

  it('a run interrupted during a step resumes in the right place and in order (real crash)', async () => {
    const gate = deferred<unknown>();
    const def = playbook([write('one'), write('two'), write('three')]);
    const h = harness(def, { respond: (c) => (c.path === '/things/two' ? gate.promise : null) });
    const ac = new AbortController();
    const first = h.exec(ac.signal);
    await tick(10);
    expect(h.status('two')).toBe('running');
    ac.abort(); // the worker dies: the in-flight call is abandoned
    gate.reject(new Error('connection reset'));
    await first;
    // A crash leaves the record running (simulate: the cancelled attempt never got saved).
    const recs = await h.all();
    const two = recs.find((r) => r.path === 'two')!;
    await h.store.saveStep(
      'run-1',
      { ...two, status: 'running', endedAt: null },
      { actor: INITIATOR, dryRun: false },
    );
    await h.store.updateRun('run-1', { status: 'running', endedAt: null });
    h.outbound.respond = () => null;
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.paths()).toEqual(['/things/one', '/things/two', '/things/two', '/things/three']);
  });
});

describe('engine: step timeouts', () => {
  it('fails a step that does not finish within its timeout and aborts the call', async () => {
    const clock = new VirtualClock();
    let aborted = false;
    const h = harness(playbook([read('slow', '/slow', { timeout: '30s' })]), {
      engine: { clock },
      respond: (_c, _n, { signal }) =>
        new Promise((_r, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
          setTimeout(() => clock.advance(31_000), 1);
        }),
    });
    const out = await h.exec();
    expect(out).toMatchObject({
      status: 'failed',
      error: { code: 'timeout', stepId: 'slow', message: 'The step did not finish within 30s.' },
    });
    expect(aborted).toBe(true);
    expect(clock.pendingTimers).toBe(0);
  });

  it('leaves no timers behind for steps that finish in time', async () => {
    const clock = new VirtualClock();
    const h = harness(playbook([read('a', '/a', { timeout: '5m' }), read('b')]), { engine: { clock } });
    expect((await h.exec()).status).toBe('succeeded');
    expect(clock.pendingTimers).toBe(0);
  });
});
