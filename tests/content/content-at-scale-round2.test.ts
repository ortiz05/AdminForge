import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Second content-scale round (plan 2026-10-17 Phase A1): endpoint device reports, the Intune apps page, inactive
// guests, directory changes, message center actions, the risky-users review and the app credential/registration
// reports filter, sort and label natively ($applyAdvanced, $withFields, native sort and grouping). Each test runs the
// definition's own transform on synthetic rows at the size it must handle, with the real 250 ms budget.

const { definitions } = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};
const NOW = '2026-10-17T12:00:00Z';
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 864e5).toISOString();
const transform = (
  id: string,
  ds: string,
  scope: { value?: unknown; ds?: Record<string, unknown>; params?: Record<string, unknown> },
) =>
  renderString(def(id).datasources[ds].transform, {
    now: NOW,
    user: {},
    env: {},
    params: {},
    ...scope,
  }) as Promise<Def>;

const OSES = ['Windows', 'Windows', 'Windows', 'iOS', 'Android', 'macOS'];
// Real fleets report hundreds of distinct builds (each cumulative update is a new revision): 4 releases × 150.
const RELEASES = ['26100', '22631', '19045', '22621'];
const build = (i: number) => `10.0.${RELEASES[i % RELEASES.length]}.${1000 + (i % 150)}`;
const device = (i: number, extra: Record<string, unknown> = {}) => {
  const os = OSES[i % OSES.length]!;
  return {
    id: `d${i}`,
    deviceName: `EX-${String(i).padStart(6, '0')}`,
    userPrincipalName: `user${i}@example.com`,
    operatingSystem: os,
    osVersion: os === 'Windows' ? build(i) : `${17 + (i % 3)}.${i % 5}`,
    isEncrypted: i % 9 !== 0,
    jailBroken: os === 'Windows' || os === 'macOS' ? 'Unknown' : i % 50 === 0 ? 'True' : 'False',
    complianceState: i % 4 === 0 ? 'noncompliant' : i % 4 === 1 ? 'inGracePeriod' : 'compliant',
    lastSyncDateTime: daysAgo(i % 120),
    managedDeviceOwnerType: i % 3 ? 'company' : 'personal',
    ...extra,
  };
};

