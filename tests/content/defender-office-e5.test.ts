import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatasourceRunner, fixtureRunner } from '@adminforge/api/src/datasources/executor';
import { FsDefinitionSource, registryFrom } from '@adminforge/api/src/definitions';
import { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
import { createFixtureFetch } from '@adminforge/connectors';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Microsoft Defender content as an Office 365 E5 tenant sees it (Defender for Office 365 Plan 2, no Defender for
// Endpoint): Secure Score before Microsoft has calculated the first score, the control catalogue listing controls the
// tenant isn't licensed for, mixed-case cost/impact ratings, and email evidence on incidents and alerts. Shapes follow
// what Graph returned live on 2026-10-16 (values synthetic).

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

/** One datasource, exactly as the portal runs it in mock mode. */
async function run(id: string, datasource: string, params: Record<string, unknown> = {}): Promise<Def> {
  const page = await runner.page(id);
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

/** A transform on a hand-made Graph response (for states the fixtures don't show). */
const transform = (id: string, ds: string, value: unknown, params: Record<string, unknown> = {}) =>
  renderString(def(id).datasources[ds].transform, {
    now: NOW,
    user: USER,
    env: {},
    params,
    value,
  }) as Promise<Def>;

const fixture = (rel: string) => JSON.parse(readFileSync(path.join(FIXTURES, rel), 'utf8')) as Def;
const PROFILES = fixture('graph/v1.0/security/securescorecontrolprofiles/GET.json');
const CATALOGUE_ONLY = ['scid_6090', 'AATP_UnsecureKerberosDelegation', 'MDA_SF_EnforceMfa'];

describe('Secure Score before the first score is calculated (new tenant)', () => {
  const empty = { '@odata.context': 'x', value: [] };

  it.each([
    ['security.secure-score', { days: 30 }],
    ['security.secure-score-summary', {}],
  ])('%s shows no score, no change and no improvement actions', async (id, params) => {
    const history = await transform(id, 'history', empty, params);
    expect(history).toMatchObject({ pending: true, trend: [], percent: null, allTenants: null });
    const actions = await transform(
      id,
      'actions',
      { latest: empty, profiles: PROFILES },
      { category: 'All', state: 'open', top: 25 },
    );
    // The catalogue alone says nothing about what counts for this tenant: no rows, no invented points.
    expect(actions).toMatchObject({ pending: true, rows: [], pointsAvailable: null });
  });

  it('the dashboard KPI stays empty instead of reading 0 %', async () => {
    expect(await transform('security.overview', 'score', { value: [] })).toMatchObject({
      trend: [],
      percent: null,
      delta: null,
    });
  });

  it('pages say why, and KPI tones never treat a missing score as critical', async () => {
    for (const id of ['security.secure-score', 'security.secure-score-summary']) {
      const notice = def(id).layout.find(
        (b: Def) => b.widget === 'markdown' && /history\.pending/.test(b.when),
      );
      expect(notice?.text).toMatch(/hasn't calculated a Secure Score/);
      const kpi = def(id).layout.find((b: Def) => b.data === 'history.percent');
      expect(await renderString(kpi.status, { value: null })).toBe('neutral');
      expect(await renderString(kpi.status, { value: 0.42 })).toBe('crit');
    }
  });
});

describe('Secure Score improvement actions come from the controls that count for the tenant', () => {
  it('leaves out catalogue controls for products the tenant has no score for', async () => {
    const page = await run('security.secure-score', 'actions', { state: 'all' });
    const ids = page.rows.map((r: Def) => r.id);
    expect(ids).toHaveLength(17);
    for (const id of CATALOGUE_ONLY) expect(ids).not.toContain(id);
    const report = await run('security.secure-score-summary', 'actions', { top: 1000 });
    for (const id of CATALOGUE_ONLY) expect(report.rows.map((r: Def) => r.id)).not.toContain(id);
  });

  it('normalises mixed-case and unknown cost and impact ratings', async () => {
    const page = await run('security.secure-score', 'actions', { state: 'all' });
    const byId = Object.fromEntries(page.rows.map((r: Def) => [r.id, r]));
    expect(byId.mdo_safelinksforemail).toMatchObject({ implementationCost: 'Low', userImpact: 'Low' });
    expect(byId.mdo_autoforwardingmode).toMatchObject({ implementationCost: 'Low', userImpact: 'Moderate' });
    expect(byId.MFARegistrationV2).toMatchObject({ implementationCost: 'Moderate', userImpact: 'Moderate' });
    expect(byId.IntegratedApps).toMatchObject({ implementationCost: 'Unknown', userImpact: 'Unknown' });
    expect(byId.UserRiskPolicy).toMatchObject({ implementationCost: 'High', userImpact: 'High' });
    // States set in Defender still win; the default state carries no timestamp.
    expect(byId.SelfServicePasswordReset).toMatchObject({ state: 'accepted', manualState: 'ThirdParty' });
    expect(byId.AdminMFAV2).toMatchObject({ state: 'completed', manualState: 'Default' });
    // Lower-case "low" ratings still make a quick win.
    const report = await run('security.secure-score-summary', 'actions', { top: 1000 });
    expect(report.rows.find((r: Def) => r.id === 'RoleOverlap')).toMatchObject({
      implementationCost: 'Low',
      userImpact: 'Low',
      quickWin: true,
    });
  });

  it('every rating the transforms produce has a label on the table', () => {
    for (const id of ['security.secure-score', 'security.secure-score-summary']) {
      const table = def(id).layout.find((b: Def) => b.widget === 'table');
      for (const field of ['implementationCost', 'userImpact']) {
        const col = table.columns.find((c: Def) => c.field === field);
        expect(Object.keys(col.map).sort()).toEqual(['High', 'Low', 'Moderate', 'Unknown']);
      }
    }
  });

  it('the 7- and 30-day change needs a score that old', async () => {
    const day = (d: string, current: number) => ({
      createdDateTime: `${d}T00:00:00Z`,
      currentScore: current,
      maxScore: 100,
      averageComparativeScores: [],
      controlScores: [],
    });
    const three = { value: [day('2026-10-15', 50), day('2026-10-14', 48), day('2026-10-13', 47)] };
    expect(await transform('security.secure-score-summary', 'history', three)).toMatchObject({
      percent: 0.5,
      change7: null,
      change30: null,
    });
  });
});

describe('email evidence on incidents and alerts (Defender for Office 365)', () => {
  it('the alert lists the message, the email cluster and the user report by name', async () => {
    const alert = await run('security.alert', 'alert', { id: 'da638647315200000011_-1194836011' });
    const rows = alert.evidenceRows.map((r: Def) => [r.type, r.name, r.detail]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ['Email message', 'Your mailbox is almost full', 'To hana.kim@example.com'],
        ['Email cluster', 'billing@invoices-example.net', '6 messages by Sender'],
        ['User-reported email', 'Your mailbox is almost full', 'Reported by hana.kim@example.com'],
      ]),
    );
  });

  it('the incident shows the same evidence under impacted assets', async () => {
    const incident = await run('security.incident', 'incident', { id: '4218' });
    const types = incident.assets.map((a: Def) => a.type);
    expect(types).toEqual(expect.arrayContaining(['Email message', 'Email cluster', 'User-reported email']));
    expect(incident.assets.every((a: Def) => typeof a.key === 'string' && a.name)).toBe(true);
  });

  it('labels other email evidence and keeps unknown types readable', async () => {
    const ev = (type: string, extra: Record<string, unknown>) => ({
      '@odata.type': `#microsoft.graph.security.${type}`,
      verdict: 'suspicious',
      remediationStatus: 'none',
      roles: [],
      ...extra,
    });
    const alert = await transform('security.alert', 'alert', {
      id: 'x',
      evidence: [
        ev('mailboxConfigurationEvidence', {
          mailboxPrimaryAddress: 'ops@example.com',
          configurationType: 'mailForwardingRule',
        }),
        ev('oauthApplicationEvidence', { displayName: 'Mail Helper', publisher: 'Example Org' }),
        ev('teamsMessageEvidence', { subject: null, senderFromAddress: 'ext@example.net' }),
        ev('someFutureEvidence', {}),
      ],
    });
    expect(alert.evidenceRows.map((r: Def) => [r.type, r.name, r.detail])).toEqual([
      ['Mailbox configuration', 'ops@example.com', 'mailForwardingRule'],
      ['OAuth app', 'Mail Helper', 'Example Org'],
      ['Teams message', 'ext@example.net', 'From ext@example.net'],
      ['someFutureEvidence', '—', null],
    ]);
  });
});

describe('Defender for Endpoint content is gated apart from Defender for Office 365', () => {
  it('device vulnerabilities need defenderEndpoint; incidents, alerts and the hunting probe need defender', () => {
    expect(def('security.device-vulnerabilities').requires.licences).toEqual(['defenderEndpoint']);
    for (const id of [
      'security.incidents',
      'security.incident',
      'security.alerts',
      'security.alert',
      'security.alerts-summary',
      'security.open-high-severity-incidents',
      'security.assign-incident',
      'security.update-incident',
      'probes.defender-new-high-severity-alerts',
      'probes.risky-oauth-consents',
    ])
      expect(def(id).requires.licences, id).toEqual(['defender']);
  });

  it('no other content links to Defender device or vulnerability pages without the endpoint gate', () => {
    const links = loaded.definitions.filter((d) =>
      /security\.microsoft\.com\/(machines|vulnerabilities)\//.test(JSON.stringify(d.def)),
    );
    expect(links.map((d) => [d.def.id, d.def.requires?.licences])).toEqual([
      ['security.device-vulnerabilities', ['defenderEndpoint']],
    ]);
  });
});

describe('Secure Score comparison with other tenants', () => {
  it('reads averageScore as a percentage, whatever this tenant’s maximum is', async () => {
    // Live 2026-10-16: a new tenant (max 8 points) compared with an AllTenants averageScore of about 54.
    const snapshot = {
      createdDateTime: '2026-10-16T00:00:00Z',
      currentScore: 3,
      maxScore: 8,
      averageComparativeScores: [
        { basis: 'AllTenants', averageScore: 53.99, identityScore: 38.57, identityScoreMax: 61.04 },
      ],
      controlScores: [],
    };
    for (const id of ['security.secure-score', 'security.secure-score-summary'])
      expect(await transform(id, 'history', { value: [snapshot] })).toMatchObject({
        percent: 0.375,
        allTenants: 0.5399,
        similarSize: null,
      });
  });
});
