import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import { AppError } from '@adminforge/api/src/errors';
import { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
import { namesUserByName } from '@adminforge/api/src/execution/protected';
import type { ExecutionIdentity, ServiceCall } from '@adminforge/api/src/execution/types';

// S-15: the protected-object guard matches object ids (GUIDs), but Graph also accepts a user's sign-in name
// (`/users/{upn}`, `users('{upn}')`, an `@odata.id` naming `/users/{upn}`). A declared Graph write that names a user
// by anything but an object id is refused, so no playbook can reach a break-glass account in AF_PROTECTED_USER_IDS
// by its UPN. GUID targets, reads by UPN, AdminForge's own notification mail and Teams chat members are unaffected.

// Synthetic ids only (never a real tenant).
const READ_APP = '22222222-3333-4444-8555-666666666666';
const WRITE_APP = '33333333-4444-4555-8666-777777777777';
const AUTOMATION_APP = '44444444-0000-4000-8000-0000000000a0';
const BREAK_GLASS = '00000000-0000-4000-8000-0000000001ff';
const GROUP = '00000000-0000-4000-8000-000000000201';
const USER = '00000000-0000-4000-8000-000000000102';
const UPN = 'breakglass@example.com';
const NOW = Date.parse('2026-10-21T12:00:00.000Z');

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
const READER: ExecutionIdentity = { kind: 'delegated', session: session(), mode: 'read' };
const AUTOMATION_WRITE: ExecutionIdentity = { kind: 'automation', mode: 'write' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup() {
  const sent: Array<{ method: string; url: string }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    sent.push({ method, url: decodeURIComponent(String(input)) });
    if (method !== 'GET') return new Response(null, { status: 204 });
    const url = String(input);
    // The directory part of the protected set: no app registrations, no role holders in this tenant.
    if (url.includes('(appId='))
      return json({ error: { code: 'Request_ResourceNotFound', message: 'Not found.' } }, 404);
    if (url.includes('/appRoleAssignedTo') || url.includes('/applications?')) return json({ value: [] });
    return json({ id: USER });
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
      AF_PROTECTED_USER_IDS: BREAK_GLASS,
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

describe('declared Graph writes that name a user by sign-in name', () => {
  it.each([
    ['a /users/{upn} path', { method: 'PATCH', path: `/users/${UPN}`, body: { accountEnabled: false } }],
    ['a percent-encoded UPN', { method: 'PATCH', path: `/users/${encodeURIComponent(UPN)}`, body: {} }],
    ['an action under the UPN', { method: 'POST', path: `/users/${UPN}/revokeSignInSessions` }],
    ["the users('{upn}') key form", { method: 'POST', path: `/users('${UPN}')/revokeSignInSessions` }],
    [
      'an @odata.id naming /users/{upn}',
      {
        method: 'POST',
        path: `/groups/${GROUP}/members/$ref`,
        body: { '@odata.id': `https://graph.microsoft.com/v1.0/users/${UPN}` },
      },
    ],
    [
      "an @odata.id naming users('{upn}')",
      {
        method: 'POST',
        path: `/groups/${GROUP}/members/$ref`,
        body: { '@odata.id': `https://graph.microsoft.com/v1.0/users('${UPN}')` },
      },
    ],
    [
      'an @odata.bind list with one UPN',
      {
        method: 'POST',
        path: '/groups',
        body: {
          displayName: 'Example',
          'members@odata.bind': [
            `https://graph.microsoft.com/v1.0/users/${USER}`,
            `https://graph.microsoft.com/v1.0/users/${UPN}`,
          ],
        },
      },
    ],
    ['mail sent as a mailbox named by address', { method: 'POST', path: `/users/${UPN}/sendMail`, body: {} }],
  ])('refuses %s, before anything is sent', async (_name, call) => {
    const t = setup();
    const err = await outcome(t.out.execute(ARMED, write(call)));
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 403, code: 'user_not_by_id' });
    // Never echoes the name it refused.
    expect((err as AppError).message).not.toContain('breakglass');
    expect((err as AppError).extras.hint).toMatch(/object ID/);
    expect(t.writes()).toEqual([]);
  });

  it('refuses a changing $batch sub-request that names a user by UPN; reading by UPN in the batch is fine', async () => {
    const t = setup();
    const batch = (requests: unknown[]) => write({ method: 'POST', path: '/$batch', body: { requests } });
    expect(
      await outcome(
        t.out.execute(
          ARMED,
          batch([
            { id: '1', method: 'GET', url: `/users/${UPN}` },
            { id: '2', method: 'PATCH', url: `/users/${UPN}`, body: { accountEnabled: false } },
          ]),
        ),
      ),
    ).toMatchObject({ code: 'user_not_by_id' });
    expect(t.writes()).toEqual([]);
    await t.out.execute(
      ARMED,
      batch([
        { id: '1', method: 'GET', url: `/users/${UPN}` },
        { id: '2', method: 'PATCH', url: `/users/${USER}`, body: { accountEnabled: false } },
      ]),
    );
    expect(t.writes()).toHaveLength(1);
  });

  it('lets GUID targets through (any case, encoded, key form, @odata.id and @odata.bind)', async () => {
    const t = setup();
    const calls: Array<Omit<ServiceCall, 'service' | 'declaredWrite'>> = [
      { method: 'PATCH', path: `/users/${USER}`, body: { jobTitle: 'Analyst' } },
      { method: 'PATCH', path: `/users/${USER.toUpperCase()}`, body: {} },
      { method: 'POST', path: `/users('${USER}')/revokeSignInSessions` },
      { method: 'POST', path: `/users/${USER}/authentication/methods/x/resetPassword`, body: {} },
      {
        method: 'POST',
        path: `/groups/${GROUP}/members/$ref`,
        body: { '@odata.id': `https://graph.microsoft.com/v1.0/users/${USER}` },
      },
      {
        method: 'PUT',
        path: `/users/${USER}/manager/$ref`,
        body: { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${USER}` },
      },
      { method: 'POST', path: '/users', body: { displayName: 'New', userPrincipalName: 'new@example.com' } },
      {
        method: 'POST',
        path: '/groups',
        body: { 'owners@odata.bind': [`https://graph.microsoft.com/v1.0/users/${USER}`] },
      },
    ];
    for (const call of calls) expect(await outcome(t.out.execute(ARMED, write(call)))).toBe('went ahead');
    expect(t.writes()).toHaveLength(calls.length);
  });

  it('leaves reads by UPN alone', async () => {
    const t = setup();
    await expect(
      t.out.execute(READER, { service: 'graph', method: 'GET', path: `/users/${UPN}` }),
    ).resolves.toBeDefined();
  });

  it("lets AdminForge's own notification mail through (the sender is configured as an address)", async () => {
    const t = setup();
    const notify: ServiceCall = {
      service: 'graph',
      method: 'POST',
      path: `/users/${encodeURIComponent('reports@example.com')}/sendMail`,
      declaredWrite: true,
      notification: true,
      body: { message: { subject: 'Report' } },
    };
    expect(await outcome(t.out.execute(AUTOMATION_WRITE, notify))).toBe('went ahead');
  });

  it('lets a Teams chat name its members by UPN (a conversation, not a change to the account)', async () => {
    const t = setup();
    const chat = write({
      method: 'POST',
      path: '/chats',
      body: {
        chatType: 'oneOnOne',
        members: [
          { 'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${USER}')` },
          { 'user@odata.bind': "https://graph.microsoft.com/v1.0/users('o''brien@example.com')" },
        ],
      },
    });
    expect(await outcome(t.out.execute(ARMED, chat))).toBe('went ahead');
  });

  it('leaves PowerShell runner targets to the runner (their inputs are names, not Graph references)', async () => {
    const t = setup();
    await expect(
      t.out.assertWritable(ARMED, [
        { service: 'exchange', method: 'POST', path: 'exchange/Set-Forwarding.ps1', body: { identity: UPN } },
      ]),
    ).resolves.toBeUndefined();
  });
});

describe('namesUserByName (the rule on its own)', () => {
  const target = (path: string, body?: unknown) => ({
    service: 'graph' as const,
    method: 'POST',
    path,
    body,
  });
  it('reads the path after a version prefix and ignores the query', () => {
    expect(namesUserByName(target(`/v1.0/users/${UPN}`))).toBe(true);
    expect(namesUserByName(target(`/beta/users/${USER}?$select=id`))).toBe(false);
    expect(namesUserByName(target('/users'))).toBe(false);
  });
  it('finds references nested in a body and ignores other services', () => {
    expect(namesUserByName(target('/groups', { nested: [{ 'members@odata.bind': `/users/${UPN}` }] }))).toBe(
      true,
    );
    expect(namesUserByName({ ...target(`/users/${UPN}`), service: 'arm' })).toBe(false);
  });
});
