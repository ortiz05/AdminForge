import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import { loadConfig } from '@adminforge/api/src/config';
import { AppError } from '@adminforge/api/src/errors';
import { createOutboundExecutor, type OutboundDeps } from '@adminforge/api/src/execution/outbound';
import { isSensitiveWrite, referencedIds } from '@adminforge/api/src/execution/protected';
import type { ExecutionIdentity, ServiceCall } from '@adminforge/api/src/execution/types';
import { createFixtureFetch, fixtureKey } from '@adminforge/connectors';

// Synthetic ids only (never a real tenant).
const READ_APP = '22222222-3333-4444-8555-666666666666';
const WRITE_APP = '33333333-4444-4555-8666-777777777777';
const AUTOMATION_APP = '44444444-0000-4000-8000-0000000000a0';
const PROVISIONER_APP = '44444444-0000-4000-8000-0000000000b0';
const BREAK_GLASS = '00000000-0000-4000-8000-0000000001ff';
const appObject = (appId: string) => `5${appId.slice(1)}`;
const spObject = (appId: string) => `6${appId.slice(1)}`;
const PORTAL_GROUP = '00000000-0000-4000-8000-0000000002ff'; // SG-AdminForge-…-Playbook.Approver
const DIRECT_HOLDER = '00000000-0000-4000-8000-0000000002fe'; // a principal assigned an app role directly
const GROUP = '00000000-0000-4000-8000-000000000201';
const USER = '00000000-0000-4000-8000-000000000102';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');

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
const AUTOMATION_WRITE: ExecutionIdentity = { kind: 'automation', mode: 'write' };

interface Sent {
  method: string;
  url: string;
  auth: string | undefined;
}

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'ms-req-1' },
  });

/** A tenant where the Read app's service principal is assigned to the portal group and one direct holder. */
function tenant(opts: { lookups?: (url: string, auth: string | undefined) => Response | undefined } = {}) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = decodeURIComponent(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    sent.push({ method, url, auth });
    if (method !== 'GET') return new Response(null, { status: 204 });
    const override = opts.lookups?.(url, auth);
    if (override) return override;
    const byAppId = /\/(applications|servicePrincipals)\(appId='([^']+)'\)/.exec(url);
    if (byAppId) {
      const [, kind, appId] = byAppId;
      if (appId === PROVISIONER_APP && kind === 'applications')
        return json({ error: { code: 'Request_ResourceNotFound', message: 'Not found.' } }, 404);
      return json({ id: kind === 'applications' ? appObject(appId!) : spObject(appId!), appId });
    }
    if (url.includes(`/servicePrincipals/${spObject(READ_APP)}/appRoleAssignedTo`))
      return json({ value: [{ principalId: PORTAL_GROUP.toUpperCase() }, { principalId: DIRECT_HOLDER }] });
    if (url.includes('/appRoleAssignedTo')) return json({ value: [] });
    return json({ id: 'x' });
  };
  return { fetch, sent };
}

function executor(fetch: typeof globalThis.fetch, over: Partial<OutboundDeps> = {}) {
  const clock = { t: NOW };
  const auth = {
    token: async (i: { kind: 'read' | 'write' }) => `token-${i.kind}`,
  } as unknown as AuthClient;
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
      AF_PROTECTED_USER_IDS: ` ${BREAK_GLASS.toUpperCase()}, `,
    },
    broker: new TokenBroker(auth, {}, () => new Date(clock.t)),
    auth,
    automation: { clientId: AUTOMATION_APP, credential: 'secret', token: async () => 'token-app' },
    fetch,
    now: () => new Date(clock.t),
    sleep: async () => undefined,
    maxRetries: 0,
    ...over,
  });
  return { out, clock };
}

const write = (
  call: Omit<ServiceCall, 'service' | 'declaredWrite'> & { service?: ServiceCall['service'] },
) => ({
  service: 'graph' as const,
  declaredWrite: true,
  ...call,
});
const refused = (p: Promise<unknown>) =>
  p.then(
    () => 'went ahead',
    (e: unknown) => e,
  );
const writesSent = (sent: Sent[]) => sent.filter((s) => s.method !== 'GET');

