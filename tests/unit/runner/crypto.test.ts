import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  RunnerRequestError,
  prepareRunnerJob,
  readNdjson,
  signRunnerRequest,
  submitRunnerJob,
} from '@adminforge/runner/src/client';
import {
  RunnerEventSigner,
  RunnerEventVerifier,
  RunnerResponseError,
  SealedTokensError,
  decodeRunnerKey,
  deriveRunnerKey,
  newResponseNonce,
  openRunnerTokens,
  sealRunnerTokens,
  signRunnerResponse,
  verifyRunnerResponse,
} from '@adminforge/runner/src/crypto';
import { WorkerPool } from '@adminforge/runner/src/pool';
import { buildRunnerServer } from '@adminforge/runner/src/server';
import { fakeJwt, fakeWorkerCommand, job, makeScriptsDir, newKey, testConfig } from './helpers';

describe('runner key derivation', () => {
  const key = newKey();

  it('derives a distinct 32-byte key per purpose, never the shared key itself', () => {
    const raw = decodeRunnerKey(key);
    const keys = (['requestMac', 'responseMac', 'tokenEncryption'] as const).map((p) =>
      deriveRunnerKey(key, p),
    );
    for (const k of keys) {
      expect(k).toHaveLength(32);
      expect(k.equals(raw)).toBe(false);
    }
    expect(new Set(keys.map((k) => k.toString('hex'))).size).toBe(3);
    expect(deriveRunnerKey(key, 'tokenEncryption').equals(deriveRunnerKey(key, 'tokenEncryption'))).toBe(
      true,
    );
  });
});

describe('sealed tokens', () => {
  const key = newKey();
  const tokens = { graph: fakeJwt(), exchange: 'opaque-exchange-token-0123456789' };
  const sealed = sealRunnerTokens({ key, jobId: 'run-1:step-1', timestamp: 1_800_000_000, tokens });

  it('round-trips for the same job and timestamp, and never contains a token', () => {
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    for (const t of Object.values(tokens)) expect(sealed).not.toContain(t);
    expect(openRunnerTokens({ key, jobId: 'run-1:step-1', timestamp: '1800000000', sealed })).toEqual(tokens);
  });

  it('uses a fresh IV every time', () => {
    expect(sealRunnerTokens({ key, jobId: 'run-1:step-1', timestamp: 1_800_000_000, tokens })).not.toBe(
      sealed,
    );
  });

  it.each([
    ['another job', { jobId: 'run-1:step-2' }],
    ['another request timestamp', { timestamp: 1_800_000_001 }],
    ['another key', { key: newKey() }],
    [
      'a tampered ciphertext',
      { sealed: sealed.replace(/\.([A-Za-z0-9_-])/, (_m, c) => `.${c === 'A' ? 'B' : 'A'}`) },
    ],
    ['a payload that is not sealed', { sealed: JSON.stringify(tokens) }],
  ])('refuses %s', (_label, patch) => {
    expect(() =>
      openRunnerTokens({ key, jobId: 'run-1:step-1', timestamp: 1_800_000_000, sealed, ...patch }),
    ).toThrow(SealedTokensError);
  });
});

