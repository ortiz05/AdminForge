import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import { AppError } from '@adminforge/api/src/errors';
import { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
import { isSensitiveWrite, permissionGrantIds } from '@adminforge/api/src/execution/protected';
import type { ExecutionIdentity, ServiceCall } from '@adminforge/api/src/execution/types';

// A delegated permission grant's id is not a GUID (`DELETE /oauth2PermissionGrants/{id}` names no object the guard
// could match), so the protected-object guard looks the grant up — through the executor, like the rest of the
// protected set — and refuses a write to a grant held by one of AdminForge's own apps or a configured protected app.
// The playbook's own `notPortalApp` check stays; this is the guard every write passes through.

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const READ_APP = '22222222-3333-4444-8555-666666666666';
const WRITE_APP = '33333333-4444-4555-8666-777777777777';
const AUTOMATION_APP = '44444444-0000-4000-8000-0000000000a0';
const PROVISIONER_APP = '44444444-0000-4000-8000-0000000000b0';
const spObject = (appId: string) => `6${appId.slice(1)}`;
const OTHER_SP = '00000000-0000-4000-8000-000000000404';
const GRAPH_SP = '00000000-0000-4000-8000-000000000409';

/** Grants in the synthetic tenant: id → the service principal (client) holding it. */
const GRANTS: Record<string, string> = {
  'grant-af-read': spObject(READ_APP),
  'grant-af-write': spObject(WRITE_APP).toUpperCase(),
  'grant-provisioner': spObject(PROVISIONER_APP),
  'grant-pdf-mchen': OTHER_SP,
  'Zm9vYmFy-1_x': OTHER_SP,
};

const ARMED: ExecutionIdentity = {
  kind: 'delegated',
  mode: 'write',
  session: {
    idHash: 'sid',
    userOid: '00000000-0000-4000-8000-0000000000c0',
    upn: 'avery@example.com',
    roles: ['Portal.Reader', 'Portal.Operator'],
    readAccountId: 'read-acct',
    writeAccountId: 'write-acct',
    writeExpiresAt: new Date(NOW + 3_600_000),
  } as unknown as SessionRecord,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(opts: { grantRead?: (id: string, auth: string | undefined) => Response | undefined } = {}) {
  const sent: Array<{ method: string; url: string; auth: string | undefined }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = decodeURIComponent(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    sent.push({ method, url, auth });
    if (method !== 'GET') return new Response(null, { status: 204 });
    const grant = /\/oauth2PermissionGrants\/([^/?]+)/.exec(url);
    if (grant) {
      const id = grant[1]!;
      const override = opts.grantRead?.(id, auth);
      if (override) return override;
      const clientId = GRANTS[id];
      return clientId
        ? json({ id, clientId, consentType: 'AllPrincipals', resourceId: GRAPH_SP, scope: 'User.Read' })
        : json({ error: { code: 'Request_ResourceNotFound', message: 'Not found.' } }, 404);
    }
    const byAppId = /\/(applications|servicePrincipals)\(appId='([^']+)'\)/.exec(url);
    if (byAppId) return json({ id: spObject(byAppId[2]!), appId: byAppId[2] });
    return json({ value: [] });
  };
  const auth = { token: async (i: { kind: string }) => `token-${i.kind}` } as unknown as AuthClient;
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
      AF_PROTECTED_APP_IDS: PROVISIONER_APP,
    },
    broker: new TokenBroker(auth, {}, () => new Date(NOW)),
    auth,
    automation: { clientId: AUTOMATION_APP, credential: 'secret', token: async () => 'token-app' },
    fetch,
    now: () => new Date(NOW),
    sleep: async () => undefined,
    maxRetries: 0,
  });
  return { out, sent };
}

const write = (call: Partial<ServiceCall> & Pick<ServiceCall, 'method' | 'path'>): ServiceCall =>
  ({ service: 'graph', declaredWrite: true, ...call }) as ServiceCall;
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'went ahead',
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );
const changes = (sent: Array<{ method: string; url: string }>) => sent.filter((s) => s.method !== 'GET');

