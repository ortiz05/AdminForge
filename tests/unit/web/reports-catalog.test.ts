import {
  changedParams,
  DeliveryOptionsResponse,
  filterReports,
  formatsFor,
  formIssues,
  formValuesFromSchedule,
  lastRunOf,
  ReportCatalogResponse,
  ReportDetailResponse,
  scheduleRequest,
  scheduleText,
  tagCounts,
  type ReportItem,
  type ScheduleFormState,
} from '@adminforge/web/src/reports/catalog';
import { filtersOf, validateReportsSearch } from '@adminforge/web/src/reports/search';
import { cronFor, DEFAULT_CRON_PARTS, partsFromCron } from '@adminforge/web/src/ops/cadence';
import { readSchedule } from '@adminforge/web/src/ops/schedules';
import { DELIVERY_OPTIONS, PORTAL_SCHEDULE_KEY, reportSchedules } from '../../e2e/fixtures/reports';
import { reportsApi } from '../../e2e/support/mock-reports';

// The report catalogue's contract readers, filters and the schedule form → request mapping (reports/catalog.ts).

function catalogue() {
  const { handler } = reportsApi();
  const reply = handler({
    method: 'GET',
    path: '/api/reports',
    url: new URL('http://localhost/api/reports'),
    body: undefined,
  })!;
  return ReportCatalogResponse.parse(reply.body);
}
const byKey = (items: ReportItem[], key: string) => items.find((r) => r.key === key)!;

describe('catalogue contract', () => {
  it('reads reports with their params, requirements and schedules', () => {
    const { items, areas } = catalogue();
    expect(items).toHaveLength(10);
    expect(areas.map((a) => a.key)).toEqual(['identity', 'm365', 'endpoint', 'security', 'azure']);
    const users = byKey(items, 'identity.inactive-users');
    expect(users).toMatchObject({
      area: 'identity',
      href: '/p/identity.inactive-users',
      badge: 'Requires Entra P1',
      schedulable: true,
      requires: { licences: ['signInLogs'], scopes: { graph: ['User.Read.All', 'AuditLog.Read.All'] } },
    });
    expect(users.params.map((p) => [p.name, p.type, p.default, p.schedulable])).toEqual([
      ['days', 'enum', 90, true],
      ['includeDisabled', 'boolean', false, true],
      ['licensedOnly', 'boolean', false, true],
    ]);
    expect(users.schedules.map((s) => [s.key, s.source, s.canManage])).toEqual([
      ['reports.inactive-users-weekly', 'content', false],
      [PORTAL_SCHEDULE_KEY, 'portal', true],
    ]);
    expect(byKey(items, 'azure.budgets').schedulable).toBe(false);
  });

  it('labels an area the server did not describe, and fails on a response without items', () => {
    const parsed = ReportCatalogResponse.parse({
      items: [{ key: 'custom.thing', title: 'Thing' }],
      areas: [],
    });
    expect(parsed.areas).toEqual([{ key: 'custom', label: 'Custom', icon: 'folder' }]);
    expect(() => ReportCatalogResponse.parse({ reports: [] })).toThrow();
  });

  it('reads the details columns and the delivery options', () => {
    const detail = ReportDetailResponse.parse({
      key: 'identity.inactive-users',
      title: 'Inactive users',
      columns: [{ field: 'displayName', label: 'Name' }, { field: 'upn' }, { label: 'no field' }],
    });
    expect(detail.columns).toEqual([
      { field: 'displayName', label: 'Name' },
      { field: 'upn', label: 'upn' },
    ]);
    expect(DeliveryOptionsResponse.parse(DELIVERY_OPTIONS).email.lists[0]).toEqual({
      key: 'AF_REPORT_RECIPIENTS',
      label: 'Report recipients',
    });
    expect(DeliveryOptionsResponse.parse({})).toEqual({
      email: { available: false, lists: [] },
      teams: { lists: [] },
    });
  });
});

