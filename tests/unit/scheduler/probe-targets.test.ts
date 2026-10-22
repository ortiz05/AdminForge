import {
  runProbe,
  type DnsResolver,
  type PeerCertificate,
  type ProbeDeps,
  type TlsInspector,
} from '@adminforge/api/src/probes/checks';
import type { OutboundExecutor } from '@adminforge/api/src/execution/types';
import { probe } from './helpers';

// Certificate and DNS probes follow the HTTP probes' rule (2026-10-22 security review): a certificate probe connects
// only to this portal's own host or a host that resolves to public addresses, and to the address it checked; a DNS
// probe asks the system resolver, a public one by IP, or one an administrator listed in AF_PROBE_RESOLVERS. Content
// could otherwise point them at the host itself, the LAN or cloud metadata. Synthetic data only.
const NOW = new Date('2026-10-22T12:00:00.000Z');
const cert: PeerCertificate = {
  validFrom: new Date('2026-01-01'),
  validTo: new Date('2027-01-01'),
  authorized: true,
};

function deps(o: Partial<ProbeDeps> = {}, env: Record<string, unknown> = {}): ProbeDeps {
  return {
    outbound: {} as OutboundExecutor,
    automation: null,
    connection: async () => Promise.reject(new Error('none')),
    env: () => ({ PUBLIC_BASE_URL: 'https://portal.example.com:8443', ...env }),
    now: () => NOW,
    fetch: async () => new Response(''),
    ...o,
  };
}
const inspector = () => {
  const seen: Array<Record<string, unknown>> = [];
  const tls: TlsInspector = { inspect: async (opts) => (seen.push(opts), cert) };
  return { tls, seen };
};
const certProbe = (host: string) =>
  probe('probes.c', { check: { kind: 'certExpiry', host, port: 443, warnDays: 21, critDays: 7 } });
const lookup = (answers: Record<string, string[]>) => async (host: string) => answers[host] ?? [];

describe('certificate probe targets', () => {
  it.each([
    ['localhost', {}],
    ['127.0.0.1', {}],
    ['169.254.169.254', {}],
    ['internal.example.com', { 'internal.example.com': ['10.0.0.5'] }],
    ['mixed.example.com', { 'mixed.example.com': ['20.112.52.29', '192.168.1.4'] }],
  ])('refuses %s without connecting', async (host, answers) => {
    const { tls, seen } = inspector();
    const o = await runProbe('probes.c', certProbe(host), deps({ tls, lookup: lookup(answers) }));
    expect(o).toMatchObject({ status: 'error', code: 'probe_target_not_allowed' });
    expect(seen).toEqual([]);
  });

  it('connects to the public address it checked, naming the host for SNI', async () => {
    const { tls, seen } = inspector();
    const o = await runProbe(
      'probes.c',
      certProbe('www.example.com'),
      deps({ tls, lookup: lookup({ 'www.example.com': ['20.112.52.29'] }) }),
    );
    expect(o.status).toBe('ok');
    expect(seen).toEqual([
      expect.objectContaining({
        host: 'www.example.com',
        address: '20.112.52.29',
        servername: 'www.example.com',
      }),
    ]);
  });

  it('always reaches this portal’s own host on its own port or 443, wherever it lives — not its other ports', async () => {
    const own = (port: number) =>
      probe('probes.c', {
        check: { kind: 'certExpiry', host: 'portal.example.com', port, warnDays: 21, critDays: 7 },
      });
    const { tls, seen } = inspector();
    const look = lookup({ 'portal.example.com': ['10.0.0.8'] });
    expect((await runProbe('probes.c', own(8443), deps({ tls, lookup: look }))).status).toBe('ok');
    expect(seen[0]).not.toHaveProperty('address');
    expect(await runProbe('probes.c', own(22), deps({ tls, lookup: look }))).toMatchObject({
      code: 'probe_target_not_allowed',
    });
    expect((await runProbe('probes.c', own(443), deps({ tls, lookup: look }))).status).toBe('ok');
    expect(seen).toHaveLength(2);
  });

  it('reports a host whose name no longer resolves as unreachable', async () => {
    const { tls } = inspector();
    const gone = async () =>
      Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    const o = await runProbe('probes.c', certProbe('gone.example.com'), deps({ tls, lookup: gone }));
    expect(o).toMatchObject({ status: 'crit', code: 'unreachable' });
  });
});

describe('DNS probe resolvers', () => {
  const resolver = (server?: string) =>
    probe('probes.d', {
      check: { kind: 'dnsResolve', name: 'example.com', type: 'A', ...(server ? { resolver: server } : {}) },
    });
  const dns = () => {
    const asked: Array<string | undefined> = [];
    const d: DnsResolver = { resolve: async (_n, _t, opts) => (asked.push(opts.server), ['20.112.52.29']) };
    return { d, asked };
  };

  it.each(['10.0.0.53', '127.0.0.53', '169.254.169.254', 'dns.internal.example'])(
    'refuses %s',
    async (server) => {
      const { d, asked } = dns();
      const o = await runProbe('probes.d', resolver(server), deps({ dns: d }));
      expect(o).toMatchObject({ status: 'error', code: 'probe_target_not_allowed' });
      expect(asked).toEqual([]);
    },
  );

  it('asks a public resolver, the system resolver, or one an administrator listed', async () => {
    for (const [server, env] of [
      ['1.1.1.1', {}],
      [undefined, {}],
      ['10.0.0.53', { AF_PROBE_RESOLVERS: '10.0.0.53, 10.0.0.54' }],
    ] as const) {
      const { d, asked } = dns();
      const o = await runProbe('probes.d', resolver(server), deps({ dns: d }, env));
      expect(o.status, String(server)).toBe('ok');
      expect(asked).toEqual([server]);
    }
  });
});