describe('endpoint reports at scale', { retry: 2 }, () => {
  const devices = Array.from({ length: 30_000 }, (_, i) => device(i));

  it('endpoint.os-versions: 30k devices grouped per version, out-of-support devices picked natively', async () => {
    // A device Intune reports without an OS or version is counted, never a grouping key (which must be text).
    const withBlank = [...devices, { ...device(30_000), operatingSystem: null, osVersion: null }];
    const out = await transform('endpoint.os-versions', 'devices', { value: { value: withBlank } });
    expect(out.total).toBe(30_001);
    const win1022h2 = devices.filter((d) => d.osVersion?.startsWith('10.0.19045.')).length;
    const win1122h2 = devices.filter((d) => d.osVersion?.startsWith('10.0.22621.')).length;
    expect(out.unsupported).toBe(win1022h2 + win1122h2);
    expect(out.outdatedCount).toBe(win1022h2 + win1122h2);
    expect(out.outdated).toHaveLength(Math.min(win1022h2 + win1122h2, 10_000));
    expect(out.rows.at(-1)).toMatchObject({ release: 'Unknown OS or version', devices: 1 });
    expect(out.outdated[0]).toMatchObject({ release: 'Windows 10 22H2' });
    expect(out.rows.find((r: Def) => r.release === 'Windows 11 24H2')).toMatchObject({ supported: true });
  });

  it('endpoint.device-security-gaps: rooted first, unencrypted only where the OS can be, 10,000 on the page', async () => {
    const out = await transform('endpoint.device-security-gaps', 'deviceList', {
      value: { value: devices },
      params: { issue: 'any', os: 'Any', ownership: 'Any' },
    });
    const rooted = devices.filter((d) => d.jailBroken === 'True').length;
    const unencrypted = devices.filter(
      (d) => d.isEncrypted === false && ['Windows', 'macOS', 'Android', 'Linux'].includes(d.operatingSystem),
    ).length;
    expect(out.jailbroken).toBe(rooted);
    expect(out.unencrypted).toBe(unencrypted);
    expect(out.rows[0].jailbroken).toBe(true);
    expect(out.rows.every((r: Def) => r.operatingSystem !== 'iOS' || r.jailbroken)).toBe(true);
    const page = await transform('endpoint.device-security-gaps', 'devices', { value: out });
    expect(page.rows.length).toBe(Math.min(out.rows.length, 10_000));
    expect(def('endpoint.device-security-gaps').export).toMatchObject({
      data: 'deviceList.rows',
      maxRows: 100_000,
    });
  });

  it('endpoint.non-compliant-devices: not compliant first, likely cause set natively', async () => {
    const wanted = devices.filter((d) => d.complianceState !== 'compliant');
    const out = await transform('endpoint.non-compliant-devices', 'deviceList', {
      value: { value: wanted },
      params: { state: 'Both', os: 'Any', ownership: 'Any' },
    });
    expect(out.rows).toHaveLength(wanted.length);
    expect(out.rows[0].complianceState).toBe('noncompliant');
    expect(out.nonCompliant + out.grace).toBe(wanted.length);
    const silent = out.rows.find((r: Def) => Date.parse(r.lastSyncDateTime) < Date.parse(daysAgo(30)));
    expect(silent.likelyCause).toBe('Not checking in');
  });

  it('endpoint.stale-devices: 30k stale Entra devices with their next step, oldest first', async () => {
    const entra = Array.from({ length: 30_000 }, (_, i) => ({
      id: `e${i}`,
      displayName: `EX-${i}`,
      operatingSystem: OSES[i % OSES.length],
      trustType: i % 4 === 0 ? 'ServerAd' : 'AzureAd',
      accountEnabled: i % 2 === 0,
      approximateLastSignInDateTime: daysAgo(100 + (i % 300)),
    }));
    const out = await transform('endpoint.stale-devices', 'entraList', {
      value: { value: entra },
      params: { days: 90 },
    });
    expect(out.total).toBe(30_000);
    expect(out.hybrid).toBe(entra.filter((d) => d.trustType === 'ServerAd').length);
    expect(Date.parse(out.rows[0].approximateLastSignInDateTime)).toBeLessThanOrEqual(
      Date.parse(out.rows.at(-1).approximateLastSignInDateTime),
    );
    expect(out.rows.find((r: Def) => r.trustType === 'ServerAd').cleanup).toBe('Delete in AD');
  });

  it('endpoint.autopilot-not-enrolled: failed first, never contacted shown without a date', async () => {
    const ids = Array.from({ length: 30_000 }, (_, i) => ({
      id: `a${i}`,
      serialNumber: `SN${i}`,
      enrollmentState: ['notContacted', 'failed', 'enrolled', 'pendingReset'][i % 4],
      lastContactedDateTime: i % 3 === 0 ? '0001-01-01T00:00:00Z' : daysAgo(i % 60),
      groupTag: i % 5 ? `tag${i % 7}` : null,
    }));
    const out = await transform('endpoint.autopilot-not-enrolled', 'devices', {
      value: { value: ids },
      params: { state: 'any', minDays: 0 },
    });
    expect(out.notEnrolled).toBe(ids.filter((d) => d.enrollmentState !== 'enrolled').length);
    expect(out.rows[0].enrollmentState).toBe('failed');
    expect(out.rows.find((r: Def) => r.contacted === false).lastContactedDateTime).toBeNull();
  });

  it('endpoint.apps: 10k apps typed once per Graph type, filtered natively', async () => {
    const types = ['#microsoft.graph.win32LobApp', '#microsoft.graph.iosStoreApp', '#microsoft.graph.webApp'];
    const apps = Array.from({ length: 10_000 }, (_, i) => ({
      id: `x${i}`,
      displayName: `App ${i}`,
      publisher: i % 2 ? 'Contoso' : 'Fabrikam',
      '@odata.type': types[i % 3],
      assignments: i % 4 ? [{ id: 'g' }] : [],
    }));
    const out = await transform('endpoint.apps', 'apps', {
      value: { value: apps },
      params: { q: 'fabrikam', platform: 'Any', kind: 'Win32', assigned: 'Any' },
    });
    expect(out.total).toBe(10_000);
    expect(out.unassigned).toBe(apps.filter((a) => a.assignments.length === 0).length);
    expect(out.rows.every((r: Def) => r.kind === 'Win32' && r.publisher === 'Fabrikam')).toBe(true);
  });
});

