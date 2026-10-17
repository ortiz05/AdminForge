import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
import type { ExecutionIdentity } from '@adminforge/api/src/execution/types';

// A named app identity removed from AF_SCHEDULE_IDENTITIES (ADR-014) keeps its registration and application
// permissions until someone deletes it. The central write guard still treats it as AdminForge's own: found by its
// display name ("AdminForge Identity …"), its app object and service principal can't be changed through AdminForge.

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const RETIRED_APP = '77777777-0000-4000-8000-0000000000a7';
const appObject = (appId: string) => `5${appId.slice(1)}`;
const spObject = (appId: string) => `6${appId.slice(1)}`;

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

function setup() {
  const sent: Array<{ method: string; url: string }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = decodeURIComponent(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    sent.push({ method, url });
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (method !== 'GET') return new Response(null, { status: 204 });
    if (url.includes("startswith(displayName,'AdminForge Identity ')"))
      return json({ value: [{ id: appObject(RETIRED_APP), appId: RETIRED_APP }] });
    const byAppId = /\/(applications|servicePrincipals)\(appId='([^']+)'\)/.exec(url);
    if (byAppId)
      return json({ id: byAppId[1] === 'applications' ? appObject(byAppId[2]!) : spObject(byAppId[2]!) });
    return json({ value: [] });
  };
  const auth = { token: async () => 'token' } as unknown as AuthClient;
  const out = createOutboundExecutor({
    config: {
      DATA_MODE: 'live',
      AF_SPO_TENANT_NAME: undefined,
      OUTBOUND_CONCURRENCY: 16,
      OUTBOUND_USER_CONCURRENCY: 6,
      OUTBOUND_TIMEOUT_MS: 5000,
      TOKEN_CACHE_KEY: undefined,
      AF_READ_CLIENT_ID: '22222222-3333-4444-8555-666666666666',
      AF_WRITE_CLIENT_ID: '33333333-4444-4555-8666-777777777777',
      AF_AUTOMATION_CLIENT_ID: '44444444-0000-4000-8000-0000000000a0',
    },
    broker: new TokenBroker(auth, {}, () => new Date(NOW)),
    auth,
    automation: {
      clientId: '44444444-0000-4000-8000-0000000000a0',
      credential: 'secret',
      token: async () => 't',
    },
    fetch,
    now: () => new Date(NOW),
    sleep: async () => undefined,
    maxRetries: 0,
  });
  return { out, sent };
}

describe('retired app identities stay protected', () => {
  it.each([
    `/applications/${appObject(RETIRED_APP)}/addPassword`,
    `/servicePrincipals/${spObject(RETIRED_APP)}`,
    `/applications(appId='${RETIRED_APP}')`,
  ])('%s', async (path) => {
    const { out, sent } = setup();
    const err = await out
      .execute(ARMED, { service: 'graph', declaredWrite: true, method: 'PATCH', path, body: {} })
      .then(
        () => 'went ahead',
        (e: unknown) => e,
      );
    expect(err).toMatchObject({ code: 'protected_object' });
    expect(sent.filter((s) => s.method !== 'GET')).toEqual([]);
  });
});
