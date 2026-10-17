import { ApiErrorBody, ReportCatalogResponse, ReportDetailResponse } from '@adminforge/schemas';
import { AVERY, BLAKE, OPERATOR, READER, body, portalApp } from './portal-schedules-helpers';

// The Reports catalogue (GET /api/reports, /api/reports/:key): every report the caller may open, with requirements,
// licence badge, params as the schedule form shows them, export formats and columns, and the schedules that run it.

describe('GET /api/reports', () => {
  it('lists only active reports the caller may open, with areas in navigation order', async () => {
    const t = await portalApp();
    const reader = await t.login(READER, ['Portal.Reader']);
    const op = await t.login(AVERY, OPERATOR);

    const asReader = ReportCatalogResponse.parse((await reader.get('/api/reports')).json());
    // Drafts are hidden; the Operator-only cost report is not offered to a Reader.
    expect(asReader.items.map((i) => i.key)).toEqual(['security.no-export', 'identity.inactive-users']);
    expect(asReader.areas).toEqual([
      { key: 'identity', label: 'Identity', icon: 'identification-card' },
      { key: 'security', label: 'Security', icon: 'folder' },
    ]);

    const asOperator = ReportCatalogResponse.parse((await op.get('/api/reports')).json());
    expect(asOperator.items.map((i) => i.key)).toEqual([
      'security.no-export',
      'identity.inactive-users',
      'azure.monthly-cost',
    ]);
    // Azure (order 60) comes after Identity (order 20) even though navigation.yaml lists it first.
    expect(asOperator.areas.map((a) => a.key)).toEqual(['identity', 'azure', 'security']);
    expect((await t.app.inject({ method: 'GET', url: '/api/reports' })).statusCode).toBe(401);
    await t.close();
  });

  it('describes a report: requirements, licence badge, export, params and its schedules', async () => {
    const t = await portalApp();
    const op = await t.login(AVERY, OPERATOR);
    const created = await op.post('/api/schedules', body({}, { params: { days: 90 } }));
    expect(created.statusCode).toBe(201);

    const reader = await t.login(READER, ['Portal.Reader']);
    const { items } = ReportCatalogResponse.parse((await reader.get('/api/reports')).json());
    const item = items.find((i) => i.key === 'identity.inactive-users')!;
    expect(item).toMatchObject({
      title: 'Inactive users',
      summary: 'Accounts that have not signed in for a while.',
      tags: ['identity', 'users', 'report'],
      owner: 'identity-team',
      version: '1.2.0',
      area: 'identity',
      icon: 'user-minus',
      href: '/p/identity.inactive-users',
      requires: {
        licences: ['AAD_PREMIUM'],
        entraRoles: ['Reports Reader'],
        portalRoles: ['Portal.Reader'],
        scopes: { graph: ['User.Read.All', 'AuditLog.Read.All'] },
      },
      // The tenant (subscribedSkus: none) lacks the declared licence: badged like the navigation does.
      badge: 'Requires AAD_PREMIUM',
      exportFormats: ['csv', 'xlsx'],
      schedulable: true,
    });
    expect(item.params).toEqual([
      {
        name: 'days',
        type: 'enum',
        label: 'Inactive for',
        description: null,
        default: 30,
        required: false,
        multiple: false,
        values: [
          { value: 30, label: '30 days' },
          { value: 90, label: '90 days' },
        ],
        min: null,
        max: null,
        schedulable: true,
      },
      expect.objectContaining({ name: 'includeGuests', type: 'boolean', default: false, schedulable: true }),
      // An expression default is evaluated when the report runs: no literal to show.
      expect.objectContaining({
        name: 'top',
        type: 'number',
        default: null,
        min: 1,
        max: 500,
        schedulable: true,
      }),
      expect.objectContaining({
        name: 'department',
        description: 'Exact department name.',
        schedulable: true,
      }),
      // Entity pickers and dates keep the report's default when scheduled.
      expect.objectContaining({ name: 'manager', type: 'string', schedulable: false }),
      expect.objectContaining({ name: 'since', type: 'date', default: '-30d', schedulable: false }),
    ]);
    expect(item.params.map((p) => p.name)).not.toContain('id');
    // The content schedule and the one just created, each with its source and who may manage it.
    expect(item.schedules.map((s) => [s.key, s.source, s.createdBy, s.canManage])).toEqual([
      [created.json().key, 'portal', 'avery@example.com', false],
      ['reports.inactive-users-weekly', 'content', null, false],
    ]);
    expect(item.schedules[1]).toMatchObject({
      cron: '0 6 * * 1',
      cronText: 'Every Monday at 06:00 UTC',
      timezone: 'UTC',
      enabled: true,
      nextRunAt: '2026-10-19T06:00:00.000Z',
      lastRunAt: null,
      lastStatus: null,
      pendingApprovalId: null,
    });
    // The creator sees canManage on their own schedule.
    const own = ReportCatalogResponse.parse((await op.get('/api/reports')).json()).items.find(
      (i) => i.key === 'identity.inactive-users',
    )!;
    expect(own.schedules.find((s) => s.source === 'portal')!.canManage).toBe(true);

    const noExport = items.find((i) => i.key === 'security.no-export')!;
    expect(noExport).toMatchObject({
      exportFormats: [],
      schedulable: false,
      icon: null,
      badge: null,
      params: [],
    });
    await t.close();
  });

  it('shows no badge when the tenant holds the licence (or licences are unknown)', async () => {
    const t = await portalApp({
      skus: {
        value: [
          {
            skuPartNumber: 'AAD_PREMIUM',
            capabilityStatus: 'Enabled',
            prepaidUnits: { enabled: 10 },
            servicePlans: [],
          },
        ],
      },
    });
    const reader = await t.login(READER, ['Portal.Reader']);
    const { items } = ReportCatalogResponse.parse((await reader.get('/api/reports')).json());
    expect(items.find((i) => i.key === 'identity.inactive-users')!.badge).toBeNull();
    await t.close();
  });
});