describe('protected objects: delegated permission grants', () => {
  it('finds the grant id in a write path (key segment or parentheses, encoded, versioned)', () => {
    const t = (path: string, method = 'DELETE') => ({ service: 'graph' as const, method, path });
    expect(permissionGrantIds(t('/oauth2PermissionGrants/grant-af-read'))).toEqual(['grant-af-read']);
    expect(permissionGrantIds(t("/oauth2PermissionGrants('grant-af-read')"))).toEqual(['grant-af-read']);
    expect(permissionGrantIds(t('/v1.0/oauth2PermissionGrants/grant%2Daf%2Dread'))).toEqual([
      'grant-af-read',
    ]);
    expect(permissionGrantIds(t('/OAuth2PermissionGrants//grant-af-read', 'PATCH'))).toEqual([
      'grant-af-read',
    ]);
    expect(permissionGrantIds(t('/oauth2PermissionGrants', 'POST'))).toEqual([]);
    expect(permissionGrantIds({ ...t('/oauth2PermissionGrants/x'), service: 'arm' as never })).toEqual([]);
    expect(isSensitiveWrite(t('/oauth2PermissionGrants/grant-af-read'))).toBe(true);
  });

  it.each([
    ['AdminForge Read', 'grant-af-read'],
    ['AdminForge Write (client id in another case)', 'grant-af-write'],
    ['a configured protected app (AF_PROTECTED_APP_IDS)', 'grant-provisioner'],
  ])('refuses deleting or changing a grant held by %s', async (_who, id) => {
    const { out, sent } = setup();
    expect(
      await outcome(out.execute(ARMED, write({ method: 'DELETE', path: `/oauth2PermissionGrants/${id}` }))),
    ).toBe('protected_object');
    expect(
      await outcome(
        out.execute(
          ARMED,
          write({ method: 'PATCH', path: `/oauth2PermissionGrants('${id}')`, body: { scope: 'User.Read' } }),
        ),
      ),
    ).toBe('protected_object');
    expect(changes(sent)).toEqual([]);
    // The grant was read (not trusted from content), and never by the write sign-in.
    const reads = sent.filter((s) => s.method === 'GET' && s.url.includes(`/oauth2PermissionGrants/${id}`));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.auth !== 'Bearer token-write')).toBe(true);
  });

  it('refuses it inside a $batch too', async () => {
    const { out, sent } = setup();
    const batch = write({
      method: 'POST',
      path: '/$batch',
      body: {
        requests: [
          { id: '1', method: 'DELETE', url: '/oauth2PermissionGrants/grant-pdf-mchen' },
          { id: '2', method: 'DELETE', url: '/oauth2PermissionGrants/grant-af-read' },
        ],
      },
    });
    expect(await outcome(out.execute(ARMED, batch))).toBe('protected_object');
    expect(changes(sent)).toEqual([]);
  });

  it('lets other apps’ grants be revoked; a grant that doesn’t exist goes to Microsoft (which answers 404)', async () => {
    const { out, sent } = setup();
    for (const id of ['grant-pdf-mchen', 'Zm9vYmFy-1_x', 'grant-gone'])
      expect(
        await outcome(out.execute(ARMED, write({ method: 'DELETE', path: `/oauth2PermissionGrants/${id}` }))),
      ).toBe('went ahead');
    expect(changes(sent).map((s) => s.url.replace(/^.*\/v1\.0/, ''))).toEqual([
      '/oauth2PermissionGrants/grant-pdf-mchen',
      '/oauth2PermissionGrants/Zm9vYmFy-1_x',
      '/oauth2PermissionGrants/grant-gone',
    ]);
  });

  it('fails closed when the grant can’t be read (or names no client)', async () => {
    const failing = setup({
      grantRead: () => json({ error: { code: 'Authorization_RequestDenied', message: 'No.' } }, 403),
    });
    expect(
      await outcome(
        failing.out.execute(
          ARMED,
          write({ method: 'DELETE', path: '/oauth2PermissionGrants/grant-pdf-mchen' }),
        ),
      ),
    ).toBe('protected_objects_unavailable');
    expect(changes(failing.sent)).toEqual([]);

    const odd = setup({ grantRead: (id) => json({ id, scope: 'User.Read' }) });
    expect(
      await outcome(
        odd.out.execute(ARMED, write({ method: 'DELETE', path: '/oauth2PermissionGrants/grant-pdf-mchen' })),
      ),
    ).toBe('protected_objects_unavailable');
    expect(changes(odd.sent)).toEqual([]);
  });

  it('reads the grant as the caller when the automation identity can’t', async () => {
    const { out, sent } = setup({
      grantRead: (_id, auth) =>
        auth === 'Bearer token-app'
          ? json({ error: { code: 'Authorization_RequestDenied', message: 'No.' } }, 403)
          : undefined,
    });
    expect(
      await outcome(
        out.execute(ARMED, write({ method: 'DELETE', path: '/oauth2PermissionGrants/grant-af-read' })),
      ),
    ).toBe('protected_object');
    expect(
      sent.some(
        (s) => s.url.includes('/oauth2PermissionGrants/grant-af-read') && s.auth === 'Bearer token-read',
      ),
    ).toBe(true);
    expect(changes(sent)).toEqual([]);
  });
});