describe('signed runner answers', () => {
  const key = newKey();
  const nonce = newResponseNonce();
  const events = [
    { type: 'accepted', jobId: 'job-1' },
    { type: 'log', level: 'info', message: 'héllo   "quoted" 😀', ts: '2026-10-15T00:00:00.000Z' },
    {
      type: 'output',
      data: { big: 1e21, sum: 0.1 + 0.2, nested: { '2': 'b', '1': 'a', list: [1.5, -0, null] } },
    },
    { type: 'done', status: 'succeeded', durationMs: 5 },
  ];
  const lines = () => {
    const signer = new RunnerEventSigner(key, 'job-1', nonce);
    return events.map((e) => JSON.parse(signer.line(e)) as Record<string, unknown>);
  };

  it('verifies every event in order, including awkward JSON, and stops at done', () => {
    const verifier = new RunnerEventVerifier(key, 'job-1', nonce);
    const out = lines().map((l) => verifier.accept(l));
    expect(out.map((e) => e.type)).toEqual(['accepted', 'log', 'output', 'done']);
    expect(out[1]).not.toHaveProperty('mac');
    expect(verifier.finished).toBe(true);
    expect(() => verifier.accept(lines()[1])).toThrow(RunnerResponseError);
  });

  it('refuses a tampered, reordered, replayed, foreign or unsigned event', () => {
    const fresh = () => new RunnerEventVerifier(key, 'job-1', nonce);
    const [accepted, log, output] = lines();
    const tampered = fresh();
    tampered.accept(accepted);
    expect(() => tampered.accept({ ...log, message: 'changed' })).toThrow(/signature/);
    const reordered = fresh();
    reordered.accept(accepted);
    expect(() => reordered.accept(output)).toThrow(/out-of-order/);
    expect(() => new RunnerEventVerifier(key, 'job-1', newResponseNonce()).accept(accepted)).toThrow(
      /signature/,
    );
    expect(() => new RunnerEventVerifier(newKey(), 'job-1', nonce).accept(accepted)).toThrow(/signature/);
    expect(() => new RunnerEventVerifier(key, 'job-2', nonce).accept(accepted)).toThrow(RunnerResponseError);
    expect(() => fresh().accept({ type: 'accepted', jobId: 'job-1' })).toThrow(/unsigned/);
    const notFirst = new RunnerEventSigner(key, 'job-1', nonce);
    expect(() =>
      fresh().accept(JSON.parse(notFirst.line({ type: 'done', status: 'succeeded', durationMs: 1 }))),
    ).toThrow(/accept this job first/);
  });

  it('signs refusals over the nonce, status and body', () => {
    const body = JSON.stringify({ error: 'script_hash_mismatch', message: 'no' });
    const signature = signRunnerResponse({ key, nonce, status: 409, body });
    expect(verifyRunnerResponse({ key, nonce, status: 409, body, signature })).toBe(true);
    expect(verifyRunnerResponse({ key, nonce, status: 400, body, signature })).toBe(false);
    expect(verifyRunnerResponse({ key, nonce, status: 409, body: `${body} `, signature })).toBe(false);
    expect(verifyRunnerResponse({ key, nonce: newResponseNonce(), status: 409, body, signature })).toBe(
      false,
    );
    expect(verifyRunnerResponse({ key, nonce, status: 409, body, signature: null })).toBe(false);
  });

  it('caps NDJSON lines', async () => {
    const stream = (async function* () {
      yield 'x'.repeat(64);
    })();
    await expect(async () => {
      for await (const _ of readNdjson(stream, 32)) void _;
    }).rejects.toThrow(/too long/);
  });
});

