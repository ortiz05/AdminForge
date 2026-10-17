import { AVERY, FakeOutbound, schedulesApp } from './schedules-helpers';

/**
 * AF_QUERY_SOURCES switches Query Studio sources off for an installation: POST /api/query and /api/query/scaffold
 * refuse them with 403 `source_off` before anything is sent, and GET /api/me lists what is offered.
 */
describe('Query Studio sources switched off (AF_QUERY_SOURCES)', () => {
  const config = { AF_QUERY_SOURCES: 'resourceGraph,logAnalytics' };

  it('refuses advanced hunting before any outbound call, in plain words, without auditing a query', async () => {
    const outbound = new FakeOutbound(() => ({ results: [], schema: [] }));
    const t = await schedulesApp({ outbound, config });
    const user = await t.login(AVERY, ['Portal.Reader']);
    const res = await user.post('/api/query', { source: 'advancedHunting', query: 'DeviceInfo | take 1' });
    expect(res.statusCode).toBe(403);
    const { error } = res.json();
    expect(error).toMatchObject({
      code: 'source_off',
      message: 'Advanced hunting is switched off for this AdminForge.',
      hint: 'Use Azure Resource Graph or Log Analytics instead, or ask whoever runs this AdminForge to switch it back on.',
    });
    expect(error.correlationId).toEqual(expect.any(String));
    // No env key names in what the person sees (CLAUDE.md rule 10).
    expect(JSON.stringify(error)).not.toMatch(/AF_|QUERY_SOURCES/);
    expect(outbound.calls).toHaveLength(0);
    expect(t.audit.rows.filter((r) => r.action === 'query.executed')).toHaveLength(0);
    await t.close();
  });

  it('still runs the sources that are on', async () => {
    const outbound = new FakeOutbound(() => ({ value: [{ n: 1 }], totalRecords: 1 }));
    const t = await schedulesApp({ outbound, config });
    const user = await t.login(AVERY, ['Portal.Reader']);
    const res = await user.post('/api/query', { source: 'resourceGraph', query: 'resources | count' });
    expect(res.statusCode).toBe(200);
    expect(outbound.calls).toHaveLength(1);
    await t.close();
  });

  it('refuses to scaffold content for a source that is off', async () => {
    const t = await schedulesApp({ config });
    const user = await t.login(AVERY, ['Portal.Reader']);
    const body = { source: 'advancedHunting', query: 'DeviceInfo | take 1', title: 'Devices' };
    for (const as of ['report', 'probe'] as const) {
      const res = await user.post('/api/query/scaffold', { ...body, as });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('source_off');
    }
    const ok = await user.post('/api/query/scaffold', { ...body, source: 'logAnalytics', as: 'report' });
    expect(ok.statusCode).toBe(200);
    await t.close();
  });

  it('checks the portal role first: a person without Portal.Reader gets forbidden, not source_off', async () => {
    const t = await schedulesApp({ config });
    const user = await t.login(AVERY, []);
    const res = await user.post('/api/query', { source: 'advancedHunting', query: 'DeviceInfo' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
    await t.close();
  });

  it('GET /api/me lists the sources that are on (all three by default)', async () => {
    const off = await schedulesApp({ config });
    const me = (await (await off.login(AVERY, ['Portal.Reader'])).get('/api/me')).json();
    expect(me.querySources).toEqual(['resourceGraph', 'logAnalytics']);
    await off.close();

    const all = await schedulesApp();
    const me2 = (await (await all.login(AVERY, ['Portal.Reader'])).get('/api/me')).json();
    expect(me2.querySources).toEqual(['resourceGraph', 'logAnalytics', 'advancedHunting']);
    await all.close();
  });
});