describe('protected objects (central write guard)', () => {
  it('refuses a write whose path names a portal role group (resolved by id via appRoleAssignedTo, any case)', async () => {
    const t = tenant();
    const { out } = executor(t.fetch);
    for (const path of [
      `/groups/${PORTAL_GROUP}/members/${USER}/$ref`,
      `/groups/${PORTAL_GROUP.toUpperCase()}/owners/$ref`,
      `/groups/${encodeURIComponent(PORTAL_GROUP)}`,
    ]) {
      const err = await refused(out.execute(ARMED, write({ method: 'DELETE', path })));
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ status: 403, code: 'protected_object' });
    }
    expect(writesSent(t.sent)).toEqual([]);
    // The directory was read once, as the automation identity (app-only token), never with the Write token.
    expect(t.sent.every((s) => s.auth === 'Bearer token-app')).toBe(true);
  });

  it('refuses a write whose JSON body references a protected object (@odata.id, principalId), including directly assigned holders', async () => {
    const t = tenant();
    const { out } = executor(t.fetch);
    const bodies = [
      { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${PORTAL_GROUP}` },
      { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${DIRECT_HOLDER}` },
      { '@odata.id': `https://graph.microsoft.com/v1.0/users/${BREAK_GLASS}` },
      {
        principalId: USER,
        resourceId: spObject(WRITE_APP),
        appRoleId: '00000000-0000-0000-0000-000000000000',
      },
      { nested: [{ deep: { ids: [`x ${appObject(AUTOMATION_APP)} y`] } }] },
    ];
    for (const body of bodies) {
      const err = await refused(
        out.execute(ARMED, write({ method: 'POST', path: `/groups/${GROUP}/members/$ref`, body })),
      );
      expect(err).toMatchObject({ code: 'protected_object' });
    }
    expect(writesSent(t.sent)).toEqual([]);
  });

  it("refuses the (appId='…') form, app objects and service principals of AdminForge's own and protected apps", async () => {
    const t = tenant();
    const { out } = executor(t.fetch);
    for (const path of [
      `/applications(appId='${WRITE_APP}')`,
      `/servicePrincipals(appId='${PROVISIONER_APP}')`,
      `/applications/${appObject(READ_APP)}/addPassword`,
      `/servicePrincipals/${spObject(AUTOMATION_APP)}`,
      `/servicePrincipals/${spObject(PROVISIONER_APP)}/owners/$ref`,
    ]) {
      const err = await refused(out.execute(ARMED, write({ method: 'PATCH', path, body: {} })));
      expect(err).toMatchObject({ code: 'protected_object' });
    }
    expect(writesSent(t.sent)).toEqual([]);
  });

  it('refuses a break-glass account (AF_PROTECTED_USER_IDS) without asking Graph, for scheduled writes too', async () => {
    const t = tenant();
    const { out } = executor(t.fetch);
    for (const path of [
      `/users/${BREAK_GLASS}`,
      `/users/${BREAK_GLASS}/authentication/temporaryAccessPassMethods`,
      `/users/${BREAK_GLASS}/revokeSignInSessions`,
    ])
      for (const who of [ARMED, AUTOMATION_WRITE])
        expect(
          await refused(out.execute(who, write({ method: 'POST', path, body: { accountEnabled: false } }))),
        ).toMatchObject({ code: 'protected_object' });
    expect(t.sent).toEqual([]);
  });

  it('lets unrelated writes through (one directory read, then the write with the Write token)', async () => {
    const t = tenant();
    const { out } = executor(t.fetch);
    const res = await out.execute(
      ARMED,
      write({
        method: 'POST',
        path: `/groups/${GROUP}/members/$ref`,
        body: { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${USER}` },
      }),
    );
    expect(res.status).toBe(204);
    const writes = writesSent(t.sent);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.auth).toBe('Bearer token-write');
    // Reads are never guarded, even of protected objects.
    const before = t.sent.length;
    await out.execute(ARMED, { service: 'graph', method: 'GET', path: `/groups/${PORTAL_GROUP}` });
    expect(t.sent.length).toBe(before + 1);
  });

  it('$batch: a changing sub-request naming a protected object is refused; reading it in the same batch is not', async () => {
    const t = tenant();
    const { out } = executor(t.fetch);
    const batch = (requests: unknown[]) => write({ method: 'POST', path: '/$batch', body: { requests } });
    expect(
      await refused(
        out.execute(
          ARMED,
          batch([
            { id: '1', method: 'GET', url: `/groups/${GROUP}` },
            { id: '2', method: 'DELETE', url: `/groups/${PORTAL_GROUP}/members/${USER}/$ref` },
          ]),
        ),
      ),
    ).toMatchObject({ code: 'protected_object' });
    expect(writesSent(t.sent)).toEqual([]);
    await out.execute(
      ARMED,
      batch([
        { id: '1', method: 'GET', url: `/groups/${PORTAL_GROUP}` },
        { id: '2', method: 'DELETE', url: `/groups/${GROUP}/members/${USER}/$ref` },
      ]),
    );
    expect(writesSent(t.sent).map((s) => s.url)).toEqual(['https://graph.microsoft.com/v1.0/$batch']);
  });

  it('caches the protected set for 10 minutes, then reads it again', async () => {
    const t = tenant();
    const { out, clock } = executor(t.fetch);
    const harmless = write({ method: 'PATCH', path: `/users/${USER}`, body: { jobTitle: 'Analyst' } });
    const reads = () => t.sent.filter((s) => s.method === 'GET').length;
    await out.execute(ARMED, harmless);
    const first = reads();
    // 4 apps × (application + service principal) + the Read and Write apps' appRoleAssignedTo.
    expect(first).toBe(10);
    clock.t += 9 * 60_000;
    await out.execute(AUTOMATION_WRITE, harmless);
    expect(reads()).toBe(first);
    clock.t += 2 * 60_000;
    await out.execute(ARMED, harmless);
    expect(reads()).toBe(first * 2);
  });

  it("falls back to the caller's own Read sign-in when the automation identity can't read the directory", async () => {
    const t = tenant({
      lookups: (_url, auth) =>
        auth === 'Bearer token-app'
          ? json({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges.' } }, 403)
          : undefined,
    });
    const { out } = executor(t.fetch);
    expect(
      await refused(
        out.execute(ARMED, write({ method: 'DELETE', path: `/groups/${PORTAL_GROUP}/owners/${USER}/$ref` })),
      ),
    ).toMatchObject({ code: 'protected_object' });
    expect(t.sent.some((s) => s.auth === 'Bearer token-read')).toBe(true);
    expect(t.sent.some((s) => s.auth === 'Bearer token-write')).toBe(false);
  });

  it("fails closed for sensitive writes when the set can't be read; other writes go ahead; errors never name the ids", async () => {
    const t = tenant({
      lookups: () =>
        json({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges.' } }, 403),
    });
    const { out, clock } = executor(t.fetch);
    const sensitive = [
      {
        method: 'POST',
        path: `/groups/${GROUP}/members/$ref`,
        body: { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${USER}` },
      },
      { method: 'DELETE', path: `/groups/${GROUP}/owners/${USER}/$ref` },
      { method: 'PATCH', path: `/groups/${GROUP}`, body: { membershipRule: 'x' } },
      { method: 'POST', path: `/servicePrincipals/${GROUP}/appRoleAssignedTo`, body: {} },
      { method: 'POST', path: `/users/${USER}/appRoleAssignments`, body: {} },
      { method: 'PATCH', path: `/applications/${GROUP}`, body: {} },
      { method: 'POST', path: `/users/${USER}/authentication/temporaryAccessPassMethods`, body: {} },
      { method: 'DELETE', path: `/directoryObjects/${GROUP}` },
    ];
    for (const call of sensitive) {
      const err = (await refused(out.execute(ARMED, write(call)))) as AppError;
      expect(err).toMatchObject({ status: 503, code: 'protected_objects_unavailable' });
      expect(err.extras.hint).toMatch(/Application\.Read\.All/);
      expect(`${err.message} ${err.extras.hint}`).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }
    // Configured ids are still refused as protected; unrelated writes go ahead.
    expect(
      await refused(out.execute(ARMED, write({ method: 'PATCH', path: `/users/${BREAK_GLASS}`, body: {} }))),
    ).toMatchObject({
      code: 'protected_object',
    });
    await out.execute(
      ARMED,
      write({ method: 'PATCH', path: `/users/${USER}`, body: { jobTitle: 'Analyst' } }),
    );
    expect(writesSent(t.sent).map((s) => s.method)).toEqual(['PATCH']);
    // A failed reader isn't asked again for a minute (no read storm), then is.
    const lookups = t.sent.filter((s) => s.method === 'GET').length;
    await out.execute(ARMED, write({ method: 'PATCH', path: `/users/${USER}`, body: { jobTitle: 'Lead' } }));
    expect(t.sent.filter((s) => s.method === 'GET').length).toBe(lookups);
    clock.t += 61_000;
    await out.execute(ARMED, write({ method: 'PATCH', path: `/users/${USER}`, body: { jobTitle: 'Lead' } }));
    expect(t.sent.filter((s) => s.method === 'GET').length).toBeGreaterThan(lookups);
  });

  it('keeps enforcing the last answer when a refresh fails', async () => {
    let deny = false;
    const t = tenant({
      lookups: () =>
        deny ? json({ error: { code: 'Authorization_RequestDenied', message: 'No.' } }, 403) : undefined,
    });
    const { out, clock } = executor(t.fetch);
    await out.execute(ARMED, write({ method: 'PATCH', path: `/users/${USER}`, body: {} }));
    deny = true;
    clock.t += 11 * 60_000;
    // Not sensitive, but names a holder known from the last answer.
    expect(
      await refused(
        out.execute(ARMED, write({ method: 'PATCH', path: `/users/${DIRECT_HOLDER}`, body: {} })),
      ),
    ).toMatchObject({ code: 'protected_object' });
  });

  it('works in DATA_MODE=fixtures from fixture files (no tokens, automation identity)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'af-protected-fixtures-'));
    try {
      const put = (method: string, url: string, body: unknown) => {
        const file = path.join(dir, fixtureKey(method, url).candidates.at(-1)!);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(body));
      };
      put('GET', `https://graph.microsoft.com/v1.0/servicePrincipals(appId='${READ_APP}')`, {
        id: spObject(READ_APP),
      });
      put(
        'GET',
        `https://graph.microsoft.com/v1.0/servicePrincipals/${spObject(READ_APP)}/appRoleAssignedTo`,
        {
          value: [{ principalId: PORTAL_GROUP }],
        },
      );
      const { out } = executor(createFixtureFetch(dir, { acceptWrites: true }), {
        config: {
          DATA_MODE: 'fixtures',
          AF_SPO_TENANT_NAME: undefined,
          OUTBOUND_CONCURRENCY: 16,
          OUTBOUND_USER_CONCURRENCY: 6,
          OUTBOUND_TIMEOUT_MS: 5000,
          TOKEN_CACHE_KEY: undefined,
          AF_READ_CLIENT_ID: READ_APP,
        },
        broker: null,
        auth: null,
        automation: null,
      });
      expect(
        await refused(
          out.execute(
            ARMED,
            write({ method: 'DELETE', path: `/groups/${PORTAL_GROUP}/members/${USER}/$ref` }),
          ),
        ),
      ).toMatchObject({ code: 'protected_object' });
      // Apps with no fixture (404) are skipped; the set is complete, so ordinary group writes go ahead.
      const ok = await out.execute(
        ARMED,
        write({ method: 'DELETE', path: `/groups/${GROUP}/members/${USER}/$ref` }),
      );
      expect(ok.status).toBe(204);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes paused: every declared write is refused before any call, interactive and scheduled; reads keep working', async () => {
    const t = tenant();
    let paused = true;
    const { out } = executor(t.fetch, { writesPaused: async () => paused });
    for (const who of [ARMED, AUTOMATION_WRITE]) {
      const err = (await refused(
        out.execute(who, write({ method: 'PATCH', path: `/users/${USER}`, body: { jobTitle: 'x' } })),
      )) as AppError;
      expect(err).toMatchObject({ code: 'writes_paused', status: 503 });
      expect(err.extras.hint).toMatch(/Portal Admin/);
      expect(err.extras.hint).toMatch(/Audit/);
    }
    expect(t.sent).toEqual([]);
    await out.execute(ARMED, { service: 'graph', method: 'GET', path: `/users/${USER}` });
    expect(t.sent).toHaveLength(1);
    paused = false;
    await out.execute(ARMED, write({ method: 'PATCH', path: `/users/${USER}`, body: { jobTitle: 'x' } }));
    expect(writesSent(t.sent)).toHaveLength(1);
  });

  it('writes paused: AdminForge’s own notification mail still goes out, nothing else marked like it does', async () => {
    const t = tenant();
    const { out } = executor(t.fetch, { writesPaused: async () => true });
    const mail = { method: 'POST', path: '/users/adminforge@example.com/sendMail', body: { message: {} } };
    await out.execute(AUTOMATION_WRITE, { ...write(mail), notification: true });
    expect(writesSent(t.sent)).toHaveLength(1);
    // The flag only counts for the automation identity's sendMail.
    for (const [who, call] of [
      [ARMED, { ...write(mail), notification: true }],
      [AUTOMATION_WRITE, write(mail)],
      [
        AUTOMATION_WRITE,
        { ...write({ method: 'PATCH', path: `/users/${USER}`, body: {} }), notification: true },
      ],
    ] as const)
      expect(await refused(out.execute(who, call))).toMatchObject({ code: 'writes_paused' });
    expect(writesSent(t.sent)).toHaveLength(1);
  });
});

