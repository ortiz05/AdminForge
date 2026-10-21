import type { AuthClient } from '@adminforge/api/src/auth/types';
import { createAppIdentityRegistry } from '@adminforge/api/src/auth/automation';
import { loadConfig, scheduleIdentities } from '@adminforge/api/src/config';
import { createOutboundExecutor, type OutboundDeps } from '@adminforge/api/src/execution/outbound';
import {
  identityCacheKey,
  identitySessionKey,
  type ExecutionIdentity,
} from '@adminforge/api/src/execution/types';

// Named app identities and creators' grants on the one outbound path (ADR-014): each app identity gets its own
// app-only tokens from its own app registration; a schedule's grant gets delegated Read-app tokens from that
// schedule's token-cache partition and never writes; results and limits are never shared between identities.

const NOW = new Date('2026-10-15T12:00:00.000Z');
const BASE = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  AUTH_MODE: 'entra',
  DATA_MODE: 'live',
  AF_TENANT_ID: '11111111-2222-4333-8444-555555555555',
  AF_AUTOMATION_CLIENT_ID: '00000000-0000-4000-8000-00000000a000',
  AF_AUTOMATION_CLIENT_SECRET: 's',
  AF_READ_CLIENT_ID: '00000000-0000-4000-8000-00000000a0f1',
  AF_READ_CLIENT_SECRET: 's',
  TOKEN_CACHE_KEY: Buffer.alloc(32, 7).toString('base64'),
  DATABASE_PATH: '/var/lib/adminforge/adminforge.db',
};
const REPORTS_APP = '00000000-0000-4000-8000-00000000a001';

const grant: ExecutionIdentity = {
  kind: 'grant',
  mode: 'read',
  grant: {
    scheduleId: 's-1',
    scheduleKey: 'portal.x',
    oid: 'u-1',
    upn: 'avery@example.com',
    homeAccountId: 'home-1',
    partitionKey: 'schedule:s-1',
  },
};

describe('AF_SCHEDULE_IDENTITIES', () => {
  it('reads each identity from AF_IDENTITY_<NAME>_* (names only in problems)', () => {
    const cfg = loadConfig({
      ...BASE,
      AF_SCHEDULE_IDENTITIES: 'reports-team, intune-ops',
      AF_IDENTITY_REPORTS_TEAM_CLIENT_ID: REPORTS_APP,
      AF_IDENTITY_REPORTS_TEAM_CERT_PATH: '/etc/adminforge/reports.pem',
      AF_IDENTITY_INTUNE_OPS_CLIENT_ID: '00000000-0000-4000-8000-00000000a002',
      AF_IDENTITY_INTUNE_OPS_CLIENT_SECRET: 'secret-value',
    });
    expect(cfg.SCHEDULE_IDENTITIES).toEqual([
      { name: 'reports-team', clientId: REPORTS_APP, certPath: '/etc/adminforge/reports.pem' },
      { name: 'intune-ops', clientId: '00000000-0000-4000-8000-00000000a002', clientSecret: 'secret-value' },
    ]);
  });

  it('refuses bad names, missing credentials, reused apps and credentials in mock mode — never echoing values', () => {
    const parsed = (env: Record<string, string>) => scheduleIdentities(env, env as never).problems;
    expect(parsed({ ...BASE, AF_SCHEDULE_IDENTITIES: 'Reports' })[0]).toMatch(/lower-case/);
    expect(
      parsed({ ...BASE, AF_SCHEDULE_IDENTITIES: 'x1', AF_IDENTITY_X1_CLIENT_ID: REPORTS_APP })[0],
    ).toMatch(/AF_IDENTITY_X1_CERT_PATH or AF_IDENTITY_X1_CLIENT_SECRET/);
    expect(
      parsed({
        ...BASE,
        AF_SCHEDULE_IDENTITIES: 'x1',
        AF_IDENTITY_X1_CLIENT_ID: BASE.AF_AUTOMATION_CLIENT_ID,
        AF_IDENTITY_X1_CLIENT_SECRET: 'top-secret',
      })[0],
    ).toMatch(/app registration of its own/);
    expect(
      parsed({
        ...BASE,
        AF_PROTECTED_APP_IDS: `00000000-0000-4000-8000-0000000000ff, ${REPORTS_APP.toUpperCase()}`,
        AF_SCHEDULE_IDENTITIES: 'x1',
        AF_IDENTITY_X1_CLIENT_ID: REPORTS_APP,
        AF_IDENTITY_X1_CLIENT_SECRET: 'top-secret',
      })[0],
    ).toMatch(/listed in AF_PROTECTED_APP_IDS/);
    const mock = parsed({
      ...BASE,
      AUTH_MODE: 'mock',
      AF_SCHEDULE_IDENTITIES: 'x1',
      AF_IDENTITY_X1_CLIENT_ID: REPORTS_APP,
      AF_IDENTITY_X1_CLIENT_SECRET: 'top-secret',
    });
    expect(mock[0]).toMatch(/must not be set with AUTH_MODE=mock/);
    expect(JSON.stringify(mock)).not.toContain('top-secret');
    expect(() =>
      loadConfig({ ...BASE, AF_SCHEDULE_IDENTITIES: 'x1', AF_IDENTITY_X1_CLIENT_ID: 'not-a-guid' }),
    ).toThrow(/AF_IDENTITY_X1_CLIENT_ID/);
  });

  it('the registry: one provider per identity, every app-only client id protected', () => {
    const cfg = loadConfig({
      ...BASE,
      AF_SCHEDULE_IDENTITIES: 'reports-team',
      AF_IDENTITY_REPORTS_TEAM_CLIENT_ID: REPORTS_APP,
      AF_IDENTITY_REPORTS_TEAM_CLIENT_SECRET: 's',
    });
    const reg = createAppIdentityRegistry(cfg, {
      createClient: () => ({ acquireTokenByClientCredential: async () => ({ accessToken: 'x' }) }),
    });
    expect(reg.names()).toEqual(['reports-team']);
    expect(reg.get()!.clientId).toBe(BASE.AF_AUTOMATION_CLIENT_ID);
    expect(reg.get('reports-team')).toMatchObject({ clientId: REPORTS_APP, identity: 'reports-team' });
    expect(reg.get('nobody')).toBeNull();
    expect(reg.clientIds()).toEqual([BASE.AF_AUTOMATION_CLIENT_ID, REPORTS_APP]);
  });
});

