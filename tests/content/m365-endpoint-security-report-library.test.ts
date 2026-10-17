import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatasourceRunner, fixtureRunner } from '@adminforge/api/src/datasources/executor';
import { FsDefinitionSource, registryFrom } from '@adminforge/api/src/definitions';
import { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
import type { OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import { createFixtureFetch } from '@adminforge/connectors';
import { renderString } from '@adminforge/expressions';
import { loadContentDir, validateCron, type Probe } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// The Microsoft 365, endpoint (Intune) and security (Defender) report library: each report's datasources run the way
// DATA_MODE=fixtures runs them (params defaulted and validated, the fixture picked, the transform applied), plus the
// weekly/daily schedules that deliver them and the two probes that alert between runs.

const NOW = '2026-10-15T12:00:00Z';
const CONTENT = path.join(repoRoot, 'portal/content');
const FIXTURES = path.join(repoRoot, 'tests/fixtures');
const USER = { oid: 'automation', upn: 'automation', name: 'Automation identity', roles: ['Portal.Reader'] };

const loaded = await loadContentDir(CONTENT);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};

const registry = registryFrom(new FsDefinitionSource(CONTENT), 'fs');
const now = () => new Date(NOW);
const runner = new DatasourceRunner({
  definitions: registry,
  outbound: createOutboundExecutor({
    config: {
      DATA_MODE: 'fixtures',
      AF_SPO_TENANT_NAME: undefined,
      OUTBOUND_CONCURRENCY: 4,
      OUTBOUND_USER_CONCURRENCY: 4,
      OUTBOUND_TIMEOUT_MS: 30_000,
      TOKEN_CACHE_KEY: undefined,
    } as never,
    broker: null,
    auth: null,
    automation: null,
    fetch: createFixtureFetch(FIXTURES),
    env: () => ({}),
    now,
  }),
  runner: fixtureRunner(FIXTURES),
  env: () => ({}),
  now,
});
afterAll(() => registry.close());

/** One datasource of a report, exactly as the portal runs it in mock mode. */
async function run(id: string, datasource: string, params: Record<string, unknown> = {}): Promise<Def> {
  // The exact version, so retired definitions (kept for history, never the latest) still run here.
  const page = await runner.page(id, def(id).version);
  const values = await runner.prepareParams(page, params, USER);
  const out = await runner.run({
    identity: { kind: 'automation', mode: 'read' },
    user: USER,
    page,
    datasource,
    params: values,
    correlationId: 'content-test',
    noCache: true,
  });
  return out.data;
}
const transform = (id: string, ds: string, scope: Record<string, unknown>) =>
  renderString(def(id).datasources[ds].transform, {
    now: NOW,
    user: USER,
    env: {},
    ...scope,
  }) as Promise<Def>;
const pick = (rows: Def[], ...fields: string[]) => rows.map((r) => fields.map((f) => r[f]));

const REPORTS = {
  'm365.inactive-licensed-users': { schedule: 'reports.inactive-licensed-users-weekly', licences: [] },
  'm365.mailbox-storage': { schedule: 'reports.mailbox-storage-weekly', licences: ['exchange'] },
  'm365.shared-mailbox-sign-in': {
    schedule: 'reports.shared-mailbox-sign-in-weekly',
    licences: ['exchange'],
  },
  'm365.teams-activity': { schedule: 'reports.teams-activity-weekly', licences: ['teams'] },
  'm365.sharepoint-site-usage': {
    schedule: 'reports.sharepoint-site-usage-weekly',
    licences: ['sharepoint'],
  },
  'm365.onedrive-usage': { schedule: 'reports.onedrive-usage-weekly', licences: ['sharepoint'] },
  'm365.service-health-review': { schedule: 'reports.service-health-review-weekly', licences: [] },
  'm365.message-center-actions': { schedule: 'reports.message-center-actions-weekly', licences: [] },
  'endpoint.device-security-gaps': { schedule: 'reports.device-security-gaps-daily', licences: ['intune'] },
  'endpoint.os-versions': { schedule: 'reports.os-versions-weekly', licences: ['intune'] },
  'endpoint.compliance-policy-gaps': {
    schedule: 'reports.compliance-policy-gaps-weekly',
    licences: ['intune'],
  },
  'endpoint.autopilot-not-enrolled': {
    schedule: 'reports.autopilot-not-enrolled-weekly',
    licences: ['intune'],
  },
  'security.alerts-summary': { schedule: 'reports.alerts-summary-weekly', licences: ['defender'] },
  'security.secure-score-summary': { schedule: 'reports.secure-score-summary-weekly', licences: [] },
  'security.risky-users-review': {
    schedule: 'reports.risky-users-review-daily',
    licences: ['identityProtection'],
  },
} as const;

describe('report library definitions', () => {
  it.each(Object.entries(REPORTS))(
    '%s is a Reader report in the Reports section with CSV/XLSX export and its licences',
    (id, { licences }) => {
      const r = def(id);
      expect(r.kind).toBe('report');
      expect(r.nav).toMatchObject({ section: 'reports' });
      expect(r.requires.portalRoles).toEqual(['Portal.Reader']);
      expect(r.export.formats).toEqual(expect.arrayContaining(['csv', 'xlsx']));
      expect(r.requires.licences ?? []).toEqual(licences);
      // The exported table (bound to export.data, else the first, as the export picks it) has columns.
      const tables = r.layout.filter((b: Def) => b.widget === 'table');
      const table = tables.find((b: Def) => b.data === r.export.data) ?? tables[0];
      expect(table?.columns.length).toBeGreaterThan(3);
    },
  );

  it('reads only (no write scopes) and names Graph permissions the Read app or provisioning knows', () => {
    for (const id of Object.keys(REPORTS)) {
      const graph: string[] = def(id).requires.scopes.graph ?? [];
      expect([id, graph.filter((s) => /ReadWrite|\.Write\b/.test(s))]).toEqual([id, []]);
    }
  });
});

describe('m365.inactive-licensed-users', () => {
  it('lists licensed people idle in every workload for 90 days, never-active first; new licences are left out', async () => {
    // 2.0: native filters on the report's own rows (no per-user mapping, so no computed days): never active first.
    const out = await run('m365.inactive-licensed-users', 'users');
    const rows = pick(out.rows, 'userPrincipalName', 'activity');
    expect(rows[0]).toEqual(['eli.obrien@example.com', 'never']);
    expect(rows.slice(1).sort()).toEqual([
      ['dana@example.com', 'inactive'],
      ['finance.temp@example.com', 'inactive'],
      ['kiosk@example.com', 'inactive'],
    ]);
    expect(out).toMatchObject({ total: 4, never: 1, licences: 5, licensedUsers: 8, concealed: false });
  });

  it('can ask about one workload (a Teams licence nobody uses)', async () => {
    const out = await run('m365.inactive-licensed-users', 'users', { workload: 'teams', days: 60 });
    expect(out.rows.map((r: Def) => r.userPrincipalName)).toContain('blake@example.com');
    expect(out.rows.map((r: Def) => r.userPrincipalName)).not.toContain('finance.temp@example.com');
  });

  it('says so when the tenant conceals user names, and offers no link for hashed names', async () => {
    const out = await transform('m365.inactive-licensed-users', 'userList', {
      params: { days: 90, workload: 'any' },
      value: {
        value: [
          {
            userPrincipalName: '5B2F0A8C1D3E4F5061728394A5B6C7D8',
            displayName: '0A1B2C3D4E5F',
            isDeleted: false,
            hasExchangeLicense: true,
            exchangeLastActivityDate: '2026-01-02',
            exchangeLicenseAssignDate: '2025-01-01',
            assignedProducts: ['MICROSOFT 365 E3'],
          },
        ],
      },
    });
    expect(out).toMatchObject({ concealed: true, total: 1 });
    const action = def('m365.inactive-licensed-users').layout.find((b: Def) => b.widget === 'table')
      .rowActions[0];
    expect(await renderString(action.when, { row: out.rows[0] })).toBe(false);
  });
});

describe('m365.mailbox-storage', () => {
  it('puts mailboxes over and near their quota first, then inactive ones', async () => {
    const out = await run('m365.mailbox-storage', 'mailboxes');
    const rows = pick(out.rows, 'userPrincipalName', 'state');
    expect(rows.slice(0, 3)).toEqual([
      ['ceo@example.com', 'full'],
      ['blake@example.com', 'nearQuota'],
      ['reception@example.com', 'nearQuota'],
    ]);
    // Then the inactive ones, never active first, then the longest idle.
    expect(rows.slice(3).sort()).toEqual([
      ['dana@example.com', 'inactive'],
      ['eli.obrien@example.com', 'inactive'],
      ['invoices@example.com', 'inactive'],
    ]);
    expect(out.listCapped).toBe(false);
    expect(out).toMatchObject({ full: 1, nearQuota: 3, inactive: 3, mailboxes: 8 });
    expect(out.largest[0]).toMatchObject({ mailbox: 'Casey Director' });
  });

  it('honours the threshold and the view', async () => {
    const quota = await run('m365.mailbox-storage', 'mailboxes', { view: 'quota', threshold: 95 });
    expect(quota.rows.map((r: Def) => r.userPrincipalName)).toEqual(['ceo@example.com', 'blake@example.com']);
    const all = await run('m365.mailbox-storage', 'mailboxes', { view: 'all' });
    expect(all.rows).toHaveLength(8);
  });
});

describe('m365.shared-mailbox-sign-in', () => {
  it('lists shared mailboxes whose account can sign in, with the object id Block sign-in needs', async () => {
    const out = await run('m365.shared-mailbox-sign-in', 'mailboxes');
    expect(pick(out.rows, 'primarySmtpAddress', 'signIn', 'canBlock')).toEqual([
      ['support@example.com', 'allowed', true],
      ['reception@example.com', 'allowed', true],
      ['events@example.com', 'unknown', false],
    ]);
    expect(out).toMatchObject({ allowed: 2, unknown: 1, blocked: 2, total: 5 });
    const all = await run('m365.shared-mailbox-sign-in', 'mailboxes', { includeBlocked: true });
    expect(all.rows).toHaveLength(5);
  });

  it('wires Block sign-in to identity.disable-user for that account', async () => {
    const table = def('m365.shared-mailbox-sign-in').layout.find((b: Def) => b.widget === 'table');
    const action = table.rowActions.find((a: Def) => a.playbook === 'identity.disable-user');
    const row = { externalDirectoryObjectId: '10000000-0000-4000-8000-000000000c03', canBlock: true };
    expect(await renderString(action.when, { row })).toBe(true);
    expect(await renderString(action.inputs.userId, { row })).toBe(row.externalDirectoryObjectId);
  });

  it('pins the extended mailbox summary script everywhere it is used', () => {
    const text = readFileSync(path.join(CONTENT, 'scripts/exchange/Get-MailboxSummary.ps1'));
    const sha = createHash('sha256').update(text).digest('hex');
    const pins: Array<[string, string]> = [
      ['m365.shared-mailbox-sign-in', 'mailboxes'],
      ['m365.shared-mailboxes', 'shared'],
      ['m365.mailboxes', 'mailboxes'],
    ];
    for (const [id, ds] of pins) expect([id, def(id).datasources[ds].sha256]).toEqual([id, sha]);
  });

  it('shows the sign-in state on the Shared mailboxes page too', async () => {
    const out = await run('m365.shared-mailboxes', 'shared', { q: '', licence: 'Any' });
    expect(out.signInAllowed).toBe(2);
  });
});

describe('m365.teams-activity', () => {
  it('lists inactive teams (never used first) and counts public and guest-active teams', async () => {
    const out = await run('m365.teams-activity', 'teams');
    expect(out.rows.map((r: Def) => r.teamName).sort()).toEqual([
      'Marketing 2024 Launch',
      'Social Club',
      'Test Team (never used)',
    ]);
    expect(out.rows.every((r: Def) => r.activity === 'inactive')).toBe(true);
    expect(out).toMatchObject({ inactive: 3, public: 2, inactivePublic: 1, guests: 2, total: 6 });
    const guests = await run('m365.teams-activity', 'teams', { view: 'guests' });
    expect(guests.rows.map((r: Def) => r.teamName).sort()).toEqual(['Partner Extranet', 'Project Phoenix']);
  });

  it('reads counts from details[0] or from the row itself, and spots concealed team ids', async () => {
    const out = await transform('m365.teams-activity', 'teams', {
      params: { view: 'all', days: 90 },
      value: {
        value: [
          {
            teamId: 'A1B2C3',
            teamName: 'F00D',
            teamType: 'Private',
            lastActivityDate: '2026-10-01',
            guests: 3,
          },
        ],
      },
    });
    expect(out.rows[0]).toMatchObject({ guests: 3, activity: 'active' });
    expect(out.guests).toBe(1);
    expect(out.concealed).toBe(true);
  });
});

describe('m365.sharepoint-site-usage and m365.onedrive-usage', () => {
  it('flags sites near the storage limit first, then inactive ones', async () => {
    const out = await run('m365.sharepoint-site-usage', 'sites');
    const rows = pick(out.rows, 'siteUrl', 'state');
    expect(rows[0]).toEqual(['https://exampleorg.sharepoint.com/sites/finance-archive', 'storage']);
    expect(rows.slice(1).sort()).toEqual([
      ['https://exampleorg.sharepoint.com/sites/hr-2025', 'inactive'],
      ['https://exampleorg.sharepoint.com/sites/intranet-pilot', 'inactive'],
      ['https://exampleorg.sharepoint.com/sites/project-x', 'inactive'],
    ]);
    expect(out).toMatchObject({ inactive: 3, nearLimit: 1, sites: 5, concealed: false });
  });

  it('flags OneDrives of people who stopped working in them', async () => {
    const out = await run('m365.onedrive-usage', 'accounts', { view: 'inactive' });
    expect(out.rows.map((r: Def) => r.ownerPrincipalName).sort()).toEqual([
      'dana@example.com',
      'eli.obrien@example.com',
      'finance.temp@example.com',
    ]);
    expect(out).toMatchObject({ inactive: 3, nearLimit: 1, accounts: 5 });
  });
});

describe('m365.service-health-review', () => {
  it('summarises incidents and advisories of the period with their duration', async () => {
    const out = await run('m365.service-health-review', 'issues');
    expect(out).toMatchObject({
      incidents: 4,
      advisories: 5,
      open: 3,
      openIncidents: 1,
      incidentHours: 15.5,
    });
    expect(out.rows[0]).toMatchObject({ id: 'TM912345', state: 'open', hours: 5.5 });
    expect(out.rows.find((r: Def) => r.id === 'EX910442')).toMatchObject({ state: 'resolved', hours: 5 });
    expect(out.byService[0]).toEqual({ service: 'Microsoft Teams', incidents: 1, advisories: 1 });
  });

  it('narrows to a shorter period and one type', async () => {
    const out = await run('m365.service-health-review', 'issues', { days: 7, classification: 'incident' });
    expect(out.rows.map((r: Def) => r.id)).toEqual(['TM912345', 'EX910442']);
  });
});

describe('m365.message-center-actions', () => {
  it('lists overdue posts, then those due in the window, then major changes', async () => {
    const out = await run('m365.message-center-actions', 'messages');
    expect(pick(out.rows, 'id', 'kind')).toEqual([
      ['MC909100', 'overdue'],
      ['MC910333', 'due'],
      ['MC911870', 'due'],
      ['MC907412', 'due'],
      ['MC912001', 'due'],
      ['MC908765', 'due'],
      ['MC911455', 'due'],
      ['MC910120', 'due'],
      ['MC905321', 'major'],
    ]);
    expect(out).toMatchObject({ overdue: 1, dueSoon: 2, due: 7 });
  });

  it('filters by service and can leave out major changes', async () => {
    const exchange = await run('m365.message-center-actions', 'messages', { service: 'Exchange Online' });
    expect(exchange.rows.map((r: Def) => r.id)).toEqual(['MC911870', 'MC905321']);
    const noMajor = await run('m365.message-center-actions', 'messages', {
      horizon: 30,
      majorChanges: false,
    });
    expect(noMajor.rows.every((r: Def) => r.kind !== 'major')).toBe(true);
  });
});

describe('endpoint reports', () => {
  it('endpoint.device-security-gaps lists jailbroken devices first, then unencrypted ones', async () => {
    const out = await run('endpoint.device-security-gaps', 'devices');
    expect(pick(out.rows, 'id', 'issue')).toEqual([
      ['00000000-0000-4000-8000-000000000610', 'jailbroken'],
      ['00000000-0000-4000-8000-000000000606', 'unencrypted'],
      ['00000000-0000-4000-8000-000000000611', 'unencrypted'],
    ]);
    expect(out).toMatchObject({ unencrypted: 2, jailbroken: 1, companyOwned: 2 });
    const rooted = await run('endpoint.device-security-gaps', 'devices', { issue: 'jailbroken' });
    expect(rooted.rows.map((r: Def) => r.deviceName)).toEqual(['Galaxy A15 – J. Okafor']);
  });

  it('endpoint.os-versions (1.1) also lists the devices on out-of-support releases', async () => {
    const out = await run('endpoint.os-versions', 'devices');
    expect(def('endpoint.os-versions').version).toBe('1.1.0');
    expect(out.unsupported).toBe(2);
    expect(pick(out.outdated, 'deviceName', 'release')).toEqual([
      ['EX-LT-0193', 'Windows 10 22H2'],
      ['EX-LT-0077', 'Windows 11 22H2'],
    ]);
  });

  it('endpoint.compliance-policy-gaps finds uncovered platforms and policies that apply to nobody', async () => {
    const out = await run('endpoint.compliance-policy-gaps', 'gaps');
    expect(pick(out.rows, 'key', 'finding')).toEqual([
      ['platform|macOS', 'noPolicy'],
      ['policy|00000000-0000-4000-8000-000000000704', 'unassigned'],
      ['platform|Windows', 'groupsOnly'],
    ]);
    expect(out).toMatchObject({
      uncovered: 1,
      uncoveredDevices: 96,
      unassigned: 1,
      compliantByDefault: false,
    });
    expect(await run('endpoint.compliance-policy-gaps', 'noPolicy')).toEqual({ devices: 102, found: true });
  });

  it('endpoint.compliance-policy-gaps puts the compliant-by-default setting first when it is on', async () => {
    const out = await transform('endpoint.compliance-policy-gaps', 'gaps', {
      params: { includeOk: false },
      ds: {
        policies: { value: [] },
        fleet: {
          overview: {
            deviceOperatingSystemSummary: { windowsCount: 3, macOSCount: 0, iosCount: 0, androidCount: 0 },
          },
          settings: { settings: { secureByDefault: false } },
        },
      },
    });
    expect(pick(out.rows, 'key', 'finding')).toEqual([
      ['setting|secureByDefault', 'compliantByDefault'],
      ['platform|Windows', 'noPolicy'],
    ]);
    expect(out.compliantByDefault).toBe(true);
  });

  it('endpoint.autopilot-not-enrolled lists failed and blocked devices first', async () => {
    const out = await run('endpoint.autopilot-not-enrolled', 'devices');
    expect(pick(out.rows, 'serialNumber', 'enrollmentState')).toEqual([
      ['EXSN000631', 'failed'],
      ['EXSN000611', 'failed'],
      ['EXSN000632', 'blocked'],
      ['EXSN000610', 'notContacted'],
      ['EXSN000634', 'notContacted'],
      ['EXSN000633', 'pendingReset'],
    ]);
    expect(out).toMatchObject({ notEnrolled: 6, failed: 3, neverContacted: 2, noGroupTag: 2 });
    const failed = await run('endpoint.autopilot-not-enrolled', 'devices', { state: 'failed' });
    expect(failed.rows).toHaveLength(3);
  });
});

describe('security reports', () => {
  it('security.alerts-summary counts alerts by severity, status and product', async () => {
    const out = await run('security.alerts-summary', 'alerts', { days: 30 });
    expect(out).toMatchObject({ total: 15, openHigh: 4, open: 14, unassigned: 8, meanHoursToResolve: 24 });
    expect(out.bySeverity[0]).toEqual({ severity: 'High', new: 2, inProgress: 2, resolved: 1 });
    expect(out.rows[0]).toMatchObject({ severity: 'high', open: true, product: 'Entra ID Protection' });
    const open = await run('security.alerts-summary', 'alerts', {
      days: 30,
      severity: 'high',
      status: 'open',
    });
    expect(open.rows).toHaveLength(4);
  });

  it('security.secure-score-summary reports the score, its change and the top actions', async () => {
    const history = await run('security.secure-score-summary', 'history');
    expect(history).toMatchObject({ percent: 0.6261, change7: 0.0112, change30: 0.0546, allTenants: 0.5154 });
    const actions = await run('security.secure-score-summary', 'actions', { top: 10 });
    expect(actions.rows[0]).toMatchObject({ id: 'mdo_autoforwardingmode', pointsAvailable: 8 });
    expect(actions).toMatchObject({ open: 7, quickWins: 3, quickWinPoints: 7.7 });
    const quick = await run('security.secure-score-summary', 'actions', { quickWins: true, top: 1000 });
    expect(quick.rows.every((r: Def) => r.quickWin)).toBe(true);
  });

  it('security.risky-users-review joins each risky user with their detections of the last 30 days', async () => {
    const out = await run('security.risky-users-review', 'review');
    expect(out.rows[0]).toMatchObject({
      userPrincipalName: 'eli.obrien@example.com',
      riskState: 'confirmedCompromised',
    });
    expect(out.rows.find((r: Def) => r.userPrincipalName === 'avery@example.com')).toMatchObject({
      riskLevel: 'high',
      detections30: 3,
      detectionTypes: ['passwordSpray', 'unfamiliarFeatures', 'suspiciousInboxManipulationRules'],
    });
    expect(out.rows.some((r: Def) => r.userPrincipalName === 'f.employee@example.com')).toBe(false);
    expect(out).toMatchObject({ high: 1, medium: 4, compromised: 1 });
    const high = await run('security.risky-users-review', 'review', { level: 'high' });
    expect(high.rows.map((r: Def) => r.userPrincipalName)).toEqual([
      'eli.obrien@example.com',
      'avery@example.com',
    ]);
  });
});

describe('report schedules', () => {
  it.each(Object.entries(REPORTS))(
    '%s is delivered by its schedule as the automation identity',
    (id, { schedule, licences }) => {
      const s = def(schedule);
      expect(validateCron(s.cron)).toBeUndefined();
      expect(s).toMatchObject({ kind: 'schedule', identity: 'automation', overlap: 'skip', timezone: 'UTC' });
      expect(s.job).toMatchObject({ kind: 'report', ref: id });
      // Job params must be params the report declares (validated), pinned so the archive stays comparable.
      for (const k of Object.keys(s.job.params ?? {})) expect(def(id).params).toHaveProperty(k);
      expect(s.job.delivery).toEqual([
        expect.objectContaining({
          type: 'file',
          format: 'xlsx',
          path: expect.stringMatching(/\{date\}\.xlsx$/),
        }),
        expect.objectContaining({ type: 'email', to: ['${ env.AF_REPORT_RECIPIENTS }'] }),
      ]);
      expect(s.requires.licences ?? []).toEqual(licences);
      const graph: string[] = s.requires.scopes.graph ?? [];
      expect(graph.filter((p) => /ReadWrite|\.Write\b|Send/.test(p))).toEqual([]);
      // The report's Graph permissions, as application permissions on the automation identity.
      expect(graph).toEqual(expect.arrayContaining(def(id).requires.scopes.graph ?? []));
    },
  );

  it('runs every active report except the Exchange PowerShell one, which waits for app-only Exchange', () => {
    for (const [id, { schedule }] of Object.entries(REPORTS)) {
      // A retired report (the Defender portal ones) takes its schedule with it.
      const retired = def(id).status === 'retired';
      expect([schedule, def(schedule).status === 'retired']).toEqual([schedule, retired]);
      expect([schedule, def(schedule).enabled]).toEqual([
        schedule,
        !retired && schedule !== 'reports.shared-mailbox-sign-in-weekly',
      ]);
    }
    expect(def('reports.shared-mailbox-sign-in-weekly').requires.scopes).toEqual({
      exchange: ['Exchange.ManageAsApp'],
    });
  });
});

describe('probes', () => {
  class Outbound implements OutboundExecutor {
    readonly calls: ServiceCall[] = [];
    constructor(private readonly value: unknown[]) {}
    async execute<T>(_identity: unknown, call: ServiceCall) {
      this.calls.push(call);
      return {
        data: { '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#x', value: this.value } as T,
        status: 200,
        provenance: { service: call.service, path: call.path, ms: 1 },
      };
    }
  }
  const deps = (outbound: OutboundExecutor): ProbeDeps => ({
    outbound,
    automation: null,
    connection: async () => {
      throw new Error('no connections');
    },
    env: () => ({}),
    now,
    fetch: async () => new Response(''),
  });

  it.each([
    ['probes.m365-workload-incidents', /service eq 'Exchange Online'.*service eq 'Microsoft 365 suite'/],
    ['probes.defender-new-high-severity-alerts', /status eq 'new' and severity eq 'high'/],
  ])('%s is healthy with nothing open and critical otherwise', async (id, filter) => {
    const probe = def(id) as Probe;
    expect(probe.tags).toContain('sweep-15m');
    const quiet = new Outbound([]);
    expect(await runProbe(id, probe, deps(quiet))).toMatchObject({ status: 'ok' });
    expect(String(quiet.calls[0]!.query?.$filter)).toMatch(filter);
    expect(await runProbe(id, probe, deps(new Outbound([{ id: 'x' }])))).toMatchObject({
      status: 'crit',
      code: 'expectation_failed',
    });
  });
});