describe('filters', () => {
  const { items } = catalogue();
  const keys = (list: ReportItem[]) => list.map((r) => r.key).sort();

  it('search matches every word in the title, summary, tags or key', () => {
    expect(keys(filterReports(items, { q: 'inactive guests', areas: [], tags: [] }))).toEqual([
      'identity.inactive-guests',
    ]);
    expect(keys(filterReports(items, { q: 'secure-score', areas: [], tags: [] }))).toEqual([
      'security.secure-score-summary',
    ]);
    expect(filterReports(items, { q: 'm365.mailbox', areas: [], tags: [] })).toHaveLength(1);
  });

  it('areas combine with "or", tags with "and", plus the schedule state', () => {
    expect(filterReports(items, { areas: ['endpoint', 'security'], tags: [] })).toHaveLength(2);
    expect(keys(filterReports(items, { areas: [], tags: ['hygiene', 'guests'] }))).toEqual([
      'identity.inactive-guests',
    ]);
    expect(keys(filterReports(items, { areas: [], tags: [], scheduled: 'yes' }))).toEqual([
      'identity.app-credential-expiry',
      'identity.inactive-users',
      'm365.mailbox-storage',
    ]);
    // A report whose only schedule is paused counts as not scheduled.
    expect(keys(filterReports(items, { areas: [], tags: [], scheduled: 'no' }))).toContain(
      'azure.untagged-resources',
    );
  });

  it('counts tags, most used first', () => {
    expect(tagCounts(items).slice(0, 3)).toEqual([
      { tag: 'report', count: 6 },
      { tag: 'hygiene', count: 4 },
      { tag: 'identity', count: 4 },
    ]);
  });

  it('describes the schedule column and the latest run', () => {
    expect(scheduleText(byKey(items, 'identity.app-credential-expiry'))).toEqual({
      text: 'Every Monday at 07:00 UTC',
      muted: false,
    });
    expect(scheduleText(byKey(items, 'identity.inactive-users')).text).toBe('2 schedules');
    expect(scheduleText(byKey(items, 'azure.untagged-resources'))).toEqual({ text: '1 paused', muted: true });
    expect(scheduleText(byKey(items, 'azure.budgets'))).toEqual({ text: 'Not scheduled', muted: true });
    expect(lastRunOf(byKey(items, 'identity.inactive-users'))?.at).toBe(
      reportSchedules().find((s) => s.key === PORTAL_SCHEDULE_KEY)!.lastRunAt,
    );
    expect(lastRunOf(byKey(items, 'azure.budgets'))).toBeNull();
  });
});

describe('URL state', () => {
  it('keeps valid keys and lists, comma-separated or repeated, and drops anything else', () => {
    expect(
      validateReportsSearch({
        report: 'identity.inactive-users',
        area: 'identity,Security,../x',
        tag: ['hygiene', 'users', 'hygiene', '<b>'],
        scheduled: 'maybe',
        schedule: 'new',
        edit: 'portal.identity-inactive-users-3f9a2c',
        q: 42,
      }),
    ).toEqual({
      report: 'identity.inactive-users',
      q: '42',
      area: 'identity,security',
      tag: 'hygiene,users',
      scheduled: undefined,
      schedule: 'new',
      edit: 'portal.identity-inactive-users-3f9a2c',
    });
    expect(
      validateReportsSearch({ report: 'javascript:alert(1)', edit: 'x', schedule: 'old' }),
    ).toMatchObject({
      report: undefined,
      edit: undefined,
      schedule: undefined,
    });
    expect(filtersOf({ area: 'identity,m365', tag: 'hygiene', scheduled: 'yes' })).toEqual({
      q: undefined,
      areas: ['identity', 'm365'],
      tags: ['hygiene'],
      scheduled: 'yes',
    });
  });
});

describe('cadence builder', () => {
  it.each([
    ['0 7 * * 1', 'weekly'],
    ['30 6 * * 1-5', 'weekdays'],
    ['15 * * * *', 'hourly'],
    ['0 8 1 * *', 'monthly'],
    ['5 22 * * *', 'daily'],
    ['0 */2 * * *', 'custom'],
    ['0 8 31 * *', 'custom'],
  ])('%s reads back as %s and round-trips', (cron, cadence) => {
    const parts = partsFromCron(cron);
    expect(parts.cadence).toBe(cadence);
    expect(cronFor(parts)).toBe(cron);
  });

  it('a cadence the form doesn’t offer comes back as custom', () => {
    expect(partsFromCron('*/15 * * * *').cadence).toBe('minutes');
    expect(partsFromCron('*/15 * * * *', ['hourly', 'daily', 'custom'])).toMatchObject({
      cadence: 'custom',
      custom: '*/15 * * * *',
    });
  });
});

