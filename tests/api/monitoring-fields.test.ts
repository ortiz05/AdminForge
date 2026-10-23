import { FakeDefinitions, probe, READER, schedule, schedulesApp } from './schedules-helpers';

// Monitoring's filters (Overview › Monitoring) need each item's service and tags: GET /api/probes carries every probe's
// `tags`; GET /api/schedules every schedule's `group` (a report's area or key prefix, a playbook's key prefix,
// `platform` for content health and news, none for a probe sweep) and `tags`.
const report = {
  kind: 'report' as const,
  id: 'identity.app-credential-expiry',
  version: '1.0.0',
  title: 'App credential expiry',
  owner: 'test',
  area: 'identity',
  datasources: {},
  layout: [],
  export: { formats: ['csv'] },
};

describe('Monitoring fields', () => {
  it('gives probes their tags and schedules their service and tags', async () => {
    const defs = new FakeDefinitions()
      .set(probe('probes.mail', { group: 'exchange', tags: ['synthetic', 'sweep-15m'] }))
      .set(probe('probes.loose'))
      .set(report as never)
      .set(
        schedule('reports.app-credential-expiry', {
          tags: ['weekly'],
          job: {
            kind: 'report',
            ref: 'identity.app-credential-expiry',
            delivery: [{ type: 'file', format: 'csv' }],
          },
        }),
      )
      .set(schedule('probes.sweep-15m', { job: { kind: 'probe', select: { tags: ['sweep-15m'] } } }))
      .set(schedule('maintenance.content-health', { job: { kind: 'contentHealth' } }));
    const t = await schedulesApp({ defs });
    const reader = await t.login(READER, ['Portal.Reader']);
    const probes = (await reader.get('/api/probes')).json().items as Array<{ key: string; tags: string[] }>;
    expect(Object.fromEntries(probes.map((p) => [p.key, p.tags]))).toEqual({
      'probes.loose': [],
      'probes.mail': ['synthetic', 'sweep-15m'],
    });
    const items = (await reader.get('/api/schedules')).json().items as Array<{
      key: string;
      group: string | null;
      tags: string[];
    }>;
    expect(Object.fromEntries(items.map((s) => [s.key, [s.group, s.tags]]))).toEqual({
      'maintenance.content-health': ['platform', []],
      'probes.sweep-15m': [null, []],
      'reports.app-credential-expiry': ['identity', ['weekly']],
    });
    await t.close();
  });
});
