import path from 'node:path';
import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import { createOutboundExecutor, type OutboundDeps } from '@adminforge/api/src/execution/outbound';
import type { ExecutionIdentity } from '@adminforge/api/src/execution/types';
import { createOutboundPort } from '@adminforge/api/src/runs/ports';
import { Engine, MemoryRunStore, VirtualClock, type IdentityResolver } from '@adminforge/engine';
import { loadContentDir, type Playbook } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// L2 (whole-branch security review), end to end: `avd.log-off-user-session` signs a user out with an ARM DELETE marked
// `idempotent: false` — the session number may belong to someone else by the time a second DELETE lands. The step's
// flag now reaches the HTTP client through the engine, the API's outbound port and the executor, so the DELETE goes out
// once even when Azure answers 500 (the HTTP client otherwise resends a DELETE, safe to repeat by method) — and a claims
// challenge on its poll, once Azure accepted it, doesn't send it again either.

const NOW = new Date('2026-10-21T12:00:00.000Z');
const USER = '44444444-5555-4666-8777-888888888888';
const SESSION_ID =
  '/subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg-example-avd/providers/Microsoft.DesktopVirtualization/hostPools/hp-example-pooled/sessionHosts/avd-ex-0001.example.com/userSessions/3';

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'), { references: false });
const logOff = loaded.definitions.find((d) => d.def.id === 'avd.log-off-user-session')!.def as Playbook;

const armedSession: SessionRecord = {
  idHash: 'sid-hash',
  userOid: USER,
  upn: 'avery@example.com',
  displayName: 'Avery Engineer',
  tenantId: '11111111-2222-4333-8444-555555555555',
  tenantName: 'Example Org',
  tenantDomain: 'example.com',
  roles: ['Portal.Reader', 'Portal.Operator'],
  csrf: 'x',
  readAccountId: 'read-acct',
  writeAccountId: 'write-acct',
  writeExpiresAt: new Date(NOW.getTime() + 600_000),
  writeExtended: false,
  writeReason: null,
  createdAt: NOW,
  lastSeenAt: NOW,
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  ip: null,
  userAgent: null,
};

const OPERATION = 'https://management.azure.com/operations/op-1';

/**
 * Azure: the session read answers who holds it; every DELETE fails with 500 — or, with `accepted`, is accepted (202)
 * and the operation's poll gets a Continuous Access Evaluation claims challenge.
 */
function azure(accepted = false) {
  const methods: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    methods.push(method);
    if (method === 'GET' && String(input).startsWith(OPERATION))
      return Response.json(
        { error: { code: 'InvalidAuthenticationToken', message: 'Claims challenge.' } },
        {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer error="insufficient_claims", claims="eyJhY2Nlc3NfdG9rZW4iOnt9fQ=="',
          },
        },
      );
    if (method === 'GET')
      return Response.json({
        name: 'hp-example-pooled/avd-ex-0001.example.com/3',
        type: 'Microsoft.DesktopVirtualization/hostPools/sessionHosts/userSessions',
        properties: { userPrincipalName: 'm.chen@example.com', sessionState: 'Active' },
      });
    if (accepted) return new Response(null, { status: 202, headers: { location: OPERATION } });
    return Response.json({ error: { code: 'InternalServerError', message: 'Try again.' } }, { status: 500 });
  };
  return { fetch, methods };
}

async function runLogOff(def: Playbook, accepted = false) {
  const cloud = azure(accepted);
  const auth = { token: async () => 'token' } as unknown as AuthClient;
  const deps: OutboundDeps = {
    config: {
      DATA_MODE: 'live',
      AF_SPO_TENANT_NAME: undefined,
      OUTBOUND_CONCURRENCY: 4,
      OUTBOUND_USER_CONCURRENCY: 2,
      OUTBOUND_TIMEOUT_MS: 5000,
      TOKEN_CACHE_KEY: undefined,
    },
    broker: new TokenBroker(auth, {}, () => NOW),
    auth,
    automation: null,
    fetch: cloud.fetch,
    now: () => NOW,
    sleep: async () => undefined,
    maxRetries: 3,
  };
  const executor = createOutboundExecutor(deps);
  const identity: IdentityResolver = {
    resolve: async (_run, actor, mode) => ({
      actor,
      mode,
      handle: { kind: 'delegated', session: armedSession, mode } satisfies ExecutionIdentity,
    }),
  };
  const clock = new VirtualClock();
  const store = new MemoryRunStore(clock.now);
  store.create({
    id: 'run-1',
    kind: 'playbook',
    definitionKey: def.id,
    inputs: {
      userSessionId: SESSION_ID,
      expectedUser: 'm.chen@example.com',
      reason: 'ticket 5521 frozen session',
    },
    initiator: { kind: 'delegated', oid: USER, upn: 'avery@example.com' },
  });
  const engine = new Engine({ store, clock, identity, outbound: createOutboundPort(() => executor) });
  const outcome = await engine.execute('run-1', def);
  return { outcome, methods: cloud.methods };
}

describe('avd.log-off-user-session: the sign-out DELETE goes out once', () => {
  it('declares idempotent: false on the DELETE', () => {
    const step = logOff.steps.find((s) => s.id === 'logOff')!;
    expect(step).toMatchObject({
      type: 'arm',
      mode: 'write',
      idempotent: false,
      request: { method: 'DELETE' },
    });
  });

  it('a 500 from Azure fails the step after a single DELETE', async () => {
    const { outcome, methods } = await runLogOff(logOff);
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatchObject({ stepId: 'logOff' });
    expect(methods).toEqual(['GET', 'DELETE']);
  });

  it('without idempotent: false the same DELETE would have been resent (the control)', async () => {
    const resent: Playbook = {
      ...logOff,
      steps: logOff.steps.map((s) => (s.id === 'logOff' ? { ...s, idempotent: undefined } : s)),
    };
    const { methods } = await runLogOff(resent);
    expect(methods).toEqual(['GET', 'DELETE', 'DELETE', 'DELETE', 'DELETE']);
  });

  it('a claims challenge on the sign-out’s poll, after Azure accepted it, does not send the DELETE again', async () => {
    const { outcome, methods } = await runLogOff(logOff, true);
    // Before, the token broker answered the challenge by running the whole call again: DELETE, poll, DELETE, poll.
    expect(methods).toEqual(['GET', 'DELETE', 'GET']);
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.message).toMatch(/^Azure accepted the change/);
  });
});