function executor(over: Partial<OutboundDeps> = {}) {
  const calls: Array<{ url: string; auth: string }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      auth: new Headers(init?.headers).get('authorization') ?? '',
    });
    return new Response(JSON.stringify({ value: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const delegated: Array<{ partitionKey: string; homeAccountId: string; kind: string }> = [];
  const auth = {
    token: async (i: { kind: string; partitionKey: string; homeAccountId: string }) => {
      delegated.push({ kind: i.kind, partitionKey: i.partitionKey, homeAccountId: i.homeAccountId });
      return 'token-grant';
    },
  } as unknown as AuthClient;
  const deps: OutboundDeps = {
    config: {
      DATA_MODE: 'live',
      AF_SPO_TENANT_NAME: undefined,
      OUTBOUND_CONCURRENCY: 16,
      OUTBOUND_USER_CONCURRENCY: 6,
      OUTBOUND_TIMEOUT_MS: 5000,
      TOKEN_CACHE_KEY: undefined,
    },
    broker: null,
    auth,
    automation: { clientId: 'automation-app', credential: 'secret', token: async () => 'token-automation' },
    identities: {
      get: (name) =>
        name === 'reports-team'
          ? {
              clientId: REPORTS_APP,
              credential: 'certificate',
              identity: name,
              token: async () => 'token-reports',
            }
          : null,
    },
    fetch,
    now: () => NOW,
    sleep: async () => undefined,
    maxRetries: 0,
    ...over,
  };
  return { out: createOutboundExecutor(deps), calls, delegated };
}

const users = { service: 'graph' as const, method: 'GET', path: '/users' };

describe('outbound as an app identity or a grant', () => {
  it('a named app identity uses its own app-only token', async () => {
    const { out, calls } = executor();
    await out.execute({ kind: 'automation', mode: 'read', app: 'reports-team' }, users);
    await out.execute({ kind: 'automation', mode: 'read' }, users);
    expect(calls.map((c) => c.auth)).toEqual(['Bearer token-reports', 'Bearer token-automation']);
  });

  it('an app identity this host does not have: identity_not_configured, naming its keys', async () => {
    const { out } = executor();
    await expect(
      out.execute({ kind: 'automation', mode: 'read', app: 'ghost' }, users),
    ).rejects.toMatchObject({
      code: 'identity_not_configured',
      extras: { hint: expect.stringMatching(/AF_IDENTITY_GHOST_CLIENT_ID/) },
    });
  });

  it('a grant: delegated Read-app tokens from the schedule’s own partition', async () => {
    const { out, calls, delegated } = executor();
    await out.execute(grant, users);
    expect(delegated).toEqual([{ kind: 'read', partitionKey: 'schedule:s-1', homeAccountId: 'home-1' }]);
    expect(calls[0]!.auth).toBe('Bearer token-grant');
  });

  it('a grant never writes, whatever the call declares', async () => {
    const { out, calls } = executor();
    await expect(
      out.execute({ ...grant, mode: 'write' } as unknown as ExecutionIdentity, {
        service: 'graph',
        method: 'PATCH',
        path: '/users/u-2',
        body: { accountEnabled: false },
        declaredWrite: true,
      }),
    ).rejects.toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('results and limits are keyed per identity: no two of them share', () => {
    const keys = [
      identityCacheKey({ kind: 'automation', mode: 'read' }),
      identityCacheKey({ kind: 'automation', mode: 'read', app: 'reports-team' }),
      identityCacheKey({ kind: 'automation', mode: 'read', app: 'intune-ops' }),
      identityCacheKey(grant),
      identityCacheKey({ ...grant, grant: { ...grant.grant, scheduleId: 's-2' } } as ExecutionIdentity),
      identityCacheKey({ kind: 'delegated', mode: 'read', session: { userOid: 'u-1' } } as never),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    // A creator's grant never shares with their own interactive session either.
    expect(identitySessionKey(grant)).not.toBe('u-1');
  });
});
