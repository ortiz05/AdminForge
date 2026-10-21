import { harness, playbook, write } from './helpers';

// L2 (whole-branch security review): a step's `idempotent: false` reaches the outbound call it makes, so the API's
// executor sends it at most once whenever its outcome is unknown (connectors › sendOnce). Steps without it, and
// compensations (which have no such flag), keep the executor's retries.

const SESSION =
  '/subscriptions/s/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/hp/sessionHosts/h/userSessions/3';

describe('engine: idempotent: false on the outbound call', () => {
  it('graph, graphBatch, arm and function steps carry it; a step without it does not', async () => {
    const h = harness(
      playbook([
        write('patch', { idempotent: false }),
        {
          id: 'batch',
          type: 'graphBatch',
          mode: 'write',
          describe: 'Batch',
          idempotent: false,
          requests: { a: { method: 'DELETE', path: '/groups/g/members/u/$ref' } },
        },
        {
          id: 'logOff',
          type: 'arm',
          mode: 'write',
          describe: 'Sign out',
          idempotent: false,
          request: { method: 'DELETE', path: SESSION, apiVersion: '2024-04-03' },
        },
        {
          id: 'sync',
          type: 'function',
          mode: 'write',
          describe: 'Sync',
          idempotent: false,
          connection: 'example.hr-sync',
          operation: 'resync',
        },
        write('again'),
      ]),
      { respond: (c) => (c.path === '/$batch' ? { responses: [{ id: 'a', status: 204 }] } : {}) },
    );
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.calls.map((c) => [c.call.service, c.call.idempotent])).toEqual([
      ['graph', false],
      ['graph', false],
      ['arm', false],
      ['function', false],
      ['graph', undefined],
    ]);
  });

  it('a compensation of an idempotent: false step keeps the executor’s retries', async () => {
    const undo = { type: 'graph', request: { method: 'PATCH', path: '/things/undo', body: { v: 0 } } };
    const h = harness(
      playbook([
        write('one', { idempotent: false, compensate: undo }),
        write('two', { onError: 'compensate' }),
      ]),
      {
        respond: (c) => {
          if (c.path === '/things/two') throw Object.assign(new Error('refused'), { status: 400 });
          return {};
        },
      },
    );
    await h.exec();
    expect(h.outbound.calls.map((c) => [c.call.path, c.call.idempotent])).toEqual([
      ['/things/one', false],
      ['/things/two', undefined],
      ['/things/undo', undefined],
    ]);
  });
});
