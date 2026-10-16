import type { ApiCall } from '../../live/lib/portal-session';
import {
  isSettled,
  previewThenRun,
  settle,
  stepOutput,
  waitForRun,
  type RunClient,
  type RunDetail,
} from '../../live/lib/runs';

// Playbook runs for the live suite and scripts (tests/live/lib/runs.ts): preview → run → poll, one "settled" rule.

type Reply = { status: number; json: unknown };

/** A fake portal API: POST /api/runs answers from `creates`, GET /api/runs/:id from `reads[id]` (last one repeats). */
function fakeApi(creates: Reply[], reads: Record<string, Reply[]>) {
  const posts: Array<Record<string, unknown>> = [];
  const gets: string[] = [];
  const api: ApiCall = async <T>(method: string, url: string, body?: unknown) => {
    if (method === 'POST' && url === '/api/runs') {
      posts.push(body as Record<string, unknown>);
      return (creates.shift() ?? { status: 500, json: undefined }) as { status: number; json: T };
    }
    const id = decodeURIComponent(url.replace('/api/runs/', ''));
    gets.push(id);
    const list = reads[id] ?? [{ status: 404, json: { error: { code: 'run_not_found' } } }];
    return (list.length > 1 ? list.shift()! : list[0]!) as { status: number; json: T };
  };
  const sleeps: number[] = [];
  const client: RunClient = { api, sleep: async (ms) => void sleeps.push(ms) };
  return { client, posts, gets, sleeps };
}

const detail = (status: string, extra: Partial<RunDetail> = {}): Reply => ({
  status: 200,
  json: { run: { status }, steps: [], ...extra },
});

describe('isSettled', () => {
  it('is true for finished and parked runs, false while queued or running', () => {
    expect(['succeeded', 'failed', 'cancelled', 'compensated', 'needs_review'].every(isSettled)).toBe(true);
    expect(['awaiting_approval', 'awaiting_input', 'awaiting_arm', 'awaiting_reauth'].every(isSettled)).toBe(
      true,
    );
    expect(['queued', 'running', 'something-new'].some(isSettled)).toBe(false);
  });
});

describe('waitForRun', () => {
  it('polls until the run settles', async () => {
    const f = fakeApi([], { r1: [detail('queued'), detail('running'), detail('awaiting_arm')] });
    expect((await waitForRun(f.client, 'r1')).run.status).toBe('awaiting_arm');
    expect(f.gets).toEqual(['r1', 'r1', 'r1']);
    expect(f.sleeps).toEqual([2000, 2000]);
  });

  it('gives up with `timeout`, and reports a refused read as `http <status>`', async () => {
    const f = fakeApi([], { r1: [detail('running')] });
    expect((await waitForRun(f.client, 'r1', { polls: 3, intervalMs: 5 })).run.status).toBe('timeout');
    expect(f.sleeps).toEqual([5, 5, 5]);
    expect(await waitForRun(f.client, 'gone')).toEqual({
      run: { status: 'http 404', error: { code: 'run_not_found' } },
      steps: [],
    });
  });
});

describe('settle', () => {
  it('says why a run was not created', async () => {
    const f = fakeApi([], {});
    expect(await settle(f.client, { http: 409, error: { code: 'preview_required' } })).toEqual({
      run: { status: 'not created (http 409)', error: { code: 'preview_required' } },
      steps: [],
    });
  });
});

describe('previewThenRun', () => {
  const inputs = { userId: 'u1', reason: 'live validation' };

  it('previews, then runs with the preview id and the confirmation read from the preview', async () => {
    const preview = detail('succeeded', {
      steps: [
        { stepId: 'lookup', status: 'failed' },
        { stepId: 'lookup', status: 'succeeded', output: { userPrincipalName: 'old@example.com' } },
        { stepId: 'lookup', status: 'succeeded', output: { userPrincipalName: 'af-test@example.com' } },
      ],
    });
    const f = fakeApi(
      [
        { status: 202, json: { runId: 'p1' } },
        { status: 202, json: { runId: 'r1' } },
      ],
      { p1: [preview] },
    );
    const r = await previewThenRun(f.client, 'identity.disable-user', inputs, {
      confirm: (p) => stepOutput(p, 'lookup')?.userPrincipalName as string,
    });
    expect(r.run).toEqual({ http: 202, runId: 'r1' });
    expect(f.posts).toEqual([
      { playbook: 'identity.disable-user', inputs, dryRun: true },
      {
        playbook: 'identity.disable-user',
        inputs,
        dryRun: false,
        previewRunId: 'p1',
        confirmation: 'af-test@example.com',
      },
    ]);
  });

  it('retries a failed preview (replication lag), then runs', async () => {
    const f = fakeApi(
      [
        { status: 202, json: { runId: 'p1' } },
        { status: 202, json: { runId: 'p2' } },
        { status: 202, json: { runId: 'r1' } },
      ],
      { p1: [detail('failed')], p2: [detail('succeeded')] },
    );
    const retried: number[] = [];
    const r = await previewThenRun(f.client, 'identity.enable-user', inputs, {
      onRetry: (attempt) => retried.push(attempt),
    });
    expect(retried).toEqual([1]);
    expect(f.sleeps).toContain(10_000);
    expect(r.run?.runId).toBe('r1');
    expect(f.posts.at(-1)).toEqual({
      playbook: 'identity.enable-user',
      inputs,
      dryRun: false,
      previewRunId: 'p2',
    });
  });

  it('never creates the real run without a succeeded preview', async () => {
    const failing = fakeApi(
      [1, 2, 3].map((n) => ({ status: 202, json: { runId: `p${n}` } })),
      { p1: [detail('failed')], p2: [detail('failed')], p3: [detail('failed')] },
    );
    const r = await previewThenRun(failing.client, 'x.y', inputs, { previewAttempts: 3, retryDelayMs: 1 });
    expect(r).toEqual({ preview: { run: { status: 'failed' }, steps: [] } });
    expect(failing.posts.every((p) => p.dryRun === true)).toBe(true);

    // A preview the API refuses is not retried: the same request would be refused again.
    const refused = fakeApi(
      [{ status: 400, json: { error: { code: 'invalid_inputs', message: 'bad' } } }],
      {},
    );
    const r2 = await previewThenRun(refused.client, 'x.y', inputs);
    expect(r2.run).toBeUndefined();
    expect(r2.preview.run).toEqual({
      status: 'not created (http 400)',
      error: { code: 'invalid_inputs', message: 'bad' },
    });
    expect(refused.posts).toHaveLength(1);
  });
});
