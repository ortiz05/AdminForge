import { FsDefinitionSource, registryFrom } from '@adminforge/api/src/definitions';
import {
  DatasourceRunner,
  fixtureRunner,
  type RunnerJobSpec,
} from '@adminforge/api/src/datasources/executor';
import { liveRunner } from '@adminforge/api/src/datasources/runner';
import { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import { createFixtureFetch } from '@adminforge/connectors';
import { ApiErrorBody, DatasourceExecuteManyResponse, DatasourceResult } from '@adminforge/schemas';
import { fixturesApp, liveApp, setupContent, type ContentEnv } from './content-helpers';
import { mockLogin } from './helpers';
import { readFakeRunnerRequest, signedRunnerAnswer, type FakeRunnerRequest } from './runner-fake';

let env: ContentEnv;
beforeAll(() => {
  env = setupContent();
});
afterAll(() => env.cleanup());

const post = (
  app: Awaited<ReturnType<typeof fixturesApp>>['app'],
  url: string,
  h: Record<string, string>,
  payload: object,
) => app.inject({ method: 'POST', url, headers: h, payload });

describe('datasource dependencies (ds.<name>)', () => {
  it('execute-many runs dependents after what they reference; independent ones still run', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const h = { cookie, 'x-adminforge-csrf': csrf };
    const res = await post(t.app, '/api/datasources/execute-many', h, {
      page: 'deps.chain',
      datasources: ['third', 'second', 'first', 'independent'],
    });
    expect(res.statusCode).toBe(200);
    const body = DatasourceExecuteManyResponse.parse(res.json());
    expect(Object.keys(body.results)).toEqual(['third', 'second', 'first', 'independent']);
    expect(body.results.first).toMatchObject({ data: '30000000-0000-4000-8000-000000000001' });
    expect(body.results.second).toMatchObject({
      data: { value: [{ id: 'g1' }] },
      provenance: { path: '/users/{value}/memberOf' },
    });
    expect(body.results.third).toMatchObject({ data: { firstId: '30000000-0000-4000-8000-000000000001' } });
    expect(body.results.independent).toMatchObject({ data: 42 });
    await t.app.close();
  });

  it('a single execute resolves the datasources it depends on server-side', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const res = DatasourceResult.parse(
      (
        await post(
          t.app,
          '/api/datasources/execute',
          { cookie, 'x-adminforge-csrf': csrf },
          { page: 'deps.chain', datasource: 'third' },
        )
      ).json(),
    );
    expect(res.data).toEqual({ firstId: '30000000-0000-4000-8000-000000000001' });
    await t.app.close();
  });

  // Published definitions come back from Postgres (jsonb) with their keys reordered, so the runtime resolves any order;
  // `adminforge validate` keeps authors declaring dependencies first (tests/unit/cli/datasource-order.test.ts).
  it('a datasource declared after its dependent still resolves; failed dependencies fail their dependents', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const h = { cookie, 'x-adminforge-csrf': csrf };
    const many = DatasourceExecuteManyResponse.parse(
      (await post(t.app, '/api/datasources/execute-many', h, { page: 'deps.backwards' })).json(),
    );
    expect(many.results.early).toMatchObject({ data: 1 });
    expect(many.results.late).toMatchObject({ data: 1 });

    const runner = t.app.ctx.datasources as DatasourceRunner;
    const page = await runner.page('deps.chain');
    const failing = new DatasourceRunner({
      definitions: t.app.ctx.definitions,
      outbound: { execute: async () => Promise.reject(Object.assign(new Error('boom'), { status: 0 })) },
      env: () => ({}),
      now: () => new Date(),
    });
    const user = { oid: 'u', upn: 'u@example.com', name: 'U', roles: [] };
    const results = await failing.runMany(
      {
        identity: { kind: 'automation', mode: 'read' },
        user,
        page,
        params: { kind: 'Member' },
        correlationId: 'c',
      },
      ['second', 'third', 'independent'],
    );
    expect(results.second).toEqual({
      error: expect.objectContaining({
        code: 'dependency_failed',
        // What really failed (the first datasource's own error), not the chain of internal datasource names.
        message: expect.not.stringMatching(/needs "first"|Datasource "second"/),
      }),
    });
    expect(results.third).toEqual({ error: expect.objectContaining({ code: 'dependency_failed' }) });
    expect(results.independent).toMatchObject({ data: 42 });
    await t.app.close();
  });
});

