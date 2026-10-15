import { ApiError } from '@adminforge/connectors';
import { backoff, StepError } from '@adminforge/engine';
import { harness, playbook, read, write } from './helpers';

const fail = (status: number, code = `E${status}`) => {
  throw new ApiError(status, code, `failed with ${status}`);
};

describe('engine: retries (transient errors only)', () => {
  it('retries 429/5xx/network with exponential backoff, one record per attempt', async () => {
    let n = 0;
    const h = harness(
      playbook([read('a', '/a', { retry: { max: 3, backoff: 'exponential', delay: '2s' } })]),
      {
        respond: () => (++n < 3 ? fail(n === 1 ? 503 : 0) : { ok: true }),
      },
    );
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.clock.sleeps).toEqual([2000, 4000]);
    expect((await h.all()).map((r) => [r.attempt, r.status])).toEqual([
      [1, 'retried'],
      [2, 'retried'],
      [3, 'succeeded'],
    ]);
    expect(h.store.events.filter((e) => e.type === 'log').map((e) => e.data.message)).toEqual([
      expect.stringMatching(/^Attempt 1 failed \(E503/),
      expect.stringMatching(/^Attempt 2 failed \(E0/),
    ]);
  });

  it('gives up after retry.max and fails the step', async () => {
    const h = harness(playbook([read('a', '/a', { retry: { max: 2, backoff: 'fixed', delay: '1s' } })]), {
      respond: () => fail(500),
    });
    const out = await h.exec();
    expect(out).toMatchObject({ status: 'failed', error: { code: 'E500', status: 500, stepId: 'a' } });
    expect(h.outbound.calls).toHaveLength(3);
    expect(h.clock.sleeps).toEqual([1000, 1000]);
  });

  it('never retries non-transient errors (4xx, assertions, policy)', async () => {
    const h = harness(playbook([read('a', '/a', { retry: { max: 5 } })]), { respond: () => fail(403) });
    expect((await h.exec()).status).toBe('failed');
    expect(h.outbound.calls).toHaveLength(1);
  });

  it('does not retry without a retry policy', async () => {
    const h = harness(playbook([read('a')]), { respond: () => fail(503) });
    expect((await h.exec()).status).toBe('failed');
    expect(h.outbound.calls).toHaveLength(1);
  });

  it('honours Retry-After when longer than the backoff, capped at 5 minutes', () => {
    expect(backoff({ max: 3, backoff: 'exponential' }, 1)).toBe(1000);
    expect(backoff({ max: 3, backoff: 'exponential' }, 3)).toBe(4000);
    expect(backoff({ max: 3, backoff: 'fixed', delay: '10s' }, 3)).toBe(10_000);
    expect(backoff({ max: 3, backoff: 'exponential' }, 1, 30_000)).toBe(30_000);
    expect(backoff({ max: 9, backoff: 'exponential', delay: '1m' }, 9)).toBe(300_000);
    expect(backoff({ max: 1, backoff: 'exponential' }, 1, 3_600_000)).toBe(300_000);
  });

  it('uses Retry-After from a transient StepError', async () => {
    let n = 0;
    const h = harness(playbook([read('a', '/a', { retry: { max: 1 } })]), {
      respond: () => {
        if (++n === 1) throw new StepError('throttled', 'slow down', { transient: true, retryAfterMs: 7000 });
        return 1;
      },
    });
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.clock.sleeps).toEqual([7000]);
  });
});

