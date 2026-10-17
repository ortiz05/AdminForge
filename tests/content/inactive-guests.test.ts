import path from 'node:path';
import { AUTOMATION_GRAPH_ROLES } from '@adminforge/cli/src/provision/catalog';
import { renderTemplate } from '@adminforge/expressions';
import { loadContentDir, validateCron } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// identity.inactive-guests (report) and reports.inactive-guests-weekly (its Monday schedule).

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const byId = <T>(id: string): T => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def as unknown as T;
};

interface Report {
  requires: { scopes: { graph: string[] } };
  datasources: { guests: { transform: string } };
  layout: Array<{
    widget: string;
    id?: string;
    rowActions?: Array<{ playbook: string; inputs: Record<string, string> }>;
  }>;
  export: { formats: string[] };
}
interface Schedule {
  cron: string;
  timezone: string;
  enabled: boolean;
  identity: string;
  job: {
    kind: string;
    ref: string;
    params: Record<string, unknown>;
    delivery: Array<{ type: string; format: string }>;
  };
  requires: { scopes: { graph: string[] }; licences: string[] };
}
interface Out {
  rows: Array<{ id: string; daysInactive: number; invitation: string; homeDomain: string | null }>;
  total: number;
  pending: number;
  allGuests: number;
  domains: Array<{ domain: string; guests: number }>;
}

const report = byId<Report>('identity.inactive-guests');
const schedule = byId<Schedule>('reports.inactive-guests-weekly');

// The scheduled run time: Monday 2026-10-12 06:15 UTC.
const now = '2026-10-12T06:15:00Z';
const guest = (id: string, extra: Record<string, unknown>) => ({
  id,
  displayName: id,
  userPrincipalName: `${id}_example.com#EXT#@exampleorg.onmicrosoft.com`,
  userType: 'Guest',
  accountEnabled: true,
  externalUserState: 'Accepted',
  createdDateTime: '2025-01-01T00:00:00Z',
  ...extra,
});
// Directory objects as Graph returns them (`value` of GET /users after paging).
const users = [
  guest('g-old', {
    mail: 'old@partner.example',
    signInActivity: { lastSuccessfulSignInDateTime: '2026-06-14T06:15:00Z' },
  }), // 120 days
  guest('g-recent', {
    mail: 'recent@partner.example',
    signInActivity: { lastSuccessfulSignInDateTime: '2026-10-02T09:00:00Z' },
  }),
  guest('g-boundary', {
    mail: 'edge@partner.example',
    signInActivity: { lastSuccessfulSignInDateTime: '2026-07-14T06:15:00Z' },
  }), // exactly 90
  guest('g-89', {
    mail: 'g89@partner.example',
    signInActivity: { lastSuccessfulSignInDateTime: '2026-07-15T06:15:00Z' },
  }),
  guest('g-pending', {
    mail: 'invitee@vendor.example',
    externalUserState: 'PendingAcceptance',
    externalUserStateChangeDateTime: '2026-03-26T06:15:00Z', // invited 200 days ago, never redeemed
    signInActivity: {
      lastSignInDateTime: null,
      lastNonInteractiveSignInDateTime: null,
      lastSuccessfulSignInDateTime: null,
    },
  }),
  guest('g-never', { mail: 'never@contractor.example', createdDateTime: '2026-07-09T06:15:00Z' }), // accepted, no sign-in, 95 days old
  guest('g-disabled', {
    mail: 'blocked@partner.example',
    accountEnabled: false,
    signInActivity: { lastSuccessfulSignInDateTime: '2025-12-16T06:15:00Z' },
  }),
  // Only the older interactive/non-interactive fields: 2.0 keys on the last successful sign-in, so this guest is listed
  // as having no successful sign-in recorded.
  guest('g-noninteractive', {
    mail: 'app@partner.example',
    signInActivity: {
      lastSignInDateTime: '2026-05-15T06:15:00Z',
      lastNonInteractiveSignInDateTime: '2026-10-07T06:15:00Z',
    },
  }),
  {
    id: 'm-member',
    userType: 'Member',
    accountEnabled: true,
    createdDateTime: '2025-01-01T00:00:00Z',
    signInActivity: { lastSuccessfulSignInDateTime: '2025-09-01T00:00:00Z' },
  },
];
// 2.0: Microsoft narrows three reads and `guests` (a static datasource) combines them. Each read is given what
// Graph's own filter would return: inactive = last successful sign-in older than the window (any user type);
// never = guests created before the window; invitations = unredeemed guest invitations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type User = Record<string, any>;
const cutoff = Date.parse(now) - 90 * 864e5;
const reads = (value: User[]) => ({
  inactive: {
    value: value.filter(
      (u) =>
        u.signInActivity?.lastSuccessfulSignInDateTime &&
        Date.parse(u.signInActivity.lastSuccessfulSignInDateTime) <= cutoff,
    ),
  },
  never: { value: value.filter((u) => u.userType === 'Guest' && Date.parse(u.createdDateTime) <= cutoff) },
  invitations: {
    value: value.filter((u) => u.userType === 'Guest' && u.externalUserState === 'PendingAcceptance'),
  },
  guestCount: value.filter((u) => u.userType === 'Guest').length,
});
const run = (params: Record<string, unknown>, value: User[] = users) =>
  renderTemplate<Out>(report.datasources.guests.transform, { ds: reads(value), params, now });

