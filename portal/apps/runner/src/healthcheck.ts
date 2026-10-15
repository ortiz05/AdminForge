import { signRunnerRequest } from './client';

// Container HEALTHCHECK: a signed GET /healthz against the local runner. Exit 0 when it answers 200.
const key = process.env.RUNNER_SHARED_KEY ?? '';
const port = process.env.RUNNER_PORT || '3101';
const host = process.env.RUNNER_HEALTHCHECK_HOST || '127.0.0.1';

try {
  const res = await fetch(`http://${host}:${port}/healthz`, {
    headers: signRunnerRequest({ key, method: 'GET', path: '/healthz' }),
    signal: AbortSignal.timeout(5000),
  });
  process.exit(res.status === 200 ? 0 : 1);
} catch {
  process.exit(1);
}
