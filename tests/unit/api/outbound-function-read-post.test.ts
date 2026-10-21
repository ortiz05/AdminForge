import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import { AppError } from '@adminforge/api/src/errors';
import { createOutboundExecutor, type OutboundDeps } from '@adminforge/api/src/execution/outbound';
import type { ExecutionIdentity } from '@adminforge/api/src/execution/types';
import type { Connection } from '@adminforge/schemas';

// S-23 end to end through the executor: `readPost` comes from the published connection, never from the caller, and a
// read-mode POST without it (a connection published before validate refused that) needs write access.
const NOW = new Date('2026-10-15T12:00:00.000Z');

const session: SessionRecord = {
  idHash: 'sid-hash',
  userOid: '44444444-5555-4666-8777-888888888888',
  upn: 'avery@example.com',
  displayName: 'Avery Engineer',
  tenantId: '11111111-2222-4333-8444-555555555555',
  tenantName: 'Example Org',
  tenantDomain: 'example.com',
  roles: ['Portal.Reader', 'Portal.Operator'],
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
};
const read: ExecutionIdentity = { kind: 'delegated', session, mode: 'read' };

const CONNECTION = {
  kind: 'connection',
  id: 'example.hr-search',
  version: '1.0.0',
  title: 'HR search',
  owner: 'test',
  baseUrl: 'https://hr.example.com/api',
  audience: 'api://00000000-0000-4000-8000-0000000000f1',
  operations: {
    search: { method: 'POST', path: '/employees/search', mode: 'read', readPost: true },
    // As a definition stored before the rule would hold it: a read POST without readPost.
    legacy: { method: 'POST', path: '/employees/query', mode: 'read' },
  },
} as Connection;

function executor() {
  const sent: string[] = [];
  const auth = { token: async () => 'token-read' } as unknown as AuthClient;
  const deps: OutboundDeps = {
    config: {
      DATA_MODE: 'live',
      AF_SPO_TENANT_NAME: undefined,
      OUTBOUND_CONCURRENCY: 16,
      OUTBOUND_USER_CONCURRENCY: 6,
      OUTBOUND_TIMEOUT_MS: 5000,
      TOKEN_CACHE_KEY: undefined,
    },
    broker: new TokenBroker(auth, {}, () => NOW),
    auth,
    automation: null,
    connection: async (key) => {
      if (key !== CONNECTION.id) throw new AppError(404, 'definition_not_found', 'no');
      return CONNECTION;
    },
    env: () => ({}),
    now: () => NOW,
    sleep: async () => undefined,
    maxRetries: 0,
    fetch: async (input, init) => {
      sent.push(`${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`);
      return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  return { out: createOutboundExecutor(deps), sent };
}

const call = (operation: string, extra: Record<string, unknown> = {}) => ({
  service: 'function' as const,
  method: 'POST',
  path: '',
  operation,
  connection: CONNECTION.id,
  body: { name: 'Lee' },
  ...extra,
});

describe('function read-mode POSTs through the executor (S-23)', () => {
  it('an operation the connection marks readPost runs in a read session', async () => {
    const { out, sent } = executor();
    await expect(out.execute(read, call('search'))).resolves.toMatchObject({ data: { value: [] } });
    expect(sent).toEqual(['POST https://hr.example.com/api/employees/search']);
  });

  it('one without it is refused before anything is sent, whatever the caller claims', async () => {
    const { out, sent } = executor();
    for (const extra of [{}, { readPost: true, declaredRead: true }])
      await expect(out.execute(read, call('legacy', extra))).rejects.toMatchObject({ code: 'policy_denied' });
    expect(sent).toEqual([]);
  });
});
