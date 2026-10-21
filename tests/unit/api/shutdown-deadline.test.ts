import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@adminforge/api/src/config';
import { onShutdownSignal } from '@adminforge/api/src/shutdown';
import { repoRoot } from '../../lib/repo';

// D-24: the API's shutdown has a deadline of its own, shorter than the pod's terminationGracePeriodSeconds, so a stop
// that hangs ends with a log line naming what was still open and exit code 1 — not a silent SIGKILL. A second signal
// exits at once.
function harness(close: () => Promise<void>) {
  const lines: Array<{ level: 'info' | 'error'; obj: Record<string, unknown>; msg: string }> = [];
  const exits: number[] = [];
  const onSignal = onShutdownSignal({
    close,
    deadlineMs: 50_000,
    log: {
      info: (obj, msg) => void lines.push({ level: 'info', obj: obj as Record<string, unknown>, msg }),
      error: (obj, msg) => void lines.push({ level: 'error', obj: obj as Record<string, unknown>, msg }),
    },
    pending: () => ({ runs: ['00000000-0000-4000-8000-0000000000r1'] }),
    exit: (code) => void exits.push(code),
  });
  return { onSignal, lines, exits };
}

describe('API shutdown deadline (D-24)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('exits 0 once the app has closed, before the deadline', async () => {
    const h = harness(async () => undefined);
    h.onSignal('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.exits).toEqual([0]);
    expect(h.lines.map((l) => [l.level, l.msg])).toEqual([['info', 'shutting down']]);
    expect(h.lines[0]!.obj).toMatchObject({ signal: 'SIGTERM', deadlineMs: 50_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.exits).toEqual([0]); // the deadline timer was cleared
  });

  it('a close that hangs past the deadline logs what is still open and exits 1', async () => {
    const h = harness(() => new Promise<void>(() => undefined));
    h.onSignal('SIGTERM');
    await vi.advanceTimersByTimeAsync(49_999);
    expect(h.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.exits).toEqual([1]);
    const line = h.lines.find((l) => l.level === 'error')!;
    expect(line.msg).toBe('shutdown did not finish in time; exiting');
    expect(line.obj).toMatchObject({
      deadlineMs: 50_000,
      open: { runs: ['00000000-0000-4000-8000-0000000000r1'], resources: expect.any(Object) },
    });
  });

  it('a close that fails exits 1 with the reason logged', async () => {
    const h = harness(async () => {
      throw new Error('database is locked');
    });
    h.onSignal('SIGINT');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.exits).toEqual([1]);
    expect(h.lines.at(-1)).toMatchObject({
      level: 'error',
      msg: 'shutdown failed',
      obj: { err: { message: 'database is locked' } },
    });
  });

  it('a second signal exits at once', async () => {
    const h = harness(() => new Promise<void>(() => undefined));
    h.onSignal('SIGINT');
    h.onSignal('SIGINT');
    expect(h.exits).toEqual([1]);
    expect(h.lines.at(-1)).toMatchObject({ level: 'error', msg: 'second signal; exiting now' });
  });

  it('the default deadline (SHUTDOWN_TIMEOUT_SECONDS) ends before the pod is killed', () => {
    const base = {
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      AUTH_MODE: 'mock',
      DATA_MODE: 'fixtures',
    };
    const config = loadConfig(base);
    expect(config.SHUTDOWN_TIMEOUT_SECONDS).toBe(50);
    const deployment = readFileSync(
      path.join(repoRoot, 'portal/deploy/kubernetes/base/deployment.yaml'),
      'utf8',
    );
    const grace = Number(/terminationGracePeriodSeconds:\s*(\d+)/.exec(deployment)?.[1]);
    expect(grace).toBeGreaterThan(0);
    // Room for the log line and the exit before SIGKILL.
    expect(config.SHUTDOWN_TIMEOUT_SECONDS).toBeLessThanOrEqual(grace - 5);
    expect(() => loadConfig({ ...base, SHUTDOWN_TIMEOUT_SECONDS: '2' })).toThrow(/SHUTDOWN_TIMEOUT_SECONDS/);
  });
});