describe('identity and M365 reports at scale', { retry: 2 }, () => {
  it('identity.inactive-guests: 20k inactive accounts filtered to enabled guests natively (the perf suite runs 100k)', async () => {
    const inactive = Array.from({ length: 20_000 }, (_, i) => ({
      id: `g${i}`,
      mail: `g${i}@d${i % 40}.example.com`,
      userType: i % 3 ? 'Guest' : 'Member',
      accountEnabled: i % 10 !== 0,
      externalUserState: 'Accepted',
      createdDateTime: daysAgo(400),
      signInActivity: { lastSuccessfulSignInDateTime: daysAgo(100 + (i % 200)) },
    }));
    const out = await transform('identity.inactive-guests', 'guests', {
      ds: {
        inactive: { value: inactive },
        never: { value: [] },
        invitations: { value: [] },
        guestCount: 20_000,
      },
      params: { days: 90, pending: 'Include' },
    });
    expect(out.total).toBe(inactive.filter((u) => u.userType === 'Guest' && u.accountEnabled).length);
    expect(out.domains).toHaveLength(6);
  });

  it('identity.directory-changes: 20k events labelled natively, newest 500 described', async () => {
    const names = ['Add member to role', 'Consent to application', 'Add owner to application', 'Update user'];
    const events = Array.from({ length: 20_000 }, (_, i) => ({
      id: `e${i}`,
      activityDateTime: daysAgo(i / 3000),
      activityDisplayName: names[i % 4],
      result: i % 11 ? 'success' : 'failure',
      initiatedBy: { user: { userPrincipalName: `a${i % 9}@example.com` } },
      targetResources: [{ displayName: 'Target', modifiedProperties: [] }],
    }));
    const out = await transform('identity.directory-changes', 'audits', {
      value: { value: events },
      ds: { rules: def('identity.directory-changes').datasources.rules.data },
    });
    expect(out.roles).toBe(5000);
    expect(out.consent).toBe(5000);
    expect(out.credentials).toBe(5000);
    expect(out.events).toBe(15_000); // "Update user" isn't a high-impact change
    expect(out.rows).toHaveLength(500);
    expect(out.listCapped).toBe(true);
    expect(out.rows[0].time >= out.rows[1].time).toBe(true);
  });

  it('m365.message-center-actions: overdue, due and major changes sorted natively', async () => {
    const posts = Array.from({ length: 3_000 }, (_, i) => ({
      id: `MC${i}`,
      title: `Post ${i}`,
      services: [i % 2 ? 'Microsoft Teams' : 'Exchange Online'],
      isMajorChange: i % 5 === 0,
      actionRequiredByDateTime: i % 3 === 0 ? null : daysAgo(20 - (i % 90)),
      lastModifiedDateTime: daysAgo(i % 80),
    }));
    const out = await transform('m365.message-center-actions', 'messages', {
      value: { value: posts },
      params: { horizon: 60, majorChanges: true, service: 'All' },
    });
    expect(out.rows[0].kind).toBe('overdue');
    expect(out.overdue + out.due).toBeGreaterThan(0);
    expect(out.byService.map((s: Def) => s.service).sort()).toEqual(['Exchange Online', 'Microsoft Teams']);
  });

  it('security.risky-users-review: 5k risky users, compromised first, detections looked up for the first 1,000', async () => {
    const users = Array.from({ length: 5_000 }, (_, i) => ({
      id: `u${i}`,
      userPrincipalName: `u${i}@example.com`,
      riskLevel: ['high', 'medium', 'low'][i % 3],
      riskState: i % 100 === 0 ? 'confirmedCompromised' : 'atRisk',
      riskLastUpdatedDateTime: daysAgo(i % 40),
    }));
    const out = await transform('security.risky-users-review', 'review', {
      ds: {
        users: { value: users },
        detections: { byUser: { u0: { count: 2, types: ['passwordSpray'], last: daysAgo(1) } } },
      },
      params: { level: 'all', minDays: 0 },
    });
    expect(out.rows[0].riskState).toBe('confirmedCompromised');
    expect(out.rows).toHaveLength(1000);
    expect(out).toMatchObject({ compromised: 50, listCapped: true, listed: 5000 });
    expect(out.rows.find((r: Def) => r.id === 'u0').detections30).toBe(2);
  });
});

describe('one row is still a list (JSONata returns a one-item sort as the item)', () => {
  it.each([
    [
      'endpoint.os-versions',
      'devices',
      'outdated',
      { value: { value: [{ ...device(2), osVersion: '10.0.19045.1', operatingSystem: 'Windows' }] } },
    ],
    [
      'endpoint.stale-devices',
      'entraList',
      'rows',
      {
        value: {
          value: [
            {
              id: 'e',
              operatingSystem: 'Windows',
              trustType: 'AzureAd',
              accountEnabled: true,
              approximateLastSignInDateTime: daysAgo(200),
            },
          ],
        },
        params: { days: 90 },
      },
    ],
    [
      'endpoint.device-security-gaps',
      'deviceList',
      'rows',
      { value: { value: [device(0)] }, params: { issue: 'any', os: 'Any', ownership: 'Any' } },
    ],
    [
      'endpoint.apps',
      'apps',
      'rows',
      {
        value: {
          value: [{ id: 'x', displayName: 'A', '@odata.type': '#microsoft.graph.webApp', assignments: [] }],
        },
        params: { q: '', platform: 'Any', kind: 'Any', assigned: 'Any' },
      },
    ],
  ] as const)('%s#%s', async (id, ds, field, scope) => {
    const out = await transform(id, ds, scope as never);
    expect(Array.isArray(out[field])).toBe(true);
    expect(out[field]).toHaveLength(1);
  });

  it('security.risky-users-review: detections say when their read was cut off', async () => {
    const out = await transform('security.risky-users-review', 'detections', {
      value: { value: [], truncated: true },
    });
    expect(out.partial).toBe(true);
    const review = await transform('security.risky-users-review', 'review', {
      ds: { users: { value: [] }, detections: { byUser: {}, partial: true } },
      params: { level: 'all', minDays: 0 },
    });
    expect(review.partial).toBe(true);
  });
});
