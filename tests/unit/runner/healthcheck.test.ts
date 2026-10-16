import { decodeRunnerKey } from '@adminforge/runner/src/client';
import { verifyRunnerRequest } from '@adminforge/runner/src/auth';
import { healthcheckTarget, probeRunnerHealth } from '@adminforge/runner/src/health-probe';
import { newKey } from './helpers';

// The container HEALTHCHECK (dist/healthcheck.js → health-probe.ts) against a fake fetch: where it goes, that the
// runner would accept its signature, and the exit code for every outcome.

interface Call {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | null | undefined;
}

function fakeFetch(answer: number | Error) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      signal: init?.signal,
    });
    if (answer instanceof Error) throw answer;
    return new Response(null, { status: answer });
  }) as typeof fetch;
  return { impl, calls };
}

describe('runner healthcheck', () => {
  it('probes loopback on the runner port by default', () => {
    expect(healthcheckTarget({})).toEqual({ url: 'http://127.0.0.1:3101/healthz', key: '' });
    expect(
      healthcheckTarget({
        RUNNER_PORT: '4101',
        RUNNER_HEALTHCHECK_HOST: 'runner.internal',
        RUNNER_SHARED_KEY: 'k',
      }),
    ).toEqual({ url: 'http://runner.internal:4101/healthz', key: 'k' });
    expect(healthcheckTarget({ RUNNER_PORT: '', RUNNER_HEALTHCHECK_HOST: '' }).url).toBe(
      'http://127.0.0.1:3101/healthz',
    );
  });

  it('sends a GET /healthz the runner accepts, with a timeout', async () => {
    const key = newKey();
    const f = fakeFetch(200);
    expect(await probeRunnerHealth({ RUNNER_SHARED_KEY: key }, f.impl)).toBe(0);
    const [call] = f.calls;
    expect(call?.url).toBe('http://127.0.0.1:3101/healthz');
    expect(call?.signal).toBeInstanceOf(AbortSignal);
    const verdict = verifyRunnerRequest({
      key: decodeRunnerKey(key),
      authorization: call?.headers.authorization,
      timestamp: call?.headers['x-adminforge-timestamp'],
      method: 'GET',
      path: '/healthz',
      body: Buffer.alloc(0),
    });
    expect(verdict).toEqual({ ok: true });
  });

  it.each([401, 503, 500])('is unhealthy when the runner answers %i', async (status) => {
    expect(await probeRunnerHealth({ RUNNER_SHARED_KEY: newKey() }, fakeFetch(status).impl)).toBe(1);
  });

  it('is unhealthy when the runner cannot be reached or does not answer in time', async () => {
    const refused = fakeFetch(new TypeError('fetch failed'));
    expect(await probeRunnerHealth({ RUNNER_SHARED_KEY: newKey() }, refused.impl)).toBe(1);
    const timeout = fakeFetch(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(await probeRunnerHealth({ RUNNER_SHARED_KEY: newKey() }, timeout.impl)).toBe(1);
  });

  it('is unhealthy without a usable key, and then sends nothing', async () => {
    for (const env of [{}, { RUNNER_SHARED_KEY: 'too-short' }]) {
      const f = fakeFetch(200);
      expect(await probeRunnerHealth(env, f.impl)).toBe(1);
      expect(f.calls).toEqual([]);
    }
  });

  it('gives up after the timeout', async () => {
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    expect(await probeRunnerHealth({ RUNNER_SHARED_KEY: newKey() }, hanging, 20)).toBe(1);
  });
});
