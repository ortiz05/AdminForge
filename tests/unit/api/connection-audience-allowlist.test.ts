import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import { AppError } from '@adminforge/api/src/errors';
import {
  audienceHostList,
  connectionAudienceProblem,
  createOutboundExecutor,
  isMicrosoftResource,
  type OutboundDeps,
} from '@adminforge/api/src/execution/outbound';
import type { ExecutionIdentity } from '@adminforge/api/src/execution/types';
import { Connection } from '@adminforge/schemas';

// A connection's token goes to the connection's own host. Its audience (and scopes) may therefore only name your own
// app registrations: an allow-list, with Microsoft first-party resources refused even when listed.
const NOW = new Date('2026-10-15T12:00:00.000Z');

describe('connectionAudienceProblem (allow-list)', () => {
  const listed = audienceHostList('api.example.com, hr-sync.example.org.');

  it.each([
    'api://example-hr-sync',
    'api://11111111-2222-4333-8444-555555555555',
    'api://example.com/hr-sync',
    '11111111-2222-4333-8444-555555555555',
    'https://api.example.com',
    'https://api.example.com/hr',
    'https://API.EXAMPLE.COM.',
    'https://hr-sync.example.org',
  ])('allows %s', (aud) => expect(connectionAudienceProblem(aud, listed)).toBeUndefined());

  it.each([
    ['https://hr.example.net', 'not_listed'],
    ['https://func-hr.azurewebsites.net', 'not_listed'],
    ['https://graph.microsoft.com', 'microsoft'],
    ['https://graph.microsoft.com.', 'microsoft'],
    ['https://api.securitycenter.windows.com', 'microsoft'],
    ['https://app.vssps.visualstudio.com', 'microsoft'],
    ['https://api.applicationinsights.io', 'microsoft'],
    ['https://ps.outlook.com', 'microsoft'],
    ['https://analysis.windows.net/powerbi/api', 'microsoft'],
    ['https://contoso.crm.dynamics.com', 'microsoft'],
    ['https://outlook.cloud.microsoft', 'microsoft'],
    ['499b84ac-1321-427f-aa17-267ca6975798', 'microsoft'], // Azure DevOps
    ['00000009-0000-0000-c000-000000000000', 'microsoft'], // Power BI
    ['00000007-0000-0000-c000-000000000000', 'microsoft'], // Dynamics CRM
    ['0000000a-0000-0000-c000-000000000000', 'microsoft'], // Intune
    ['00000004-0000-0ff1-ce00-000000000000', 'microsoft'], // Skype for Business
    ['api://00000003-0000-0000-c000-000000000000', 'microsoft'],
    ['api://AzureADTokenExchange', 'microsoft'],
    ['http://api.example.com', 'invalid'],
    ['ftp://api.example.com', 'invalid'],
    ['https://user:pw@api.example.com', 'invalid'],
    ['api://bad value', 'invalid'],
    ['', 'invalid'],
  ])('refuses %s (%s)', (aud, problem) => expect(connectionAudienceProblem(aud, listed)).toBe(problem));

  it('refuses a Microsoft host even when an administrator lists it', () => {
    expect(connectionAudienceProblem('https://graph.microsoft.com', ['graph.microsoft.com'])).toBe(
      'microsoft',
    );
  });

  it('isMicrosoftResource strips the trailing dot before matching', () => {
    expect(isMicrosoftResource('https://management.azure.com.')).toBe(true);
    expect(isMicrosoftResource('https://api.example.com')).toBe(false);
  });
});

describe('connection schema: scopes are names on the connection audience', () => {
  const base = {
    kind: 'connection',
    id: 'integrations.hr',
    version: '1.0.0',
    title: 'HR',
    owner: 'test',
    baseUrl: 'https://hr.example.com',
    audience: 'api://example-hr',
    operations: { health: { method: 'GET', path: '/health', mode: 'read' } },
  };
  it('accepts plain scope names', () =>
    expect(Connection.safeParse({ ...base, scopes: ['user_impersonation', 'Hr.Read-All'] }).success).toBe(
      true,
    ));
  it.each([['https://graph.microsoft.com/.default'], ['api://other/user_impersonation'], ['openid profile']])(
    'refuses %s',
    (scope) => expect(Connection.safeParse({ ...base, scopes: [scope] }).success).toBe(false),
  );
});

