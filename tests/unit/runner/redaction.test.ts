import { WorkerPool } from '@adminforge/runner/src/pool';
import { REDACTED, createRedactor, redactDeep, redactGeneric } from '@adminforge/runner/src/redact';
import { buildRunnerServer } from '@adminforge/runner/src/server';
import { buildWorkerCommand } from '@adminforge/runner/src/config';
import {
  FAKE_WORKER,
  fakeJwt,
  job,
  logCapture,
  makeScriptsDir,
  newKey,
  parseEvents,
  signedInject,
  testConfig,
} from './helpers';

describe('redactor', () => {
  it('replaces forwarded tokens and anything shaped like a JWT or bearer credential', () => {
    const opaque = 'opaque-delegated-token-0123456789';
    const jwt = fakeJwt();
    const other = fakeJwt('someone@example.com');
    const redact = createRedactor([opaque, undefined, 'short']);
    const out = redact(
      `a ${opaque} b ${jwt} c Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 d short`,
    );
    expect(out).not.toContain(opaque);
    expect(out).not.toContain(jwt);
    expect(out).toContain(`a ${REDACTED} b ${REDACTED} c Authorization: Bearer ${REDACTED} d short`);
    expect(redactGeneric(`token=${other}`)).toBe(`token=${REDACTED}`);
  });

  it('deep-redacts plain objects but leaves class instances alone', () => {
    const jwt = fakeJwt();
    class Request {
      constructor(readonly header = jwt) {}
    }
    const req = new Request();
    const out = redactDeep({ msg: jwt, nested: [{ v: `x${jwt}` }], req, err: new Error(`bad ${jwt}`) });
    expect(JSON.stringify({ ...out, req: undefined })).not.toContain(jwt);
    expect(out.req).toBe(req);
    expect(out.err.message).toBe(`bad ${REDACTED}`);
  });
});

describe('tokens never leak from a job', () => {
  const key = newKey();
  const scripts = makeScriptsDir();
  const logs = logCapture();
  const graph = fakeJwt();
  const exchange = 'opaque-exchange-token-not-a-jwt-0123456789';
  let app: Awaited<ReturnType<typeof buildRunnerServer>>;

  beforeAll(async () => {
    const config = testConfig(key, { scriptsDir: scripts.dir });
    // The real worker command, but with node + the fake worker swapped in, and a parent environment
    // that contains secrets the worker must not inherit.
    const real = buildWorkerCommand(config, {
      ...process.env,
      RUNNER_SHARED_KEY: key,
      AF_AUTOMATION_CLIENT_SECRET: 'automation-secret-value',
    });
    const command = { ...real, command: process.execPath, args: [FAKE_WORKER] };
    const pool = new WorkerPool({ command, size: 1, maxJobs: 2 });
    app = await buildRunnerServer({ config, pool, logger: { level: 'debug', stream: logs.stream } });
  });
  afterAll(async () => {
    await app.close();
    scripts.cleanup();
  });

  const run = async (inputs: Record<string, unknown>) => {
    const res = await signedInject(app, key, {
      method: 'POST',
      url: '/v1/jobs',
      body: job({
        script: { path: scripts.script, sha256: scripts.sha },
        inputs,
        tokens: { graph, exchange },
      }),
    });
    expect(res.statusCode).toBe(200);
    return res;
  };

  it('redacts tokens a script echoes into logs, stderr, raw stdout, output data and errors', async () => {
    const res = await run({ behaviour: 'leak' });
    for (const secret of [graph, exchange]) {
      expect(res.body).not.toContain(secret);
      expect(logs.text()).not.toContain(secret);
    }
    const events = parseEvents(res.body);
    expect(events.find((e) => e.type === 'log' && e.message.startsWith('token is'))).toMatchObject({
      message: `token is ${REDACTED}`,
    });
    expect(events.find((e) => e.type === 'log' && e.message.startsWith('stderr token'))).toMatchObject({
      level: 'warn',
    });
    expect(events.find((e) => e.type === 'output')).toMatchObject({
      data: { nested: { list: [REDACTED, `prefix-${REDACTED}-suffix`] } },
    });
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      message: `failed with ${REDACTED}`,
      category: 'auth',
    });
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'failed' });
  });

  it('delivers tokens on stdin only: not in argv, not in the environment, and no supervisor secrets either', async () => {
    const res = await run({ behaviour: 'echo' });
    const output = parseEvents(res.body).find((e) => e.type === 'output');
    const data = (
      output as { data: { argv: string[]; envKeys: string[]; envHasToken: boolean; tokenServices: string[] } }
    ).data;
    expect(data.tokenServices.sort()).toEqual(['exchange', 'graph']);
    expect(data.argv.join(' ')).not.toContain(graph);
    expect(data.envHasToken).toBe(false);
    expect(data.envKeys).not.toContain('RUNNER_SHARED_KEY');
    expect(data.envKeys).not.toContain('AF_AUTOMATION_CLIENT_SECRET');
    expect(res.body).not.toContain(key);
  });

  it('never logs request headers or bodies', async () => {
    await run({ behaviour: 'echo' });
    expect(logs.text()).not.toContain('AdminForge-HMAC');
    expect(logs.text()).not.toContain('behaviour');
    expect(logs.text()).toContain('job finished');
  });
});