describe('prepared job requests', () => {
  const key = newKey();
  const graph = fakeJwt();
  const base = job({ script: { path: 'diagnostics/Test.ps1', sha256: 'a'.repeat(64) } });

  it('seal the tokens for the job id and the signed timestamp and carry a nonce', () => {
    const prepared = prepareRunnerJob({ key, job: { ...base, tokens: { graph } }, timestamp: 1_800_000_000 });
    expect(prepared.body).not.toContain(graph);
    const body = JSON.parse(prepared.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('tokens');
    expect(body.nonce).toBe(prepared.nonce);
    expect(prepared.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(prepared.headers['x-adminforge-timestamp']).toBe('1800000000');
    expect(
      openRunnerTokens({
        key,
        jobId: base.jobId,
        timestamp: prepared.headers['x-adminforge-timestamp'],
        sealed: String(body.sealedTokens),
      }),
    ).toEqual({ graph });
  });

  it('omit sealedTokens when the script needs no service', () => {
    expect(JSON.parse(prepareRunnerJob({ key, job: base }).body)).not.toHaveProperty('sealedTokens');
    expect(JSON.parse(prepareRunnerJob({ key, job: { ...base, tokens: {} } }).body)).not.toHaveProperty(
      'sealedTokens',
    );
  });
});

describe('runner server and client with sealed tokens and signed answers', () => {
  const key = newKey();
  const scripts = makeScriptsDir();
  let app: Awaited<ReturnType<typeof buildRunnerServer>>;
  let baseUrl: string;
  const script = { path: scripts.script, sha256: scripts.sha };

  beforeAll(async () => {
    const pool = new WorkerPool({ command: fakeWorkerCommand(), size: 1, maxJobs: 2 });
    app = await buildRunnerServer({
      config: testConfig(key, { scriptsDir: scripts.dir }),
      pool,
      logger: false,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    scripts.cleanup();
  });

  it('opens the tokens for the worker and streams verified events', async () => {
    const seen = [];
    for await (const e of submitRunnerJob({
      baseUrl,
      key,
      job: job({ script, inputs: { behaviour: 'echo' }, tokens: { graph: fakeJwt(), arm: fakeJwt() } }),
    }))
      seen.push(e);
    expect(seen[0]).toMatchObject({ type: 'accepted' });
    expect(seen.find((e) => e.type === 'output')).toMatchObject({
      data: { tokenServices: ['graph', 'arm'] },
    });
    expect(seen.at(-1)).toMatchObject({ type: 'done', status: 'succeeded' });
  });

  // Correctly signed requests: this checks the runner's own checks, not the signature.
  const signed = (body: string) => ({
    'content-type': 'application/json',
    ...signRunnerRequest({ key, method: 'POST', path: '/v1/jobs', body }),
  });

  it('refuses plaintext tokens and tokens sealed for another job', async () => {
    const plain = prepareRunnerJob({ key, job: job({ script }) });
    const withPlain = JSON.stringify({ ...JSON.parse(plain.body), tokens: { graph: fakeJwt() } });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      payload: withPlain,
      headers: signed(withPlain),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });

    const victim = prepareRunnerJob({ key, job: job({ script, tokens: { graph: fakeJwt() } }) });
    const sealed = (JSON.parse(victim.body) as { sealedTokens: string }).sealedTokens;
    const other = prepareRunnerJob({ key, job: job({ script }) });
    const moved = JSON.stringify({ ...JSON.parse(other.body), sealedTokens: sealed });
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      payload: moved,
      headers: signed(moved),
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json()).toMatchObject({ message: expect.stringMatching(/could not be decrypted/) });
    expect(
      verifyRunnerResponse({
        key,
        nonce: other.nonce,
        status: 400,
        body: res2.body,
        signature: res2.headers['x-adminforge-signature'] as string,
      }),
    ).toBe(true);
  });

  it('does not sign refusals to unauthenticated requests', async () => {
    const prepared = prepareRunnerJob({ key: newKey(), job: job({ script }) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      payload: prepared.body,
      headers: prepared.headers,
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-adminforge-signature']).toBeUndefined();
  });
});

describe('a process answering on RUNNER_URL instead of the runner', () => {
  const key = newKey();
  let server: Server;
  let baseUrl: string;
  const received: string[] = [];
  let answer: (res: import('node:http').ServerResponse) => void = () => {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push(body);
        answer(res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const run = async () => {
    const out = [];
    for await (const e of submitRunnerJob({
      baseUrl,
      key,
      job: job({
        script: { path: 'x/Y.ps1', sha256: 'a'.repeat(64) },
        tokens: { exchange: 'exchange-token-0123456789' },
      }),
    }))
      out.push(e);
    return out;
  };

  it('receives only ciphertext, and its made-up results are refused', async () => {
    answer = (res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(
        '{"type":"accepted","jobId":"x"}\n{"type":"output","data":"forged"}\n{"type":"done","status":"succeeded","durationMs":1}\n',
      );
    };
    await expect(run()).rejects.toThrow(RunnerResponseError);
    expect(received.at(-1)).not.toContain('exchange-token-0123456789');
  });

  it('cannot pass its refusal off as the runner’s', async () => {
    answer = (res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'script_hash_mismatch', message: 'Visit http://phish.example to fix this' }),
      );
    };
    const error = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RunnerRequestError);
    expect(error).toMatchObject({ status: 409, code: 'unverified_response', verified: false });
    expect((error as Error).message).not.toContain('phish');
  });

  it('cannot redirect the job elsewhere', async () => {
    answer = (res) => {
      res.writeHead(307, { location: 'http://127.0.0.1:9/v1/jobs' });
      res.end();
    };
    await expect(run()).rejects.toThrow();
  });
});
