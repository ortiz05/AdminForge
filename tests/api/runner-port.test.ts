import type { AddressInfo } from 'node:net';
import { createRunnerPort } from '@adminforge/api/src/runs/ports';
import type { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import { StepError, type ResolvedIdentity, type RunnerJob } from '@adminforge/engine';
import { WorkerPool } from '@adminforge/runner/src/pool';
import { buildRunnerServer } from '@adminforge/runner/src/server';
import { fakeJwt, fakeWorkerCommand, makeScriptsDir, newKey, testConfig } from '../unit/runner/helpers';
import {
  type FakeRunnerRequest,
  readFakeRunnerRequest,
  signedRunnerAnswer,
  signedRunnerRefusal,
} from './runner-fake';

// runs/ports.ts: the API side of the runner protocol (sealed tokens, signed answers, no redirects).

const TENANT = { id: '11111111-2222-4333-8444-555555555555', domain: 'example.com' };
const exchangeToken = fakeJwt('engineer@example.com');
const graphToken = fakeJwt('engineer@example.com');

const broker = {
  get: async (_session: unknown, service: string, mode: string) => {
    if (mode !== 'read') throw new Error('unexpected mode');
    return service === 'exchange' ? exchangeToken : graphToken;
  },
} as unknown as TokenBroker;

const identity = {
  actor: { kind: 'delegated', oid: 'u', upn: 'u@example.com' },
  mode: 'read',
  handle: { kind: 'delegated', session: { idHash: 'h', userOid: 'u', upn: 'u@example.com' }, mode: 'read' },
} as unknown as ResolvedIdentity;

const runnerJob = (patch: Partial<RunnerJob> = {}): RunnerJob => ({
  jobId: `run-1:step-${Math.random().toString(36).slice(2)}`,
  script: 'exchange/Get-Test.ps1',
  sha256: 'a'.repeat(64),
  parameters: { kinds: ['Member'] },
  services: ['exchange'],
  timeoutSeconds: 60,
  mode: 'read',
  ...patch,
});

/** A port whose fetch is a fake runner: `answer` sees the request as the runner would. */
function portWith(key: string, answer: (req: FakeRunnerRequest) => Response | Promise<Response>) {
  const requests: FakeRunnerRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = readFakeRunnerRequest(key, input, init);
    requests.push(req);
    return answer(req);
  };
  return {
    port: createRunnerPort({ url: 'http://127.0.0.1:3101', key, broker, tenant: TENANT, fetch }),
    requests,
  };
}

async function run(port: ReturnType<typeof createRunnerPort>, job = runnerJob()) {
  const events: unknown[] = [];
  const result = await port.run(identity, job, {
    signal: new AbortController().signal,
    onEvent: (e) => {
      events.push(e);
    },
  });
  return { result, events };
}

async function failure(promise: Promise<unknown>): Promise<StepError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StepError);
  return error as StepError;
}

