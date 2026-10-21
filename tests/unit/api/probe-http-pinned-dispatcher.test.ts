import type { OutboundExecutor } from '@adminforge/api/src/execution/types';
import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import { Probe } from '@adminforge/schemas';

// DNS rebinding (security plan S-24): an HTTP probe checks that its host resolves only to public addresses, then
// connects. On the real network the connection is pinned, as for news feeds: the socket resolves the host again through
// a lookup that refuses non-public addresses (news/fetch-feed.ts `checkedConnectLookup`), so a name that answers
// "public" for the check and "loopback" for the connect is refused before any connection is made. The portal's own
// origin (which may live on a private address) and injected fetches (tests, DATA_MODE=fixtures) are not pinned.
// No test here opens a socket: every connect-time lookup is a fake that refuses or fails first.
const NOW = new Date('2026-10-21T12:00:00.000Z');

// The system resolver the pinned connection uses by default: every name "rebinds" to a LAN address here.
const systemLookups = vi.hoisted(() => [] as string[]);
vi.mock('node:dns/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns/promises')>()),
  lookup: async (host: string) => {
    systemLookups.push(host);
    return [{ address: '10.0.0.5', family: 4 }];
  },
}));

const PUBLIC = async () => ['93.184.216.34'];

const probe = (url: string) =>
  Probe.parse({
    kind: 'probe',
    id: 'probes.h',
    version: '1.0.0',
    title: 'H',
    owner: 'test',
    check: { kind: 'http', url, expect: { status: 200 } },
  });

const neverCalled = (async () => {
  throw new Error('the injected fetch must not be used on the pinned path');
}) as unknown as typeof fetch;

function deps(o: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    outbound: {} as OutboundExecutor,
    automation: null,
    connection: async () => {
      throw new Error('no connections');
    },
    env: () => ({ PUBLIC_BASE_URL: 'https://192.168.1.20:8443' }),
    now: () => NOW,
    fetch: neverCalled,
    lookup: PUBLIC,
    ...o,
  };
}

describe('HTTP probes on the pinned connection', () => {
  it('refuses a host that rebinds to loopback between the check and the connect', async () => {
    const lookups: string[] = [];
    const out = await runProbe(
      'probes.h',
      probe('https://status.example.com/health'),
      deps({
        connectLookup: async (host) => {
          lookups.push(host);
          return ['127.0.0.1']; // what the socket would have connected to
        },
      }),
    );
    expect(out).toMatchObject({ status: 'error', code: 'probe_target_not_allowed' });
    expect(out.message).toMatch(/private, loopback or link-local/);
    expect(lookups).toEqual(['status.example.com']);
  });

  it('refuses a host with one private address among public ones at connect time', async () => {
    const out = await runProbe(
      'probes.h',
      probe('https://status.example.com/health'),
      deps({ connectLookup: async () => ['93.184.216.34', '169.254.169.254'] }),
    );
    expect(out).toMatchObject({ status: 'error', code: 'probe_target_not_allowed' });
  });

  it('reports a name the socket cannot resolve as unreachable', async () => {
    const out = await runProbe(
      'probes.h',
      probe('https://status.example.com/health'),
      deps({
        connectLookup: async () => Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })),
      }),
    );
    expect(out).toMatchObject({ status: 'crit', code: 'unreachable' });
    expect(out.message).toMatch(/ENOTFOUND/);
  });

  it('pins the platform fetch: the socket resolves through the system resolver again and is refused', async () => {
    // The real network: the probe's fetch is the platform fetch. The up-front check sees a public address; the socket's
    // own lookup (the system resolver, faked above) sees a LAN address — refused, and the platform fetch is never
    // handed the request.
    const platform = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', platform);
    systemLookups.length = 0;
    try {
      const out = await runProbe(
        'probes.h',
        probe('https://status.example.com/health'),
        deps({ fetch: globalThis.fetch }),
      );
      expect(out).toMatchObject({ status: 'error', code: 'probe_target_not_allowed' });
      expect(systemLookups).toEqual(['status.example.com']);
      expect(platform).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("calls the portal's own origin directly (it may live on a private address)", async () => {
    const fetched: string[] = [];
    const out = await runProbe(
      'probes.h',
      probe('https://192.168.1.20:8443/readyz'),
      deps({
        fetch: (async (input: string) => {
          fetched.push(String(input));
          return new Response('{"status":"ok"}', { status: 200 });
        }) as unknown as typeof fetch,
        connectLookup: async () => {
          throw new Error('the own origin is not pinned');
        },
      }),
    );
    expect(out.status).toBe('ok');
    expect(fetched).toEqual(['https://192.168.1.20:8443/readyz']);
  });

  it('uses an injected fetch as is (tests, fixtures): it never opens a socket', async () => {
    const fetched: string[] = [];
    const out = await runProbe(
      'probes.h',
      probe('https://status.example.com/health'),
      deps({
        fetch: (async (input: string) => {
          fetched.push(String(input));
          return new Response('', { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );
    expect(out.status).toBe('ok');
    expect(fetched).toEqual(['https://status.example.com/health']);
  });
});