describe('engine: onError', () => {
  it('fail (default) stops the run at the failing step', async () => {
    const h = harness(playbook([write('a'), write('b'), write('c')]), {
      respond: (c) => (c.path === '/things/b' ? fail(400) : null),
    });
    const out = await h.exec();
    expect(out).toMatchObject({ status: 'failed', error: { stepId: 'b' } });
    expect(h.status('c')).toBeUndefined();
    expect(h.status('a')).toBe('succeeded');
  });

  it('continue records the failure and carries on (status visible to later steps)', async () => {
    const h = harness(
      playbook([
        write('a', { onError: 'continue' }),
        { id: 'seen', type: 'transform', expression: '${ [steps.a.status, steps.a.error.code] }' },
        write('b'),
      ]),
      { respond: (c) => (c.path === '/things/a' ? fail(409, 'Conflict') : null) },
    );
    const out = await h.exec();
    expect(out.status).toBe('succeeded');
    expect(h.status('a')).toBe('failed');
    expect(h.record('seen')?.output).toEqual(['failed', 'Conflict']);
    expect(h.status('b')).toBe('succeeded');
  });

  it('compensate undoes completed steps in reverse order and ends compensated', async () => {
    const comp = (id: string) => ({
      type: 'graph',
      describe: `Undo ${id}`,
      request: { method: 'PATCH', path: `/undo/${id}`, body: { id } },
    });
    const def = playbook([
      write('one', { compensate: comp('one') }),
      write('two'), // no compensate block
      write('three', { compensate: comp('three') }),
      write('four', { onError: 'compensate', compensate: comp('four') }),
    ]);
    const h = harness(def, { respond: (c) => (c.path === '/things/four' ? fail(400) : null) });
    const out = await h.exec();
    expect(out.status).toBe('compensated');
    expect(out.error).toMatchObject({ code: 'E400', stepId: 'four', compensating: false });
    expect(h.outbound.paths()).toEqual([
      '/things/one',
      '/things/two',
      '/things/three',
      '/things/four',
      '/undo/three',
      '/undo/one',
    ]);
    expect(['one', 'two', 'three', 'four'].map(h.status)).toEqual([
      'compensated',
      'succeeded',
      'compensated',
      'failed',
    ]);
    expect(h.record('three#compensate')).toMatchObject({
      status: 'succeeded',
      mode: 'write',
      stepId: 'three',
    });
    expect(h.outbound.calls.at(-1)!.call.declaredWrite).toBe(true);
  });

  it('a failed compensation leaves the run needs_review with the failures listed', async () => {
    const def = playbook([
      write('one', { compensate: { type: 'graph', request: { method: 'PATCH', path: '/undo/one' } } }),
      write('two', { compensate: { type: 'graph', request: { method: 'PATCH', path: '/undo/two' } } }),
      write('boom', { onError: 'compensate' }),
    ]);
    const h = harness(def, {
      respond: (c) => (c.path === '/things/boom' || c.path === '/undo/two' ? fail(400) : null),
    });
    const out = await h.exec();
    expect(out.status).toBe('needs_review');
    expect(out.error?.compensationFailures).toEqual([
      { stepId: 'two', path: 'two', message: 'failed with 400' },
    ]);
    expect(h.outbound.paths()).toContain('/undo/one');
    expect(h.status('one')).toBe('compensated');
    expect(h.status('two')).toBe('succeeded');
  });

  it('compensation in a dry run is planned (compensation: true) and marks steps compensated', async () => {
    const def = playbook([
      read('lookup'),
      write('disable', {
        compensate: {
          type: 'graph',
          describe: 'Re-enable',
          request: { method: 'PATCH', path: '/users/x', body: { accountEnabled: true } },
        },
      }),
      { id: 'check', type: 'assert', that: '${ false }', message: 'nope', onError: 'compensate' },
    ]);
    const h = harness(def, { dryRun: true });
    expect((await h.exec()).status).toBe('compensated');
    const plan = await h.plan();
    expect(plan.map((p) => [p.stepId, p.method, p.path, p.compensation ?? false, p.describe])).toEqual([
      ['disable', 'PATCH', '/things/disable', false, 'Write disable'],
      ['disable', 'PATCH', '/users/x', true, 'Re-enable'],
    ]);
    expect(h.status('disable')).toBe('compensated');
  });

  it('compensation that needs write access parks the run (awaiting_arm) and finishes after re-arming', async () => {
    const def = playbook([
      write('one', { compensate: { type: 'graph', request: { method: 'PATCH', path: '/undo/one' } } }),
      write('two', { onError: 'compensate' }),
    ]);
    const h = harness(def);
    h.outbound.respond = (c) => {
      if (c.path === '/things/two') {
        h.identity.signIn({ kind: 'delegated', oid: h.identity.resolves[0]!.oid, upn: null }, false); // disarmed meanwhile
        return fail(400);
      }
      return null;
    };
    expect((await h.exec()).status).toBe('awaiting_arm');
    expect((await h.run()).error?.compensating).toBe(true);
    h.identity.signIn({ kind: 'delegated', oid: h.identity.resolves[0]!.oid, upn: null }, true);
    expect((await h.exec()).status).toBe('compensated');
    expect(h.outbound.paths()).toEqual(['/things/one', '/things/two', '/undo/one']);
  });
});
