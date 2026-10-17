import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import { createOutboundExecutor, type OutboundDeps } from '@adminforge/api/src/execution/outbound';
import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import { Probe } from '@adminforge/schemas';

// Synthetic transactions through the real outbound executor (not a fake): the emergency stop holds their writes back,
// the protected-object guard refuses one aimed at a protected account, and otherwise the write goes out with the
// app-only token. Synthetic ids only.
const AUTOMATION_APP = '44444444-0000-4000-8000-0000000000a0';
const BREAK_GLASS = '00000000-0000-4000-8000-0000000001ff';
const TEST_USER = '00000000-0000-4000-8000-000000000102';
const NOW = Date.parse('2026-10-17T12:00:00.000Z');

const meeting = Probe.parse({
  kind: 'probe',
  id: 'probes.teams-online-meeting',
  version: '1.0.0',
  title: 'Teams meeting',
  owner: 'test',
  check: { kind: 'onlineMeeting' },
});

function run(organizer: string, over: Partial<OutboundDeps> = {}) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    sent.push({
      method,
      url: decodeURIComponent(String(input)),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    });
    if (method === 'POST')
      return new Response(JSON.stringify({ id: 'meet-1', joinWebUrl: 'https://teams.microsoft.com/l/x' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ value: [] }), { headers: { 'content-type': 'application/json' } });
  };
  const auth = { token: async () => 'token-delegated' } as unknown as AuthClient;
  const outbound = createOutboundExecutor({
    config: {
      DATA_MODE: 'live',
      AF_SPO_TENANT_NAME: undefined,
      OUTBOUND_CONCURRENCY: 16,
      OUTBOUND_USER_CONCURRENCY: 6,
      OUTBOUND_TIMEOUT_MS: 5000,
      TOKEN_CACHE_KEY: undefined,
      AF_READ_CLIENT_ID: '22222222-3333-4444-8555-666666666666',
      AF_WRITE_CLIENT_ID: '33333333-4444-4555-8666-777777777777',
      AF_AUTOMATION_CLIENT_ID: AUTOMATION_APP,
      AF_PROTECTED_APP_IDS: undefined,
      AF_PROTECTED_USER_IDS: BREAK_GLASS,
    },
    broker: new TokenBroker(auth, {}, () => new Date(NOW)),
    auth,
    automation: { clientId: AUTOMATION_APP, credential: 'secret', token: async () => 'token-app' },
    fetch,
    now: () => new Date(NOW),
    sleep: async () => undefined,
    maxRetries: 0,
    ...over,
  } as unknown as OutboundDeps);
  const deps: ProbeDeps = {
    outbound,
    automation: null,
    connection: async () => Promise.reject(new Error('none')),
    env: () => ({ AF_SYNTHETIC_USER_ID: organizer }),
    now: () => new Date(NOW),
    fetch,
  };
  return { out: runProbe('probes.teams-online-meeting', meeting, deps), sent };
}

type Sent = { method: string; url: string; auth?: string };
const writes = (sent: Sent[]) => sent.filter((s) => s.method !== 'GET');

describe('synthetic transactions through the outbound executor', () => {
  it('creates and deletes the meeting with the app-only token', async () => {
    const { out, sent } = run(TEST_USER);
    expect(await out).toMatchObject({ status: 'ok' });
    expect(writes(sent).map((s) => `${s.method} ${new URL(s.url).pathname} ${s.auth}`)).toEqual([
      `POST /v1.0/users/${TEST_USER}/onlineMeetings Bearer token-app`,
      `DELETE /v1.0/users/${TEST_USER}/onlineMeetings/meet-1 Bearer token-app`,
    ]);
  });

  it('sends nothing while changes are paused (emergency stop)', async () => {
    const { out, sent } = run(TEST_USER, { writesPaused: async () => true });
    expect(await out).toMatchObject({ status: 'error', code: 'writes_paused' });
    expect(writes(sent)).toEqual([]);
  });

  it('refuses a test user that is a protected account', async () => {
    const { out, sent } = run(BREAK_GLASS);
    expect(await out).toMatchObject({ status: 'error', code: 'protected_object' });
    expect(writes(sent)).toEqual([]);
  });
});
