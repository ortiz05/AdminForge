import path from 'node:path';
import { DatasourceRunner, fixtureRunner } from '@adminforge/api/src/datasources/executor';
import { FsDefinitionSource, registryFrom } from '@adminforge/api/src/definitions';
import { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
import { createFixtureFetch } from '@adminforge/connectors';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// The engineer report library added on 2026-10-17 (plan Phase E): SAML certificate expiry, subscription renewals,
// Intune connector health, licence assignment errors, user attribute completeness, group lifecycle, unused apps,
// authentication method strength, BitLocker key escrow, Windows LAPS coverage and Conditional Access report-only
// impact — with their probes and schedules. Datasources run as in mock mode (fixtures, a fixed clock); the scale tests
// feed each transform a large-enterprise answer (tens of thousands of rows) and must stay inside the 250 ms budget the
// API enforces on every transform.

const NOW = '2026-10-17T12:00:00Z';
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
const makeRunner = (env: Record<string, string>) =>
  new DatasourceRunner({
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
      env: () => env,
      now,
    }),
    runner: fixtureRunner(FIXTURES),
    env: () => env,
    now,
  });
const runner = makeRunner({});
// A workspace that receives the sign-in logs (tests/fixtures/logAnalytics/…c1).
const withLogAnalytics = makeRunner({
  AF_LOG_ANALYTICS_WORKSPACE_ID: '00000000-0000-4000-8000-0000000000c1',
});
afterAll(() => registry.close());

