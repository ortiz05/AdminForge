import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import { isBatchPath } from '@adminforge/api/src/execution/batch';
import { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
import { isSensitiveWrite, namesObjectByKey } from '@adminforge/api/src/execution/protected';
import type { ExecutionIdentity, ServiceCall } from '@adminforge/api/src/execution/types';

// The protected-object guard matches object ids. Three ways a declared Graph write could get past it (2026-10-22
// security review), each refused whatever Microsoft Graph does with the request:
// - an alternate key (`groups(uniqueName='…')`, which provisioning sets on AdminForge's own groups and apps);
// - an empty path segment (`/groups//{id}/members/$ref`) while the protected set can't be read;
// - `$batch` written another way (`/$Batch`, `/$batch/`, `/%24batch`), sent as one opaque write.
// Synthetic ids only.
const READ_APP = '22222222-3333-4444-8555-666666666666';
const WRITE_APP = '33333333-4444-4555-8666-777777777777';
const AUTOMATION_APP = '44444444-0000-4000-8000-0000000000a0';
const spObject = (appId: string) => `6${appId.slice(1)}`;
const PORTAL_GROUP = '00000000-0000-4000-8000-0000000002ff';
const GROUP = '00000000-0000-4000-8000-000000000201';
const USER = '00000000-0000-4000-8000-000000000102';
const NOW = Date.parse('2026-10-22T12:00:00.000Z');

const session = (): SessionRecord => ({
  idHash: 'sid-hash',
  userOid: '00000000-0000-4000-8000-0000000000c0',
  upn: 'avery@example.com',
  displayName: 'Avery Engineer',
  tenantId: '11111111-2222-4333-8444-555555555555',
  tenantName: 'Example Org',
  tenantDomain: 'example.com',
  roles: ['Portal.Reader', 'Portal.Operator'],
  csrf: 'x',
  readAccountId: 'read-acct',
  writeAccountId: 'write-acct',
  writeExpiresAt: new Date(NOW + 3_600_000),
  writeExtended: false,
  writeReason: null,
  createdAt: new Date(NOW),
  lastSeenAt: new Date(NOW),
  expiresAt: new Date(NOW + 3_600_000),
  ip: null,
  userAgent: null,
});
const ARMED: ExecutionIdentity = { kind: 'delegated', session: session(), mode: 'write' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The Read app's role holders are the portal group; `unreadable`: every directory read answers 403. */
function setup(opts: { unreadable?: boolean } = {}) {
  const sent: Array<{ method: string; url: string }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = decodeURIComponent(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    sent.push({ method, url });
    if (method === 'POST' && /\$batch$/.test(url))
      return json({ responses: [{ id: '1', status: 204, body: null }] });
    if (method !== 'GET') return new Response(null, { status: 204 });
    if (opts.unreadable)
      return json({ error: { code: 'Authorization_RequestDenied', message: 'Denied.' } }, 403);
    const byAppId = /\/(applications|servicePrincipals)\(appId='([^']+)'\)/.exec(url);
    if (byAppId) return json({ id: spObject(byAppId[2]!), appId: byAppId[2] });
    if (url.includes(`/servicePrincipals/${spObject(READ_APP)}/appRoleAssignedTo`))
      return json({ value: [{ principalId: PORTAL_GROUP }] });
    if (url.includes('/appRoleAssignedTo')) return json({ value: [] });
    return json({ value: [] });
  };
  const auth = { token: async (i: { kind: 'read' | 'write' }) => `token-${i.kind}` } as unknown as AuthClient;
  const out = createOutboundExecutor({
    config: {
      DATA_MODE: 'live',
      AF_SPO_TENANT_NAME: undefined,
      OUTBOUND_CONCURRENCY: 16,
      OUTBOUND_USER_CONCURRENCY: 6,
      OUTBOUND_TIMEOUT_MS: 5000,
      TOKEN_CACHE_KEY: undefined,
      AF_READ_CLIENT_ID: READ_APP,
      AF_WRITE_CLIENT_ID: WRITE_APP,
      AF_AUTOMATION_CLIENT_ID: AUTOMATION_APP,
    },
    broker: new TokenBroker(auth, {}, () => new Date(NOW)),
    auth,
    automation: { clientId: AUTOMATION_APP, credential: 'secret', token: async () => 'token-app' },
    fetch,
    now: () => new Date(NOW),
    sleep: async () => undefined,
    maxRetries: 0,
  });
  return { out, writes: () => sent.filter((s) => s.method !== 'GET') };
}

const write = (call: Omit<ServiceCall, 'service' | 'declaredWrite'>): ServiceCall => ({
  service: 'graph',
  declaredWrite: true,
  ...call,
});
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'went ahead',
    (e: unknown) => e,
  );