describe('runner port: request', () => {
  const key = newKey();

  it('seals the delegated tokens for this job, adds a nonce and refuses redirects', async () => {
    const { port, requests } = portWith(key, (req) =>
      signedRunnerAnswer(key, req, [{ type: 'done', status: 'succeeded', durationMs: 1 }]),
    );
    await run(port, runnerJob({ services: ['exchange', 'graph'] }));
    const [req] = requests;
    expect(req!.url).toBe('http://127.0.0.1:3101/v1/jobs');
    expect(req!.redirect).toBe('error');
    expect(req!.rawBody).not.toContain(exchangeToken);
    expect(req!.rawBody).not.toContain(graphToken);
    expect(req!.body).not.toHaveProperty('tokens');
    expect(req!.body.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(req!.tokens).toEqual({ exchange: exchangeToken, graph: graphToken });
    expect(req!.body).toMatchObject({
      script: { path: 'exchange/Get-Test.ps1' },
      mode: 'read',
      inputs: { kinds: ['Member'] },
      timeoutSeconds: 60,
    });
  });

  it('sends no sealed tokens when the script needs no service', async () => {
    const { port, requests } = portWith(key, (req) =>
      signedRunnerAnswer(key, req, [{ type: 'done', status: 'succeeded', durationMs: 1 }]),
    );
    await run(port, runnerJob({ services: [] }));
    expect(requests[0]!.body).not.toHaveProperty('sealedTokens');
  });
});

describe('runner port: answers', () => {
  const key = newKey();

  it('uses a verified answer: events in order, outputs, status and error', async () => {
    const { port } = portWith(key, (req) =>
      signedRunnerAnswer(key, req, [
        { type: 'log', level: 'info', message: 'connecting', ts: '2026-10-15T00:00:00Z' },
        { type: 'progress', percent: 50, message: 'half' },
        { type: 'output', data: { name: 'a' } },
        { type: 'output', data: { name: 'b' } },
        { type: 'error', message: 'partial', category: 'script' },
        { type: 'done', status: 'failed', durationMs: 3 },
      ]),
    );
    const { result, events } = await run(port);
    expect(result).toEqual({
      status: 'failed',
      output: [{ name: 'a' }, { name: 'b' }],
      error: { message: 'partial', category: 'script' },
    });
    expect(events).toEqual([
      { type: 'log', level: 'info', message: 'connecting' },
      { type: 'progress', percent: 50, message: 'half' },
      { type: 'output', data: { name: 'a' } },
      { type: 'output', data: { name: 'b' } },
    ]);
  });

  it.each([
    [
      'an unsigned answer',
      () =>
        new Response(
          '{"type":"accepted","jobId":"x"}\n{"type":"output","data":"forged"}\n{"type":"done","status":"succeeded"}\n',
        ),
    ],
    [
      'an answer signed with another key',
      (req: FakeRunnerRequest) =>
        signedRunnerAnswer(newKey(), req, [
          { type: 'output', data: 'forged' },
          { type: 'done', status: 'succeeded', durationMs: 1 },
        ]),
    ],
    [
      'an answer signed for another request',
      (req: FakeRunnerRequest) =>
        signedRunnerAnswer(key, { ...req, body: { ...req.body, nonce: 'n'.repeat(43) } }, [
          { type: 'output', data: 'forged' },
          { type: 'done', status: 'succeeded', durationMs: 1 },
        ]),
    ],
    ['an answer that ends before done', (req: FakeRunnerRequest) => signedRunnerAnswer(key, req, [])],
    ['an answer that is not NDJSON', () => new Response('<html>proxy error</html>\n')],
  ])('discards %s without using any of it', async (_label, answer) => {
    const { port } = portWith(key, answer);
    const events: unknown[] = [];
    const error = await failure(
      port.run(identity, runnerJob(), {
        signal: new AbortController().signal,
        onEvent: (e) => void events.push(e),
      }),
    );
    expect(error.code).toBe('runner_unverified');
    expect(error.opts.status).toBe(502);
    expect(error.opts.hint).toMatch(/portal administrator/);
    expect(events.filter((e) => (e as { type: string }).type === 'output')).toEqual([]);
  });

  it('stops at the first event that does not verify', async () => {
    const { port } = portWith(key, async (req) => {
      const good = await signedRunnerAnswer(key, req, [
        { type: 'output', data: 'real' },
        { type: 'output', data: 'second' },
        { type: 'done', status: 'succeeded', durationMs: 1 },
      ]).text();
      return new Response(good.replace('"second"', '"forged"'));
    });
    const events: unknown[] = [];
    const error = await failure(
      port.run(identity, runnerJob(), {
        signal: new AbortController().signal,
        onEvent: (e) => void events.push(e),
      }),
    );
    expect(error.code).toBe('runner_unverified');
    expect(events).toEqual([{ type: 'output', data: 'real' }]);
  });

  it('reports a signed refusal with its code and message, and only a verified 503 as transient', async () => {
    const refused = portWith(key, (req) =>
      signedRunnerRefusal(key, req, 409, { error: 'script_hash_mismatch', message: 'Script does not match' }),
    );
    const error = await failure(run(refused.port));
    expect(error).toMatchObject({ code: 'runner_script_hash_mismatch', message: 'Script does not match' });
    const busy = portWith(key, (req) =>
      signedRunnerRefusal(key, req, 503, { error: 'runner_unavailable', message: 'No worker' }),
    );
    expect((await failure(run(busy.port))).opts.transient).toBe(true);
  });

  it('does not repeat an unsigned refusal to the person', async () => {
    const { port } = portWith(
      key,
      () =>
        new Response(JSON.stringify({ error: 'reauth', message: 'Sign in again at http://phish.example' }), {
          status: 503,
        }),
    );
    const error = await failure(run(port));
    expect(error.code).toBe('runner_error');
    expect(error.message).not.toContain('phish');
    expect(error.opts.transient).toBeFalsy();
  });
});

describe('runner port against the real runner service', () => {
  const key = newKey();
  const scripts = makeScriptsDir();
  let app: Awaited<ReturnType<typeof buildRunnerServer>>;
  let url: string;

  beforeAll(async () => {
    const pool = new WorkerPool({ command: fakeWorkerCommand(), size: 1, maxJobs: 2 });
    app = await buildRunnerServer({
      config: testConfig(key, { scriptsDir: scripts.dir }),
      pool,
      logger: false,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    scripts.cleanup();
  });

  it('runs a job end to end: the worker gets the tokens, the API gets verified results', async () => {
    const port = createRunnerPort({ url, key, broker, tenant: TENANT });
    const { result } = await run(
      port,
      runnerJob({ script: scripts.script, sha256: scripts.sha, parameters: { behaviour: 'echo' } }),
    );
    expect(result.status).toBe('succeeded');
    expect(result.output).toMatchObject({ tokenServices: ['exchange'], mode: 'read' });
  });

  it('refuses a runner that uses another key, before using anything it says', async () => {
    const port = createRunnerPort({ url, key: newKey(), broker, tenant: TENANT });
    const error = await failure(run(port, runnerJob({ script: scripts.script, sha256: scripts.sha })));
    expect(error.code).toBe('runner_error');
    expect(error.opts.status).toBe(401);
  });
});
