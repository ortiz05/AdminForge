import { createHash } from 'node:crypto';
import { ApiError } from '@adminforge/connectors';
import { OutboundError } from '@adminforge/api/src/execution/outbound';
import { parseDefinition } from '@adminforge/schemas';
import { AVERY, FakeOutbound, schedulesApp } from './schedules-helpers';

const WORKSPACE = '00000000-0000-4000-8000-00000000abcd';

describe('Query Studio API', () => {
  it('runs Resource Graph KQL as the signed-in engineer (delegated, read) and audits a hash of the query', async () => {
    const outbound = new FakeOutbound(() => ({ value: [{ name: 'sa1', count_: 3, enabled: true, created: '2026-10-01T00:00:00Z', tags: { env: 'dev' } }], totalRecords: 1 }));
    const t = await schedulesApp({ outbound });
    const user = await t.login(AVERY, ['Portal.Reader']);
    const query = `resources | where type =~ 'microsoft.storage/storageaccounts' ${'| project name '.repeat(30)}`;
    const res = await user.post('/api/query', { source: 'resourceGraph', query, subscriptions: ['00000000-0000-4000-8000-000000000001'] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      columns: [
        { name: 'name', type: 'string' },
        { name: 'count_', type: 'long' },
        { name: 'enabled', type: 'bool' },
        { name: 'created', type: 'datetime' },
        { name: 'tags', type: 'dynamic' },
      ],
      rows: [{ name: 'sa1' }],
      rowCount: 1,
      truncated: false,
      provenance: { service: 'arm', path: '/providers/Microsoft.ResourceGraph/resources' },
    });
    expect(body.ms).toBeGreaterThanOrEqual(0);
    expect(outbound.calls[0]).toMatchObject({
      identity: { kind: 'delegated', mode: 'read', session: { userOid: AVERY.oid } },
      call: { service: 'arm', method: 'POST', body: { query: query.trim(), subscriptions: ['00000000-0000-4000-8000-000000000001'] }, paging: 'all', maxItems: 5000 },
    });
    const audit = t.audit.rows.find((r) => r.action === 'query.executed')!;
    expect(audit).toMatchObject({ actorUpn: 'avery@example.com', mode: 'read', targetType: 'kql', targetId: 'resourceGraph', result: 'success' });
    expect(audit.details).toMatchObject({ queryHash: createHash('sha256').update(query.trim()).digest('hex'), queryLength: query.trim().length, rowCount: 1, subscriptions: 1 });
    expect(String(audit.details!.queryPreview)).toHaveLength(200);
    await t.close();
  });

  it('flags truncation at 5000 rows', async () => {
    const outbound = new FakeOutbound(() => ({ value: Array.from({ length: 5000 }, (_, i) => ({ i })), totalRecords: 7200 }));
    const t = await schedulesApp({ outbound });
    const user = await t.login(AVERY, ['Portal.Reader']);
    expect((await user.post('/api/query', { source: 'resourceGraph', query: 'resources' })).json()).toMatchObject({ rowCount: 5000, truncated: true });
    await t.close();
  });

  it('queries Log Analytics in the given (or default) workspace and advanced hunting through Graph', async () => {
    const outbound = new FakeOutbound((call) =>
      call.service === 'logAnalytics'
        ? { value: [{ Count: 4 }], tables: [{ name: 'PrimaryResult', columns: [{ name: 'Count', type: 'long' }] }] }
        : { schema: [{ name: 'DeviceName', type: 'String' }], results: [{ DeviceName: 'pc-1' }] },
    );
    const t = await schedulesApp({ outbound });
    const user = await t.login(AVERY, ['Portal.Reader']);
    const la = await user.post('/api/query', { source: 'logAnalytics', query: 'AzureActivity | count', workspace: WORKSPACE, timespan: 'PT1H' });
    expect(la.json()).toMatchObject({ columns: [{ name: 'Count', type: 'long' }], rows: [{ Count: 4 }], rowCount: 1 });
    expect(outbound.calls[0]!.call).toMatchObject({ service: 'logAnalytics', path: `/v1/workspaces/${WORKSPACE}/query`, body: { query: 'AzureActivity | count', timespan: 'PT1H' } });
    const ah = await user.post('/api/query', { source: 'advancedHunting', query: 'DeviceInfo | take 1' });
    expect(ah.json()).toMatchObject({ columns: [{ name: 'DeviceName', type: 'String' }], rows: [{ DeviceName: 'pc-1' }] });
    expect(outbound.calls[1]!.call).toMatchObject({ service: 'graph', method: 'POST', path: '/security/runHuntingQuery', body: { Query: 'DeviceInfo | take 1' } });
    // No workspace given and none configured: a clear 503.
    const none = await user.post('/api/query', { source: 'logAnalytics', query: 'AzureActivity' });
    expect([none.statusCode, none.json().error.code]).toEqual([503, 'workspace_not_configured']);
    await t.close();
  });

  it('validates requests and maps upstream errors (audited as failures)', async () => {
    const outbound = new FakeOutbound(() => Promise.reject(new OutboundError(new ApiError(403, 'AuthorizationFailed', 'No access'), 'arm', 'Needs the Azure role Reader on the target scope.', false)));
    const t = await schedulesApp({ outbound });
    const user = await t.login(AVERY, ['Portal.Reader']);
    for (const body of [{ source: 'sentinel', query: 'x' }, { source: 'resourceGraph', query: '' }, { source: 'resourceGraph', query: 'x', workspace: WORKSPACE }, { source: 'logAnalytics', query: 'x', timespan: '1h' }, { source: 'resourceGraph', query: 'x', subscriptions: ['not-a-guid'] }])
      expect((await user.post('/api/query', body)).statusCode).toBe(400);
    const denied = await user.post('/api/query', { source: 'resourceGraph', query: 'resources' });
    expect([denied.statusCode, denied.json().error.code, denied.json().error.hint]).toEqual([403, 'upstream_forbidden', 'Needs the Azure role Reader on the target scope.']);
    expect(t.audit.rows.find((r) => r.action === 'query.executed')).toMatchObject({ result: 'failure', details: expect.objectContaining({ error: 'upstream_forbidden' }) });
    const noRole = await t.login({ oid: '00000000-0000-4000-8000-0000000000d4', upn: 'drew@example.com' }, ['Playbook.Author']);
    expect((await noRole.post('/api/query', { source: 'resourceGraph', query: 'resources' })).statusCode).toBe(403);
    await t.close();
  });

  describe('scaffold', () => {
    const cases = [
      ['report', 'resourceGraph', 'reports/azure/storage-without-tls.report.yaml'],
      ['report', 'logAnalytics', 'reports/azure/storage-without-tls.report.yaml'],
      ['report', 'advancedHunting', 'reports/security/storage-without-tls.report.yaml'],
      ['probe', 'resourceGraph', 'probes/storage-without-tls.probe.yaml'],
      ['probe', 'logAnalytics', 'probes/storage-without-tls.probe.yaml'],
      ['probe', 'advancedHunting', 'probes/storage-without-tls.probe.yaml'],
      ['schedule', 'resourceGraph', 'schedules/kql/storage-without-tls.schedule.yaml'],
    ] as const;
    it.each(cases)('scaffolds a valid %s from %s KQL', async (as, source, rel) => {
      const t = await schedulesApp();
      const user = await t.login(AVERY, ['Portal.Reader']);
      const query = "resources\n| where type =~ 'microsoft.storage/storageaccounts'\n| extend note = '${ not an expression }'";
      const res = await user.post('/api/query/scaffold', { as, source, query, title: 'Storage without TLS', columns: [{ name: 'name', type: 'string' }, { name: 'created', type: 'datetime' }, { name: 'id', type: 'string' }] });
      expect(res.statusCode).toBe(200);
      const { yaml, path } = res.json();
      expect(path).toBe(`portal/content/${rel}`);
      const parsed = parseDefinition(yaml, rel);
      expect(parsed.ok ? [] : parsed.errors).toEqual([]);
      if (as !== 'schedule') expect(yaml).toContain('$${ not an expression }');
      if (!parsed.ok) return;
      expect(parsed.def.kind).toBe(as);
      if (parsed.def.kind === 'probe') expect(parsed.def.check).toMatchObject({ kind: 'kql', source, metric: 'rowCount', detailsLimit: 50 });
      if (parsed.def.kind === 'schedule') expect(parsed.def).toMatchObject({ enabled: false, identity: 'automation', job: { kind: 'probe', ref: 'probes.storage-without-tls' } });
      if (parsed.def.kind === 'report') expect(parsed.def.export).toMatchObject({ formats: ['csv', 'xlsx'] });
      expect(yaml).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      await t.close();
    });
    it('never writes ids into the YAML: literal subscriptions/workspaces are ignored for env references', async () => {
      const t = await schedulesApp();
      const user = await t.login(AVERY, ['Portal.Reader']);
      const body = { source: 'resourceGraph', query: 'resources | take 5', title: 'Five resources', subscriptions: ['00000000-0000-4000-8000-000000000001'], workspace: WORKSPACE };
      for (const as of ['report', 'probe']) {
        const { yaml } = (await user.post('/api/query/scaffold', { ...body, as })).json();
        expect(yaml).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
        expect(yaml).toContain('# Scope: every subscription the identity can read.');
      }
      const scoped = (await user.post('/api/query/scaffold', { ...body, as: 'probe', scope: 'default' })).json().yaml;
      expect(parseDefinition(scoped, 'probes/x.probe.yaml')).toMatchObject({ ok: true, def: { check: { subscriptions: ['${ env.AF_SUBSCRIPTION_ID }'] } } });
      const la = (await user.post('/api/query/scaffold', { as: 'report', source: 'logAnalytics', query: 'AzureActivity | take 5', title: 'Activity', workspace: WORKSPACE })).json().yaml;
      expect(la).toContain('workspace: ${ env.AF_LOG_ANALYTICS_WORKSPACE_ID }');
      expect(la).not.toContain(WORKSPACE);
      await t.close();
    });

    it('refuses text holding tenant values, naming the kind but never the value', async () => {
      const TENANT = '00000000-0000-4000-8000-00000000e1e1';
      const SUB = '00000000-0000-4000-8000-00000000f2f2';
      const t = await schedulesApp({ config: { AF_TENANT_ID: TENANT, AF_SUBSCRIPTION_ID: SUB, AF_PRIMARY_DOMAIN: 'contoso-test.example' } });
      const user = await t.login(AVERY, ['Portal.Reader']);
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ query: `resources | where tenantId == '${TENANT.toUpperCase()}'` }, /query contains the tenant id/],
        [{ query: `resources | where subscriptionId == '${SUB}'` }, /query contains the default subscription id/],
        [{ query: "resources | where tags.mail endswith 'CONTOSO-TEST.example'" }, /query contains the primary domain/],
        [{ query: "resources | where id has '11111111-2222-4333-8444-555555555555'" }, /query contains a GUID/],
        [{ query: "SigninLogs | where UserPrincipalName endswith 'fabrikam.onmicrosoft.com'" }, /query contains a tenant domain/],
        [{ title: `Resources in ${SUB}` }, /title contains the default subscription id/],
      ];
      for (const [over, message] of cases) {
        const res = await user.post('/api/query/scaffold', { as: 'probe', source: 'resourceGraph', query: 'resources', title: 'Check', ...over });
        expect([res.statusCode, res.json().error.code]).toEqual([400, 'tenant_value_in_query']);
        expect(res.json().error.message).toMatch(message);
        expect(res.json().error.hint).toMatch(/env\.AF_SUBSCRIPTION_ID|\$kql/);
        expect(JSON.stringify(res.json())).not.toMatch(new RegExp(`${TENANT}|${SUB}|contoso-test|fabrikam|11111111`, 'i'));
      }
      expect((await user.post('/api/query/scaffold', { as: 'probe', source: 'resourceGraph', query: 'resources | where tags.env == ${ $kql(env.AF_ENV_LABEL) }', title: 'Check' })).statusCode).toBe(200);
      await t.close();
    });

    it('uses the key, cron and thresholds it is given and refuses bad input', async () => {
      const t = await schedulesApp();
      const user = await t.login(AVERY, ['Portal.Reader']);
      const probe = (await user.post('/api/query/scaffold', { as: 'probe', source: 'logAnalytics', query: 'AzureActivity | summarize n = count()', title: 'Activity', key: 'checks.activity', metric: { column: 'n', aggregate: 'max' }, thresholds: { warn: 5, crit: 50 }, workspaceEnv: 'AF_LOG_ANALYTICS_WORKSPACE_ID', timespan: 'PT1H' })).json();
      expect(probe.path).toBe('portal/content/probes/checks/activity.probe.yaml');
      expect(probe.yaml).toContain('workspace: ${ env.AF_LOG_ANALYTICS_WORKSPACE_ID }');
      const sched = (await user.post('/api/query/scaffold', { as: 'schedule', source: 'resourceGraph', query: 'resources', title: 'Nightly', cron: '30 2 * * *', timezone: 'Europe/London', job: { kind: 'report', ref: 'azure.nightly' } })).json();
      expect(parseDefinition(sched.yaml, 'x.schedule.yaml')).toMatchObject({ ok: true, def: { cron: '30 2 * * *', timezone: 'Europe/London', job: { kind: 'report', ref: 'azure.nightly' } } });
      expect((await user.post('/api/query/scaffold', { as: 'schedule', source: 'resourceGraph', query: 'resources', title: 'Bad', cron: '61 * * * *' })).statusCode).toBe(400);
      expect((await user.post('/api/query/scaffold', { as: 'page', source: 'resourceGraph', query: 'resources', title: 'x' })).statusCode).toBe(400);
      expect((await user.post('/api/query/scaffold', { as: 'probe', source: 'resourceGraph', query: 'resources', title: 'x', key: 'NotAKey' })).statusCode).toBe(400);
      await t.close();
    });
  });
});