describe('alternate keys', () => {
  it.each([
    [
      'a group by uniqueName (members)',
      {
        method: 'POST',
        path: "/groups(uniqueName='sg-adminforge-dev-portal-admin')/members/$ref",
        body: { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${USER}` },
      },
    ],
    [
      'a group by uniqueName (properties)',
      {
        method: 'PATCH',
        path: "/groups(uniqueName='sg-adminforge-dev-portal-admin')",
        body: { description: 'x' },
      },
    ],
    [
      'an app by uniqueName',
      { method: 'PATCH', path: "/applications(uniqueName='adminforge-read-dev')", body: { web: {} } },
    ],
    [
      'a percent-encoded key',
      {
        method: 'PATCH',
        path: `/applications(${encodeURIComponent("uniqueName='adminforge-read-dev'")})`,
        body: {},
      },
    ],
    ['an empty key', { method: 'DELETE', path: '/servicePrincipals()' }],
    [
      'a reference in the body',
      {
        method: 'POST',
        path: `/groups/${GROUP}/members/$ref`,
        body: {
          '@odata.id':
            "https://graph.microsoft.com/v1.0/groups(uniqueName='sg-adminforge-dev-playbook-approver')",
        },
      },
    ],
    [
      'a key after a cast',
      {
        method: 'POST',
        path: "/directoryObjects/microsoft.graph.group(uniqueName='sg-adminforge-dev-portal-admin')/members/$ref",
        body: {},
      },
    ],
    [
      'an app key after a cast',
      {
        method: 'PATCH',
        path: "/directoryObjects/microsoft.graph.application(uniqueName='adminforge-read-dev')",
        body: {},
      },
    ],
    [
      'a key in its own segment',
      {
        method: 'POST',
        path: "/groups/(uniqueName='sg-adminforge-dev-portal-admin')/members/$ref",
        body: {},
      },
    ],
    [
      'a bare key segment',
      { method: 'PATCH', path: "/groups/uniqueName='sg-adminforge-dev-portal-admin'", body: {} },
    ],
    [
      'a name .NET folds (groupſ)',
      { method: 'POST', path: "/groupſ(uniqueName='sg-adminforge-dev-portal-admin')/members/$ref", body: {} },
    ],
    [
      'a GUID without hyphens',
      { method: 'POST', path: '/groups/000000000000400080000000000002ff/members/$ref', body: {} },
    ],
    [
      'a stray % that stopped decoding',
      {
        method: 'POST',
        path: "/groups%28uniqueName='sg-adminforge-dev-portal-admin'%29/members/$ref%",
        body: {},
      },
    ],
    [
      'a reference with leading spaces',
      {
        method: 'POST',
        path: `/groups/${GROUP}/members/$ref`,
        body: { '@odata.id': "  groups(uniqueName='sg-adminforge-dev-portal-admin')" },
      },
    ],
    [
      'a reference with a cast',
      {
        method: 'POST',
        path: `/groups/${GROUP}/members/$ref`,
        body: {
          '@odata.id':
            "https://graph.microsoft.com/v1.0/directoryObjects/microsoft.graph.group(uniqueName='x')",
        },
      },
    ],
    [
      'a reference by unhyphenated id',
      {
        method: 'POST',
        path: `/groups/${GROUP}/members/$ref`,
        body: {
          '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/000000000000400080000000000002ff',
        },
      },
    ],
    [
      'a space before the key',
      {
        method: 'POST',
        path: "/groups (uniqueName='sg-adminforge-dev-portal-admin')/members/$ref",
        body: {},
      },
    ],
    [
      'junk after the key',
      { method: 'PATCH', path: "/groups(uniqueName='sg-adminforge-dev-portal-admin');", body: {} },
    ],
  ])('refuses %s with nothing sent', async (_name, call) => {
    const t = setup();
    expect(await outcome(t.out.execute(ARMED, write(call as never)))).toMatchObject({
      status: 403,
      code: 'object_not_by_id',
    });
    expect(t.writes()).toEqual([]);
  });

  it('refuses a user named by a .NET-folded collection (userſ) as named by sign-in name', async () => {
    const t = setup();
    const call = write({
      method: 'PATCH',
      path: '/userſ/breakglass@example.com',
      body: { accountEnabled: false },
    });
    expect(await outcome(t.out.execute(ARMED, call))).toMatchObject({ status: 403, code: 'user_not_by_id' });
    expect(t.writes()).toEqual([]);
  });

  it('matches a protected id written without hyphens anywhere in a write', async () => {
    const t = setup();
    const bare = PORTAL_GROUP.replace(/-/g, '').toUpperCase();
    const call = write({
      method: 'POST',
      path: `/servicePrincipals/${GROUP}/appRoleAssignedTo`,
      body: { principalId: bare, resourceId: GROUP, appRoleId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(await outcome(t.out.execute(ARMED, call))).toMatchObject({ code: 'protected_object' });
    expect(t.writes()).toEqual([]);
  });

  it('keeps id and appId keys: they reach the id comparison', async () => {
    const t = setup();
    expect(
      namesObjectByKey(write({ method: 'PATCH', path: `/servicePrincipals(appId='${READ_APP}')` })),
    ).toBe(false);
    expect(namesObjectByKey(write({ method: 'PATCH', path: `/directoryObjects('${USER}')` }))).toBe(false);
    expect(namesObjectByKey(write({ method: 'PATCH', path: `/groups(id='${GROUP}')` }))).toBe(false);
    expect(
      await outcome(
        t.out.execute(
          ARMED,
          write({ method: 'PATCH', path: `/servicePrincipals(appId='${READ_APP}')`, body: {} }),
        ),
      ),
    ).toMatchObject({ code: 'protected_object' });
    expect(
      await outcome(
        t.out.execute(
          ARMED,
          write({ method: 'PATCH', path: `/groups/${GROUP}`, body: { description: 'x' } }),
        ),
      ),
    ).toBe('went ahead');
    for (const call of [
      {
        method: 'POST',
        path: '/groups',
        body: { displayName: 'Example', mailEnabled: false, securityEnabled: true },
      },
      { method: 'POST', path: `/applications/${GROUP}/addPassword`, body: {} },
      { method: 'POST', path: `/directoryObjects/${USER}/microsoft.graph.user/checkMemberGroups`, body: {} },
      { method: 'POST', path: '/groups/validateProperties', body: {} },
      { method: 'PUT', path: '/sites/x/drive/root:/IT/Applications/f.json:/content', body: 'x' },
      { method: 'PUT', path: `/drives/d/items/${GROUP}:/Groups/notes.groups:/content`, body: 'x' },
    ])
      expect(namesObjectByKey(write(call as never)), call.path).toBe(false);
  });
});

describe('empty path segments while the protected set is unreadable', () => {
  it.each([
    `/groups//${GROUP}/members/$ref`,
    `/groups/${GROUP}//members/$ref`,
    `//applications/${GROUP}`,
    `/directoryObjects/${GROUP}/microsoft.graph.group/members/$ref`,
    `/groups/${GROUP}/microsoft.graph.group/members/$ref`,
    `/directoryObjects/microsoft.graph.group/${GROUP}/members/$ref`,
    `/groupſ/${GROUP}/members/$ref`,
  ])('treats %s as the sensitive write it is', async (path) => {
    expect(isSensitiveWrite(write({ method: 'POST', path }))).toBe(true);
    const t = setup({ unreadable: true });
    const body = { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${USER}` };
    expect(await outcome(t.out.execute(ARMED, write({ method: 'POST', path, body })))).toMatchObject({
      code: 'protected_objects_unavailable',
    });
    expect(t.writes()).toEqual([]);
  });
});

describe('$batch however it is written', () => {
  it('recognises the spellings', () => {
    for (const p of ['/$batch', '/$Batch', '/$BATCH', '/$batch/', '/%24batch', '/%24Batch', '//$batch'])
      expect(isBatchPath(p), p).toBe(true);
    for (const p of ['/batch', '/$batchx', '/users/$batch', '/$batch;x'])
      expect(isBatchPath(p), p).toBe(false);
  });

  it.each(['/$batch;x', '/$batch.', '/$batch%20', '/$batchx'])(
    'refuses %s, which starts like a batch but is not one',
    async (path) => {
      const t = setup();
      const call = write({
        method: 'POST',
        path,
        body: { requests: [{ id: '1', method: 'GET', url: '/organization' }] },
      });
      expect(await outcome(t.out.execute(ARMED, call))).toMatchObject({ code: 'invalid_request' });
      expect(t.writes()).toEqual([]);
    },
  );

  it.each(['/v1.0/$batch', 'v1.0/$batch', '/beta/$batch', '/V1.0/$Batch'])(
    'refuses a batch inside a batch written %s',
    async (url) => {
      const t = setup();
      const call = write({
        method: 'POST',
        path: '/$batch',
        body: { requests: [{ id: '1', method: 'POST', url, body: { requests: [] } }] },
      });
      expect(await outcome(t.out.execute(ARMED, call))).toMatchObject({ code: 'invalid_request' });
      expect(t.writes()).toEqual([]);
    },
  );

  it.each(['/%20$batch', '/ $batch'])('refuses %s, a padded batch path', async (path) => {
    const t = setup();
    const call = write({
      method: 'POST',
      path,
      body: { requests: [{ id: '1', method: 'GET', url: '/organization' }] },
    });
    expect(await outcome(t.out.execute(ARMED, call))).toMatchObject({ code: 'invalid_request' });
  });

  it('refuses a batch inside a batch', async () => {
    const t = setup();
    const call = write({
      method: 'POST',
      path: '/$batch',
      body: { requests: [{ id: '1', method: 'POST', url: '/$Batch', body: { requests: [] } }] },
    });
    expect(await outcome(t.out.execute(ARMED, call))).toMatchObject({ code: 'invalid_request' });
    expect(t.writes()).toEqual([]);
  });

  it.each(['/$Batch', '/$batch/', '/%24batch'])(
    'checks each request of %s and sends the canonical path',
    async (path) => {
      const t = setup();
      const refused = write({
        method: 'POST',
        path,
        body: {
          requests: [{ id: '1', method: 'DELETE', url: `/groups/${PORTAL_GROUP}/members/${USER}/$ref` }],
        },
      });
      expect(await outcome(t.out.execute(ARMED, refused))).toMatchObject({ code: 'protected_object' });
      expect(t.writes()).toEqual([]);
      const allowed = write({
        method: 'POST',
        path,
        body: { requests: [{ id: '1', method: 'DELETE', url: `/groups/${GROUP}/members/${USER}/$ref` }] },
      });
      await t.out.execute(ARMED, allowed);
      expect(t.writes().map((w) => w.url)).toEqual(['https://graph.microsoft.com/v1.0/$batch']);
    },
  );
});
