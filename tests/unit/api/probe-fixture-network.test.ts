import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OutboundExecutor } from '@adminforge/api/src/execution/types';
import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import {
  createFixtureNetwork,
  FIXTURE_ADDRESS,
  PORTAL_FIXTURE_HOST,
} from '@adminforge/api/src/probes/fixture-network';
import { Probe } from '@adminforge/schemas';

// The network probes use in DATA_MODE=fixtures (probes/fixture-network.ts): HTTP from `hosts/`, the SSRF guard's lookup
// and DNS from `dns/`, certificates from `tls/` — the portal's own origin answered as portal.example.com, dates
// relative to the probe's clock, names kept inside the fixtures directory, and a missing or broken fixture reported as
// "could not evaluate" (error), never as a crit, without naming a file.

const NOW = new Date('2026-10-21T12:00:00.000Z');
const PUBLIC_BASE_URL = 'http://localhost:5173';
let root: string;
let dir: string;

const put = (rel: string, content: unknown) => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'af-fixture-network-'));
  dir = path.join(root, 'fixtures');
  mkdirSync(dir);
  // A canary next to the fixtures directory: nothing may read it.
  mkdirSync(path.join(root, 'dns', 'secret'), { recursive: true });
  writeFileSync(path.join(root, 'dns', 'secret', 'TXT.json'), JSON.stringify(['outside the fixtures']));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const network = () => createFixtureNetwork({ dir, publicBaseUrl: PUBLIC_BASE_URL, now: () => NOW });

const probe = (check: Record<string, unknown>) =>
  Probe.parse({ kind: 'probe', id: 'probes.x', version: '1.0.0', title: 'X', owner: 'test', check });

function deps(env: Record<string, string> = {}): ProbeDeps {
  const n = network();
  return {
    outbound: {} as OutboundExecutor,
    automation: null,
    connection: async () => {
      throw new Error('no connections');
    },
    env: () => ({ PUBLIC_BASE_URL, ...env }),
    now: () => NOW,
    fetch: n.fetch,
    lookup: n.lookup,
    dns: n.dns,
    tls: n.tls,
  };
}

describe('HTTP', () => {
  it("answers from hosts/, the portal's own origin as portal.example.com", async () => {
    put('hosts/status.example.com/health/GET.json', { status: 'ok' });
    put(`hosts/${PORTAL_FIXTURE_HOST}/readyz/GET.json`, { status: 'ok' });
    const n = network();
    expect(await (await n.fetch('https://status.example.com/health')).json()).toEqual({ status: 'ok' });
    expect((await n.fetch(`${PUBLIC_BASE_URL}/readyz`)).status).toBe(200);
    const out = await runProbe(
      'probes.x',
      probe({
        kind: 'http',
        url: '${ env.PUBLIC_BASE_URL & "/readyz" }',
        expect: { bodyContains: '"status":"ok"' },
      }),
      deps(),
    );
    expect(out).toMatchObject({ status: 'ok' });
  });

  it('reports a host without a fixture, or a broken one, as could-not-evaluate — no crit, no file name', async () => {
    put('hosts/broken.example.com/GET.json', '{ not json');
    for (const url of ['https://nothing.example.com/', 'https://broken.example.com/']) {
      const out = await runProbe('probes.x', probe({ kind: 'http', url }), deps());
      expect(out.status, url).toBe('error');
      expect(out.code).toMatch(/^fixture_(not_found|invalid)$/);
      expect(out.message).not.toMatch(/\.json|hosts\//);
    }
  });

  it('keeps the SSRF guard: a host whose A fixture is private is refused before the fetch', async () => {
    put('dns/intranet.example.com/A.json', ['10.0.0.5']);
    put('hosts/intranet.example.com/GET.json', { status: 'ok' });
    const out = await runProbe(
      'probes.x',
      probe({ kind: 'http', url: 'https://intranet.example.com/' }),
      deps(),
    );
    expect(out).toMatchObject({ status: 'error', code: 'probe_target_not_allowed' });
  });
});

describe('lookup', () => {
  it('answers the A and AAAA fixtures, else a synthetic public address', async () => {
    put('dns/www.example.com/A.json', ['93.184.216.34']);
    put('dns/www.example.com/AAAA.json', ['2606:2800:220:1:248:1893:25c8:1946']);
    const n = network();
    expect(await n.lookup('www.example.com')).toEqual([
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
    ]);
    expect(await n.lookup('other.example.com')).toEqual([FIXTURE_ADDRESS]);
  });
});

describe('DNS', () => {
  const dns = (name: string, type = 'TXT', expect: Record<string, unknown> = {}) =>
    probe({ kind: 'dnsResolve', name, type, expect });

  it('answers dns/<name>/<TYPE>.json and lets the probe judge it', async () => {
    put('dns/example.com/TXT.json', ['v=spf1 include:spf.protection.outlook.com -all']);
    const out = await runProbe(
      'probes.x',
      dns('example.com', 'TXT', { contains: ['include:spf.protection.outlook.com'] }),
      deps(),
    );
    expect(out).toMatchObject({ status: 'ok' });
  });

  it('answers a name that does not exist from { "error": "ENOTFOUND" } (a real finding, so crit)', async () => {
    put('dns/gone.example.com/MX.json', { error: 'ENOTFOUND' });
    const out = await runProbe('probes.x', dns('gone.example.com', 'MX'), deps());
    expect(out).toMatchObject({
      status: 'crit',
      code: 'expectation_failed',
      message: 'No MX record (ENOTFOUND).',
    });
  });

  it('reports a missing or broken fixture as could-not-evaluate, naming no file', async () => {
    put('dns/broken.example.com/TXT.json', '[');
    for (const name of ['missing.example.com', 'broken.example.com']) {
      const out = await runProbe('probes.x', dns(name), deps());
      expect(out.status, name).toBe('error');
      expect(out.message).not.toMatch(/\.json|dns\//);
    }
  });

  it('keeps every name inside the fixtures directory', async () => {
    const n = network();
    for (const name of ['../dns/secret', '../../dns/secret', '..', '%2e%2e/secret', 'a/../../dns/secret'])
      await expect(n.dns.resolve(name, 'TXT', { timeoutMs: 1000 }), name).rejects.toMatchObject({
        code: 'fixture_not_found',
      });
  });
});

describe('TLS', () => {
  const cert = (host: string) => probe({ kind: 'certExpiry', host, port: 443, warnDays: 21, critDays: 7 });

  it("answers tls/<host>/<port>.json relative to the probe's clock, the portal's own host as portal.example.com", async () => {
    put(`tls/${PORTAL_FIXTURE_HOST}/443.json`, {
      expiresInDays: 200,
      issuedDaysAgo: 165,
      subject: 'portal.example.com',
    });
    put('tls/expiring.example.com/443.json', { expiresInDays: 5 });
    const own = await runProbe('probes.x', cert('localhost'), deps());
    expect(own).toMatchObject({ status: 'ok', metric: 200 });
    const soon = await runProbe('probes.x', cert('expiring.example.com'), deps());
    expect(soon).toMatchObject({ status: 'crit', metric: 5 });
  });

  it('reports a missing or broken fixture as could-not-evaluate, naming no file', async () => {
    put('tls/broken.example.com/443.json', 'nope');
    for (const host of ['missing.example.com', 'broken.example.com']) {
      const out = await runProbe('probes.x', cert(host), deps());
      expect(out.status, host).toBe('error');
      expect(out.code).toMatch(/^fixture_(not_found|invalid)$/);
      expect(out.message).not.toMatch(/\.json|tls\//);
    }
  });
});
