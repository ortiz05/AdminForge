import { isNonPublicAddress } from '@adminforge/api/src/probes/addresses';
import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import type { OutboundExecutor } from '@adminforge/api/src/execution/types';
import { Probe } from '@adminforge/schemas';

// HTTP probes run on the host with its network position: they may not reach loopback, the LAN, link-local addresses
// (cloud metadata) — except the portal's own origin — follow redirects, or POST without an explicit opt-in.
const NOW = new Date('2026-10-15T12:00:00.000Z');

const probe = (check: Record<string, unknown>) =>
  Probe.parse({ kind: 'probe', id: 'probes.h', version: '1.0.0', title: 'H', owner: 'test', check });

function deps(o: Partial<ProbeDeps> = {}) {
  const fetched: Array<{ url: string; init?: RequestInit }> = [];
  const d: ProbeDeps = {
    outbound: {} as OutboundExecutor,
    automation: null,
    connection: async () => {
      throw new Error('no connections');
    },
    env: () => ({ PUBLIC_BASE_URL: 'https://192.168.1.20:8443' }),
    now: () => NOW,
    fetch: async (input, init) => {
      fetched.push({ url: String(input), init });
      return new Response('{"status":"ok"}', { status: 200 });
    },
    lookup: async (host) => (host === 'status.example.com' ? ['93.184.216.34'] : ['10.0.0.5']),
    ...o,
  };
  return { d, fetched };
}

describe('isNonPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::5',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '64:ff9b::a00:1',
    '2002:c0a8:0101::1',
    'not-an-ip',
  ])('%s is not public', (ip) => expect(isNonPublicAddress(ip)).toBe(true));

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:93.184.216.34'])(
    '%s is public',
    (ip) => expect(isNonPublicAddress(ip)).toBe(false),
  );
});

describe('HTTP probe SSRF guard', () => {
  it('reaches a public host, without following redirects', async () => {
    const { d, fetched } = deps();
    const o = await runProbe(
      'probes.h',
      probe({ kind: 'http', url: 'https://status.example.com/health' }),
      d,
    );
    expect(o).toMatchObject({ status: 'ok' });
    expect(fetched[0]!.init?.redirect).toBe('manual');
  });

  it.each([
    'http://127.0.0.1:5432/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:3001/readyz',
    'http://localhost:3001/readyz',
    'https://intranet.example.com/', // resolves to 10.0.0.5
  ])('refuses %s', async (url) => {
    const { d, fetched } = deps();
    const o = await runProbe('probes.h', probe({ kind: 'http', url }), d);
    expect(o).toMatchObject({ status: 'error', code: 'probe_target_not_allowed' });
    expect(o.message).toMatch(/public/);
    expect(fetched).toEqual([]);
  });

  it('refuses when any address of the host is private (mixed answers)', async () => {
    const { d, fetched } = deps({ lookup: async () => ['93.184.216.34', '192.168.1.1'] });
    const o = await runProbe('probes.h', probe({ kind: 'http', url: 'https://mixed.example.com/' }), d);
    expect(o.code).toBe('probe_target_not_allowed');
    expect(fetched).toEqual([]);
  });

  it("allows the portal's own origin even on a LAN address (portal-readiness)", async () => {
    const { d, fetched } = deps();
    const o = await runProbe(
      'probes.h',
      probe({
        kind: 'http',
        url: '${ env.PUBLIC_BASE_URL & "/readyz" }',
        expect: { bodyContains: '"status":"ok"' },
      }),
      d,
    );
    expect(o).toMatchObject({ status: 'ok' });
    expect(fetched.map((f) => f.url)).toEqual(['https://192.168.1.20:8443/readyz']);
  });

  it('reports an unresolvable host as unreachable', async () => {
    const { d } = deps({
      lookup: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      },
    });
    const o = await runProbe('probes.h', probe({ kind: 'http', url: 'https://nope.example.com/' }), d);
    expect(o).toMatchObject({ status: 'crit', code: 'unreachable' });
    expect(o.message).toContain('ENOTFOUND');
  });

  it('a redirect is a failed expectation, with a note that it was not followed', async () => {
    const { d } = deps({
      fetch: async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/' } }),
    });
    const o = await runProbe('probes.h', probe({ kind: 'http', url: 'https://status.example.com/' }), d);
    expect(o).toMatchObject({ status: 'crit', code: 'expectation_failed' });
    expect(o.message).toMatch(/Redirects aren't followed/);
  });

  it('POST needs allowPost: true', async () => {
    const { d, fetched } = deps();
    const post = probe({
      kind: 'http',
      url: 'https://status.example.com/ping',
      method: 'POST',
      body: { a: 1 },
    });
    const refused = await runProbe('probes.h', post, d);
    expect(refused).toMatchObject({ status: 'error', code: 'content_error' });
    expect(refused.message).toMatch(/allowPost/);
    expect(fetched).toEqual([]);
    const allowed = { ...post, check: { ...post.check, allowPost: true } } as unknown as Probe;
    expect(await runProbe('probes.h', allowed, d)).toMatchObject({ status: 'ok' });
    expect(fetched[0]!.init?.method).toBe('POST');
  });

  it('reads at most 1 MB of the body when looking for text', async () => {
    const huge = new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(64 * 1024).fill(97));
      },
    });
    const { d } = deps({ fetch: async () => new Response(huge) });
    const o = await runProbe(
      'probes.h',
      probe({ kind: 'http', url: 'https://status.example.com/', expect: { bodyContains: 'needle' } }),
      d,
    );
    expect(o).toMatchObject({ status: 'crit', code: 'expectation_failed' });
  });
});
