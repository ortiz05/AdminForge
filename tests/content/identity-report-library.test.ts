import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '@adminforge/api/src/artifacts/store';
import { DatasourceRunner, type LoadedPage } from '@adminforge/api/src/datasources/executor';
import { registryFrom } from '@adminforge/api/src/definitions/registry';
import type { ExecutionIdentity, ServiceCall } from '@adminforge/api/src/execution/types';
import { createJobRunner, type JobContext } from '@adminforge/api/src/schedules/jobs';
import { MemoryScheduleStore } from '@adminforge/api/src/schedules/store';
import type { ScheduleRow, ScheduleRunRow } from '@adminforge/api/src/schedules/types';
import { AUTOMATION_GRAPH_ROLES, READ_GRAPH_SCOPES } from '@adminforge/cli/src/provision/catalog';
import { buildUrl, createFixtureFetch, createGraphClient, type GraphRequest } from '@adminforge/connectors';
import { renderString, renderTemplate } from '@adminforge/expressions';
import { loadContentDir, validateCron, type Schedule } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// The identity & access report library: the new identity reports, the account findings added to
// identity.privileged-role-assignments, and their schedules. Datasources run the way DATA_MODE=fixtures runs them —
// the real DatasourceRunner (dependencies, `when`, transforms) over tests/fixtures — and every schedule runs end to end
// through the scheduler's report job (automation identity, export, file delivery).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = any;

const FIXTURES = path.join(repoRoot, 'tests/fixtures');
const NOW = new Date('2026-10-15T06:00:00Z');
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const def = (id: string): Def => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};

const NEW_REPORTS = [
  'identity.app-permissions',
  'identity.consent-grants',
  'identity.apps-without-owners',
  'identity.app-credential-hygiene',
  'identity.app-registration-risks',
  'identity.groups-without-owners',
  'identity.disabled-users-with-licences',
  'identity.password-policies',
  'identity.directory-changes',
  'identity.adminforge-group-changes',
  'identity.tenant-baseline',
];
/** schedule id → [report, weekly | daily] */
const SCHEDULES: Record<string, [string, 'weekly' | 'daily']> = {
  'reports.privileged-role-assignments-weekly': ['identity.privileged-role-assignments', 'weekly'],
  'reports.app-permissions-weekly': ['identity.app-permissions', 'weekly'],
  'reports.consent-grants-weekly': ['identity.consent-grants', 'weekly'],
  'reports.apps-without-owners-weekly': ['identity.apps-without-owners', 'weekly'],
  'reports.app-credential-hygiene-weekly': ['identity.app-credential-hygiene', 'weekly'],
  'reports.app-registration-risks-weekly': ['identity.app-registration-risks', 'weekly'],
  'reports.groups-without-owners-weekly': ['identity.groups-without-owners', 'weekly'],
  'reports.disabled-users-with-licences-weekly': ['identity.disabled-users-with-licences', 'weekly'],
  'reports.password-policies-weekly': ['identity.password-policies', 'weekly'],
  'reports.tenant-baseline-weekly': ['identity.tenant-baseline', 'weekly'],
  'reports.inactive-users-weekly': ['identity.inactive-users', 'weekly'],
  'reports.users-without-mfa-weekly': ['identity.users-without-mfa', 'weekly'],
  'reports.directory-changes-daily': ['identity.directory-changes', 'daily'],
  'reports.adminforge-group-changes-daily': ['identity.adminforge-group-changes', 'daily'],
};

// ── Fixture-backed outbound executor (what DATA_MODE=fixtures does, minus policy and tokens) ──────────────────────

interface Call {
  identity: ExecutionIdentity;
  method: string;
  path: string;
}
class FixtureOutbound {
  readonly calls: Call[] = [];
  /** Requests no fixture file answered (batch sub-requests are reported through their status instead). */
  readonly missing: string[] = [];
  private readonly graph = createGraphClient({
    fetch: createFixtureFetch(FIXTURES, {
      onRequest: (i) => {
        if (!i.file && !i.url.endsWith('/$batch')) this.missing.push(`${i.method} ${i.url}`);
      },
    }),
    getToken: async () => 'fixture-token',
  });