describe('function connections: tokens only for <audience>/<scope name>', () => {
  function setup(def: Partial<Connection>, hosts?: string) {
    const scopes: string[][] = [];
    const urls: string[] = [];
    const auth = {
      token: async (i: { scopes: string[] }) => {
        scopes.push(i.scopes);
        return 'token-read';
      },
    } as unknown as AuthClient;
    const connection = {
      kind: 'connection',
      id: 'integrations.hr',
      version: '1.0.0',
      title: 'HR',
      owner: 'test',
      baseUrl: 'https://attacker.example',
      audience: 'api://example-hr',
      operations: { list: { method: 'GET', path: '/list', mode: 'read' } },
      ...def,
    } as Connection;
    const deps: OutboundDeps = {
      config: {
        DATA_MODE: 'live',
        AF_SPO_TENANT_NAME: undefined,
        OUTBOUND_CONCURRENCY: 4,
        OUTBOUND_USER_CONCURRENCY: 2,
        OUTBOUND_TIMEOUT_MS: 5000,
        TOKEN_CACHE_KEY: undefined,
        ...(hosts ? { AF_CONNECTION_AUDIENCE_HOSTS: hosts } : {}),
      },
      broker: new TokenBroker(auth, {}, () => NOW),
      auth,
      automation: null,
      connection: async (key) => {
        if (key !== connection.id) throw new AppError(404, 'definition_not_found', 'no');
        return connection;
      },
      env: () => ({}),
      fetch: async (input) => {
        urls.push(String(input));
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
      },
      now: () => NOW,
      sleep: async () => undefined,
      maxRetries: 0,
    };
    const identity: ExecutionIdentity = {
      kind: 'delegated',
      mode: 'read',
      session: {
        idHash: 'sid',
        userOid: '44444444-5555-4666-8777-888888888888',
        upn: 'avery@example.com',
        displayName: 'Avery',
        tenantId: '11111111-2222-4333-8444-555555555555',
        tenantName: 'Example Org',
        tenantDomain: 'example.com',
        roles: ['Portal.Reader'],
        csrf: 'x',
        readAccountId: 'read-acct',
        writeAccountId: null,
        writeExpiresAt: null,
        writeExtended: false,
        writeReason: null,
        createdAt: NOW,
        lastSeenAt: NOW,
        expiresAt: new Date(NOW.getTime() + 3_600_000),
        ip: null,
        userAgent: null,
      },
    };
    const run = () =>
      createOutboundExecutor(deps).execute(identity, {
        service: 'function',
        method: 'GET',
        path: 'list',
        connection: 'integrations.hr',
      });
    return { run, scopes, urls };
  }

  it('never requests a Graph token through a scope URI (finding: scopes bypassed the audience check)', async () => {
    const t = setup({ scopes: ['https://graph.microsoft.com/.default'] });
    await expect(t.run()).rejects.toMatchObject({ code: 'connection_scope_not_allowed' });
    expect(t.scopes).toEqual([]);
    expect(t.urls).toEqual([]);
  });

  it.each([['api://other-app/user_impersonation'], ['openid:x']])('refuses the scope %s', async (scope) => {
    const t = setup({ scopes: [scope] });
    await expect(t.run()).rejects.toMatchObject({ code: 'connection_scope_not_allowed' });
    expect(t.urls).toEqual([]);
  });

  it('builds <audience>/<name> for every scope name', async () => {
    const t = setup({ scopes: ['Hr.Read', 'user_impersonation'] });
    await t.run();
    expect(t.scopes).toEqual([['api://example-hr/Hr.Read', 'api://example-hr/user_impersonation']]);
  });

  it('refuses an https audience whose host is not listed, with a hint for the administrator', async () => {
    const t = setup({ audience: 'https://hr.example.com' });
    const err = (await t.run().catch((e: unknown) => e)) as AppError;
    expect(err).toMatchObject({ code: 'connection_audience_not_allowed' });
    expect(err.extras.hint).toContain('AF_CONNECTION_AUDIENCE_HOSTS');
    expect(t.urls).toEqual([]);
  });

  it('accepts an https audience on a listed host', async () => {
    const t = setup({ audience: 'https://hr.example.com' }, 'hr.example.com');
    await t.run();
    expect(t.scopes).toEqual([['https://hr.example.com/user_impersonation']]);
  });

  it('refuses a Microsoft audience (trailing dot included) and never fetches', async () => {
    const t = setup({ audience: 'https://graph.microsoft.com.' }, 'graph.microsoft.com');
    await expect(t.run()).rejects.toMatchObject({ code: 'connection_audience_not_allowed' });
    expect(t.urls).toEqual([]);
  });
});