describe('identity.inactive-guests transform', () => {
  it('lists enabled guests: unredeemed invitations, no successful sign-in, then inactive (oldest first)', async () => {
    const out = await run({ days: 90, pending: 'Include' });
    // g-noninteractive has no successful sign-in recorded (only the older interactive fields), so it is listed as
    // such (the older ones first); g-never was created 95 days ago and never signed in.
    expect(out.rows.map((r: User) => [r.id, r.state, r.invitation])).toEqual([
      ['g-pending', 'pending', 'Pending'],
      ['g-noninteractive', 'never', 'Accepted'],
      ['g-never', 'never', 'Accepted'],
      ['g-old', 'inactive', 'Accepted'],
      ['g-boundary', 'inactive', 'Accepted'],
    ]);
    expect(out).toMatchObject({ total: 5, pending: 1, never: 2, allGuests: 8, partial: false });
    expect(out.domains[0]).toEqual({ domain: 'partner.example', guests: 3 });
  });

  it('can leave out or isolate unredeemed invitations', async () => {
    expect((await run({ days: 90, pending: 'Exclude' })).rows.map((r) => r.id)).toEqual([
      'g-noninteractive',
      'g-never',
      'g-old',
      'g-boundary',
    ]);
    expect((await run({ days: 90, pending: 'Only' })).rows.map((r) => r.id)).toEqual(['g-pending']);
  });

  it('handles a tenant without guests', async () => {
    expect(await run({ days: 90, pending: 'Include' }, [])).toEqual({
      rows: [],
      total: 0,
      pending: 0,
      never: 0,
      domains: [],
      domainsSampled: false,
      allGuests: 0,
      partial: false,
    });
  });

  it('keeps an invitation without a creation date (pre-2018 accounts) and labels older guests without a state', async () => {
    const out = await run({ days: 90, pending: 'Include' }, [
      guest('g-undated', {
        createdDateTime: null,
        externalUserState: 'PendingAcceptance',
        mail: 'u@vendor.example',
      }),
      guest('g-dated', { externalUserState: 'PendingAcceptance', mail: 'd@vendor.example' }),
      guest('g-nostate', {
        externalUserState: null,
        mail: 'n@partner.example',
        signInActivity: { lastSuccessfulSignInDateTime: '2026-01-01T00:00:00Z' },
      }),
    ]);
    expect(out.rows.map((r: User) => [r.id, r.invitation])).toEqual([
      ['g-undated', 'Pending'],
      ['g-dated', 'Pending'],
      ['g-nostate', 'Other'],
    ]);
  });

  it('one listed guest is still a list', async () => {
    const out = await run({ days: 90, pending: 'Include' }, [users[0]!]);
    expect(Array.isArray(out.rows)).toBe(true);
    expect(out.rows).toHaveLength(1);
  });
});

describe('identity.inactive-guests report', () => {
  it('exports CSV and Excel', () =>
    expect(report.export.formats).toEqual(expect.arrayContaining(['csv', 'xlsx'])));

  it('offers Block sign-in on a row, bound to that guest', async () => {
    const table = report.layout.find((b) => b.widget === 'table' && b.id === 'guests');
    const action = table?.rowActions?.find((a) => a.playbook === 'identity.disable-user');
    expect(action).toBeDefined();
    expect(
      await renderTemplate(action!.inputs, { row: { id: '00000000-0000-4000-8000-000000000107' } }),
    ).toEqual({ userId: '00000000-0000-4000-8000-000000000107' });
  });
});

describe('reports.inactive-guests-weekly', () => {
  it('runs the 90-day report every Monday morning as the automation identity', () => {
    expect(validateCron(schedule.cron)).toBeUndefined();
    const [minute, hour, dom, month, dow] = schedule.cron.split(/\s+/);
    expect([dom, month, dow]).toEqual(['*', '*', '1']);
    expect(minute).toMatch(/^\d{1,2}$/);
    expect(hour).toMatch(/^\d{1,2}$/);
    expect(Number(hour)).toBeLessThan(12);
    expect(schedule).toMatchObject({
      enabled: true,
      identity: 'automation',
      job: { kind: 'report', ref: 'identity.inactive-guests', params: { days: 90, pending: 'Include' } },
    });
    expect(schedule.job.delivery).toEqual([expect.objectContaining({ type: 'file', format: 'xlsx' })]);
  });

  it('needs only application permissions the automation identity is provisioned with', () => {
    expect(schedule.requires.scopes.graph).toEqual(expect.arrayContaining(report.requires.scopes.graph));
    for (const scope of schedule.requires.scopes.graph) expect(AUTOMATION_GRAPH_ROLES).toContain(scope);
    expect(schedule.requires.licences).toContain('signInLogs');
  });
});