  async execute<T>(identity: ExecutionIdentity, call: ServiceCall) {
    if (call.service !== 'graph') throw new Error(`Unexpected ${call.service} call`);
    this.calls.push({ identity, method: call.method, path: call.path });
    const req = {
      method: call.method,
      path: call.path,
      query: call.query,
      headers: call.headers,
      body: call.body,
      beta: call.beta,
    };
    let data: unknown;
    if (call.path === '/$batch') {
      type Item = { id: string } & GraphRequest;
      const items = (call.body as { requests: Item[] }).requests.map((r): Item => ({
        id: r.id,
        method: r.method,
        path: r.path,
        query: r.query,
        headers: r.headers,
        beta: r.beta,
      }));
      const out = await this.graph.batch(items);
      data = {
        responses: items.map((i) => ({ id: i.id, status: out[i.id]?.status ?? 0, body: out[i.id]?.body })),
      };
    } else if (call.paging === 'all') {
      const value: unknown[] = [];
      let url: string | undefined = buildUrl('https://graph.microsoft.com', req);
      while (url) {
        const r: { data: { value?: unknown[]; '@odata.nextLink'?: string } } = await this.graph.request(
          req,
          url,
        );
        value.push(...(r.data.value ?? []));
        url = r.data['@odata.nextLink'];
      }
      data = { value };
    } else data = (await this.graph.request(req)).data;
    return {
      data: data as T,
      status: 200,
      provenance: { service: 'graph' as const, path: call.path, ms: 1 },
    };
  }
}

const records = loaded.definitions.map((d) => ({
  kind: d.def.kind,
  key: d.def.id,
  version: (d.def as { version: string }).version,
  sha256: 'fixture',
  def: d.def,
  status: 'published',
  source: 'fs',
  file: d.file,
}));
const registry = registryFrom(
  {
    list: async (kind?: string) => records.filter((r) => !kind || r.kind === kind),
    get: async (kind: string, key: string) => records.find((r) => r.kind === kind && r.key === key) ?? null,
    onChange: () => () => undefined,
    problems: () => [],
    close: async () => undefined,
  } as never,
  'fs',
);
const AUTOMATION: ExecutionIdentity = { kind: 'automation', mode: 'read' };
const USER = { oid: 'automation', upn: 'automation', name: 'Automation', roles: ['Portal.Reader'] } as never;

/** Runs every datasource of a report over the fixtures; returns their data by name. */
async function run(id: string, params: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const outbound = new FixtureOutbound();
  const runner = new DatasourceRunner({
    definitions: registry,
    outbound: outbound as never,
    env: () => env,
    now: () => NOW,
  });
  const r = await registry.resolve('report', id);
  const page: LoadedPage = {
    def: r.def,
    version: r.version,
    sha256: r.sha256,
    kind: 'report',
    key: id,
  } as never;
  const prepared = await runner.prepareParams(page, params, USER);
  const res = await runner.runMany(
    { identity: AUTOMATION, user: USER, page, params: prepared, correlationId: 'content-test' } as never,
    Object.keys(r.def.datasources ?? {}),
  );
  const out: Record<string, Out> = {};
  for (const [name, v] of Object.entries(res)) {
    if ('error' in v) throw new Error(`${id}#${name}: ${v.error.code} ${v.error.message}`);
    out[name] = v.data;
  }
  return { out, outbound };
}

// The exported table: the one bound to `export.data`, else the first table (as the export does — a report that caps
// its table exports the uncapped list datasource behind it, which no table shows).
const table = (id: string): Def => {
  const tables = def(id).layout.filter((b: Def) => b.widget === 'table');
  return tables.find((b: Def) => b.data === def(id).export.data) ?? tables[0];
};
const action = (id: string, labelOrPlaybook: string): Def =>
  table(id).rowActions.find((a: Def) => a.playbook === labelOrPlaybook || a.label === labelOrPlaybook);
const when = (a: Def, row: Record<string, unknown>) => renderString(a.when, { row });

// ── Every report ────────────────────────────────────────────────────────────────────────────────────────────────

