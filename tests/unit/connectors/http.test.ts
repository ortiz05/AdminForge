import { ApiError, createHttpClient, isTransient, retryDelay } from '@adminforge/connectors';
import { fakeFetch, type Fake } from './fake-fetch';

const client = (responses: Fake[], extra = {}) => {
  const f = fakeFetch(responses);
  const sleep = vi.fn(async () => {});
  return {
    f,
    sleep,
    http: createHttpClient({ getToken: async () => 'tok', fetch: f.fetch, sleep, maxRetries: 2, ...extra }),
  };
};

describe('retryDelay', () => {
  it('uses Retry-After seconds, capped at 120 s', () => {
    expect(retryDelay('2', 0)).toBe(2000);
    expect(retryDelay('600', 0)).toBe(120_000);
  });
  it('understands Retry-After as an HTTP date', () => {
    const at = new Date(Date.now() + 10_000).toUTCString();
    expect(retryDelay(at, 0)).toBeGreaterThan(8000);
    expect(retryDelay(at, 0)).toBeLessThanOrEqual(10_000);
  });
  it('falls back to exponential backoff with jitter', () => {
    expect(retryDelay(null, 0)).toBeGreaterThanOrEqual(1000);
    expect(retryDelay(null, 3)).toBeGreaterThanOrEqual(8000);
    expect(retryDelay(null, 20)).toBeLessThan(30_250);
  });
});

describe('http client', () => {
  it('turns network failures into ApiError after retrying idempotent requests', async () => {
    const { http, f } = client([
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
    ]);
    const err = await http.send({ url: 'https://graph.microsoft.com/v1.0/me' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'NetworkError' });
    expect(err.message).toMatch(/graph\.microsoft\.com/);
    expect(f.calls).toHaveLength(3);
    expect(isTransient(err)).toBe(true);
  });
  it('does not retry non-idempotent requests after a network failure', async () => {
    const { http, f } = client([new TypeError('socket hang up'), { status: 200, body: {} }]);
    await expect(http.send({ method: 'POST', url: 'https://x.example/a', body: {} })).rejects.toMatchObject({
      code: 'NetworkError',
    });
    expect(f.calls).toHaveLength(1);
  });
  it('reports timeouts', async () => {
    const timeout = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    const { http } = client([timeout], { maxRetries: 0 });
    await expect(http.send({ url: 'https://x.example/a' })).rejects.toMatchObject({
      status: 0,
      code: 'Timeout',
    });
  });
  it('retries 503 with Retry-After even for writes (the request was not processed)', async () => {
    const { http, sleep } = client([{ status: 503, headers: { 'retry-after': '1' } }, { status: 204 }]);
    await expect(http.send({ method: 'POST', url: 'https://x.example/a', body: {} })).resolves.toMatchObject({
      status: 204,
    });
    expect(sleep).toHaveBeenCalledWith(1000);
  });
  it('keeps text when a JSON content type carries invalid JSON', async () => {
    const { http } = client(
      [{ status: 502, body: 'not json', headers: { 'content-type': 'application/json' } }],
      { maxRetries: 0 },
    );
    await expect(http.send({ url: 'https://x.example/a' })).rejects.toMatchObject({
      status: 502,
      code: 'HTTP502',
    });
  });
  it('uses OData-style and plain error bodies', async () => {
    const { http } = client([{ status: 400, body: { error: 'invalid_request', message: 'Bad thing' } }]);
    await expect(http.send({ url: 'https://x.example/a' })).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Bad thing',
    });
  });
  it('lets the caller mark a POST idempotent', async () => {
    const { http, f } = client([{ status: 500 }, { status: 200, body: { ok: true } }]);
    await expect(
      http.send({ method: 'POST', url: 'https://x.example/q', body: {}, idempotent: true }),
    ).resolves.toMatchObject({ data: { ok: true } });
    expect(f.calls).toHaveLength(2);
  });
  it('propagates token-provider failures unchanged, without fetching or retrying', async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const sleep = vi.fn(async () => {});
    const tokenError = Object.assign(new Error('Sign in again to continue.'), { code: 'ReauthRequired' });
    const http = createHttpClient({
      getToken: async () => Promise.reject(tokenError),
      fetch: f.fetch,
      sleep,
      maxRetries: 4,
    });
    const err = await http.send({ url: 'https://graph.microsoft.com/v1.0/me' }).catch((e) => e);
    expect(err).toBe(tokenError);
    expect(f.fn).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
  it('does not retry or wrap non-network errors thrown by fetch', async () => {
    const boom = new RangeError('bad header value');
    const { http, f, sleep } = client([boom, { status: 200, body: {} }]);
    expect(await http.send({ url: 'https://x.example/a' }).catch((e) => e)).toBe(boom);
    expect(f.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it('does not retry when the caller aborts during a request', async () => {
    const controller = new AbortController();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetch = vi.fn(async () => {
      controller.abort();
      throw abort;
    });
    const http = createHttpClient({
      getToken: async () => 'tok',
      fetch,
      sleep: async () => {},
      maxRetries: 2,
    });
    expect(await http.send({ url: 'https://x.example/a', signal: controller.signal }).catch((e) => e)).toBe(
      abort,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('sends nothing for a request that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { http, f } = client([{ status: 200, body: {} }]);
    const err = await http.send({ url: 'https://x.example/a', signal: controller.signal }).catch((e) => e);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(f.calls).toHaveLength(0);
  });
  it('classifies transient errors', () => {
    expect(isTransient(new ApiError(429, 'x', 'x'))).toBe(true);
    expect(isTransient(new ApiError(503, 'x', 'x'))).toBe(true);
    expect(isTransient(new ApiError(404, 'x', 'x'))).toBe(false);
    expect(isTransient(new Error('x'))).toBe(false);
  });
});
