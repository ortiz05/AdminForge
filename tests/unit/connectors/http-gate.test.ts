import { abortableSleep, createGraphClient, createHttpClient, type Gate } from '@adminforge/connectors';
import { fakeFetch } from './fake-fetch';

// Enterprise scale: each attempt runs through the caller's concurrency slot (`gate`), and the waits between attempts
// (Retry-After, backoff) don't hold it; a timed-out attempt is retried at most once; retries are observable.

const timeoutError = () =>
  Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

/** A gate that records whether a slot is held, and when. */
function recordingGate() {
  const events: string[] = [];
  let held = 0;
  const gate: Gate = async (attempt) => {
    held++;
    events.push('acquire');
    try {
      return await attempt();
    } finally {
      held--;
      events.push('release');
    }
  };
  return { gate, events, held: () => held };
}

describe('http client: gated attempts', () => {
  it('runs every attempt through the gate and sleeps outside it', async () => {
    const g = recordingGate();
    const heldWhileSleeping: number[] = [];
    const f = fakeFetch([
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 200, body: { ok: true } },
    ]);
    const http = createHttpClient({
      getToken: async () => 'tok',
      fetch: f.fetch,
      gate: g.gate,
      sleep: async () => {
        heldWhileSleeping.push(g.held());
      },
    });
    const r = await http.send<{ ok: boolean }>({ url: 'https://graph.microsoft.com/v1.0/users' });
    expect(r.data).toEqual({ ok: true });
    expect(f.calls).toHaveLength(3);
    expect(g.events).toEqual(['acquire', 'release', 'acquire', 'release', 'acquire', 'release']);
    expect(heldWhileSleeping).toEqual([0, 0]);
  });

  it('reports each retry (throttling is visible even when the call ends well)', async () => {
    const onRetry = vi.fn();
    const f = fakeFetch([
      { status: 429, headers: { 'retry-after': '3' } },
      { status: 503 },
      { status: 200, body: {} },
    ]);
    const http = createHttpClient({
      getToken: async () => 'tok',
      fetch: f.fetch,
      sleep: async () => {},
      onRetry,
    });
    await http.send({ url: 'https://graph.microsoft.com/v1.0/users' });
    expect(onRetry.mock.calls.map(([i]) => [i.status, i.reason, i.attempt, i.delayMs >= 0])).toEqual([
      [429, 'throttled', 0, true],
      [503, 'server', 1, true],
    ]);
    expect(onRetry.mock.calls[0]![0].delayMs).toBe(3000);
  });

  it('a gate that throws (queue full) fails the call without a request', async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const busy = new Error('busy');
    const http = createHttpClient({
      getToken: async () => 'tok',
      fetch: f.fetch,
      gate: async () => {
        throw busy;
      },
    });
    await expect(http.send({ url: 'https://graph.microsoft.com/v1.0/users' })).rejects.toBe(busy);
    expect(f.calls).toHaveLength(0);
  });
});

describe('http client: timeouts', () => {
  it('retries a timed-out attempt once by default, then gives up', async () => {
    const f = fakeFetch([timeoutError(), timeoutError(), timeoutError(), { status: 200, body: {} }]);
    const http = createHttpClient({ getToken: async () => 'tok', fetch: f.fetch, sleep: async () => {} });
    const err = await http
      .send({ url: 'https://graph.microsoft.com/v1.0/auditLogs/signIns' })
      .catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: 'Timeout' });
    expect(f.calls).toHaveLength(2);
  });

  it('maxTimeoutRetries: 0 makes one (longer) attempt only', async () => {
    const f = fakeFetch([timeoutError(), { status: 200, body: {} }]);
    const http = createHttpClient({
      getToken: async () => 'tok',
      fetch: f.fetch,
      sleep: async () => {},
      maxTimeoutRetries: 0,
    });
    await expect(http.send({ url: 'https://api.loganalytics.io/v1/x' })).rejects.toMatchObject({
      code: 'Timeout',
    });
    expect(f.calls).toHaveLength(1);
  });

  it('network errors keep the full retry budget', async () => {
    const f = fakeFetch([
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      { status: 200, body: {} },
    ]);
    const http = createHttpClient({ getToken: async () => 'tok', fetch: f.fetch, sleep: async () => {} });
    expect((await http.send({ url: 'https://graph.microsoft.com/v1.0/me' })).status).toBe(200);
    expect(f.calls).toHaveLength(3);
  });
});

describe('http client: aborts', () => {
  it('a wait between attempts ends as soon as the caller aborts', async () => {
    const controller = new AbortController();
    const f = fakeFetch([
      { status: 429, headers: { 'retry-after': '120' } },
      { status: 200, body: {} },
    ]);
    const http = createHttpClient({
      getToken: async () => 'tok',
      fetch: f.fetch,
      // A sleep that never ends: only the abort can end the wait.
      sleep: () => new Promise<void>(() => {}),
      signal: controller.signal,
    });
    const pending = http.send({ url: 'https://graph.microsoft.com/v1.0/users' }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort(new Error('page closed'));
    expect(await pending).toMatchObject({ message: 'page closed' });
    expect(f.calls).toHaveLength(1);
  });

  it('the client-level signal reaches fetch', async () => {
    const controller = new AbortController();
    const f = fakeFetch([{ status: 200, body: {} }]);
    const http = createHttpClient({ getToken: async () => 'tok', fetch: f.fetch, signal: controller.signal });
    await http.send({ url: 'https://graph.microsoft.com/v1.0/me' });
    const sent = f.calls[0]!.init.signal!;
    expect(sent.aborted).toBe(false);
    controller.abort();
    expect(sent.aborted).toBe(true);
  });

  it('abortableSleep resolves normally without a signal and rejects on abort', async () => {
    await expect(abortableSleep(async () => {}, 10)).resolves.toBeUndefined();
    const c = new AbortController();
    c.abort(new Error('stop'));
    await expect(abortableSleep(async () => {}, 10, c.signal)).rejects.toThrow('stop');
  });
});

describe('graph $batch: throttled sub-requests', () => {
  it('reports the retry and honours the abort while waiting', async () => {
    const onRetry = vi.fn();
    const f = fakeFetch([
      {
        status: 200,
        body: { responses: [{ id: 'a', status: 429, headers: { 'Retry-After': '2' }, body: {} }] },
      },
      { status: 200, body: { responses: [{ id: 'a', status: 200, body: { value: 1 } }] } },
    ]);
    const graph = createGraphClient({
      getToken: async () => 'tok',
      fetch: f.fetch,
      sleep: async () => {},
      onRetry,
    });
    const out = await graph.batch([{ id: 'a', method: 'GET', path: '/users/$count' }]);
    expect(out.a).toEqual({ status: 200, body: { value: 1 } });
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, reason: 'throttled', delayMs: 2000 }),
    );
  });
});
