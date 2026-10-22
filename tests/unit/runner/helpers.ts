import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { decodeRunnerKey, prepareRunnerJob, signRunnerRequest } from '@adminforge/runner/src/client';
import type { RunnerConfig, WorkerCommand } from '@adminforge/runner/src/config';
import { RunnerEventVerifier } from '@adminforge/runner/src/crypto';
import { type RunnerEvent, type RunnerJobInput, RunnerEventSchema } from '@adminforge/runner/src/protocol';
import type { buildRunnerServer } from '@adminforge/runner/src/server';

type FastifyInstance = Awaited<ReturnType<typeof buildRunnerServer>>;

export const FAKE_WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-worker.mjs',
);
export const TENANT = { id: '0f3a4c2e-8b1d-4e6f-9a7c-2d5b8e1f4a63', domain: 'example.onmicrosoft.com' };

export function newKey(): string {
  return randomBytes(32).toString('base64');
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A syntactically valid, unsigned JWT with synthetic claims. */
export function fakeJwt(upn = 'engineer@example.com'): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ upn, aud: 'test', exp, nonce: randomUUID() })}.${randomBytes(24).toString('base64url')}`;
}

export function fakeWorkerCommand(env: Record<string, string> = {}): WorkerCommand {
  return {
    command: process.execPath,
    args: [FAKE_WORKER],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
  };
}

/** A throw-away scripts directory with one script; returns its path and sha256. */
export function makeScriptsDir(content = "Write-AdminForgeOutput -Data 'hello'\n"): {
  dir: string;
  script: string;
  sha: string;
  cleanup(): void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'af-scripts-'));
  mkdirSync(path.join(dir, 'diagnostics'));
  writeFileSync(path.join(dir, 'diagnostics', 'Test.ps1'), content);
  return {
    dir,
    script: 'diagnostics/Test.ps1',
    sha: sha256(content),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function testConfig(key: string, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    sharedKey: decodeRunnerKey(key),
    poolSize: 1,
    maxJobs: 2,
    scriptsDir: tmpdir(),
    modulesDir: path.join(tmpdir(), 'af-no-modules'),
    workerScript: '/nonexistent/worker.ps1',
    pwshPath: 'pwsh',
    preload: [],
    queueTimeoutMs: 5000,
    maxWaiting: 64,
    ...overrides,
  };
}

export function job(overrides: Partial<RunnerJobInput> & Pick<RunnerJobInput, 'script'>): RunnerJobInput {
  return {
    jobId: `job-${randomUUID()}`,
    mode: 'read',
    tenant: TENANT,
    inputs: {},
    timeoutSeconds: 30,
    ...overrides,
  };
}

export async function signedInject(
  app: FastifyInstance,
  key: string,
  opts: { method: 'GET' | 'POST'; url: string; body?: unknown; timestamp?: number },
) {
  const payload = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    ...signRunnerRequest({
      key,
      method: opts.method,
      path: opts.url,
      body: payload,
      timestamp: opts.timestamp,
    }),
  };
  if (payload) headers['content-type'] = 'application/json';
  return app.inject({ method: opts.method, url: opts.url, payload: payload || undefined, headers });
}

/**
 * POSTs a job the way the API does (tokens sealed for this job and timestamp, a fresh nonce, signed) and returns
 * the response with its events verified against the nonce.
 */
export async function injectJob(app: FastifyInstance, key: string, body: RunnerJobInput, timestamp?: number) {
  const prepared = prepareRunnerJob({ key, job: body, timestamp });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/jobs',
    payload: prepared.body,
    headers: prepared.headers,
  });
  return {
    res,
    nonce: prepared.nonce,
    body: prepared.body,
    events: () => verifiedEvents(res.body, key, prepared.jobId, prepared.nonce),
  };
}

/** Parses an NDJSON answer and verifies every event's signature and order (throws RunnerResponseError). */
export function verifiedEvents(text: string, key: string, jobId: string, nonce: string): RunnerEvent[] {
  const verifier = new RunnerEventVerifier(key, jobId, nonce);
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => RunnerEventSchema.parse(verifier.accept(JSON.parse(l))) as RunnerEvent);
}

/** Parses an NDJSON answer without verifying it (seq and mac are dropped). */
export function parseEvents(text: string): RunnerEvent[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => RunnerEventSchema.parse(JSON.parse(l)) as RunnerEvent);
}

/** Captures pino output so tests can assert on what the supervisor logs. */
export function logCapture(): { stream: Writable; text(): string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