describe.each(NEW_REPORTS)('%s', (id) => {
  it('is a Reports-section report readers can open and export', () => {
    const d = def(id);
    expect(d.kind).toBe('report');
    expect(d.nav.section).toBe('reports');
    expect(d.requires.portalRoles).toEqual(['Portal.Reader']);
    expect(d.export.formats).toEqual(expect.arrayContaining(['csv', 'xlsx']));
    expect(d.export.columns).toBe('all');
    expect(table(id)).toBeDefined();
  });

  it('needs only delegated scopes the Read app already has, and no licence', () => {
    for (const s of def(id).requires.scopes.graph) expect(READ_GRAPH_SCOPES).toContain(s);
    expect(def(id).requires.licences).toBeUndefined();
  });

  it('renders from the fixtures with every request answered', async () => {
    const { out, outbound } = await run(id);
    expect(outbound.missing).toEqual([]);
    const [ds, field] = def(id).export.data.split('.');
    expect(Array.isArray(out[ds][field])).toBe(true);
    expect(
      outbound.calls.every(
        (c) => c.method === 'GET' || c.path === '/directoryObjects/getByIds' || c.path === '/$batch',
      ),
    ).toBe(true);
  });
});

it('identity report nav entries do not collide', () => {
  const orders = loaded.definitions
    .filter((d) => d.def.kind === 'report' && d.def.id.startsWith('identity.'))
    .map((d) => (d.def as Def).nav.order);
  expect(new Set(orders).size).toBe(orders.length);
});

// ── Report logic ────────────────────────────────────────────────────────────────────────────────────────────────

describe('identity.app-permissions', () => {
  it('tiers application permissions and says who holds them', async () => {
    const { out } = await run('identity.app-permissions');
    const p = out.permissions;
    expect(p).toMatchObject({ critical: 4, criticalApps: 1, thirdParty: 1, total: 16, truncated: false });
    expect(p.rows.map((r: Out) => r.tier)).toEqual([
      'critical',
      'critical',
      'critical',
      'critical',
      'high',
      'high',
      'high',
      'high',
      'high',
    ]);
    expect(p.rows.find((r: Out) => r.permission === 'full_access_as_app')).toMatchObject({
      principalDisplayName: 'Legacy Automation',
      resourceDisplayName: 'Office 365 Exchange Online',
      sp: expect.objectContaining({ holder: 'This organisation' }),
    });
    expect(p.rows.find((r: Out) => r.principalDisplayName === 'func-example')).toMatchObject({
      sp: expect.objectContaining({ holder: 'Managed identity' }),
      permission: 'Mail.ReadWrite',
    });
    expect(p.rows.find((r: Out) => r.principalDisplayName === 'PDF Converter Online')).toMatchObject({
      sp: expect.objectContaining({
        holder: 'Other organisation',
        verifiedPublisher: { displayName: 'Unverified publisher' },
      }),
    });
  });

  it('filters by impact and holder', async () => {
    const all = (await run('identity.app-permissions', { tier: 'all' })).out.permissions;
    expect(all.rows).toHaveLength(16);
    const mi = (await run('identity.app-permissions', { tier: 'all', holder: 'Managed identity' })).out
      .permissions;
    expect(mi.rows.map((r: Out) => r.permission)).toEqual(['Mail.ReadWrite', 'Group.Read.All']);
  });

  it('sends getByIds a list even when one app holds every grant', async () => {
    const body = await renderTemplate<{ ids: unknown }>(
      def('identity.app-permissions').datasources.holders.request.body,
      {
        ds: { grants: { value: [{ principalId: 'sp-1' }, { principalId: 'sp-1' }] }, apis: { grants: [] } },
      },
    );
    expect(body!.ids).toEqual(['sp-1']);
  });

  it("never offers to disable AdminForge's own apps", async () => {
    const env = { AF_AUTOMATION_CLIENT_ID: '00000000-0000-4000-8001-000000000306' };
    const rows = (await run('identity.app-permissions', {}, env)).out.permissions.rows;
    const legacy = rows.find((r: Out) => r.principalDisplayName === 'Legacy Automation');
    expect(legacy.sp.adminforge).toBe(true);
    const disable = action('identity.app-permissions', 'identity.disable-enterprise-app');
    expect(await when(disable, legacy)).toBe(false);
    expect(await when(disable, { ...legacy, sp: { ...legacy.sp, adminforge: false } })).toBe(true);
  });
});

