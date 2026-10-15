import { createHash, createHmac } from 'node:crypto';
import { verifyRunnerRequest } from '@adminforge/runner/src/auth';
import { computeRunnerSignature, decodeRunnerKey, signRunnerRequest } from '@adminforge/runner/src/client';
import {
  ConfigError,
  buildWorkerCommand,
  loadRunnerConfig,
  parsePreload,
} from '@adminforge/runner/src/config';
import { WorkerPool } from '@adminforge/runner/src/pool';
import { buildRunnerServer } from '@adminforge/runner/src/server';
import { fakeWorkerCommand, newKey, signedInject, testConfig } from './helpers';

describe('runner request signing', () => {
  const key = newKey();
  const keyBytes = decodeRunnerKey(key);
  const body = JSON.stringify({ jobId: 'a', inputs: { x: 1 } });
  const now = 1_800_000_000;

  it('signs HMAC-SHA256(key, `${timestamp}.${sha256hex(body)}`) as hex', () => {
    const expected = createHmac('sha256', keyBytes)
      .update(`${now}.${createHash('sha256').update(body).digest('hex')}`)
      .digest('hex');
    expect(computeRunnerSignature(key, now, body)).toBe(expected);
    expect(signRunnerRequest({ key, body, timestamp: now })).toEqual({
      authorization: `AdminForge-HMAC ${expected}`,
      'x-adminforge-timestamp': String(now),
    });
  });

  it('signs an empty body for GET requests', () => {
    const expected = createHmac('sha256', keyBytes)
      .update(`${now}.${createHash('sha256').update('').digest('hex')}`)
      .digest('hex');
    expect(signRunnerRequest({ key, timestamp: now }).authorization).toBe(`AdminForge-HMAC ${expected}`);
  });

  it('rejects keys shorter than 32 bytes', () => {
    expect(() => decodeRunnerKey(Buffer.alloc(16).toString('base64'))).toThrow(/at least 32 bytes/);
  });

  const verify = (overrides: Partial<Parameters<typeof verifyRunnerRequest>[0]> = {}) => {
    const headers = signRunnerRequest({ key, body, timestamp: now });
    return verifyRunnerRequest({
      key: keyBytes,
      authorization: headers.authorization,
      timestamp: headers['x-adminforge-timestamp'],
      body: Buffer.from(body),
      nowSeconds: now,
      ...overrides,
    });
  };

  it('accepts a valid signature inside the ±60 s window', () => {
    expect(verify()).toEqual({ ok: true });
    expect(verify({ nowSeconds: now + 60 })).toEqual({ ok: true });
    expect(verify({ nowSeconds: now - 60 })).toEqual({ ok: true });
  });

  it('rejects timestamps outside the replay window', () => {
    expect(verify({ nowSeconds: now + 61 })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verify({ nowSeconds: now - 61 })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verify({ timestamp: 'yesterday' })).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects a tampered body, a wrong key, and a signature for another timestamp', () => {
    expect(verify({ body: Buffer.from(body.replace('"x":1', '"x":2')) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verify({ key: decodeRunnerKey(newKey()) })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verify({ timestamp: String(now + 1) })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects missing or malformed headers', () => {
    expect(verify({ authorization: undefined })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(verify({ authorization: 'Bearer abc' })).toEqual({ ok: false, reason: 'malformed_signature' });
    expect(verify({ authorization: 'AdminForge-HMAC xyz' })).toEqual({
      ok: false,
      reason: 'malformed_signature',
    });
    expect(verify({ timestamp: undefined })).toEqual({ ok: false, reason: 'missing_timestamp' });
  });
});

describe('runner server authentication', () => {
  const key = newKey();
  let app: Awaited<ReturnType<typeof buildRunnerServer>>;

  beforeAll(async () => {
    const config = testConfig(key);
    const pool = new WorkerPool({ command: fakeWorkerCommand(), size: 1, maxJobs: 1 });
    app = await buildRunnerServer({ config, pool, logger: false });
  });
  afterAll(() => app.close());

  it('refuses unsigned requests on every route', async () => {
    for (const [method, url] of [
      ['GET', '/healthz'],
      ['POST', '/v1/jobs'],
      ['POST', '/v1/jobs/x/cancel'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toMatchObject({ error: 'unauthorized' });
    }
  });

  it('accepts a signed request', async () => {
    const res = await signedInject(app, key, { method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a signature made with another key', async () => {
    const res = await signedInject(app, newKey(), { method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Signature does not match');
  });

  it('refuses a replayed request outside the window', async () => {
    const res = await signedInject(app, key, {
      method: 'GET',
      url: '/healthz',
      timestamp: Math.floor(Date.now() / 1000) - 120,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/outside the allowed window/);
  });

  it('verifies the exact body bytes before parsing them', async () => {
    const payload = JSON.stringify({ jobId: 'x' });
    const headers = signRunnerRequest({ key, body: payload });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      payload: JSON.stringify({ jobId: 'y' }),
      headers: { ...headers, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('runner configuration', () => {
  const key = newKey();

  it('requires RUNNER_SHARED_KEY and defaults to loopback:3101 with two workers', () => {
    expect(() => loadRunnerConfig({})).toThrow(ConfigError);
    const config = loadRunnerConfig({ RUNNER_SHARED_KEY: key, PATH: process.env.PATH });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3101,
      poolSize: 2,
      maxJobs: 4,
      preload: ['Graph', 'Exchange', 'Teams', 'SharePoint', 'Az'],
    });
    expect(config.scriptsDir).toMatch(/portal\/content\/scripts$/);
    expect(config.workerScript).toMatch(/portal\/apps\/runner\/ps\/worker\.ps1$/);
  });

  it('validates numbers and preload lists', () => {
    expect(() => loadRunnerConfig({ RUNNER_SHARED_KEY: key, RUNNER_POOL_SIZE: '0' })).toThrow(
      /RUNNER_POOL_SIZE/,
    );
    expect(() => loadRunnerConfig({ RUNNER_SHARED_KEY: key, RUNNER_PORT: 'http' })).toThrow(/RUNNER_PORT/);
    expect(parsePreload('none')).toEqual([]);
    expect(parsePreload('exchange, teams')).toEqual(['Exchange', 'Teams']);
    expect(() => parsePreload('Exchange,Intune')).toThrow(/Intune/);
  });

  it('uses PWSH_PATH when set', () => {
    expect(loadRunnerConfig({ RUNNER_SHARED_KEY: key, PWSH_PATH: '/opt/pwsh/pwsh' }).pwshPath).toBe(
      '/opt/pwsh/pwsh',
    );
  });

  it('starts workers with a fixed command line and an allowlisted environment', () => {
    const config = loadRunnerConfig({
      RUNNER_SHARED_KEY: key,
      PWSH_PATH: '/opt/pwsh/pwsh',
      RUNNER_PRELOAD_MODULES: 'Exchange',
    });
    const command = buildWorkerCommand(config, {
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      RUNNER_SHARED_KEY: key,
      AF_AUTOMATION_CLIENT_SECRET: 'secret-value',
      DATABASE_URL: 'postgres://user:pw@db/af',
    });
    expect(command.command).toBe('/opt/pwsh/pwsh');
    expect(command.args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-File', config.workerScript]);
    expect(Object.keys(command.env).sort()).toEqual(
      [
        'ADMINFORGE_RUNNER_MODULES_DIR',
        'ADMINFORGE_RUNNER_PRELOAD',
        'DOTNET_CLI_TELEMETRY_OPTOUT',
        'DOTNET_NOLOGO',
        'LANG',
        'PATH',
        'POWERSHELL_TELEMETRY_OPTOUT',
        'POWERSHELL_UPDATECHECK',
      ].sort(),
    );
    expect(command.env.ADMINFORGE_RUNNER_PRELOAD).toBe('Exchange');
    expect(JSON.stringify(command)).not.toContain(key);
  });
});
