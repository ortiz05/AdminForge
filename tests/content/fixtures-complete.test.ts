import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DatasourceRunner,
  fixtureRunner,
  type DatasourceOutput,
} from '@adminforge/api/src/datasources/executor';
import { FsDefinitionSource, registryFrom } from '@adminforge/api/src/definitions';
import { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import { createFixtureFetch } from '@adminforge/connectors';
import { loadContentDir, type Probe } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Fixture completeness (functionality plan F-03, organization plan O-16): mock mode promises that every page renders
// from tests/fixtures. Every active page, dashboard and report runs each of its datasources through the real datasource
// runner and outbound executor on the fixtures, with its default params (entity pages with a sample id from
// SAMPLE_PARAMS), the way the mock API serves them — and none may fail with a missing fixture or a content error. Every
// active KQL probe (Resource Graph, Log Analytics) has a fixture variant matched by its `// af:<probe id>` line, so mock
// monitoring shows the synthetic estate rather than a generic answer.

const NOW = '2026-10-21T12:00:00Z';
const CONTENT = path.join(repoRoot, 'portal/content');
const FIXTURES = path.join(repoRoot, 'tests/fixtures');
const USER = {
  oid: '30000000-0000-4000-8000-000000000001',
  upn: 'avery@example.com',
  name: 'Avery Engineer',
  roles: [],
};

const loaded = await loadContentDir(CONTENT);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const active = (kinds: string[]): Def[] =>
  loaded.definitions
    .map((d) => d.def as Def)
    .filter((d) => kinds.includes(d.kind) && d.status !== 'retired' && d.status !== 'draft');

const A1 = '/subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups';
/** Entity pages: the synthetic object each opens on (every id here has fixtures under tests/fixtures). */
const SAMPLE_PARAMS: Record<string, Record<string, unknown>> = {
  'avd.host-pool': {
    id: `${A1}/rg-example-avd/providers/Microsoft.DesktopVirtualization/hostPools/hp-example-pooled`,
  },
  'avd.session-host': {
    id: `${A1}/rg-example-avd-finance/providers/Microsoft.DesktopVirtualization/hostPools/hp-example-finance/sessionHosts/avd-fin-03.example.com`,
  },
  'azure.arc-server': {
    id: `${A1}/rg-example-arc/providers/Microsoft.HybridCompute/machines/srv-example-02`,
  },
  'azure.resource': { id: `${A1}/rg-example-functions/providers/Microsoft.Web/sites/func-example` },
  'azure.subscription': { id: '00000000-0000-4000-8000-0000000000a1' },
  'endpoint.compliance-policy': { id: '00000000-0000-4000-8000-000000000701' },
  'endpoint.configuration-profile': { id: '00000000-0000-4000-8000-000000000801' },
  'endpoint.device': { id: '00000000-0000-4000-8000-000000000608' },
  'identity.app-registration': { id: '00000000-0000-4000-8000-000000000303' },
  'identity.ca-policy': { id: '00000000-0000-4000-8000-000000000903' },
  'identity.device': { id: '00000000-0000-4000-8000-000000000508' },
  'identity.enterprise-app': { id: '00000000-0000-4000-8000-000000000405' },
  'identity.group': { id: '00000000-0000-4000-8000-000000000208' },
  'identity.role': { id: '62e90394-69f5-4237-9190-012177145e10' },
  'identity.sign-in': { id: '00000000-0000-4000-8000-0000000f0001', at: '2026-10-15T02:55:00Z' },
  'identity.user': { id: '00000000-0000-4000-8000-000000000102' },
  'm365.distribution-list': { address: 'all-staff@example.com' },
  'm365.licence': { skuId: '00000000-0000-4000-8000-000000001001' },
  'm365.mailbox': { mailbox: 'avery@example.com' },
  'm365.message': { id: 'MC912001' },
  'm365.service-issue': { id: 'TM913002' },
  'm365.sharepoint-site': {
    id: 'exampleorg.sharepoint.com,10000000-0000-4000-8000-000000000907,10000000-0000-4000-8000-000000000a07',
  },
  'm365.team': { id: '10000000-0000-4000-8000-000000000201' },
  'security.risky-user': { id: '30000000-0000-4000-8000-000000000001' },
};

const registry = registryFrom(new FsDefinitionSource(CONTENT), 'fs');
const now = () => new Date(NOW);
const outbound = createOutboundExecutor({
  config: {
    DATA_MODE: 'fixtures',
    AF_SPO_TENANT_NAME: undefined,
    OUTBOUND_CONCURRENCY: 16,
    OUTBOUND_USER_CONCURRENCY: 16,
    OUTBOUND_TIMEOUT_MS: 30_000,
    TOKEN_CACHE_KEY: undefined,
  } as never,
  broker: null,
  auth: null,
  automation: null,
  fetch: createFixtureFetch(FIXTURES),
  env: () => ({}),
  now,
});
const runner = new DatasourceRunner({
  definitions: registry,
  outbound,
  runner: fixtureRunner(FIXTURES),
  env: () => ({}),
  now,
});
afterAll(() => registry.close());

type Failure = { page: string; datasource: string; code: string; message: string };
/** What a fixture gap looks like (the connector's 404 for a missing file, a transform or expression that failed). */
const GAPS = new Set(['FixtureNotFound', 'content_error', 'upstream_not_found']);

async function render(def: Def): Promise<Failure[]> {
  const page = await runner.page(def.id);
  let params: Record<string, unknown>;
  try {
    params = await runner.prepareParams(page, SAMPLE_PARAMS[def.id] ?? {}, {
      ...USER,
      roles: ['Portal.Reader'],
    });
  } catch (err) {
    return [{ page: def.id, datasource: '(params)', code: 'needs_sample', message: (err as Error).message }];
  }
  const names = Object.keys(page.def.datasources ?? {});
  const out = await runner.runMany(
    {
      identity: { kind: 'automation', mode: 'read' },
      user: { ...USER, roles: ['Portal.Reader'] },
      page,
      params,
      correlationId: 'fixtures-complete',
      noCache: true,
    },
    names,
  );
  return Object.entries(out).flatMap(([name, r]) =>
    'error' in r
      ? [{ page: def.id, datasource: name, code: r.error.code, message: r.error.message }]
      : // A batch's sub-request may fail on purpose (a fixture answering 404 for "not set up in this tenant"); a
        // missing fixture or a content error never.
        Object.entries((r as DatasourceOutput).errors ?? {})
          .filter(([, e]) => GAPS.has(e.code))
          .map(([k, e]) => ({
            page: def.id,
            datasource: `${name} (${k})`,
            code: e.code,
            message: e.message,
          })),
  );
}

describe('every page, dashboard and report renders from the fixtures', () => {
  const pages = active(['page', 'dashboard', 'report']);

  it('finds the catalogue, and every sample is for an active page', () => {
    expect(pages.length).toBeGreaterThan(140);
    const ids = new Set(pages.map((p) => p.id));
    expect(Object.keys(SAMPLE_PARAMS).filter((k) => !ids.has(k))).toEqual([]);
  });

  it(
    'runs every datasource with default params (entity pages with a sample id)',
    { timeout: 60_000 },
    async () => {
      const failures: Failure[] = [];
      for (const def of pages) failures.push(...(await render(def)));
      expect(
        failures.map((f) => `${f.page} › ${f.datasource}: ${f.code} ${f.message.slice(0, 160)}`),
      ).toEqual([]);
    },
  );
});

describe('every active KQL probe and datasource has its af: fixture variant', () => {
  const kql = active(['probe']).filter(
    (p: Probe) =>
      p.check.kind === 'kql' &&
      ((p.check as { source?: string }).source === 'resourceGraph' ||
        (p.check as { source?: string }).source === 'logAnalytics'),
  ) as Probe[];
  const markers = (file: string): Set<string> => {
    const body = JSON.parse(readFileSync(file, 'utf8')) as {
      $fixture?: { variants?: Array<{ match?: { bodyIncludes?: string | string[] } }> };
    };
    return new Set(
      (body.$fixture?.variants ?? []).flatMap((v) =>
        [v.match?.bodyIncludes ?? []].flat().map((s) => s.toLowerCase()),
      ),
    );
  };
  const resourceGraph = markers(path.join(FIXTURES, 'resourceGraph/POST.json'));
  const logAnalytics = new Set(
    readdirSync(path.join(FIXTURES, 'logAnalytics')).flatMap((ws) => [
      ...markers(path.join(FIXTURES, 'logAnalytics', ws, 'POST.json')),
    ]),
  );

  it('finds them', () => expect(kql.length).toBeGreaterThan(20));

  it('every Resource Graph and Log Analytics datasource names a variant the fixtures have', () => {
    const missing = active(['page', 'dashboard', 'report']).flatMap((def: Def) =>
      Object.entries((def.datasources ?? {}) as Record<string, { source?: string; query?: string }>)
        .filter(([, ds]) => ds.source === 'resourceGraph' || ds.source === 'logAnalytics')
        .filter(([, ds]) => {
          const marker = /\/\/\s*(af:[A-Za-z0-9._#-]+)/.exec(ds.query ?? '')?.[1]?.toLowerCase();
          return !marker || !(ds.source === 'resourceGraph' ? resourceGraph : logAnalytics).has(marker);
        })
        .map(([name, ds]) => `${def.id}#${name} (${ds.source})`),
    );
    expect(missing).toEqual([]);
  });

  // The workspace the Log Analytics variants answer for (tests/fixtures/logAnalytics/…c1).
  const env = { AF_LOG_ANALYTICS_WORKSPACE_ID: '00000000-0000-4000-8000-0000000000c1' };
  const deps: ProbeDeps = {
    outbound,
    automation: null,
    connection: async () => {
      throw new Error('KQL probes use no connection');
    },
    env: () => env,
    now,
    fetch: async () => {
      throw new Error('KQL probes never fetch directly');
    },
  };

  it.each(kql.map((p) => [p.id, p] as const))('%s', async (id, p) => {
    const check = p.check as { source: string; query: string };
    const marker = `af:${id}`;
    expect(check.query.split('\n')[0]!.trim(), 'the first KQL line names the probe').toBe(`// ${marker}`);
    const variants = check.source === 'resourceGraph' ? resourceGraph : logAnalytics;
    expect(variants.has(marker.toLowerCase()), `a ${check.source} fixture variant matches "${marker}"`).toBe(
      true,
    );
    // …and the probe evaluates on it (ok, warn or crit from the synthetic estate, never "could not evaluate").
    const out = await runProbe(id, p, deps);
    expect(out.status, out.message).not.toBe('error');
  });
});