describe('identity.consent-grants', () => {
  it('flags high-impact delegated grants and names apps, APIs and users', async () => {
    const r = (await run('identity.consent-grants')).out.report;
    expect(r).toMatchObject({ critical: 2, adminRisky: 2, userRisky: 3, apps: 4, truncated: false });
    expect(r.rows[0]).toMatchObject({
      client: expect.objectContaining({ displayName: 'Legacy Automation' }),
      consentType: 'AllPrincipals',
      who: { displayName: 'All users' },
      sc: expect.objectContaining({ tier: 'critical' }),
    });
    expect(r.rows.find((g: Out) => g.id === 'grant-pdf-spatel')).toMatchObject({
      who: expect.objectContaining({ displayName: 'Sam Patel' }),
      client: expect.objectContaining({ origin: 'Other organisation' }),
      sc: expect.objectContaining({ risky: ['Files.ReadWrite.All', 'Mail.Read'] }),
    });
    expect(r.rows.find((g: Out) => g.id === 'grant-exo-jrivera')).toMatchObject({
      resource: expect.objectContaining({ displayName: 'Office 365 Exchange Online' }),
      sc: expect.objectContaining({ tier: 'critical' }),
    });
    expect((await run('identity.consent-grants', { risk: 'all' })).out.report.rows).toHaveLength(8);
    expect((await run('identity.consent-grants', { consent: 'User' })).out.report.rows).toHaveLength(3);
  });

  it('revokes through the playbook, except for AdminForge apps', async () => {
    const revoke = action('identity.consent-grants', 'identity.revoke-consent-grant');
    expect(await renderTemplate(revoke.inputs, { row: { id: 'grant-x' } })).toEqual({ grantId: 'grant-x' });
    const env = { AF_PROTECTED_APP_IDS: ' 00000000-0000-4000-8001-000000000306 , other' };
    const row = (await run('identity.consent-grants', {}, env)).out.report.rows[0];
    expect(row.client.adminforge).toBe(true);
    expect(await when(revoke, row)).toBe(false);
  });

  it('sends getByIds a list even for a single grant', async () => {
    const body = await renderTemplate<{ ids: unknown }>(
      def('identity.consent-grants').datasources.objects.request.body,
      {
        ds: { grants: { value: [{ clientId: 'c', resourceId: 'c', principalId: null }] } },
      },
    );
    expect(body!.ids).toEqual(['c']);
  });
});

describe('identity.apps-without-owners', () => {
  it('lists ownerless registrations and third-party enterprise apps, riskiest first', async () => {
    const r = (await run('identity.apps-without-owners')).out.report;
    expect(r).toMatchObject({ registrations: 3, withAccess: 1, enterprise: 2, openToAll: 1 });
    expect(r.rows[0]).toMatchObject({
      displayName: 'Example Data Pipeline',
      attention: 'high',
      reason: 'Live credentials',
    });
    expect(r.rows.map((x: Out) => x.displayName)).not.toContain('Example Reporting'); // its registration is covered
    expect(new Set(r.rows.map((x: Out) => x.id)).size).toBe(r.rows.length); // each app once
    const regs = (await run('identity.apps-without-owners', { kind: 'App registrations' })).out;
    expect(regs.sps).toBeNull();
    expect(regs.report.rows.every((x: Out) => x.kind === 'App registration')).toBe(true);
  });

  it('adds an owner to app registrations only', async () => {
    const add = action('identity.apps-without-owners', 'identity.add-app-owner');
    expect(await when(add, { kind: 'App registration' })).toBe(true);
    expect(await when(add, { kind: 'Enterprise app' })).toBe(false);
  });
});

