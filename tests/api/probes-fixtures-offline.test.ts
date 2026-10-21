import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ScheduleRow, ScheduleRunRow } from '@adminforge/api/src/schedules/types';
import { loadContentDir, Schedule, type Probe } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';
import { mockConfig } from './helpers';
import { buildTestApp } from './support/app';

// DATA_MODE=fixtures never touches the network (functionality plan F-20, F-04): the probes' HTTP, DNS and TLS checks
// and Teams and e-mail delivery answer from tests/fixtures. Every probe sweep the content schedules runs here in a mock
// app whose platform fetch, system resolver and TLS connect throw — and record that they were called.
//
// Mock monitoring then shows only "not configured" for the settings mock mode doesn't have (no false crit), and with a
// synthetic configuration every HTTP, DNS and certificate probe passes from its host, DNS and TLS fixtures.

const network = vi.hoisted(() => ({ fetch: [] as string[], dns: [] as string[], tls: [] as string[] }));

vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>();
  const refuse = (name: string) => {
    network.dns.push(name);
    return Promise.reject(Object.assign(new Error('DNS is off in this test'), { code: 'ECONNREFUSED' }));
  };
  class Resolver {
    setServers() {}
    resolve4 = refuse;
    resolve6 = refuse;
    resolveCname = refuse;
    resolveMx = refuse;
    resolveTxt = refuse;
    resolveNs = refuse;
    resolveSrv = refuse;
    resolveCaa = refuse;
  }
  return { ...real, default: { ...real.default, lookup: refuse, Resolver }, lookup: refuse, Resolver };
});

vi.mock('node:tls', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:tls')>();
  const connect = (opts: { host?: string }) => {
    network.tls.push(String(opts?.host));
    throw new Error('TLS is off in this test');
  };
  return { ...real, default: { ...real.default, connect }, connect };
});

const CONTENT = path.join(repoRoot, 'portal/content');
const loaded = await loadContentDir(CONTENT);
const active = <T>(kind: string) =>
  loaded.definitions
    .map((d) => d.def as T & { kind: string; id: string; status?: string })
    .filter((d) => d.kind === kind && d.status !== 'retired' && d.status !== 'draft');

const probes = new Map(active<Probe>('probe').map((p) => [p.id, p]));
const sweeps = active<Schedule>('schedule').filter((s) => s.job.kind === 'probe');
/** Checks that would use the network outside fixtures mode. */
const NETWORK_KINDS = new Set(['http', 'dnsResolve', 'certExpiry']);
const networkProbes = [...probes.values()].filter((p) => NETWORK_KINDS.has(p.check.kind)).map((p) => p.id);

/** Everything mock mode or a synthetic tenant may answer; anything else would be the network leaking through. */
const NETWORK_FAILURES = new Set([
  'unreachable',
  'timeout',
  'expectation_failed',
  'not_found',
  'upstream_error',
]);

const SYNTHETIC_ENV = {
  AF_TENANT_ID: '00000000-0000-4000-8000-00000000e0e0',
  AF_PRIMARY_DOMAIN: 'example.com',
  AF_MAIL_DOMAIN: 'example.com',
  AF_SPO_TENANT_NAME: 'exampleorg',
};

