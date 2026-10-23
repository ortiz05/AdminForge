import {
  catalogAreas,
  catalogItem,
  mayOpen,
  reportArea,
  reportParams,
  schedulesByReport,
} from '@adminforge/api/src/reports/catalog';
import { parseSubscribedSkus } from '@adminforge/api/src/capabilities/licences';
import type { ScheduleItem } from '@adminforge/api/src/schedules/service';
import { Params, type Navigation } from '@adminforge/schemas';

// The Reports catalogue's pure parts: params as the schedule form shows them, areas in navigation order, the item
// (requirements, licence badge, export) and schedules grouped by report.

describe('reportParams', () => {
  const params = Params.parse({
    scope: {
      type: 'enum',
      label: 'Scope',
      multiple: true,
      values: ['all', { value: 'members', label: 'Members only' }],
      default: ['all'],
    },
    days: { type: 'number', min: 1, max: 365, default: 30, required: true },
    expr: { type: 'number', default: '${ 7 * 4 }' },
    on: { type: 'boolean' },
    q: { type: 'string', label: 'Search', default: '${ user.upn }' },
    sub: { type: 'string', picker: 'subscription' },
    group: { type: 'group', multiple: true },
    range: { type: 'dateRange', default: 'P7D' },
    guid: { type: 'guid' },
    id: { type: 'string', hidden: true },
  });
  const byName = Object.fromEntries(reportParams(params).map((p) => [p.name, p]));

  it('omits hidden params and keeps the declared order', () => {
    expect(Object.keys(byName)).toEqual([
      'scope',
      'days',
      'expr',
      'on',
      'q',
      'sub',
      'group',
      'range',
      'guid',
    ]);
  });
  it('maps enums, numbers and literal defaults', () => {
    expect(byName.scope).toEqual({
      name: 'scope',
      type: 'enum',
      label: 'Scope',
      description: null,
      default: ['all'],
      required: false,
      multiple: true,
      values: [
        { value: 'all', label: 'all' },
        { value: 'members', label: 'Members only' },
      ],
      min: null,
      max: null,
      schedulable: true,
    });
    expect(byName.days).toMatchObject({
      label: 'days',
      default: 30,
      required: true,
      min: 1,
      max: 365,
      values: null,
    });
    expect(byName.expr!.default).toBeNull();
    expect(byName.q).toMatchObject({ label: 'Search', default: null, schedulable: true });
    expect(byName.on).toMatchObject({ default: null, schedulable: true });
    expect(byName.range).toMatchObject({ default: 'P7D', min: null, max: null });
  });
  it('only string/number/boolean/enum without a picker are schedulable', () => {
    expect(
      Object.values(byName)
        .filter((p) => p.schedulable)
        .map((p) => p.name),
    ).toEqual(['scope', 'days', 'expr', 'on', 'q']);
    expect(byName.group!.multiple).toBe(true);
  });
});

describe('catalogAreas', () => {
  const navigation = {
    sections: [
      { key: 'reports', label: 'Reports', icon: 'chart-bar', order: 80 },
      { key: 'azure', label: 'Azure', icon: 'cloud', order: 60 },
      { key: 'identity', label: 'Identity', icon: 'identification-card', order: 20 },
      { key: 'm365', label: 'Microsoft 365', icon: 'squares-four' },
    ],
  } as Navigation;
  it('uses navigation labels and icons in navigation order; unknown areas follow, capitalised', () => {
    expect(catalogAreas(navigation, ['azure', 'zeta', 'identity', 'm365', 'identity', 'beta'])).toEqual([
      { key: 'identity', label: 'Identity', icon: 'identification-card' },
      { key: 'azure', label: 'Azure', icon: 'cloud' },
      { key: 'm365', label: 'Microsoft 365', icon: 'squares-four' },
      { key: 'beta', label: 'Beta', icon: 'folder' },
      { key: 'zeta', label: 'Zeta', icon: 'folder' },
    ]);
    expect(catalogAreas(undefined, ['identity'])).toEqual([
      { key: 'identity', label: 'Identity', icon: 'folder' },
    ]);
  });
});