describe('identity.app-credential-hygiene', () => {
  it('finds long-lived secrets, several active secrets and credentials on enterprise apps', async () => {
    const c = (await run('identity.app-credential-hygiene')).out.page;
    expect(c).toMatchObject({ long: 4, onServicePrincipals: 2, several: 1, secretOnly: 2 });
    expect(c.rows[0]).toMatchObject({
      displayName: 'Example Data Pipeline',
      finding: 'Practically never expires',
      severity: 'crit',
    });
    const onSp = c.rows.filter((r: Out) => r.onServicePrincipal).map((r: Out) => r.displayName);
    expect(onSp.sort()).toEqual(['Example Reporting', 'Office 365 Exchange Online']); // not the SAML app or the managed identity
    // 2.0: one finding per credential (the most severe) and the app's live secret count.
    const ciOld = c.rows.find((r: Out) => r.c.displayName === 'ci-old');
    expect(ciOld).toMatchObject({ finding: 'Longer than allowed', long: true });
    expect(ciOld.liveSecrets).toBeGreaterThan(1);
    expect(new Set(c.rows.map((r: Out) => r.key)).size).toBe(c.rows.length);
  });

  it('applies the allowed lifetime and the finding filter', async () => {
    const two = (await run('identity.app-credential-hygiene', { maxDays: 730 })).out.page;
    expect(two.rows.map((r: Out) => r.c.displayName)).not.toContain('prod');
    const sp = (await run('identity.app-credential-hygiene', { finding: 'servicePrincipal' })).out.page;
    expect(sp.rows).toHaveLength(2);
  });
});

describe('identity.app-registration-risks', () => {
  it('reports redirect URI, implicit grant, public client, audience and permission risks', async () => {
    const a = (await run('identity.app-registration-risks')).out.apps;
    expect(a).toMatchObject({ critical: 1, implicit: 1, publicClient: 1, personal: 1 });
    expect(a.rows[0]).toMatchObject({ displayName: 'Example Portal', severity: 'crit' });
    // 2.0: one true/false field per finding, set natively (no JSONata per app).
    expect(a.rows[0]).toMatchObject({ wildcardUri: true, plainHttpUri: true });
    expect(a.rows.find((r: Out) => r.displayName === 'Example Reporting')).toMatchObject({
      sharedHostingUri: true,
    });
    expect(a.rows.find((r: Out) => r.displayName === 'Legacy Automation')).toMatchObject({
      criticalPermissions: true,
    });
    expect((await run('identity.app-registration-risks', { severity: 'crit' })).out.apps.rows).toHaveLength(
      1,
    );
  });
});

describe('identity.groups-without-owners', () => {
  it('lists ownerless cloud groups from the server-side filter only', async () => {
    const { out } = await run('identity.groups-without-owners');
    expect(out.membership).toBeNull();
    // 2.0: plus the group owned only by an app (SG-HR-Provisioned-Sync), listed apart from the ownerless ones.
    expect(out.report).toMatchObject({ total: 5, noOwners: 4, appOnly: 1, noMembers: null, m365NoOwners: 1 });
    expect(out.report.rows.find((r: Out) => r.displayName === 'SG-HR-Provisioned-Sync').issue).toBe(
      'Owned by an app only',
    );
    const synced = (await run('identity.groups-without-owners', { includeSynced: true })).out.report;
    expect(synced.rows.map((r: Out) => r.displayName)).toContain('GG-Engineering (AD)');
  });

  it('combines owners and members when asked for either', async () => {
    const r = (await run('identity.groups-without-owners', { issue: 'either' })).out.report;
    expect(r).toMatchObject({ total: 7, noOwners: 4, appOnly: 1, noMembers: 3 });
    expect(r.rows.find((g: Out) => g.displayName === 'Finance Announcements').issue).toBe(
      'No owners or members',
    );
    const add = action('identity.groups-without-owners', 'identity.add-group-owner');
    expect(await when(add, { noOwners: false, source: 'Cloud' })).toBe(false);
  });
});