async function run(
  id: string,
  datasource: string,
  params: Record<string, unknown> = {},
  using: DatasourceRunner = runner,
): Promise<Def> {
  const page = await using.page(id);
  const values = await using.prepareParams(page, params, USER);
  const out = await using.run({
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

/** A transform on a hand-made answer, as the API runs it (250 ms budget, the scope's clock). */
const transform = (id: string, ds: string, value: unknown, params: Record<string, unknown> = {}) =>
  renderString(def(id).datasources[ds].transform, {
    now: NOW,
    user: USER,
    env: {},
    params,
    value,
  }) as Promise<Def>;
/** A probe's `items` selection, normalised like the probe engine does (one match is a single object in JSONata). */
const items = async (id: string, value: unknown[]): Promise<Def[]> => {
  const picked = await renderString(def(id).check.items, { now: NOW, env: {}, value });
  return Array.isArray(picked) ? picked : picked === undefined || picked === null ? [] : [picked];
};

const REPORTS = [
  'identity.saml-certificate-expiry',
  'm365.subscription-renewals',
  'endpoint.intune-connector-health',
  'identity.licence-assignment-errors',
  'identity.user-attribute-completeness',
  'identity.group-lifecycle',
  'identity.unused-apps',
  'identity.auth-method-strength',
  'endpoint.recovery-key-escrow',
  'endpoint.windows-laps-coverage',
  'identity.ca-report-only-impact',
];

describe('engineer report library', () => {
  it.each(REPORTS)('%s is a Reader report in the Reports section with CSV and XLSX export', (id) => {
    const r = def(id);
    expect(r.kind).toBe('report');
    expect(r.nav).toMatchObject({ section: 'reports' });
    expect(r.requires.portalRoles).toEqual(['Portal.Reader']);
    expect(r.export.formats).toEqual(expect.arrayContaining(['csv', 'xlsx']));
  });

  it('never reads key material: BitLocker and LAPS use the ReadBasic permissions only', () => {
    expect(def('endpoint.recovery-key-escrow').requires.scopes.graph).toContain('BitlockerKey.ReadBasic.All');
    expect(def('endpoint.windows-laps-coverage').requires.scopes.graph).toContain(
      'DeviceLocalCredential.ReadBasic.All',
    );
    const all = JSON.stringify([def('endpoint.recovery-key-escrow'), def('endpoint.windows-laps-coverage')]);
    expect(all).not.toMatch(
      /BitlockerKey\.Read\.All|DeviceLocalCredential\.Read\.All|\$select[^"]*\bkey\b|credentials\(/,
    );
  });

  it('the retired duplicates point at their replacements', () => {
    expect(def('identity.licence-utilization')).toMatchObject({ status: 'retired' });
    expect(def('identity.licence-utilization').summary).toMatch(
      /m365\.licence-utilization.*identity\.licence-assignment-errors/s,
    );
    for (const id of ['probes.licence-seats-spe-e3', 'probes.licence-seats-spe-e5'])
      expect(def(id)).toMatchObject({
        status: 'retired',
        summary: expect.stringMatching(/licence-seats-nearly-full/),
      });
  });
});

describe('identity.saml-certificate-expiry', () => {
  it('follows the newest signing certificate: expired, critical, expiring, rollover pending, missing', async () => {
    const out = await run('identity.saml-certificate-expiry', 'apps', { days: 60, includeExpired: true });
    const state = Object.fromEntries(out.rows.map((r: Def) => [r.app, r.state]));
    expect(state).toEqual({
      'Example Legacy Intranet': 'missing',
      'Example Expense': 'expired',
      'Example Payroll': 'critical',
      'Example Travel': 'rollover',
      'Example Wiki': 'warning',
    });
    // Missing first, then soonest expiry first; the healthy app is left out.
    expect(out.rows.map((r: Def) => r.app)).toEqual([
      'Example Legacy Intranet',
      'Example Expense',
      'Example Payroll',
      'Example Wiki',
      'Example Travel',
    ]);
    expect(out).toMatchObject({ saml: 6, total: 5, expired: 1, critical: 1, noNotification: 3 });
  });

  it('can leave expired certificates out', async () => {
    const out = await run('identity.saml-certificate-expiry', 'apps', { days: 30, includeExpired: false });
    expect(out.rows.map((r: Def) => r.state)).not.toContain('expired');
  });

  it('the two probes warn within 30 days and turn critical within 7 days or after expiry', async () => {
    const apps = (await run('identity.saml-certificate-expiry', 'apps')).rows;
    expect(apps).toBeDefined();
    const fixture =
      // The probes' answer (enabled SAML apps only — Graph filters out the disabled Example Expense).
      (await import('../fixtures/graph/v1.0/serviceprincipals/GET__hd341c0d2879e28cb.json')).default.value;
    expect(def('probes.saml-certificates-expiring').check.query.$filter).toMatch(/accountEnabled eq true/);
    expect((await items('probes.saml-certificates-expiring', fixture)).map((i) => i.displayName)).toEqual([
      'Example Payroll',
    ]);
    expect((await items('probes.saml-certificates-expired', fixture)).map((i) => i.displayName)).toEqual([
      'Example Payroll',
    ]);
    expect(def('probes.saml-certificates-expiring').check.maxItems).toBe(
      def('identity.saml-certificate-expiry').datasources.apps.maxItems,
    );
    expect(def('probes.saml-certificates-expiring').thresholds).toEqual({ warn: 1 });
    expect(def('probes.saml-certificates-expired').thresholds).toEqual({ crit: 1 });
    expect(await items('probes.saml-certificates-expiring', [])).toEqual([]);
  });
});

describe('m365.subscription-renewals', () => {
  it('flags suspended, grace-period and ending trials, and renewals in the window, with assigned seats', async () => {
    const out = await run('m365.subscription-renewals', 'report', { days: 60 });
    const by = Object.fromEntries(out.rows.map((r: Def) => [r.sku, r]));
    expect(by.POWER_BI_PRO).toMatchObject({ state: 'trialEnding', assigned: 40, daysRemaining: 7 });
    expect(by.SPE_E3).toMatchObject({ state: 'grace', assigned: 148 });
    expect(by.VISIOCLIENT).toMatchObject({ state: 'suspended' });
    expect(by.EMS).toMatchObject({ state: 'renewal' });
    expect(by.SPE_E5).toBeUndefined();
    expect(out).toMatchObject({ attention: 3, renewals: 1, trials: 1, total: 6 });
    const all = await run('m365.subscription-renewals', 'report', { days: 60, showAll: true });
    expect(all.rows).toHaveLength(6);
  });

  it('the probe counts lapsed subscriptions and trials ending within 14 days', async () => {
    const subs = (await run('m365.subscription-renewals', 'subscriptions')).value;
    expect((await items('probes.subscription-lifecycle', subs)).map((s) => s.skuPartNumber).sort()).toEqual([
      'POWER_BI_PRO',
      'SPE_E3',
      'VISIOCLIENT',
    ]);
  });
});

describe('endpoint.intune-connector-health', () => {
  it('lists every connector, reads a 404 or an empty list as not configured, and flags expiry and sync problems', async () => {
    const out = await run('endpoint.intune-connector-health', 'connectors', { days: 30 });
    const rows = out.rows.map((r: Def) => [r.connector, r.item, r.state]);
    expect(rows).toEqual([
      ['Apple MDM push certificate', null, 'warning'],
      ['Apple automated device enrolment (ADE) token', 'Example Org ABM (corporate)', 'ok'],
      ['Apple automated device enrolment (ADE) token', 'Example Org ABM (education)', 'critical'],
      ['Apple Volume Purchase (VPP) token', 'Example Org', 'syncError'],
      ['Managed Google Play', null, 'ok'],
      ['Windows Autopilot device sync', null, 'notConfigured'],
    ]);
    expect(new Set(out.rows.map((r: Def) => r.key)).size).toBe(out.rows.length);
    expect(out).toMatchObject({ attention: 3, expired: 1, configured: 5 });
  });

  it('a tenant without Apple or Android set up reads "Not configured", not an error', async () => {
    const out = await transform('endpoint.intune-connector-health', 'connectors', {
      apple: null,
      ade: { value: [] },
      vpp: { value: [] },
      googlePlay: { bindStatus: 'notBound', lastAppSyncStatus: 'none' },
      autopilot: null,
    });
    expect(out.rows.map((r: Def) => r.state)).toEqual(Array(5).fill('notConfigured'));
    expect(out).toMatchObject({ attention: 0, configured: 0 });
  });

  it('a sub-request that failed reads "Couldn\'t be read", never "Not set up"', async () => {
    // Every Intune request failed (no permission): the singletons can't be told apart from "not set up" by a 404, so
    // they read as errors too.
    const failed = await transform('endpoint.intune-connector-health', 'connectors', {
      apple: null,
      ade: null,
      vpp: null,
      googlePlay: null,
      autopilot: null,
    });
    expect(failed.rows.map((r: Def) => r.state)).toEqual(Array(5).fill('error'));
    expect(failed).toMatchObject({ attention: 5, configured: 0 });
    // Only VPP failed: the other connectors still read normally.
    const vppFailed = await transform('endpoint.intune-connector-health', 'connectors', {
      apple: null,
      ade: { value: [] },
      vpp: null,
      googlePlay: { bindStatus: 'boundAndValidated', lastAppSyncStatus: 'success' },
      autopilot: null,
    });
    expect(vppFailed.rows.map((r: Def) => [r.connector, r.state])).toEqual([
      ['Apple MDM push certificate', 'notConfigured'],
      ['Apple automated device enrolment (ADE) token', 'notConfigured'],
      ['Apple Volume Purchase (VPP) token', 'error'],
      ['Managed Google Play', 'ok'],
      ['Windows Autopilot device sync', 'notConfigured'],
    ]);
  });

  it('the token probes count expiring ADE tokens and failing VPP tokens only', async () => {
    const ade = (await import('../fixtures/graph/beta/devicemanagement/deponboardingsettings/GET.json'))
      .default.value;
    expect((await items('probes.intune-apple-tokens', ade)).map((t) => t.tokenName)).toEqual([
      'Example Org ABM (education)',
    ]);
    const vpp = (await import('../fixtures/graph/v1.0/deviceappmanagement/vpptokens/GET.json')).default.value;
    expect(await items('probes.intune-vpp-tokens', vpp)).toHaveLength(1);
    expect(await items('probes.intune-vpp-tokens', [])).toEqual([]);
  });
});

describe('identity.licence-assignment-errors', () => {
  it('lists groups with failed members, and for a chosen group each failed assignment with the reason', async () => {
    const groupOnly = await run('identity.licence-assignment-errors', 'report');
    expect(groupOnly).toMatchObject({ groups: 2, errors: 0, noLocation: 2, groupsCapped: false });
    // The KPI comes from Graph's count, not the capped list.
    expect(await run('identity.licence-assignment-errors', 'noLocationCount')).toBe(2);
    const out = await run('identity.licence-assignment-errors', 'report', {
      group: '70000000-0000-4000-8000-000000000701',
    });
    const failed = out.rows.filter((r: Def) => r.issue === 'assignmentError');
    expect(failed.map((r: Def) => [r.upn, r.sku, r.error])).toEqual([
      ['p.natarajan@example.com', 'SPE_E5', 'MutuallyExclusiveViolation'],
      ['t.ortega@example.com', 'SPE_E5', 'CountViolation'],
      ['g.oneill@example.com', 'SPE_E5', 'ProhibitedInUsageLocationViolation'],
    ]);
    expect(failed[1].detail).toMatch(/Not enough licences/);
    expect(new Set(out.rows.map((r: Def) => r.id)).size).toBe(out.rows.length);
  });
});

describe('identity.user-attribute-completeness', () => {
  it('shows the users Graph filtered, counts each attribute, and checks managers on request', async () => {
    const users = await run('identity.user-attribute-completeness', 'users');
    expect(users.value.map((u: Def) => u.displayName)).toContain('Conference Room Display');
    expect(await run('identity.user-attribute-completeness', 'counts')).toEqual({
      department: 2,
      jobTitle: 2,
      usageLocation: 2,
      employeeId: 2,
      members: 412,
    });
    const managers = await run('identity.user-attribute-completeness', 'managers', { managers: true });
    expect(managers.rows.map((r: Def) => [r.displayName, r.issue])).toEqual([
      ['Alex Morgan', 'disabledManager'],
      ['Bea Lindqvist', 'noManager'],
    ]);
  });

  it('builds the Graph filter from the chosen attribute only', async () => {
    const f = def('identity.user-attribute-completeness').datasources.users.request.query.$filter;
    const scope = (attribute: string) => ({ now: NOW, params: { attribute } });
    expect(await renderString(f, scope('jobTitle'))).toBe(
      "accountEnabled eq true and userType eq 'Member' and jobTitle eq null",
    );
    expect(await renderString(f, scope('any'))).toMatch(/department eq null or jobTitle eq null/);
  });
});

describe('identity.group-lifecycle', () => {
  it('collects expiring, single-owner, paused and deleted groups with the expiry policy', async () => {
    expect(await run('identity.group-lifecycle', 'counts')).toEqual({ expiring: 2, singleOwner: 2 });
    const out = await run('identity.group-lifecycle', 'report');
    expect(out).toMatchObject({
      expiring: 2,
      singleOwner: 2,
      paused: 1,
      deleted: 1,
      policy: '365 days, all Microsoft 365 groups',
    });
    expect(out.rows[0]).toMatchObject({
      displayName: 'Project Falcon',
      issue: 'expiring',
      daysRemaining: 11,
    });
    const deleted = out.rows.find((r: Def) => r.issue === 'deleted');
    expect(deleted.daysRemaining).toBe(22);
  });
});

describe('identity.unused-apps', () => {
  it('ranks unused non-Microsoft apps by the Graph application permissions they hold', async () => {
    const out = await run('identity.unused-apps', 'report', { days: 90 });
    const names = out.rows.map((r: Def) => r.displayName);
    expect(names).not.toContain('Microsoft Graph');
    expect(names).not.toContain('Example HR Sync'); // signed in yesterday
    expect(names).toContain('Example Portal'); // last sign-in in May
    // Apps that still hold Graph application permissions come first.
    const holds = out.rows.map((r: Def) => r.holdsPermissions);
    expect(holds).toEqual([...holds].sort((a: boolean, b: boolean) => Number(b) - Number(a)));
    expect(out.rows.find((r: Def) => r.displayName === 'Example Portal')).toMatchObject({ state: 'stale' });
  });
});

describe('identity.auth-method-strength', () => {
  it('keeps phone- or email-only users (not ones who also have a strong method) and admins without passwordless', async () => {
    const out = await run('identity.auth-method-strength', 'report');
    expect(out.rows.every((r: Def) => ['weakOnly', 'adminNotPasswordless'].includes(r.issue))).toBe(true);
    expect(out.weakOnly).toBe(1);
    expect(out.admins).toBe(1);
    expect(out.rows.find((r: Def) => r.issue === 'weakOnly').methods).toBe('mobilePhone');
  });
});

describe('endpoint.recovery-key-escrow and endpoint.windows-laps-coverage', () => {
  it('finds encrypted devices without an operating-system key, skipping stale and unencrypted ones', async () => {
    const out = await run('endpoint.recovery-key-escrow', 'report', { staleDays: 30 });
    expect(out.rows.map((r: Def) => [r.deviceName, r.state])).toEqual([
      ['EX-DT-0033', 'noKey'],
      ['EX-KIOSK-02', 'notJoined'],
    ]);
    expect(out).toMatchObject({ missing: 2, encrypted: 4, windows: 6 });
  });

  it('finds active Windows devices whose LAPS password was never or not recently backed up', async () => {
    const out = await run('endpoint.windows-laps-coverage', 'report', { days: 30, activeDays: 30 });
    expect(out.rows.map((r: Def) => [r.displayName, r.state])).toEqual([
      ['EX-DT-0033', 'hybridNoEntra'],
      ['EX-LT-0157', 'stale'],
      ['EX-LT-0201', 'never'],
    ]);
    expect(out).toMatchObject({ never: 1, stale: 1, hybrid: 1 });
  });
});

describe('identity.ca-report-only-impact', () => {
  it('counts what each report-only policy would have done', async () => {
    const out = await run('identity.ca-report-only-impact', 'report', { window: 24 });
    expect(out.rows).toEqual([
      expect.objectContaining({
        policy: 'CA004 – Require compliant device for Office 365',
        wouldBlock: 1,
        wouldPrompt: 0,
        wouldAllow: 3,
        notApplied: 8,
        people: 1,
        verdict: 'blocks',
      }),
    ]);
    expect(out).toMatchObject({ source: 'graph', signins: 12 });
  });

  it('counts every sign-in through Log Analytics when the workspace has them, without reading Graph', async () => {
    const out = await run('identity.ca-report-only-impact', 'report', { window: 24 }, withLogAnalytics);
    expect(out).toMatchObject({ source: 'logAnalytics', signins: 48210, capped: false });
    expect(out.rows[0]).toMatchObject({ wouldBlock: 37, wouldAllow: 1880, people: 21, verdict: 'blocks' });
    expect(
      await run('identity.ca-report-only-impact', 'signins', { window: 24 }, withLogAnalytics),
    ).toBeNull();
  });

  it('falls back to the Graph sample when Log Analytics returns nothing for the window', async () => {
    const out = await transform('identity.ca-report-only-impact', 'report', {
      policies: [{ id: 'p1', displayName: 'AF-Audit: one' }],
      kql: [],
      total: null,
      signins: [
        {
          userPrincipalName: 'a@example.com',
          appliedConditionalAccessPolicies: [{ id: 'p1', result: 'reportOnlyFailure' }],
        },
      ],
    });
    expect(out).toMatchObject({ source: 'graph', signins: 1, blocking: 1 });
    const f = def('identity.ca-report-only-impact').datasources;
    expect(f.kql.optional).toBe(true);
    expect(f.signins.when).toMatch(/\$count\(ds\.kql\.value\) = 0/);
    expect(f.kql.query).toMatch(/where ConditionalAccessPolicies has "reportOnly"\s*\| mv-expand/);
  });
});

describe('quick wins', () => {
  it('the new schedules say when in English and deliver to the report recipients; the device ones are on (2.0 fits)', () => {
    for (const [id, ref, enabled, every] of [
      ['reports.stale-devices-weekly', 'endpoint.stale-devices', true, 'every Monday at 06:15'],
      [
        'reports.non-compliant-devices-daily',
        'endpoint.non-compliant-devices',
        true,
        'every weekday at 06:40',
      ],
      [
        'reports.saml-certificate-expiry-daily',
        'identity.saml-certificate-expiry',
        true,
        'every day at 06:05',
      ],
    ] as const)
      expect(def(id)).toMatchObject({
        enabled,
        every,
        identity: 'automation',
        job: {
          kind: 'report',
          ref,
          delivery: expect.arrayContaining([
            expect.objectContaining({ type: 'email', to: ['${ env.AF_REPORT_RECIPIENTS }'] }),
          ]),
        },
      });
  });

  it('the licence probe covers every paid SKU without configuration', async () => {
    const skus = [
      {
        skuPartNumber: 'SPE_E5',
        capabilityStatus: 'Enabled',
        consumedUnits: 23,
        prepaidUnits: { enabled: 25 },
      },
      {
        skuPartNumber: 'EMS',
        capabilityStatus: 'Enabled',
        consumedUnits: 10,
        prepaidUnits: { enabled: 100 },
      },
      {
        skuPartNumber: 'FLOW_FREE',
        capabilityStatus: 'Enabled',
        consumedUnits: 9990,
        prepaidUnits: { enabled: 10000 },
      },
      {
        skuPartNumber: 'ENTERPRISEPREMIUM',
        capabilityStatus: 'Suspended',
        consumedUnits: 4,
        prepaidUnits: { enabled: 0 },
      },
      {
        skuPartNumber: 'POWER_BI_PRO',
        capabilityStatus: 'Suspended',
        consumedUnits: 0,
        prepaidUnits: { enabled: 0 },
      },
      // A large enterprise's main SKU: 100,000 seats, 96 % assigned — never left out for its size.
      {
        skuPartNumber: 'SPE_E3',
        capabilityStatus: 'Enabled',
        consumedUnits: 96_000,
        prepaidUnits: { enabled: 100_000 },
      },
      {
        skuPartNumber: 'POWER_BI_STANDARD',
        capabilityStatus: 'Enabled',
        consumedUnits: 999_000,
        prepaidUnits: { enabled: 1_000_000 },
      },
    ];
    expect((await items('probes.licence-seats-nearly-full', skus)).map((s) => s.skuPartNumber)).toEqual([
      'SPE_E5',
      'ENTERPRISEPREMIUM',
      'SPE_E3',
    ]);
    const monitoring = JSON.stringify(def('automation.monitoring'));
    expect(monitoring).toContain('probes.licence-seats-nearly-full');
    expect(monitoring).not.toContain('probes.licence-seats-spe-');
  });
});