let dirs: string[] = [];
beforeEach(() => {
  network.fetch.length = 0;
  network.dns.length = 0;
  network.tls.length = 0;
  vi.stubGlobal('fetch', async (input: unknown) => {
    network.fetch.push(String(input instanceof Request ? input.url : input));
    throw new TypeError('fetch failed: the network is off in this test');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** The mock API as `pnpm dev` builds it: the platform fetch on the context, content from portal/content. */
async function mockApp(o: { env?: Record<string, string>; delivery?: Record<string, string> } = {}) {
  const artifacts = mkdtempSync(path.join(tmpdir(), 'af-offline-'));
  dirs.push(artifacts);
  const { app } = await buildTestApp(mockConfig({ ADMINFORGE_ARTIFACTS_DIR: artifacts }), {
    deps: {
      fetch: globalThis.fetch,
      ...(o.env ? { contentEnv: () => o.env! } : {}),
      schedules: { inProcess: false, ...(o.delivery ? { delivery: { env: o.delivery } } : {}) },
    },
  });
  await app.ready();
  return app;
}

type App = Awaited<ReturnType<typeof mockApp>>;

const row = (def: Schedule): ScheduleRow => ({
  id: `schedule-${def.id}`,
  key: def.id,
  source: 'content',
  definition: def,
  sha256: 'x',
  enabled: true,
  createdBy: null,
  approvedBy: null,
  approvedTarget: null,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

async function runJob(app: App, def: Schedule) {
  const run: ScheduleRunRow = {
    id: `run-${def.id}`,
    scheduleId: `schedule-${def.id}`,
    scheduleKey: def.id,
    trigger: 'manual',
    status: 'running',
    runId: null,
    result: null,
    error: null,
    artifactPath: null,
    startedAt: new Date(),
    endedAt: null,
  };
  return app.schedules.jobs.run({
    schedule: row(def),
    def,
    run,
    signal: new AbortController().signal,
    correlationId: `offline-${def.id}`,
    scheduledBy: null,
  });
}

type Outcome = { probeKey: string; status: string; code: string; message: string };

/** Every sweep; then each probe's outcome (status and code from the job, the message as Monitoring shows it). */
async function sweepAll(app: App): Promise<Map<string, Outcome>> {
  const codes = new Map<string, string>();
  for (const s of sweeps) {
    const out = await runJob(app, s);
    for (const r of (out.result?.results ?? []) as Array<{ key: string; code: string }>)
      codes.set(r.key, r.code);
  }
  const latest = await app.schedules.store.latestProbeResults();
  return new Map(
    latest.map((r) => [
      r.probeKey,
      { probeKey: r.probeKey, status: r.status, code: codes.get(r.probeKey) ?? '', message: r.message },
    ]),
  );
}

const noNetwork = () => expect(network).toEqual({ fetch: [], dns: [], tls: [] });

describe('probe sweeps in fixtures mode never touch the network', { timeout: 30_000 }, () => {
  it('runs every sweep with mock mode’s empty configuration: unset settings say "not configured", nothing is crit', async () => {
    expect(sweeps.length).toBeGreaterThanOrEqual(5);
    const app = await mockApp();
    try {
      const results = await sweepAll(app);
      noNetwork();
      // Every active probe some sweep covers produced a result.
      expect(results.size).toBeGreaterThan(50);
      const leaks = [...results.values()].filter(
        (r) => NETWORK_FAILURES.has(r.code) || /reach|ENOTFOUND|handshake|fixture/i.test(r.message),
      );
      expect(leaks.map((r) => `${r.probeKey}: ${r.status} ${r.message}`)).toEqual([]);
      for (const key of networkProbes) {
        const r = results.get(key);
        if (!r) continue; // not swept (probes-schedules.test.ts holds every probe to a sweep)
        expect
          .soft(r.status === 'ok' || /is not set|are not set/.test(r.message), `${key}: ${r.message}`)
          .toBe(true);
        expect.soft(r.status, key).not.toBe('crit');
      }
      // The ones that need no setting pass from their host fixtures; the rest name what to set.
      for (const key of [
        'probes.exchange-outlook-web',
        'probes.exchange-outlook-connectivity',
        'probes.m365-web-portal',
        'probes.teams-web-client',
        'probes.portal-readiness',
        'probes.portal-tls-certificate',
      ])
        expect.soft(results.get(key), key).toMatchObject({ status: 'ok' });
      for (const [key, setting] of [
        ['probes.entra-home-realm-discovery', 'AF_PRIMARY_DOMAIN'],
        ['probes.exchange-autodiscover-service', 'AF_MAIL_DOMAIN, AF_PRIMARY_DOMAIN'],
        ['probes.entra-openid-metadata', 'AF_TENANT_ID'],
        ['probes.sharepoint-endpoint', 'AF_SPO_TENANT_NAME'],
        ['probes.dns-mx', 'AF_MAIL_DOMAIN'],
        ['probes.dns-spf', 'AF_MAIL_DOMAIN'],
        ['probes.dns-dmarc', 'AF_MAIL_DOMAIN'],
        ['probes.dns-autodiscover', 'AF_MAIL_DOMAIN'],
      ])
        expect.soft(results.get(key)?.message, key).toMatch(new RegExp(`^${setting} (is|are) not set`));
    } finally {
      await app.close();
    }
  });

  it('passes every HTTP, DNS and certificate probe from its fixtures with a synthetic configuration', async () => {
    const app = await mockApp({ env: SYNTHETIC_ENV });
    try {
      const results = await sweepAll(app);
      noNetwork();
      for (const key of networkProbes) {
        const r = results.get(key);
        if (!r) continue;
        expect.soft(`${key}: ${r.status} ${r.message}`).toMatch(/: ok /);
      }
    } finally {
      await app.close();
    }
  });
});

describe('delivery in fixtures mode never touches the network', { timeout: 30_000 }, () => {
  it('posts to Teams and sends e-mail through the fixtures (mock mode accepts them; nothing leaves the host)', async () => {
    const app = await mockApp({
      delivery: {
        AF_MAIL_SENDER: 'reports@example.com',
        AF_REPORT_RECIPIENTS: 'ops@example.com',
        AF_TEAMS_ALERTS_WEBHOOK:
          'https://example.webhook.office.com/webhookb2/00000000-0000-4000-8000-0000000000f1',
      },
    });
    try {
      const def = Schedule.parse({
        kind: 'schedule',
        id: 'test.offline-delivery',
        version: '1.0.0',
        title: 'Offline delivery',
        owner: 'test',
        every: 'every day at 07:00',
        identity: 'automation',
        job: {
          kind: 'report',
          ref: 'identity.app-credential-expiry',
          delivery: [
            { type: 'file', format: 'csv' },
            { type: 'email', to: ['${ env.AF_REPORT_RECIPIENTS }'] },
            { type: 'teams', webhook: '${ env.AF_TEAMS_ALERTS_WEBHOOK }' },
          ],
        },
      });
      const out = await runJob(app, def);
      noNetwork();
      expect(out.status ?? 'succeeded').toBe('succeeded');
      expect(out.result?.delivery).toEqual([
        { type: 'email', status: 'sent', message: 'Sent to 1 recipient(s).' },
        { type: 'teams', status: 'sent', message: 'Posted to Teams.' },
      ]);
    } finally {
      await app.close();
    }
  });
});