describe('schedule form → request', () => {
  const { items } = catalogue();
  const users = byKey(items, 'identity.inactive-users');
  const base: ScheduleFormState = {
    title: ' Inactive users, weekly ',
    titleEdited: false,
    cron: DEFAULT_CRON_PARTS,
    timezone: 'Europe/London',
    params: { days: 90, includeDisabled: false, licensedOnly: false },
    format: 'xlsx',
    retain: '26',
    emailKey: '',
    teamsKey: '',
    alertEmailKey: '',
    alertTeamsKey: '',
  };

  it('sends only what differs from the report’s defaults, and delivery by key', () => {
    expect(
      scheduleRequest(users, {
        ...base,
        params: { days: 30, includeDisabled: true, licensedOnly: false },
        emailKey: 'AF_REPORT_RECIPIENTS',
        alertTeamsKey: 'AF_TEAMS_ALERTS_WEBHOOK',
        format: 'csv',
        retain: '52',
      }),
    ).toEqual({
      title: 'Inactive users, weekly',
      cron: '0 6 * * 1',
      timezone: 'Europe/London',
      job: {
        kind: 'report',
        ref: 'identity.inactive-users',
        params: { days: 30, includeDisabled: true },
        format: 'csv',
        retain: 52,
        emailKey: 'AF_REPORT_RECIPIENTS',
      },
      notifyOnFailure: { teamsKey: 'AF_TEAMS_ALERTS_WEBHOOK' },
    });
    expect(scheduleRequest(users, base).job).not.toHaveProperty('params');
    expect(scheduleRequest(users, base)).not.toHaveProperty('notifyOnFailure');
  });

  it('numbers typed as text are sent as numbers; empty optional values are left out', () => {
    const stale = byKey(items, 'endpoint.stale-devices');
    expect(changedParams(stale.params, { staleDays: '120', platform: [] })).toEqual({ staleDays: 120 });
    expect(changedParams(stale.params, { staleDays: '90', platform: ['windows', 'macOS'] })).toEqual({
      platform: ['windows', 'macOS'],
    });
    // Params the form can't set never go out, whatever is in the state.
    const mailbox = byKey(items, 'm365.mailbox-storage');
    expect(changedParams(mailbox.params, { mailbox: 'someone' })).toEqual({});
  });

  it('catches a missing name, a bad retention and out-of-range numbers before sending', () => {
    const stale = byKey(items, 'endpoint.stale-devices');
    expect(
      formIssues(stale, { ...base, title: ' ', retain: '0', params: { staleDays: '10', platform: [] } }),
    ).toEqual({
      title: 'Give the schedule a name.',
      retain: 'Enter a whole number from 1 to 1000.',
      'param.staleDays': 'Enter 30 or more.',
    });
    expect(formIssues(users, { ...base, cron: { ...base.cron, cadence: 'custom', custom: ' ' } })).toEqual({
      cron: 'Enter a cron expression.',
    });
  });

  it('an edited schedule starts from its own params, format and delivery keys', () => {
    const portal = readSchedule(reportSchedules().find((s) => s.key === PORTAL_SCHEDULE_KEY))!;
    expect(formValuesFromSchedule(users, portal)).toEqual({
      params: { days: 30, includeDisabled: false, licensedOnly: false },
      format: 'xlsx',
      retain: '26',
      emailKey: 'AF_REPORT_RECIPIENTS',
      teamsKey: '',
      alertEmailKey: '',
      alertTeamsKey: 'AF_TEAMS_ALERTS_WEBHOOK',
    });
    expect(formatsFor({ exportFormats: ['csv'] })).toEqual(['csv', 'json']);
  });
});