describe('catalogItem', () => {
  const rec = {
    key: 'endpoint.stale-devices',
    version: '1.1.0',
    def: {
      kind: 'report',
      id: 'endpoint.stale-devices',
      version: '1.1.0',
      title: 'Stale devices',
      owner: 'endpoint-team',
      nav: { section: 'reports', icon: 'devices' },
      requires: {
        licences: ['INTUNE_A'],
        scopes: { graph: ['DeviceManagementManagedDevices.Read.All'], connections: { 'ops.api': ['Read'] } },
      },
      export: { formats: ['xlsx'] },
    } as never,
  };
  it('describes requirements, export and area; badges a licence the tenant lacks', () => {
    const none = parseSubscribedSkus({ value: [] });
    expect(catalogItem(rec, { licences: none, schedules: [] })).toEqual({
      key: 'endpoint.stale-devices',
      title: 'Stale devices',
      summary: null,
      tags: [],
      owner: 'endpoint-team',
      version: '1.1.0',
      area: 'endpoint',
      icon: 'devices',
      href: '/p/endpoint.stale-devices',
      requires: {
        licences: ['INTUNE_A'],
        entraRoles: [],
        portalRoles: [],
        scopes: { graph: ['DeviceManagementManagedDevices.Read.All'], 'connections.ops.api': ['Read'] },
      },
      badge: 'Requires INTUNE_A',
      exportFormats: ['xlsx'],
      schedulable: true,
      params: [],
      schedules: [],
    });
    // Unknown licences (Graph unreadable) never badge.
    expect(catalogItem(rec, { licences: null, schedules: [] }).badge).toBeNull();
  });
  it('reportArea and mayOpen', () => {
    expect(reportArea('m365.mailbox-storage')).toBe('m365');
    expect(
      mayOpen(
        { roles: ['Portal.Reader'] },
        { requires: { portalRoles: ['Portal.Reader', 'Portal.Operator'] } },
      ),
    ).toBe(false);
    expect(mayOpen({ roles: ['Portal.Reader'] }, {})).toBe(true);
  });
});

describe('schedulesByReport', () => {
  const item = (
    key: string,
    job: ScheduleItem['job'],
    source: 'content' | 'portal' = 'content',
  ): ScheduleItem => ({
    key,
    title: key,
    summary: null,
    cron: '0 6 * * 1',
    cronText: 'Every Monday at 06:00',
    timezone: 'UTC',
    enabled: true,
    group: null,
    tags: [],
    identity: 'automation',
    runsAs: { kind: 'automation', name: null, label: 'automation identity' },
    job,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: 'failed',
    writeCapable: false,
    source,
    createdBy: source === 'portal' ? 'avery@example.com' : null,
    canManage: source === 'portal',
    pendingApprovalId: null,
  });
  it('groups report schedules by report (content and portal), as summaries', () => {
    const map = schedulesByReport([
      item('reports.a', { kind: 'report', ref: 'identity.a' }),
      item('portal.identity-a-123456', { kind: 'report', ref: 'identity.a' }, 'portal'),
      item('probes.x', { kind: 'probe', select: { tags: ['x'] } }),
      item('reports.b', { kind: 'report', ref: 'identity.b' }),
    ]);
    expect([...map.keys()]).toEqual(['identity.a', 'identity.b']);
    expect(map.get('identity.a')).toEqual([
      expect.objectContaining({ key: 'reports.a', source: 'content', createdBy: null, canManage: false }),
      {
        key: 'portal.identity-a-123456',
        title: 'portal.identity-a-123456',
        cron: '0 6 * * 1',
        cronText: 'Every Monday at 06:00',
        timezone: 'UTC',
        enabled: true,
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: 'failed',
        source: 'portal',
        createdBy: 'avery@example.com',
        canManage: true,
        pendingApprovalId: null,
        runsAs: { kind: 'automation', name: null, label: 'automation identity' },
      },
    ]);
  });
});