describe('runner datasources', () => {
  it('fixtures: tests/fixtures/runner/<script>.json, variants matched on the parameters', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const h = { cookie, 'x-adminforge-csrf': csrf };
    const member = DatasourceResult.parse(
      (
        await post(t.app, '/api/datasources/execute', h, { page: 'deps.chain', datasource: 'mailboxes' })
      ).json(),
    );
    expect(member.data).toEqual([{ name: 'box-1' }, { name: 'box-2' }]);
    expect(member.provenance).toMatchObject({ service: 'runner', path: 'exchange/Get-Test.ps1' });
    const guest = DatasourceResult.parse(
      (
        await post(t.app, '/api/datasources/execute', h, {
          page: 'deps.chain',
          datasource: 'mailboxes',
          params: { kind: 'Guest' },
        })
      ).json(),
    );
    expect(guest.data).toEqual([{ name: 'guest-box' }]);
    await t.app.close();
  });

  it('fixtureRunner: missing files point at the file to create', async () => {
    const r = fixtureRunner(env.fixturesDir);
    const job: RunnerJobSpec = {
      script: 'exchange/Nope.ps1',
      sha256: 'a'.repeat(64),
      parameters: {},
      services: [],
      timeoutSeconds: 60,
      mode: 'read',
    };
    await expect(
      r.run({ kind: 'automation', mode: 'read' }, job, { correlationId: 'c' }),
    ).rejects.toMatchObject({
      status: 404,
      extras: { hint: 'Create runner/exchange/Nope.ps1.json in the fixtures directory.' },
    });
  });

  it('live: the runs adapter forwards read tokens, the job is clamped to 1800 s, and every output event is returned', async () => {
    // The runner opens sealed tokens and signs every event of its answer (tests/api/runner-fake.ts).
    const key = Buffer.alloc(32, 9).toString('base64');
    const sent: FakeRunnerRequest[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const req = readFakeRunnerRequest(key, input, init);
      sent.push(req);
      return signedRunnerAnswer(key, req, [
        { type: 'log', level: 'info', message: 'connecting' },
        { type: 'output', data: { name: 'a' } },
        { type: 'output', data: { name: 'b' } },
        { type: 'done', status: 'succeeded', durationMs: 1 },
      ]);
    };
    const auth = {
      token: async (i: { kind: string; scopes: string[] }) => `tok-${i.kind}-${i.scopes[0]}`,
    } as unknown as AuthClient;
    const runner = liveRunner({
      url: 'http://127.0.0.1:3101',
      key,
      broker: new TokenBroker(auth, {}),
      config: {
        AF_TENANT_ID: '11111111-2222-4333-8444-555555555555',
        AF_PRIMARY_DOMAIN: 'example.com',
        AF_SPO_TENANT_NAME: undefined,
      },
      fetch,
    })!;
    const session = {
      idHash: 'h',
      userOid: 'u',
      upn: 'u@example.com',
      readAccountId: 'acct',
      writeAccountId: null,
      writeExpiresAt: null,
    } as SessionRecord;
    const out = await runner.run(
      { kind: 'delegated', session, mode: 'read' },
      {
        script: 'exchange/Get-Test.ps1',
        sha256: 'a'.repeat(64),
        parameters: { kinds: ['Member'] },
        services: ['exchange'],
        timeoutSeconds: 1800,
        mode: 'read',
      },
      { correlationId: 'corr' },
    );
    expect(out.data).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(sent[0]!.url).toBe('http://127.0.0.1:3101/v1/jobs');
    expect(sent[0]!.body).toMatchObject({
      script: { path: 'exchange/Get-Test.ps1' },
      mode: 'read',
      inputs: { kinds: ['Member'] },
      timeoutSeconds: 1800,
    });
    // Tokens travel sealed: the runner opens them; they never appear in the request body.
    expect(sent[0]!.tokens).toEqual({ exchange: 'tok-read-https://outlook.office365.com/.default' });
    expect(sent[0]!.rawBody).not.toContain('tok-read-');
    expect(String(sent[0]!.body.jobId)).toMatch(/^ds-corr-/);
  });

  it('live: without RUNNER_URL / RUNNER_SHARED_KEY a runner datasource explains what to configure', async () => {
    // Live data needs Entra sign-in (mock sign-in only runs on fixtures): a fake AuthClient, no network.
    const t = await liveApp(env, () => new Response('unexpected', { status: 500 }));
    const { cookie, csrf } = t;
    const res = await post(
      t.app,
      '/api/datasources/execute',
      { cookie, 'x-adminforge-csrf': csrf },
      { page: 'deps.chain', datasource: 'mailboxes' },
    );
    expect(res.statusCode).toBe(503);
    expect(ApiErrorBody.parse(res.json()).error).toMatchObject({
      code: 'runner_not_configured',
      hint: expect.stringContaining('RUNNER_URL'),
    });
    await t.app.close();
  });
});

