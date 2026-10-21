import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatasourceRunner, type LoadedPage, type RunInput } from '@adminforge/api/src/datasources/executor';
import { AppError } from '@adminforge/api/src/errors';
import { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { FORBIDDEN_HEADERS } from '@adminforge/connectors';
import { FORBIDDEN_HEADER_NAMES, GraphRequestSpec, parseDefinition } from '@adminforge/schemas';

// S-02: a datasource can't set the headers AdminForge owns (the bearer token, the correlation id, cookies, the host).
// `adminforge validate` refuses a definition declaring them, and the executor refuses one that renders them anyway
// (a definition published before the rule).

const CONTENT_DIR = fileURLToPath(new URL('../../../portal/content/', import.meta.url));

function setup() {
  const calls: ServiceCall[] = [];
  const outbound: OutboundExecutor = {
    async execute(_identity, call) {
      calls.push(call);
      return {
        data: { value: [] },
        status: 200,
        provenance: { service: call.service, path: call.path, ms: 1 },
      } as never;
    },
  };
  const runner = new DatasourceRunner({
    definitions: { onChange: () => () => undefined } as never,
    outbound,
    env: () => ({}),
    now: () => new Date('2026-10-21T00:00:00Z'),
  });
  return { runner, calls };
}

const pageWith = (request: Record<string, unknown>, source = 'graph') =>
  ({
    kind: 'page',
    key: 'identity.users',
    version: '1.0.0',
    sha256: `sha-${JSON.stringify(request)}`,
    def: {
      datasources: {
        users:
          source === 'graphBatch'
            ? { source, requests: { a: request } }
            : { source, request: { apiVersion: '2022-12-01', ...request } },
      },
    },
  }) as unknown as LoadedPage;

const input = (page: LoadedPage): RunInput => ({
  identity: {
    kind: 'delegated',
    mode: 'read',
    session: { userOid: 'u1', idHash: 'h1', upn: 'u1@example.com' },
  } as unknown as ExecutionIdentity,
  user: { oid: 'u1', upn: 'u1@example.com', name: 'U', roles: ['Portal.Reader'] },
  page,
  datasource: 'users',
  params: { token: 'Bearer EVIL' },
  correlationId: 'c',
});

describe('datasource headers AdminForge owns', () => {
  it.each([
    ['graph', { Authorization: 'Bearer EVIL' }],
    ['graph', { authorization: '${ params.token }' }],
    ['graph', { 'client-request-id': 'spoofed' }],
    ['arm', { 'X-MS-Client-Request-Id': 'spoofed' }],
    ['graphBatch', { Cookie: 'a=b' }],
    ['graph', { Host: 'evil.example' }],
  ])('a %s datasource declaring %j is refused before anything is sent', async (source, headers) => {
    const t = setup();
    const err = await t.runner.run(input(pageWith({ path: '/users', headers }, source))).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 400, code: 'invalid_request' });
    // Written for the person in front of the browser: no header name in the message.
    expect((err as AppError).message).not.toMatch(/authorization|cookie|host|request-id/i);
    expect((err as AppError).extras.hint).toBeTruthy();
    expect(t.calls).toEqual([]);
  });

  it('a header content may set still goes out', async () => {
    const t = setup();
    await t.runner.run(input(pageWith({ path: '/users', headers: { ConsistencyLevel: 'eventual' } })));
    expect(t.calls[0]?.headers).toEqual({ ConsistencyLevel: 'eventual' });
  });

  it('the request schema refuses them at validate time, in any case', () => {
    for (const name of ['Authorization', 'COOKIE', 'proxy-authorization', 'Host', 'Client-Request-Id']) {
      const r = GraphRequestSpec.safeParse({ path: '/users', headers: { [name]: 'x' } });
      expect(r.success, name).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toMatch(/AdminForge sets this header itself/);
    }
    expect(
      GraphRequestSpec.safeParse({ path: '/users', headers: { ConsistencyLevel: 'eventual' } }).success,
    ).toBe(true);
  });

  it('a shipped report that declared one would fail to load (what validate and publish run)', () => {
    const file = 'reports/endpoint/stale-devices.report.yaml';
    const text = readFileSync(path.join(CONTENT_DIR, file), 'utf8');
    expect(parseDefinition(text, file).ok).toBe(true);
    const spoofed = text.replace('headers: { ConsistencyLevel: eventual }', 'headers: { Authorization: x }');
    expect(spoofed).not.toBe(text);
    const parsed = parseDefinition(spoofed, file);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.map((e) => e.message).join(' ')).toMatch(/sets this header itself/);
  });

  it('schemas and connectors name the same headers (schemas depends on nothing but zod and yaml)', () => {
    expect([...FORBIDDEN_HEADER_NAMES].sort()).toEqual([...FORBIDDEN_HEADERS].sort());
  });
});

describe('a raw $batch body (a graph step or datasource posting to /$batch itself)', () => {
  const executor = (sent: string[]) =>
    createOutboundExecutor({
      config: {
        DATA_MODE: 'fixtures',
        AF_SPO_TENANT_NAME: undefined,
        OUTBOUND_CONCURRENCY: 4,
        OUTBOUND_USER_CONCURRENCY: 2,
        OUTBOUND_TIMEOUT_MS: 5000,
        TOKEN_CACHE_KEY: undefined,
      },
      broker: null,
      auth: null,
      automation: null,
      fetch: async (input) => {
        sent.push(String(input));
        return new Response(JSON.stringify({ responses: [{ id: '1', status: 200, body: {} }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
  const reader = { kind: 'automation', mode: 'read' } as const;
  const batch = (headers: Record<string, string>) => ({
    service: 'graph' as const,
    method: 'POST',
    path: '/$batch',
    body: { requests: [{ id: '1', method: 'GET', url: '/users', headers }] },
  });

  it.each([['client-request-id'], ['Authorization'], ['COOKIE']])(
    'refuses a sub-request setting %s, before anything is sent',
    async (name) => {
      const sent: string[] = [];
      const err = await executor(sent)
        .execute(reader, batch({ [name]: 'x' }))
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toMatchObject({ status: 400, code: 'invalid_request' });
      expect((err as AppError).message).not.toMatch(/authorization|cookie|request-id/i);
      expect(sent).toEqual([]);
    },
  );

  it('lets a sub-request set the headers content may set', async () => {
    const sent: string[] = [];
    await executor(sent).execute(reader, batch({ ConsistencyLevel: 'eventual' }));
    expect(sent).toHaveLength(1);
  });
});
