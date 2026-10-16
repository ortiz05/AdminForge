import { signRunnerRequest } from './client';

/**
 * The container HEALTHCHECK's probe (entry: healthcheck.ts, bundled as dist/healthcheck.js): a signed GET /healthz
 * against the runner on this machine. Healthy means the runner answers 200, which it does only to a request signed
 * with RUNNER_SHARED_KEY — so the probe also proves the key it was started with is the one the runner checks.
 *
 * Environment (the runner's own): RUNNER_SHARED_KEY, RUNNER_PORT (default 3101), RUNNER_HEALTHCHECK_HOST (default
 * 127.0.0.1). The answer's body is not read: the probe prints nothing and reports through its exit code only.
 * tests/unit/runner/healthcheck.test.ts covers it with a fake fetch.
 */

export const HEALTHCHECK_TIMEOUT_MS = 5000;

/** Where the probe goes and the key it signs with. */
export function healthcheckTarget(env: NodeJS.ProcessEnv): { url: string; key: string } {
  const port = env.RUNNER_PORT || '3101';
  const host = env.RUNNER_HEALTHCHECK_HOST || '127.0.0.1';
  return { url: `http://${host}:${port}/healthz`, key: env.RUNNER_SHARED_KEY ?? '' };
}

/**
 * Exit code for the HEALTHCHECK: 0 when the runner answers 200, else 1 — including a missing or short key, a refused
 * connection and a timeout.
 */
export async function probeRunnerHealth(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = HEALTHCHECK_TIMEOUT_MS,
): Promise<0 | 1> {
  const { url, key } = healthcheckTarget(env);
  try {
    const res = await fetchImpl(url, {
      headers: signRunnerRequest({ key, method: 'GET', path: '/healthz' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status === 200 ? 0 : 1;
  } catch {
    return 1;
  }
}
