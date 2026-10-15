import { ApiError } from '@adminforge/connectors';
import { deferred, harness, playbook, read, tick, write } from './helpers';

const items = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);

describe('engine: forEach', () => {
  it('runs the body per item with item/index (or the `as` name) in scope, and collects per-item results', async () => {
    const def = playbook([
      {
        id: 'loop',
        type: 'forEach',
        items: '${ inputs.users }',
        as: 'user',
        steps: [
          { id: 'get', type: 'graph', mode: 'read', request: { method: 'GET', path: '/users/${ $encode(user) }' } },
          { id: 'tag', type: 'transform', expression: '${ steps.get.output.path & "#" & $string(index) }' },
        ],
      },
      { id: 'after', type: 'transform', expression: '${ steps.loop.output.outputs.tag }' },
    ], { inputs: { users: { type: 'user', multiple: true } } });
    const h = harness(def, { inputs: { users: ['a@example.com', 'b@example.com'] } });
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.record('loop')?.output).toEqual([
      { index: 0, item: 'a@example.com', status: 'succeeded', outputs: { get: { path: '/users/a%40example.com' }, tag: '/users/a%40example.com#0' } },
      { index: 1, item: 'b@example.com', status: 'succeeded', outputs: { get: { path: '/users/b%40example.com' }, tag: '/users/b%40example.com#1' } },
    ]);
    expect(h.record('after')?.output).toEqual(['/users/a%40example.com#0', '/users/b%40example.com#1']);
    expect([...h.latest().keys()]).toEqual(['loop', 'loop[0].get', 'loop[0].tag', 'loop[1].get', 'loop[1].tag', 'after']);
    expect(h.store.events.filter((e) => e.type === 'progress').map((e) => e.data)).toEqual([
      { path: 'loop', done: 1, total: 2 },
      { path: 'loop', done: 2, total: 2 },
    ]);
  });

  it('keeps at most `concurrency` items in flight, and never more than 10', async () => {
    for (const [requested, expected] of [
      [1, 1],
      [4, 4],
    ] as const) {
      const gate = deferred();
      const h = harness(playbook([{ id: 'loop', type: 'forEach', items: '${ inputs.ids }', concurrency: requested, steps: [read('get', '/users/${ item }')] }], { inputs: { ids: { type: 'enum', values: items(30), multiple: true } } }), {
        inputs: { ids: items(30) },
        respond: async () => {
          await gate.promise;
          return null;
        },
      });
      const running = h.exec();
      await tick(20);
      expect(h.outbound.inFlight).toBe(expected);
      gate.resolve();
      expect((await running).status).toBe('succeeded');
      expect(h.outbound.maxInFlight).toBe(expected);
      expect(h.outbound.calls).toHaveLength(30);
    }
    const h = harness(playbook([{ id: 'loop', type: 'forEach', items: '${ inputs.ids }', concurrency: 10, steps: [read('get', '/users/${ item }')] }], { inputs: { ids: { type: 'enum', values: items(40), multiple: true } } }), {
      inputs: { ids: items(40) },
      engine: { limits: { maxConcurrency: 10 } },
      respond: async () => {
        await tick(2);
        return null;
      },
    });
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.maxInFlight).toBeLessThanOrEqual(10);
  });

  it('refuses more items than maxItems (and never more than 1000)', async () => {
    const tooMany = playbook([{ id: 'loop', type: 'forEach', items: '${ [1..20] }', maxItems: 10, steps: [read('get')] }]);
    expect((await harness(tooMany).exec()).error).toMatchObject({ code: 'limit_exceeded', stepId: 'loop' });
    const huge = playbook([{ id: 'loop', type: 'forEach', items: '${ [1..1001] }', steps: [{ id: 't', type: 'transform', expression: '${ 1 }' }] }]);
    expect((await harness(huge).exec()).error).toMatchObject({ code: 'limit_exceeded', message: expect.stringMatching(/1001 items; the limit is 1000/) });
  });

  it('treats null items as an empty list and rejects non-lists', async () => {
    const empty = harness(playbook([{ id: 'loop', type: 'forEach', items: '${ inputs.nothing }', steps: [read('get')] }]));
    expect((await empty.exec()).status).toBe('succeeded');
    expect(empty.record('loop')?.output).toEqual([]);
    const bad = harness(playbook([{ id: 'loop', type: 'forEach', items: '${ "text" }', steps: [read('get')] }]));
    expect((await bad.exec()).error).toMatchObject({ code: 'invalid_items' });
  });

  it('stops launching items after a failure (onError fail) and fails the run at the inner step', async () => {
    const def = playbook([{ id: 'loop', type: 'forEach', items: '${ [1,2,3,4] }', steps: [write('w', { request: { method: 'PATCH', path: '/things/${ item }' } })] }]);
    const h = harness(def, {
      respond: (c) => {
        if (c.path === '/things/2') throw new ApiError(400, 'Bad', 'bad item');
        return null;
      },
    });
    const out = await h.exec();
    expect(out).toMatchObject({ status: 'failed', error: { stepId: 'w', path: 'loop[1].w', code: 'Bad' } });
    expect(h.outbound.paths()).toEqual(['/things/1', '/things/2']);
    expect(h.status('loop')).toBe('failed');
  });

  it('onError: continue on the loop keeps going and reports failed items', async () => {
    const def = playbook([
      { id: 'loop', type: 'forEach', items: '${ [1,2,3] }', onError: 'continue', steps: [write('w', { request: { method: 'PATCH', path: '/things/${ item }' } })] },
      { id: 'count', type: 'transform', expression: '${ $count(steps.loop.output[status = "failed"]) }' },
    ]);
    const h = harness(def, {
      respond: (c) => {
        if (c.path === '/things/2') throw new ApiError(400, 'Bad', 'bad item');
        return null;
      },
    });
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.paths()).toEqual(['/things/1', '/things/2', '/things/3']);
    expect(h.status('loop')).toBe('failed');
    expect(h.record('loop')?.error).toMatchObject({ code: 'items_failed', message: '1 of 3 items failed.' });
    expect(h.record('count')?.output).toBe(1);
  });

  it('compensates completed iterations in reverse order with each iteration’s item', async () => {
    const def = playbook([
      {
        id: 'loop',
        type: 'forEach',
        items: '${ ["a","b","c"] }',
        steps: [write('add', { request: { method: 'POST', path: '/groups/g/members/${ item }' }, compensate: { type: 'graph', request: { method: 'DELETE', path: '/groups/g/members/${ item }' } } })],
      },
      write('final', { onError: 'compensate' }),
    ]);
    const h = harness(def, { respond: (c) => (c.path === '/things/final' ? (() => { throw new ApiError(500, 'X', 'boom'); })() : null) });
    expect((await h.exec()).status).toBe('compensated');
    expect(h.outbound.calls.filter((c) => c.call.method === 'DELETE').map((c) => c.call.path)).toEqual(['/groups/g/members/c', '/groups/g/members/b', '/groups/g/members/a']);
  });

  it('branch: takes then/else once, marks the other side skipped, and survives resume', async () => {
    const def = playbook([
      read('lookup'),
      { id: 'decide', type: 'branch', if: '${ steps.lookup.output.enabled }', then: [write('disable')], else: [{ id: 'note', type: 'transform', expression: '${ "already" }' }] },
      { id: 'after', type: 'transform', expression: '${ [steps.decide.output.taken, steps.note.status] }' },
    ]);
    const h = harness(def, { respond: () => ({ enabled: true }) });
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.status('disable')).toBe('succeeded');
    expect(h.status('note')).toBe('skipped');
    expect(h.record('after')?.output).toEqual(['then', 'skipped']);
    const off = harness(def, { respond: () => ({ enabled: false }) });
    await off.exec();
    expect(off.status('disable')).toBe('skipped');
    expect(off.record('note')?.output).toBe('already');
  });

  it('nested loops expose outer and inner items', async () => {
    const def = playbook([
      {
        id: 'outer',
        type: 'forEach',
        items: '${ ["g1","g2"] }',
        as: 'group',
        steps: [{ id: 'inner', type: 'forEach', items: '${ ["u1","u2"] }', as: 'user', steps: [{ id: 'pair', type: 'transform', expression: '${ group & ":" & user }' }] }],
      },
    ]);
    const h = harness(def);
    await h.exec();
    expect([...h.latest().values()].filter((r) => r.stepId === 'pair').map((r) => [r.path, r.output])).toEqual([
      ['outer[0].inner[0].pair', 'g1:u1'],
      ['outer[0].inner[1].pair', 'g1:u2'],
      ['outer[1].inner[0].pair', 'g2:u1'],
      ['outer[1].inner[1].pair', 'g2:u2'],
    ]);
  });

  it('resumes a loop where it stopped (finished iterations are not repeated, items are pinned)', async () => {
    const def = playbook([{ id: 'loop', type: 'forEach', items: '${ inputs.ids }', steps: [write('w', { request: { method: 'PATCH', path: '/things/${ item }' } })] }], {
      inputs: { ids: { type: 'enum', values: ['1', '2', '3', '4'], multiple: true } },
    });
    const h = harness(def, { inputs: { ids: ['1', '2', '3'] } });
    h.outbound.respond = (c) => {
      if (c.path === '/things/2') h.identity.signIn({ kind: 'delegated', oid: h.identity.resolves[0]!.oid, upn: null }, false);
      return null;
    };
    expect((await h.exec()).status).toBe('awaiting_arm');
    expect(h.outbound.paths()).toEqual(['/things/1', '/things/2']);
    // Inputs changing under a run would not change the pinned items.
    await h.store.updateRun('run-1', {});
    h.identity.signIn({ kind: 'delegated', oid: h.identity.resolves[0]!.oid, upn: null }, true);
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.paths()).toEqual(['/things/1', '/things/2', '/things/3']);
    expect(h.record('loop')?.request).toEqual({ items: ['1', '2', '3'], count: 3 });
  });
});