describe('read-mode additions', () => {
  it('App Service app settings: allowed in read mode, values stripped before the transform, audited', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const res = await post(
      t.app,
      '/api/datasources/execute',
      { cookie, 'x-adminforge-csrf': csrf },
      { page: 'deps.chain', datasource: 'settings' },
    );
    expect(res.statusCode).toBe(200);
    expect(DatasourceResult.parse(res.json()).data).toEqual([
      'FUNCTIONS_WORKER_RUNTIME',
      'STORAGE_CONNECTION',
    ]);
    expect(res.body).not.toContain('AccountKey');
    const audit = t.audit.rows.find((r) => r.action === 'outbound.sensitive_read')!;
    expect(audit).toMatchObject({
      result: 'success',
      targetType: 'arm',
      actorUpn: 'avery@example.com',
      mode: 'read',
    });
    expect(audit.targetId).toContain('/sites/func-example/config/appsettings/list');
    expect(audit.details).toMatchObject({
      names: 2,
      valuesReturned: false,
      template: expect.stringContaining('/sites/{name}/config/appsettings/list'),
    });
    expect(JSON.stringify(audit)).not.toContain('AccountKey');
    await t.app.close();
  });

  it('the executor strips values for every caller; connection strings stay denied; getByIds is a read', async () => {
    const calls: string[] = [];
    const reads: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push(`${init?.method} ${String(input)}`);
      return new Response(
        JSON.stringify(
          String(input).includes('appsettings') ? { properties: { SECRET: 'value' } } : { value: [] },
        ),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    const out = createOutboundExecutor({
      config: {
        DATA_MODE: 'live',
        AF_SPO_TENANT_NAME: undefined,
        OUTBOUND_CONCURRENCY: 4,
        OUTBOUND_USER_CONCURRENCY: 4,
        OUTBOUND_TIMEOUT_MS: 5000,
        TOKEN_CACHE_KEY: undefined,
      },
      broker: null,
      auth: null,
      automation: { clientId: 'a', credential: 'secret', token: async () => 'tok' },
      fetch,
      onSensitiveRead: (r) => void reads.push({ result: r.result, names: r.names }),
    });
    const id = { kind: 'automation' as const, mode: 'read' as const };
    const site = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/app1';
    const settings = await out.execute(id, {
      service: 'arm',
      method: 'POST',
      path: `${site}/slots/staging/config/appsettings/list`,
      apiVersion: '2023-12-01',
    });
    expect(settings.data).toEqual({ properties: { SECRET: null } });
    expect(reads).toEqual([{ result: 'success', names: 1 }]);
    await expect(
      out.execute(id, {
        service: 'arm',
        method: 'POST',
        path: `${site}/config/connectionstrings/list`,
        apiVersion: '2023-12-01',
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await out.execute(id, {
      service: 'graph',
      method: 'POST',
      path: '/directoryObjects/getByIds',
      body: { ids: ['x'], types: ['user'] },
    });
    expect(calls.at(-1)).toBe('POST https://graph.microsoft.com/v1.0/directoryObjects/getByIds');
  });

  it('Resource Graph fixtures: variants keyed by a `// af:<page>#<datasource>` comment still match through the executor', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const res = DatasourceResult.parse(
      (
        await post(
          t.app,
          '/api/datasources/execute',
          { cookie, 'x-adminforge-csrf': csrf },
          { page: 'deps.chain', datasource: 'inventory' },
        )
      ).json(),
    );
    expect(res.data).toMatchObject({ value: [{ name: 'from-variant' }] });
    // …also when paging through every page.
    const reg = registryFrom(new FsDefinitionSource(env.contentDir), 'fs');
    const exec = createOutboundExecutor({
      config: {
        DATA_MODE: 'fixtures',
        AF_SPO_TENANT_NAME: undefined,
        OUTBOUND_CONCURRENCY: 4,
        OUTBOUND_USER_CONCURRENCY: 4,
        OUTBOUND_TIMEOUT_MS: 5000,
        TOKEN_CACHE_KEY: undefined,
      },
      broker: null,
      auth: null,
      automation: null,
      fetch: createFixtureFetch(env.fixturesDir),
    });
    const all = await exec.execute<{ value: Array<{ name: string }> }>(
      { kind: 'automation', mode: 'read' },
      {
        service: 'arm',
        method: 'POST',
        path: '/providers/Microsoft.ResourceGraph/resources',
        body: { query: '// af:deps.chain#inventory\nResources' },
        paging: 'all',
      },
    );
    expect(all.data.value.map((r) => r.name)).toEqual(['from-variant']);
    await reg.close();
    await t.app.close();
  });
});
