import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { verifyRunnerRequest } from '@adminforge/runner/src/auth';
import {
  canonicalRunnerString,
  computeRunnerSignature,
  decodeRunnerKey,
  requestTarget,
  signRunnerRequest,
} from '@adminforge/runner/src/client';
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
  // The request-mac key: HKDF-SHA256(RUNNER_SHARED_KEY, salt "adminforge-runner", info "adminforge-runner/v1 request-mac").
  const requestKey = Buffer.from(
    hkdfSync('sha256', keyBytes, Buffer.from('adminforge-runner'), 'adminforge-runner/v1 request-mac', 32),
  );
  const hmac = (canonical: string) => createHmac('sha256', requestKey).update(canonical).digest('hex');
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const emptyHash = createHash('sha256').update('').digest('hex');

  it('signs HMAC-SHA256(request-mac key, `${ts}.${METHOD}.${pathAndQuery}.${sha256hex(body)}`) as hex', () => {
    const canonical = `${now}.POST./v1/jobs.${bodyHash}`;
    expect(canonicalRunnerString({ timestamp: now, method: 'post', path: '/v1/jobs', body })).toBe(canonical);
    expect(computeRunnerSignature({ key, timestamp: now, method: 'POST', path: '/v1/jobs', body })).toBe(
      hmac(canonical),
    );
    expect(signRunnerRequest({ key, method: 'POST', path: '/v1/jobs', body, timestamp: now })).toEqual({
      authorization: `AdminForge-HMAC ${hmac(canonical)}`,
      'x-adminforge-timestamp': String(now),
    });
  });

  it('signs an empty body and keeps the query string as sent', () => {
    expect(
      signRunnerRequest({ key, method: 'GET', path: '/healthz?verbose=1', timestamp: now }).authorization,
    ).toBe(`AdminForge-HMAC ${hmac(`${now}.GET./healthz?verbose=1.${emptyHash}`)}`);
  });

  it('refuses to sign a full URL or a strange method', () => {
    expect(() => signRunnerRequest({ key, method: 'GET', path: 'http://127.0.0.1:3101/healthz' })).toThrow(
      /starting with "\/"/,
    );
    expect(() => signRunnerRequest({ key, method: 'GE T', path: '/healthz' })).toThrow(/Invalid HTTP method/);
  });

  it('takes path and query exactly as fetch sends them', () => {
    expect(
      requestTarget(new URL(`/v1/jobs/${encodeURIComponent('run-1:step 2')}/cancel?x=1`, 'http://h')),
    ).toBe('/v1/jobs/run-1%3Astep%202/cancel?x=1');
  });

  it('never uses RUNNER_SHARED_KEY itself as the HMAC key', () => {
    const canonical = `${now}.POST./v1/jobs.${bodyHash}`;
    const raw = createHmac('sha256', keyBytes).update(canonical).digest('hex');
    expect(computeRunnerSignature({ key, timestamp: now, method: 'POST', path: '/v1/jobs', body })).not.toBe(
      raw,
    );
    expect(
      verifyRunnerRequest({
        key: keyBytes,
        authorization: `AdminForge-HMAC ${raw}`,
        timestamp: String(now),
        method: 'POST',
        path: '/v1/jobs',
        body: Buffer.from(body),
        nowSeconds: now,
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects keys shorter than 32 bytes', () => {
    expect(() => decodeRunnerKey(Buffer.alloc(16).toString('base64'))).toThrow(/at least 32 bytes/);
  });

  const verify = (overrides: Partial<Parameters<typeof verifyRunnerRequest>[0]> = {}) => {
    const headers = signRunnerRequest({ key, method: 'POST', path: '/v1/jobs', body, timestamp: now });
    return verifyRunnerRequest({
      key: keyBytes,
      authorization: headers.authorization,
      timestamp: headers['x-adminforge-timestamp'],
      method: 'POST',
      path: '/v1/jobs',
      body: Buffer.from(body),
      nowSeconds: now,
      ...overrides,
    });
  };
  const bad = { ok: false, reason: 'bad_signature' };

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
    expect(verify({ body: Buffer.from(body.replace('"x":1', '"x":2')) })).toEqual(bad);
    expect(verify({ key: decodeRunnerKey(newKey()) })).toEqual(bad);
    expect(verify({ timestamp: String(now + 1) })).toEqual(bad);
  });

  it('rejects the signature on another method, path or query', () => {
    expect(verify({ method: 'PUT' })).toEqual(bad);
    expect(verify({ path: '/v1/jobs/' })).toEqual(bad);
    expect(verify({ path: '/v1/jobs?x=1' })).toEqual(bad);
    expect(verify({ path: '/v1/Jobs' })).toEqual(bad);
    expect(verify({ path: 'v1/jobs' })).toEqual(bad);
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

  /** Sends a request whose headers were signed for a (possibly different) method + path. */
  const replay = (
    signed: { method: 'GET' | 'POST'; path: string },
    sent: { method: 'GET' | 'POST'; url: string },
  ) => app.inject({ method: sent.method, url: sent.url, headers: signRunnerRequest({ key, ...signed }) });

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

  it('accepts a cancel signature on its own path (past auth: 404 for an unknown job)', async () => {
    const res = await replay(
      { method: 'POST', path: '/v1/jobs/x/cancel' },
      { method: 'POST', url: '/v1/jobs/x/cancel' },
    );
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'job_not_found' });
  });

  it('rejects a signature for POST /v1/jobs/x/cancel on POST /v1/jobs/y/cancel', async () => {
    const res = await replay(
      { method: 'POST', path: '/v1/jobs/x/cancel' },
      { method: 'POST', url: '/v1/jobs/y/cancel' },
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Signature does not match');
  });

  it('rejects a signature for POST /v1/jobs/x/cancel on GET /healthz', async () => {
    const res = await replay(
      { method: 'POST', path: '/v1/jobs/x/cancel' },
      { method: 'GET', url: '/healthz' },
    );
    expect(res.statusCode).toBe(401);
  });

  it('rejects a signature for GET /healthz on POST /healthz-shaped or query-modified requests', async () => {
    expect(
      (await replay({ method: 'GET', path: '/healthz' }, { method: 'GET', url: '/healthz?x=1' })).statusCode,
    ).toBe(401);
    expect(
      (await replay({ method: 'GET', path: '/healthz?x=1' }, { method: 'GET', url: '/healthz?x=1' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await replay({ method: 'POST', path: '/healthz' }, { method: 'GET', url: '/healthz' })).statusCode,
    ).toBe(401);
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
    const headers = signRunnerRequest({ key, method: 'POST', path: '/v1/jobs', body: payload });
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
    expect(command.args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-SettingsFile',
      config.workerScript.replace(/worker\.ps1$/, 'powershell.config.json'),
      '-File',
      config.workerScript,
    ]);
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
