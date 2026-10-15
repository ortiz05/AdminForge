import { FakeDefinitions, probe, READER, schedulesApp } from './schedules-helpers';

function content() {
  return new FakeDefinitions()
    .set(probe('probes.graph-reachability', { thresholds: { warn: 1500, crit: 5000 } }))
    .set(
      probe('probes.storage-public-blob-access', {
        check: { kind: 'kql', source: 'resourceGraph', query: 'resources' },
        thresholds: { warn: 1, crit: 10 },
      }),
    )
    .set(
      probe('probes.portal-tls', {
        check: { kind: 'certExpiry', host: 'portal.example.com', warnDays: 21, critDays: 7 },
      }),
    );
}

describe('probes API', () => {
  it('lists every probe with its latest result, a 24-hour series and its thresholds', async () => {
    const t = await schedulesApp({ defs: content() });
    const store = t.schedules.store;
    const at = (h: number) => new Date(Date.UTC(2026, 9, 15, h));
    await store.insertProbeResult({
      probeKey: 'probes.graph-reachability',
      ts: at(9),
      status: 'ok',
      metric: 120,
      durationMs: 121,
      message: 'Microsoft Graph 200 in 120 ms.',
      details: null,
      scheduleRunId: null,
    });
    await store.insertProbeResult({
      probeKey: 'probes.graph-reachability',
      ts: at(10),
      status: 'warn',
      metric: 1800,
      durationMs: 1801,
      message: 'Microsoft Graph 200 in 1800 ms.',
      details: null,
      scheduleRunId: null,
    });
    await store.insertProbeResult({
      probeKey: 'probes.graph-reachability',
      ts: new Date(Date.UTC(2026, 9, 13)),
      status: 'crit',
      metric: 9000,
      durationMs: 9000,
      message: 'old',
      details: null,
      scheduleRunId: null,
    });
    await store.insertProbeResult({
      probeKey: 'probes.storage-public-blob-access',
      ts: at(11),
      status: 'warn',
      metric: 2,
      durationMs: 300,
      message: '2 row(s) (warn ≥ 1, crit ≥ 10).',
      details: { rows: [{ name: 'sa1' }, { name: 'sa2' }], totalRows: 2 },
      scheduleRunId: null,
    });

    const reader = await t.login(READER, ['Portal.Reader']);
    const res = await reader.get('/api/probes');
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.key)).toEqual([
      'probes.graph-reachability',
      'probes.portal-tls',
      'probes.storage-public-blob-access',
    ]);
    expect(items[0]).toEqual({
      key: 'probes.graph-reachability',
      title: 'Probe probes.graph-reachability',
      kind: 'graph',
      latest: {
        status: 'warn',
        metric: 1800,
        unit: 'ms',
        ts: '2026-10-15T10:00:00.000Z',
        message: 'Microsoft Graph 200 in 1800 ms.',
      },
      series: [
        { ts: '2026-10-15T09:00:00.000Z', metric: 120, status: 'ok' },
        { ts: '2026-10-15T10:00:00.000Z', metric: 1800, status: 'warn' },
      ],
      thresholds: { warn: 1500, crit: 5000, unit: 'ms', worse: 'higher' },
    });
    expect(items[1]).toMatchObject({
      kind: 'certExpiry',
      latest: null,
      series: [],
      thresholds: { warn: 21, crit: 7, unit: 'days', worse: 'lower' },
    });
    expect(items[2]).toMatchObject({
      kind: 'kql',
      latest: { status: 'warn', metric: 2, unit: 'rows' },
      thresholds: { warn: 1, crit: 10, unit: 'rows', worse: 'higher' },
    });
    expect((await t.app.inject({ method: 'GET', url: '/api/probes' })).statusCode).toBe(401);
    await t.close();
  });

  it('returns one probe’s results with details since a time', async () => {
    const t = await schedulesApp({ defs: content() });
    const store = t.schedules.store;
    for (const h of [6, 9, 11])
      await store.insertProbeResult({
        probeKey: 'probes.storage-public-blob-access',
        ts: new Date(Date.UTC(2026, 9, 15, h)),
        status: 'warn',
        metric: h,
        durationMs: 10,
        message: `${h} rows`,
        details: { rows: [{ name: `sa${h}` }] },
        scheduleRunId: '00000000-0000-4000-8000-0000000000aa',
      });
    const reader = await t.login(READER, ['Portal.Reader']);
    const res = (
      await reader.get('/api/probes/probes.storage-public-blob-access/results?since=2026-10-15T08:00:00Z')
    ).json();
    expect(res.items).toEqual([
      {
        ts: '2026-10-15T11:00:00.000Z',
        status: 'warn',
        metric: 11,
        unit: 'rows',
        durationMs: 10,
        message: '11 rows',
        details: { rows: [{ name: 'sa11' }] },
        scheduleRunId: '00000000-0000-4000-8000-0000000000aa',
      },
      expect.objectContaining({ ts: '2026-10-15T09:00:00.000Z', metric: 9 }),
    ]);
    expect(
      (await reader.get('/api/probes/probes.storage-public-blob-access/results')).json().items,
    ).toHaveLength(3);
    expect(
      (await reader.get('/api/probes/probes.storage-public-blob-access/results?since=yesterday')).statusCode,
    ).toBe(400);
    expect((await reader.get('/api/probes/probes.nope/results')).statusCode).toBe(404);
    expect((await reader.get('/api/probes/..%2Fx/results')).statusCode).toBe(404);
    await t.close();
  });
});
