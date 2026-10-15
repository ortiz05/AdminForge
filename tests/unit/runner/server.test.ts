import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RunnerRequestError,
  cancelRunnerJob,
  readNdjson,
  signRunnerRequest,
  submitRunnerJob,
} from '@adminforge/runner/src/client';
import { WorkerPool } from '@adminforge/runner/src/pool';
import type { RunnerEvent } from '@adminforge/runner/src/protocol';
import { buildRunnerServer } from '@adminforge/runner/src/server';
import {
  fakeWorkerCommand,
  job,
  makeScriptsDir,
  newKey,
  parseEvents,
  signedInject,
  testConfig,
  waitFor,
} from './helpers';

type App = Awaited<ReturnType<typeof buildRunnerServer>>;

describe('runner server with a fake worker', () => {
  const key = newKey();
  const scripts = makeScriptsDir();
  const modulesDir = mkdtempSync(path.join(tmpdir(), 'af-modules-'));
  mkdirSync(path.join(modulesDir, 'Fake.Module', '1.0.0'), { recursive: true });
  writeFileSync(path.join(modulesDir, 'Fake.Module', '1.0.0', 'Fake.Module.psd1'), '@{}');
  let app: App;
  let baseUrl: string;
  const script = { path: scripts.script, sha256: scripts.sha };

  beforeAll(async () => {
    const config = testConfig(key, { scriptsDir: scripts.dir, modulesDir, maxJobs: 3 });
    const pool = new WorkerPool({ command: fakeWorkerCommand(), size: 1, maxJobs: 3 });
    app = await buildRunnerServer({
      config,
      pool,
      logger: false,
      keepAliveMs: 50,
      modulesLock: { modules: { 'Fake.Module': '1.0.0', 'Missing.Module': '2.0.0' } },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterAll(async () => {
    await app.close();
    scripts.cleanup();
    rmSync(modulesDir, { recursive: true, force: true });
  });

  it('streams NDJSON events from accepted to done', async () => {
    const res = await signedInject(app, key, {
      method: 'POST',
      url: '/v1/jobs',
      body: job({ script, inputs: { behaviour: 'echo', n: 1 } }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    const events = parseEvents(res.body);
    expect(events.map((e) => e.type)).toEqual(['accepted', 'log', 'progress', 'output', 'done']);
    expect(events[0]).toMatchObject({ type: 'accepted' });
    const output = events[3] as Extract<RunnerEvent, { type: 'output' }>;
    expect(output.data).toMatchObject({
      inputs: { behaviour: 'echo', n: 1 },
      mode: 'read',
      script: { path: scripts.script, sha256: scripts.sha },
    });
    expect(events[4]).toMatchObject({ type: 'done', status: 'succeeded' });
    expect((events[4] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('streams events through the client helper as they happen', async () => {
    const seen: RunnerEvent[] = [];
    for await (const event of submitRunnerJob({
      baseUrl,
      key,
      job: job({ script, inputs: { behaviour: 'echo' } }),
    }))
      seen.push(event);
    expect(seen[0]?.type).toBe('accepted');
    expect(seen.at(-1)).toMatchObject({ type: 'done', status: 'succeeded' });
  });

  it('answers 400 with issues for an invalid job and for invalid JSON', async () => {
    const res = await signedInject(app, key, {
      method: 'POST',
      url: '/v1/jobs',
      body: { ...job({ script }), timeoutSeconds: 5000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request', issues: [{ path: 'timeoutSeconds' }] });
    const raw = '{not json';
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      payload: raw,
      headers: { ...signRunnerRequest({ key, body: raw }), 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_request', message: 'Body is not valid JSON' });
  });

  it('requires spoTenantName when a SharePoint token is sent', async () => {
    const res = await signedInject(app, key, {
      method: 'POST',
      url: '/v1/jobs',
      body: job({ script, tokens: { sharepointAdmin: 'x'.repeat(20) } }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('cancels a running job on request', async () => {
    const body = job({ script, inputs: { behaviour: 'hang' } });
    const seen: RunnerEvent[] = [];
    for await (const event of submitRunnerJob({ baseUrl, key, job: body })) {
      seen.push(event);
      if (event.type === 'log' && event.message === 'hanging')
        expect(await cancelRunnerJob({ baseUrl, key, jobId: body.jobId })).toBe(true);
    }
    expect(seen.at(-2)).toMatchObject({
      type: 'error',
      category: 'cancelled',
      message: 'The job was cancelled (cancelled by request)',
    });
    expect(seen.at(-1)).toMatchObject({ type: 'done', status: 'cancelled' });
    expect(await cancelRunnerJob({ baseUrl, key, jobId: body.jobId })).toBe(false);
  });

  it('times out a job and kills its worker', async () => {
    const res = await signedInject(app, key, {
      method: 'POST',
      url: '/v1/jobs',
      body: job({ script, inputs: { behaviour: 'hang' }, timeoutSeconds: 1 }),
    });
    const events = parseEvents(res.body);
    expect(events.at(-2)).toMatchObject({ type: 'error', category: 'timeout' });
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'timeout' });
  });

  it('cancels the job when the client disconnects', async () => {
    const body = job({ script, inputs: { behaviour: 'hang' } });
    const controller = new AbortController();
    const payload = JSON.stringify(body);
    const res = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      body: payload,
      headers: { 'content-type': 'application/json', ...signRunnerRequest({ key, body: payload }) },
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    await waitFor(async () => (await health()).jobs.running === 1);
    controller.abort();
    await waitFor(async () => (await health()).jobs.running === 0);
  });

  it('sends blank keep-alive lines that the client ignores', async () => {
    const payload = JSON.stringify(job({ script, inputs: { behaviour: 'hang' }, timeoutSeconds: 1 }));
    const res = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      body: payload,
      headers: { 'content-type': 'application/json', ...signRunnerRequest({ key, body: payload }) },
    });
    const text = await res.text();
    expect(text).toMatch(/\n\n/);
    const values: unknown[] = [];
    for await (const v of readNdjson(
      (async function* () {
        yield Buffer.from(text);
      })(),
    ))
      values.push(v);
    expect(values.at(-1)).toMatchObject({ type: 'done', status: 'timeout' });
  });

  it('reports pool, pwsh and module status on /healthz', async () => {
    await waitFor(async () => (await health()).pool.ready >= 1);
    const report = await health();
    expect(report).toMatchObject({
      status: 'degraded', // Missing.Module is pinned but not installed
      pool: { size: 1, maxJobs: 3 },
      pwsh: { version: 'fake-7.6' },
      modules: {
        items: [
          { name: 'Fake.Module', pinned: '1.0.0', installed: true, loaded: '1.0.0' },
          { name: 'Missing.Module', pinned: '2.0.0', installed: false, loaded: null },
        ],
      },
      scripts: { exists: true },
    });
  });

  async function health() {
    const res = await signedInject(app, key, { method: 'GET', url: '/healthz' });
    return res.json() as { status: string; jobs: { running: number }; pool: { ready: number } };
  }
});

describe('runner server when workers cannot start', () => {
  const key = newKey();
  const scripts = makeScriptsDir();
  let app: App;

  beforeAll(async () => {
    const pool = new WorkerPool({
      command: fakeWorkerCommand({ FAKE_WORKER_STARTUP: 'crash' }),
      size: 1,
      maxJobs: 1,
      backoffBaseMs: 10,
      backoffMaxMs: 20,
    });
    app = await buildRunnerServer({
      config: testConfig(key, { scriptsDir: scripts.dir }),
      pool,
      logger: false,
    });
    await waitFor(() => pool.isUnavailable());
  });
  afterAll(async () => {
    await app.close();
    scripts.cleanup();
  });

  it('answers 503 with Retry-After instead of accepting jobs', async () => {
    const res = await signedInject(app, key, {
      method: 'POST',
      url: '/v1/jobs',
      body: job({ script: { path: scripts.script, sha256: scripts.sha } }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('10');
    expect(res.json()).toMatchObject({ error: 'runner_unavailable' });
  });

  it('reports unavailable on /healthz with the startup error', async () => {
    const res = await signedInject(app, key, { method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'unavailable',
      pool: { lastError: expect.stringMatching(/fake worker cannot start/) },
    });
  });

  it('surfaces refusals as RunnerRequestError in the client', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const iterator = submitRunnerJob({
      baseUrl,
      key,
      job: job({ script: { path: scripts.script, sha256: scripts.sha } }),
    });
    const error = await iterator.next().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RunnerRequestError);
    expect(error).toMatchObject({ status: 503, code: 'runner_unavailable' });
  });
});