describe('GET /api/reports/:key', () => {
  it('adds the columns an export contains (hidden columns are left out)', async () => {
    const t = await portalApp();
    const reader = await t.login(READER, ['Portal.Reader']);
    const res = await reader.get('/api/reports/identity.inactive-users');
    expect(res.statusCode).toBe(200);
    const detail = ReportDetailResponse.parse(res.json());
    expect(detail.columns).toEqual([
      { field: 'displayName', label: 'Name' },
      { field: 'userPrincipalName', label: 'Sign-in name' },
    ]);
    expect(detail.schedules.map((s) => s.key)).toEqual(['reports.inactive-users-weekly']);
    expect(
      ReportDetailResponse.parse((await reader.get('/api/reports/security.no-export')).json()).columns,
    ).toEqual([]);
    await t.close();
  });

  it('404 for a missing, draft or malformed key; 403 when a role is missing', async () => {
    const t = await portalApp();
    const reader = await t.login(READER, ['Portal.Reader']);
    for (const url of [
      '/api/reports/identity.nope',
      '/api/reports/identity.draft-report',
      '/api/reports/Not%20a%20key',
    ]) {
      const res = await reader.get(url);
      expect(res.statusCode).toBe(404);
      expect(ApiErrorBody.parse(res.json()).error.code).toBe('definition_not_found');
    }
    const forbidden = await reader.get('/api/reports/azure.monthly-cost');
    expect(forbidden.statusCode).toBe(403);
    expect(ApiErrorBody.parse(forbidden.json()).error).toMatchObject({
      code: 'forbidden',
      message: 'This report needs the Portal.Operator role.',
      hint: 'Ask a portal administrator for access.',
    });
    const op = await t.login(BLAKE, OPERATOR);
    expect((await op.get('/api/reports/azure.monthly-cost')).statusCode).toBe(200);
    await t.close();
  });
});
