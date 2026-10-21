import { ApiError, createArmClient, createGraphClient, createHttpClient } from '@adminforge/connectors';
import { fakeFetch, type Fake } from './fake-fetch';

// L2 (whole-branch security review): a playbook step marked `idempotent: false` (a write whose second send would hurt:
// signing an AVD user out of a session number the host may hand to someone else, a device wipe, a message) went out
// through a client that resends a DELETE or PUT after a 5xx, a network failure or a timeout. `sendOnce` sends such a
// request at most once whenever its outcome is unknown. A 429 is still waited out — Microsoft refused it before
// processing it — and reads (GET, HEAD, OPTIONS: ARM's long-running-operation polls, Graph pages) keep their retries.

const SESSION =
  '/subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg-example-avd/providers/Microsoft.DesktopVirtualization/hostPools/hp-example-pooled/sessionHosts/avd-ex-0001.example.com/userSessions/3';
const timeout = () => Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });

function arm(responses: Fake[], extra: Record<string, unknown> = {}) {
  const f = fakeFetch(responses);
  const sleep = vi.fn(async () => {});
  const client = createArmClient({
    getToken: async () => 'arm-tok',
    fetch: f.fetch,
    sleep,
    maxRetries: 3,
    pollIntervalMs: 1,
    ...extra,
  });
  return { f, sleep, client };
}
const logOff = { method: 'DELETE', path: SESSION, apiVersion: '2024-04-03', query: { force: true } };

describe('sendOnce: the AVD log-off DELETE (idempotent: false)', () => {
  it.each<[string, Fake]>([
    ['500', { status: 500, body: { error: { code: 'InternalServerError', message: 'boom' } } }],
    ['502', { status: 502 }],
    ['503 with Retry-After', { status: 503, headers: { 'retry-after': '1' } }],
    ['504', { status: 504 }],
    ['a network failure', new TypeError('fetch failed')],
    ['a timeout', timeout()],
  ])('is not sent again after %s', async (_what, first) => {
    const { f, client } = arm([first, { status: 200, body: {} }], { sendOnce: true });
    const err = await client.requestAndWait(logOff).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(f.calls).toHaveLength(1);
  });

  it('is sent again after a 429: Microsoft throttled it before processing it', async () => {
    const { f, sleep, client } = arm(
      [
        { status: 429, headers: { 'retry-after': '2' } },
        { status: 200, body: {} },
      ],
      { sendOnce: true },
    );
    expect((await client.requestAndWait(logOff)).status).toBe(200);
    expect(f.calls.map((c) => c.init.method)).toEqual(['DELETE', 'DELETE']);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying the long-running operation polls (GETs) after it was accepted', async () => {
    const { f, client } = arm(
      [
        { status: 202, headers: { location: 'https://management.azure.com/operations/op-1' } },
        { status: 500 },
        { status: 200, body: { done: true } },
      ],
      { sendOnce: true },
    );
    expect((await client.requestAndWait(logOff)).data).toEqual({ done: true });
    expect(f.calls.map((c) => c.init.method)).toEqual(['DELETE', 'GET', 'GET']);
  });

  it('without it a DELETE is resent after a 500, as before (safe to repeat by method)', async () => {
    const { f, client } = arm([{ status: 500 }, { status: 200, body: {} }]);
    expect((await client.requestAndWait(logOff)).status).toBe(200);
    expect(f.calls).toHaveLength(2);
  });
});

describe('sendOnce on the other clients', () => {
  it('a Graph PATCH or POST is not resent after a server error; a read still is', async () => {
    const f = fakeFetch([
      { status: 503, headers: { 'retry-after': '1' } },
      { status: 500 },
      { status: 200, body: {} },
    ]);
    const graph = createGraphClient({
      getToken: async () => 'tok',
      fetch: f.fetch,
      sleep: async () => {},
      maxRetries: 3,
      sendOnce: true,
    });
    await expect(graph.request({ method: 'PATCH', path: '/users/u', body: { a: 1 } })).rejects.toMatchObject({
      status: 503,
    });
    expect(f.calls).toHaveLength(1);
    expect((await graph.request({ path: '/users/u' })).status).toBe(200);
    expect(f.calls).toHaveLength(3);
  });

  it('overrides a request that says it is idempotent (a connection operation declared idempotent: true)', async () => {
    const f = fakeFetch([{ status: 500 }, { status: 200, body: {} }]);
    const http = createHttpClient({
      getToken: async () => 'tok',
      fetch: f.fetch,
      sleep: async () => {},
      sendOnce: true,
    });
    await expect(
      http.send({ method: 'POST', url: 'https://hr.example.com/sync', body: {}, idempotent: true }),
    ).rejects.toMatchObject({ status: 500 });
    expect(f.calls).toHaveLength(1);
  });

  it('a token failure before the send still propagates unchanged, with nothing sent', async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const refused = new Error('Write access needs to be re-armed.');
    const http = createHttpClient({
      getToken: async () => {
        throw refused;
      },
      fetch: f.fetch,
      sendOnce: true,
    });
    await expect(http.send({ method: 'DELETE', url: `https://management.azure.com${SESSION}` })).rejects.toBe(
      refused,
    );
    expect(f.calls).toHaveLength(0);
  });
});
