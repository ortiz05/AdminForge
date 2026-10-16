import {
  Navigation,
  PORTAL_SCHEDULE_PREFIX,
  PortalScheduleRequest,
  Schedule,
  validateReferences,
  type Definition,
} from '@adminforge/schemas';

// The `portal.` schedule namespace is reserved for schedules created in the portal: content schedules may not use it
// (cross-check), while the Schedule schema itself accepts it (portal definitions are validated with it). Plus the
// request contract for creating one and navigation's `listDefinitions`.

const schedule = (id: string) =>
  Schedule.parse({
    kind: 'schedule',
    id,
    version: '1.0.0',
    title: 'Weekly',
    owner: 'team',
    cron: '0 6 * * 1',
    job: { kind: 'contentHealth' },
  });

const check = (defs: Definition[]) =>
  validateReferences(defs.map((def) => ({ file: `${def.id}.yaml`, def }))).map(
    (e) => `${e.file} ${e.path}: ${e.message}`,
  );

describe('reserved portal. schedule namespace', () => {
  it('the Schedule schema accepts portal. ids', () => {
    expect(schedule('portal.identity-inactive-users-3f9a2c').id).toBe(
      'portal.identity-inactive-users-3f9a2c',
    );
    expect(PORTAL_SCHEDULE_PREFIX).toBe('portal.');
  });

  it('a content schedule under portal. is a content error; other kinds (portal.navigation) are fine', () => {
    const nav = Navigation.parse({
      kind: 'navigation',
      id: 'portal.navigation',
      version: '1.2.0',
      title: 'Navigation',
      owner: 'portal-admins',
      sections: [{ key: 'reports', label: 'Reports', icon: 'chart-bar' }],
    });
    expect(check([nav, schedule('reports.weekly')])).toEqual([]);
    expect(check([nav, schedule('portal.weekly')])).toEqual([
      'portal.weekly.yaml id: Schedule ids starting with "portal." are reserved for schedules created in the portal. Use <section>.<name>, e.g. reports.weekly-inactive-users.',
    ]);
  });
});

describe('PortalScheduleRequest', () => {
  const base = {
    title: ' Weekly ',
    cron: '0 6 * * 1',
    timezone: 'Europe/London',
    job: { kind: 'report', ref: 'identity.inactive-users', format: 'xlsx' },
  };
  it('defaults enabled and retain; trims the title', () => {
    expect(PortalScheduleRequest.parse(base)).toEqual({
      title: 'Weekly',
      cron: '0 6 * * 1',
      timezone: 'Europe/London',
      enabled: true,
      job: { kind: 'report', ref: 'identity.inactive-users', format: 'xlsx', retain: 26 },
    });
  });
  it.each([
    ['another job kind', { job: { ...base.job, kind: 'playbook' } }],
    ['an unknown format', { job: { ...base.job, format: 'pdf' } }],
    ['retain 0', { job: { ...base.job, retain: 0 } }],
    ['an unknown time zone', { timezone: 'Mars/Olympus' }],
    ['a title over 120 characters', { title: 'x'.repeat(121) }],
    ['a non-configuration key', { job: { ...base.job, emailKey: 'ops@example.com' } }],
  ])('refuses %s', (_label, over) =>
    expect(PortalScheduleRequest.safeParse({ ...base, ...over }).success).toBe(false),
  );
});

describe('navigation listDefinitions', () => {
  const nav = (section: Record<string, unknown>) =>
    Navigation.safeParse({
      kind: 'navigation',
      id: 'portal.navigation',
      version: '1.0.0',
      title: 'Navigation',
      owner: 'portal-admins',
      sections: [{ key: 'reports', label: 'Reports', icon: 'chart-bar', ...section }],
    });
  it('is an optional boolean', () => {
    expect(nav({}).success).toBe(true);
    expect(nav({ listDefinitions: false }).success).toBe(true);
    expect(nav({ listDefinitions: 'no' }).success).toBe(false);
  });
});
