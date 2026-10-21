import { RunInterrupted, type AutomationDefinition } from '@adminforge/engine';
import { deferred, harness, playbook, tick, write } from './helpers';

// D-01: a shutdown or a lost run lock interrupts a run instead of cancelling it. The run and the step in flight stay
// `running` (nothing is written over them), and the next execute continues from the last checkpoint: an interrupted
// idempotent step is retried, an `idempotent: false` one ends `needs_review`. A person's cancel is a plain abort and
// still ends the run `cancelled` (state.test.ts).

/** A responder that hangs on `path` until the step's signal aborts (then rejects with the signal's reason). */
const hangOn =
  (path: string, onStart: () => void) =>
  (c: { path: string }, _n: number, { signal }: { signal: AbortSignal }) => {
    if (c.path !== path) return null;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
      onStart();
    });
  };

const run = (
  h: ReturnType<typeof harness>,
  def: AutomationDefinition,
  opts: Parameters<typeof h.engine.execute>[2],
) => h.engine.execute('run-1', def, opts);

describe('engine: interrupted runs resume (D-01)', () => {
  it('a shutdown during a step leaves the run and the step running; the next execute retries the step', async () => {
    const def = playbook([write('one'), write('two'), write('three')]);
    const ac = new AbortController();
    const h = harness(def, {
      respond: hangOn('/things/two', () => setTimeout(() => ac.abort(new RunInterrupted('shutdown')), 1)),
    });
    const out = await run(h, def, { signal: ac.signal });
    expect(out).toEqual({ status: 'running' });
    const stopped = await h.run();
    expect(stopped.status).toBe('running');
    expect(stopped.endedAt).toBeFalsy();
    expect([h.status('one'), h.status('two'), h.status('three')]).toEqual([
      'succeeded',
      'running',
      undefined,
    ]);
    expect(h.runEvents()).toEqual(['running']); // never `cancelled`

    h.outbound.respond = () => null;
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.paths()).toEqual(['/things/one', '/things/two', '/things/two', '/things/three']);
    const two = (await h.all()).filter((r) => r.path === 'two');
    expect(two.map((r) => [r.status, r.attempt])).toEqual([
      ['retried', 1],
      ['succeeded', 2],
    ]);
    expect(two[0]!.error).toMatchObject({ code: 'interrupted' });
  });

  it('an interrupted idempotent: false step is not sent again: the run ends needs_review', async () => {
    const def = playbook([write('tap', { idempotent: false }), write('next')]);
    const ac = new AbortController();
    const h = harness(def, {
      respond: hangOn('/things/tap', () => setTimeout(() => ac.abort(new RunInterrupted('shutdown')), 1)),
    });
    expect((await run(h, def, { signal: ac.signal })).status).toBe('running');
    expect(h.status('tap')).toBe('running');

    const out = await h.exec();
    expect(out).toMatchObject({ status: 'needs_review', error: { code: 'needs_review', stepId: 'tap' } });
    expect(h.status('tap')).toBe('needs_review');
    expect(h.status('next')).toBeUndefined();
    expect(h.outbound.paths()).toEqual(['/things/tap']);
  });

  it('a graceful stop lets the step in flight finish and stops before the next one: nothing is repeated', async () => {
    const def = playbook([write('tap', { idempotent: false }), write('next')]);
    const drain = new AbortController();
    const h = harness(def, {
      respond: (c) => {
        if (c.path === '/things/tap') drain.abort(); // the stop arrives while `tap` is in flight
        return null;
      },
    });
    expect(await run(h, def, { interrupt: drain.signal })).toEqual({ status: 'running' });
    expect([h.status('tap'), h.status('next')]).toEqual(['succeeded', undefined]);
    expect((await h.run()).status).toBe('running');
    expect(h.store.events.some((e) => e.type === 'log' && /continues/.test(String(e.data.message)))).toBe(
      true,
    );

    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.paths()).toEqual(['/things/tap', '/things/next']);
    expect(h.status('tap')).toBe('succeeded');
  });

  it('a graceful stop cuts a retry backoff short; the next execute makes the next attempt', async () => {
    const def = playbook([write('flaky', { retry: { max: 3, delay: '30s' } })]);
    const drain = new AbortController();
    let calls = 0;
    const h = harness(def, {
      respond: () => {
        if (++calls > 1) return null;
        drain.abort();
        throw Object.assign(new Error('Service busy'), { transient: true });
      },
    });
    expect((await run(h, def, { interrupt: drain.signal })).status).toBe('running');
    expect(h.status('flaky')).toBe('retried');
    expect(h.clock.sleeps).toEqual([]);

    expect((await h.exec()).status).toBe('succeeded');
    expect((await h.all()).map((r) => [r.status, r.attempt])).toEqual([
      ['retried', 1],
      ['succeeded', 2],
    ]);
  });

  it('a stopped forEach keeps finished items and runs only the rest on resume', async () => {
    const def = playbook(
      [
        {
          id: 'loop',
          type: 'forEach',
          items: '${ inputs.ids }',
          steps: [
            {
              id: 'set',
              type: 'graph',
              mode: 'write',
              describe: 'Set',
              request: { method: 'PATCH', path: '/things/${ item }', body: {} },
            },
          ],
        },
      ],
      { inputs: { ids: { type: 'enum', values: ['a', 'b', 'c', 'd'], multiple: true } } },
    );
    const drain = new AbortController();
    const h = harness(def, {
      inputs: { ids: ['a', 'b', 'c', 'd'] },
      respond: (c) => {
        if (c.path === '/things/b') drain.abort();
        return null;
      },
    });
    expect((await run(h, def, { interrupt: drain.signal })).status).toBe('running');
    expect(h.status('loop')).toBe('running');
    expect(h.outbound.paths()).toEqual(['/things/a', '/things/b']);

    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.paths()).toEqual(['/things/a', '/things/b', '/things/c', '/things/d']);
    expect((h.record('loop')?.output as unknown[]).length).toBe(4);
  });

  it('after a lost lock nothing is written: a late result is dropped and the run is never cancelled', async () => {
    const def = playbook([write('one'), write('two')]);
    const ac = new AbortController();
    const late = deferred<unknown>();
    const h = harness(def, { respond: (c) => (c.path === '/things/one' ? late.promise : null) });
    const pending = run(h, def, { signal: ac.signal });
    await tick(10);
    expect(h.status('one')).toBe('running');
    // This worker stalled past its lease; another one took the run over and finished it.
    ac.abort(new RunInterrupted('lock_lost'));
    await h.store.updateRun('run-1', { status: 'succeeded', endedAt: h.clock.now() });
    const saves = h.store.saves.length;
    const events = h.store.events.length;
    late.resolve({ id: 'late' }); // the stalled call returns anyway (it ignored the abort)
    expect((await pending).status).toBe('running');
    expect(h.store.saves.length).toBe(saves);
    expect(h.store.events.length).toBe(events);
    expect((await h.run()).status).toBe('succeeded');
    expect(h.status('two')).toBeUndefined();
  });

  it('after a lost lock, items still in flight in a loop record nothing either', async () => {
    const def = playbook(
      [
        {
          id: 'loop',
          type: 'forEach',
          items: '${ inputs.ids }',
          concurrency: 2,
          steps: [
            {
              id: 'set',
              type: 'graph',
              mode: 'write',
              describe: 'Set',
              request: { method: 'PATCH', path: '/things/${ item }', body: {} },
            },
          ],
        },
        write('after'),
      ],
      { inputs: { ids: { type: 'enum', values: ['a', 'b', 'c'], multiple: true } } },
    );
    const ac = new AbortController();
    const late = deferred<unknown>();
    const h = harness(def, { inputs: { ids: ['a', 'b', 'c'] }, respond: () => late.promise });
    const pending = run(h, def, { signal: ac.signal });
    await tick(10);
    expect(h.outbound.inFlight).toBe(2);
    ac.abort(new RunInterrupted('lock_lost'));
    const saves = h.store.saves.length;
    const events = h.store.events.length;
    late.resolve({ ok: true }); // both stalled calls answer anyway
    expect((await pending).status).toBe('running');
    expect([h.store.saves.length, h.store.events.length]).toEqual([saves, events]);
    expect(h.outbound.paths()).toEqual(['/things/a', '/things/b']);
    expect((await h.run()).status).toBe('running');
  });

  it('a lock lost while a finished step is being recorded: the record and the run are left alone', async () => {
    const def = playbook([write('tap', { secretOutputs: ['password'] }), write('next')]);
    const ac = new AbortController();
    let savesAtLoss = -1;
    const h = harness(def, {
      respond: () => ({ password: 'Synthetic-Secret-1' }),
      engine: {
        secrets: {
          // The lock lapses while the secret is being handed over, after the call came back.
          deliver: async () => {
            savesAtLoss = h.store.saves.length;
            ac.abort(new RunInterrupted('lock_lost'));
            return { status: 'held' };
          },
        },
      },
    });
    expect((await run(h, def, { signal: ac.signal })).status).toBe('running');
    expect(h.store.saves.length).toBe(savesAtLoss);
    expect(h.status('tap')).toBe('running');
    expect(h.status('next')).toBeUndefined();
    expect(h.runEvents()).toEqual(['running']);
  });

  it('a shutdown during compensation continues the compensation on resume', async () => {
    const undo = (id: string) => ({
      type: 'graph',
      describe: `Undo ${id}`,
      request: { method: 'DELETE', path: `/things/${id}` },
    });
    const def = playbook(
      [
        write('one', { compensate: undo('one') }),
        write('two', { compensate: undo('two') }),
        write('boom', { onError: 'compensate' }),
      ],
      {},
    );
    const ac = new AbortController();
    const h = harness(def, {
      respond: (c, _n, opts) => {
        if (c.path === '/things/boom') throw new Error('Graph said no');
        if (c.method === 'DELETE' && c.path === '/things/two')
          return hangOn('/things/two', () => setTimeout(() => ac.abort(new RunInterrupted('shutdown')), 1))(
            c,
            0,
            opts,
          );
        return null;
      },
    });
    expect((await run(h, def, { signal: ac.signal })).status).toBe('running');
    expect((await h.run()).error).toMatchObject({ compensating: true });

    h.outbound.respond = (c) => {
      if (c.path === '/things/boom') throw new Error('Graph said no');
      return null;
    };
    expect((await h.exec()).status).toBe('compensated');
    expect(h.outbound.paths('DELETE')).toEqual(['/things/two', '/things/two', '/things/one']);
  });

  it('RunInterrupted says why, and whether this worker still owns the run', () => {
    const shutdown = new RunInterrupted('shutdown');
    expect(shutdown).toBeInstanceOf(Error);
    expect(shutdown.owned).toBe(true);
    expect(shutdown.message).toMatch(/continues/);
    expect(new RunInterrupted('lock_lost').owned).toBe(false);
    expect(RunInterrupted.from(AbortSignal.abort(shutdown))).toBe(shutdown);
    expect(RunInterrupted.from(AbortSignal.abort())).toBeNull();
    expect(RunInterrupted.from(new AbortController().signal)).toBeNull();
    expect(RunInterrupted.from(shutdown)).toBe(shutdown);
  });
});