describe('identity.disabled-users-with-licences', () => {
  it('lists one row per licence and how it was assigned', async () => {
    const u = (await run('identity.disabled-users-with-licences')).out.users;
    expect(u).toMatchObject({ accounts: 2, licences: 5, direct: 4 });
    expect(u.rows.map((r: Out) => [r.displayName, r.sku, r.assignment])).toEqual([
      // A SKU the tenant's list doesn't name shows (and is removed) by its id; the failed group assignment
      // (CountViolation) holds no seat and is left out.
      ['Dana Former', '30000000-0000-4000-8000-000000000499', 'Direct'],
      ['Dana Former', 'SPE_E3', 'Direct'],
      ['Rafael Castillo', 'POWER_BI_PRO', 'Direct'],
      ['Rafael Castillo', 'SPE_E5', 'Group'],
      // 2.0: one row per assignment — a licence held directly and through a group is two rows.
      ['Rafael Castillo', 'VISIOCLIENT', 'Direct'],
      ['Rafael Castillo', 'VISIOCLIENT', 'Group'],
    ]);
    expect(new Set(u.rows.map((r: Out) => r.key)).size).toBe(u.rows.length);
    const remove = action('identity.disabled-users-with-licences', 'identity.remove-licence');
    expect(await when(remove, { assignment: 'Group' })).toBe(false);
    expect(await renderTemplate(remove.inputs, { row: u.rows[0] })).toEqual({
      userId: '30000000-0000-4000-8000-000000000004',
      sku: '30000000-0000-4000-8000-000000000499',
    });
    expect(await renderTemplate(remove.inputs, { row: u.rows[2] })).toEqual({
      userId: '00000000-0000-4000-8000-000000000104',
      sku: 'POWER_BI_PRO',
    });
  });
});

describe('identity.password-policies', () => {
  it('finds old passwords, expiry exemptions on cloud accounts and weak passwords', async () => {
    const { out } = await run('identity.password-policies');
    expect(out.domains).toEqual({ policy: 'Passwords never expire', expires: false });
    expect(out.users).toMatchObject({ old: 5, neverExpires: 2, weak: 1 });
    // One row per account, under its most severe finding (2.0: native filters for 100k members).
    const byName = Object.fromEntries(out.users.rows.map((r: Out) => [r.displayName, r]));
    expect(out.users.rows).toHaveLength(new Set(out.users.rows.map((r: Out) => r.id)).size);
    expect(byName['Svc Reporting']).toMatchObject({
      severity: 'crit',
      finding: 'Never expires, old password',
    });
    expect(byName['Dana Okafor'].finding).toBe('Old password'); // synced: AD owns expiry
    expect(byName['Rafael Castillo']).toBeUndefined(); // blocked
    const blocked = (await run('identity.password-policies', { includeDisabled: true })).out.users;
    expect(blocked.rows.map((r: Out) => r.displayName)).toContain('Rafael Castillo');
  });
});

describe('identity.directory-changes', () => {
  const query = def('identity.directory-changes').datasources.audits.request.query;
  const rules = def('identity.directory-changes').datasources.rules.data;
  const filter = async (params: Record<string, unknown>) =>
    (await renderTemplate<{ $filter: string }>(query, { params, ds: { rules }, now: NOW.toISOString() }))!
      .$filter;

  it('filters server-side on the time range, the activity list and the result', async () => {
    const all = await filter({ days: 7, area: 'All', result: 'Any' });
    expect(all.startsWith('activityDateTime ge 2026-10-08T06:00:00.000Z and (')).toBe(true);
    expect(all.split(' or ')).toHaveLength(rules.length);
    expect(all).toContain("startswith(activityDisplayName, 'Add member to role')");
    expect(all).toContain("activityDisplayName eq 'Update conditional access policy'");
    const roles = await filter({ days: 1, area: 'Roles', result: 'failure' });
    expect(roles.split(' or ')).toHaveLength(rules.filter((r: Def) => r.area === 'Roles').length);
    expect(roles).not.toContain('conditional access');
    expect(roles.endsWith(") and result eq 'failure'")).toBe(true);
  });

  it('labels each event by area and leaves out anything else', async () => {
    const a = (await run('identity.directory-changes')).out.audits;
    expect(a).toMatchObject({
      roles: 1,
      consent: 1,
      credentials: 2,
      conditionalAccess: 1,
      domains: 0,
      failures: 0,
    });
    expect(a.rows.map((r: Out) => r.activity)).not.toContain('Update user');
    expect(a.rows.find((r: Out) => r.area === 'Roles')).toMatchObject({ initiator: 'avery@example.com' });
  });
});