describe('protected objects: helpers and configuration', () => {
  it('finds ids in paths (percent-encoded too), query values, body strings and keys', () => {
    const ids = referencedIds({
      service: 'graph',
      method: 'POST',
      path: `/applications(appId=%27${WRITE_APP.toUpperCase()}%27)`,
      query: { $filter: `id eq '${USER}'` },
      body: { [GROUP]: true, list: [`…/directoryObjects/${BREAK_GLASS}`] },
    });
    expect([...ids].sort()).toEqual([BREAK_GLASS, GROUP, USER, WRITE_APP].sort());
  });

  it('knows which Graph writes are sensitive', () => {
    const graph = (p: string) => isSensitiveWrite({ service: 'graph', method: 'POST', path: p });
    expect(graph(`/groups/${GROUP}/members/$ref`)).toBe(true);
    expect(graph(`/groups/${GROUP}`)).toBe(true);
    expect(graph('/groups')).toBe(false);
    expect(graph(`/users/${USER}`)).toBe(false);
    expect(graph(`/users/${USER}/authentication/methods/x/resetPassword`)).toBe(true);
    expect(graph(`/servicePrincipals(appId='${READ_APP}')`)).toBe(true);
    expect(isSensitiveWrite({ service: 'arm', method: 'PUT', path: '/applications/x' })).toBe(false);
  });

  it('AF_PROTECTED_USER_IDS and AF_PROTECTED_APP_IDS must be GUIDs, comma-separated (the value is never echoed)', () => {
    const base = {
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      AUTH_MODE: 'mock',
      DATA_MODE: 'fixtures',
    };
    expect(
      loadConfig({ ...base, AF_PROTECTED_USER_IDS: `${BREAK_GLASS}, ${USER}` }).AF_PROTECTED_USER_IDS,
    ).toBeTruthy();
    expect(() =>
      loadConfig({ ...base, AF_PROTECTED_USER_IDS: `${BREAK_GLASS}, breakglass@example.com` }),
    ).toThrow(/AF_PROTECTED_USER_IDS: must be ids \(GUIDs\), comma-separated/);
    expect(() => loadConfig({ ...base, AF_PROTECTED_APP_IDS: 'not-a-guid' })).toThrow(/AF_PROTECTED_APP_IDS/);
    try {
      loadConfig({ ...base, AF_PROTECTED_USER_IDS: 'breakglass@example.com' });
    } catch (e) {
      expect((e as Error).message).not.toContain('breakglass@example.com');
    }
  });
});
