import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import { loadConfig, type Config } from '@adminforge/api/src/config';
import { fixtureFetch } from '@adminforge/api/src/datasources/services';
import { createOutboundExecutor, type OutboundDeps } from '@adminforge/api/src/execution/outbound';
import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import { Probe } from '@adminforge/schemas';

// Graph and ARM probes on DATA_MODE=fixtures go through the outbound executor and the fixture fetch. A request without
// a fixture answers 404 `FixtureNotFound`, which became a crit `not_found` — a false alarm on Monitoring — and with
// Entra sign-in on fixtures its message named the fixture file to create. It is "could not evaluate" now
// (`fixture_not_found`, status error), like the HTTP, DNS and certificate probes' missing fixtures, and names no file.

const NOW = new Date('2026-10-21T12:00:00.000Z');
const AUTOMATION_APP = '44444444-0000-4000-8000-0000000000a0';
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'af-probe-fixture-missing-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (rel: string, content: unknown) => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(content));
};

const config = (auth: 'mock' | 'entra'): Config =>
  loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:5173',
    AUTH_MODE: auth,
    DATA_MODE: 'fixtures',
    ADMINFORGE_FIXTURES_DIR: dir,
    ...(auth === 'entra'
      ? {
          DATABASE_PATH: '/nonexistent/adminforge-test-unused.db',
          TOKEN_CACHE_KEY: Buffer.alloc(32, 7).toString('base64'),
          AF_TENANT_ID: '11111111-2222-4333-8444-555555555555',
          AF_READ_CLIENT_ID: '22222222-3333-4444-8555-666666666666',
          AF_READ_CLIENT_SECRET: 'synthetic-read-secret',
          AF_WRITE_CLIENT_ID: '33333333-4444-4555-8666-777777777777',
          AF_WRITE_CLIENT_SECRET: 'synthetic-write-secret',
        }
      : {}),
  });

/** The probe dependencies with the real outbound executor over the fixture fetch, as fixtures mode wires them. */
function deps(auth: 'mock' | 'entra'): ProbeDeps {
  const cfg = config(auth);
  const client = { token: async () => 'token-delegated' } as unknown as AuthClient;
  const outbound = createOutboundExecutor({
    config: cfg,
    broker: new TokenBroker(client, {}, () => NOW),
    auth: client,
    automation: { clientId: AUTOMATION_APP, credential: 'secret', token: async () => 'token-app' },
    fetch: fixtureFetch(cfg),
    now: () => NOW,
    sleep: async () => undefined,
    maxRetries: 0,
  } as unknown as OutboundDeps);
  return {
    outbound,
    automation: null,
    connection: async () => Promise.reject(new Error('none')),
    env: () => ({}),
    now: () => NOW,
    fetch: async () => {
      throw new Error('no network in this test');
    },
    // As schedules/module.ts sets it with DATA_MODE=fixtures.
    fixtures: true,
  };
}

const probe = (check: Record<string, unknown>) =>
  Probe.parse({ kind: 'probe', id: 'probes.x', version: '1.0.0', title: 'X', owner: 'test', check });

const CHECKS: Array<[string, Record<string, unknown>]> = [
  ['graph', { kind: 'graph', path: '/organization' }],
  ['graph expecting a 404', { kind: 'graph', path: '/groups/missing', expect: { status: 404 } }],
  ['graphCount', { kind: 'graphCount', path: '/users' }],
  [
    'arm',
    { kind: 'arm', path: '/subscriptions/00000000-0000-4000-8000-000000000001', apiVersion: '2022-12-01' },
  ],
];

describe('Graph and ARM probes without a fixture', () => {
  for (const auth of ['mock', 'entra'] as const)
    for (const [name, check] of CHECKS)
      it(`${name} (${auth} sign-in): could not evaluate, no crit, no file named`, async () => {
        const out = await runProbe('probes.x', probe(check), deps(auth));
        expect(out).toMatchObject({ status: 'error', code: 'fixture_not_found' });
        expect(out.message).toMatch(/^The synthetic data has no answer for this /);
        expect(out.message).not.toMatch(/\.json|fixtures directory|graph\/v1\.0|Create /i);
      });

  it('outside fixtures mode the code means nothing special: a 404 is the target missing', async () => {
    const live = { ...deps('entra'), fixtures: false };
    expect(await runProbe('probes.x', probe({ kind: 'graph', path: '/organization' }), live)).toMatchObject({
      status: 'crit',
      code: 'not_found',
    });
  });

  it('a fixture that answers 404 is still the target missing (crit not_found)', async () => {
    put('graph/v1.0/groups/missing/GET.json', {
      $fixture: {
        status: 404,
        body: { error: { code: 'Request_ResourceNotFound', message: 'Resource does not exist.' } },
      },
    });
    const out = await runProbe('probes.x', probe({ kind: 'graph', path: '/groups/missing' }), deps('entra'));
    expect(out).toMatchObject({ status: 'crit', code: 'not_found' });
  });
});