describe('identity.adminforge-group-changes', () => {
  it('reads changes to the SG-AdminForge-* groups, filtered by their ids', async () => {
    const { out } = await run('identity.adminforge-group-changes');
    expect(out.audits).toMatchObject({ total: 2, added: 1, owners: 0, failures: 0 });
    expect(out.audits.rows.map((r: Out) => [r.change, r.group, r.role, r.member, r.actor])).toEqual([
      [
        'Member added',
        'SG-AdminForge-dev-Portal.Operator',
        'Portal.Operator',
        'c.novak@example.com',
        'j.rivera@example.com',
      ],
      [
        'Member removed',
        'SG-AdminForge-dev-Portal.Reader',
        'Portal.Reader',
        'r.castillo@example.com',
        'a.lee@example.com',
      ],
    ]);
    const q = await renderTemplate<{ $filter: string }>(
      def('identity.adminforge-group-changes').datasources.audits.request.query,
      {
        params: { days: 7 },
        ds: { groups: { value: [{ id: '00000000-0000-4000-8000-0000000002ff' }] } },
        now: NOW.toISOString(),
      },
    );
    expect(q!.$filter).toContain("activityDisplayName eq 'Add owner to group'");
    expect(
      q!.$filter.endsWith("(targetResources/any(t:t/id eq '00000000-0000-4000-8000-0000000002ff'))"),
    ).toBe(true);
  });

  it('skips the audit query when no AdminForge groups exist', async () => {
    const w = def('identity.adminforge-group-changes').datasources.audits.when;
    expect(await renderString(w, { ds: { groups: { value: [] } } })).toBe(false);
  });
});

describe('identity.tenant-baseline', () => {
  it('checks each setting against the baseline', async () => {
    const s = (await run('identity.tenant-baseline')).out.settings;
    expect(s).toMatchObject({ checked: 27, critical: 1, warnings: 6, unread: 0 });
    const byId = Object.fromEntries(s.rows.map((r: Out) => [r.id, r]));
    expect(byId.userConsent).toMatchObject({ status: 'crit', current: 'Yes, to any app' });
    expect(byId.globalAdmins).toMatchObject({ status: 'ok', current: '2' });
    expect(byId.securityDefaults.status).toBe('ok'); // off, but Conditional Access policies are on
    expect((await run('identity.tenant-baseline', { status: 'attention' })).out.settings.rows).toHaveLength(
      7,
    );
  });

  it('reports settings it could not read instead of failing', async () => {
    const t = def('identity.tenant-baseline').datasources.settings.transform;
    const s: Out = await renderString(t, { value: {}, params: { status: 'All' } });
    expect(s.critical).toBe(0);
    expect(s.unread).toBeGreaterThan(5);
    expect(s.rows.every((r: Out) => r.status === 'unknown')).toBe(true);
  });
});

describe('identity.privileged-role-assignments account findings', () => {
  it('flags privileged users synced from AD, guests and blocked accounts', async () => {
    const a = (await run('identity.privileged-role-assignments')).out.assignments;
    expect(def('identity.privileged-role-assignments').version).toBe('2.1.1');
    expect(a.accountFindings).toBe(1);
    // 2.0: the holder is the expanded principal object; rows are keyed by assignment id.
    const dana = a.rows.find((r: Out) => r.principal.displayName === 'Dana Okafor');
    expect(dana).toMatchObject({ source: 'Synced' });
    expect(dana.findings).toContain('Synced from AD');
    const sp = a.rows.find((r: Out) => r.principalType === 'Service principal');
    expect(sp.findings).toEqual([]);
    expect(sp.principalDetail).toBe(sp.principal.appId); // an app's second line is its app id
    expect(dana.principalDetail).toBe(dana.principal.userPrincipalName);
    // Holder kinds come from @odata.type: a group without securityEnabled in the response is still a group.
    const all = (await run('identity.privileged-role-assignments', { scope: 'All' })).out.assignments;
    const group = all.rows.find((r: Out) => r.principal.displayName === 'SG-PIM-Identity-Admins');
    expect(group).toMatchObject({ principalType: 'Group', findings: [] });
  });
});

// ── Schedules ───────────────────────────────────────────────────────────────────────────────────────────────────

describe.each(Object.entries(SCHEDULES))('%s', (id, [ref, cadence]) => {
  const s = def(id) as Schedule & Def;

  it(`runs the report ${cadence} before the working day as the automation identity`, () => {
    expect(validateCron(s.cron)).toBeUndefined();
    const [minute, hour, dom, month, dow] = s.cron.split(/\s+/);
    expect([dom, month, dow]).toEqual(['*', '*', cadence === 'weekly' ? '1' : '*']);
    expect(Number(minute)).toBeLessThan(60);
    expect(Number(hour)).toBeLessThan(6);
    expect(s).toMatchObject({
      enabled: true,
      identity: 'automation',
      timezone: 'UTC',
      overlap: 'skip',
      job: { kind: 'report', ref },
    });
  });

  it('keeps the file and emails the configured recipients', () => {
    const [file, email] = s.job.delivery;
    expect(file).toMatchObject({ type: 'file', format: cadence === 'daily' ? 'csv' : 'xlsx' });
    expect(file.path.startsWith('identity/')).toBe(true);
    expect(file.retain).toBeGreaterThanOrEqual(26);
    expect(email).toMatchObject({ type: 'email', to: ['${ env.AF_REPORT_RECIPIENTS }'] });
  });

  it('needs only read application permissions the automation identity is provisioned with', () => {
    for (const scope of s.requires.scopes.graph) expect(AUTOMATION_GRAPH_ROLES).toContain(scope);
    const report = def(ref);
    if (NEW_REPORTS.includes(ref)) expect(s.requires.scopes.graph).toEqual(report.requires.scopes.graph);
    expect(s.requires.licences).toEqual(report.requires.licences);
  });
});

describe('scheduled runs (fixtures)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'af-identity-reports-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(Object.keys(SCHEDULES))('%s writes its report file', async (id) => {
    const s = def(id) as Schedule;
    const outbound = new FixtureOutbound();
    const datasources = new DatasourceRunner({
      definitions: registry,
      outbound: outbound as never,
      env: () => ({}),
      now: () => NOW,
    });
    const jobs = createJobRunner({
      definitions: registry,
      store: new MemoryScheduleStore(() => NOW),
      outbound: outbound as never,
      probes: {
        automation: null,
        connection: async () => Promise.reject(new Error('none')),
        env: () => ({}),
        now: () => NOW,
        fetch: async () => new Response(''),
      } as never,
      datasources,
      artifacts: new ArtifactStore(dir),
      runs: null,
      automationClientId: null,
      exportMaxRows: 1000,
      now: () => NOW,
      sleep: async () => undefined,
    });
    const schedule = {
      id: '00000000-0000-4000-8000-000000000001',
      key: id,
      source: 'content',
      definition: s,
      sha256: 'fixture',
      enabled: true,
      createdBy: null,
      approvedBy: null,
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as ScheduleRow;
    const ctx: JobContext = {
      schedule,
      def: s,
      run: {
        id: '00000000-0000-4000-8000-0000000000aa',
        scheduleId: schedule.id,
        scheduleKey: id,
        status: 'running',
        startedAt: NOW,
      } as unknown as ScheduleRunRow,
      signal: new AbortController().signal,
      correlationId: 'content-test',
      scheduledBy: null,
    };
    const r = await jobs.run(ctx);
    expect(r.status ?? 'succeeded').toBe('succeeded');
    const artifacts = (r.result as Out).artifacts;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].rows).toBeGreaterThan(0);
    expect(existsSync(path.join(dir, artifacts[0].path))).toBe(true);
    if (artifacts[0].format === 'csv')
      expect(readFileSync(path.join(dir, artifacts[0].path), 'utf8').split('\r\n').length).toBeGreaterThan(2);
    // No mail sender here: the email is noted, the run still succeeds.
    expect((r.result as Out).delivery).toEqual([
      expect.objectContaining({ type: 'email', status: 'not_configured' }),
    ]);
    expect(outbound.missing).toEqual([]);
    expect(outbound.calls.every((c) => c.identity.kind === 'automation' && c.identity.mode === 'read')).toBe(
      true,
    );
  });
});
