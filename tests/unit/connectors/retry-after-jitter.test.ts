import { createArmClient, createHttpClient, retryDelay } from '@adminforge/connectors';
import { fakeFetch } from './fake-fetch';

// D-03a: when Microsoft throttles, every waiting call used to retry on exactly the second Retry-After named. The wait
// is now spread ±20 % around it, still never past the 120 s cap — and ARM's long-running-operation polls, which read
// Retry-After through the same function, are spread too.

describe('retryDelay with Retry-After', () => {
  it('spreads the wait ±20 % around the seconds Microsoft named', () => {
    expect(retryDelay('10', 0, () => 0)).toBe(8000);
    expect(retryDelay('10', 0, () => 0.5)).toBe(10_000);
    expect(retryDelay('10', 0, () => 0.999_999)).toBe(12_000);
  });

  it('really varies between calls (Math.random by default)', () => {
    const waits = Array.from({ length: 50 }, () => retryDelay('10', 0));
    for (const w of waits) {
      expect(w).toBeGreaterThanOrEqual(8000);
      expect(w).toBeLessThanOrEqual(12_000);
    }
    expect(new Set(waits).size).toBeGreaterThan(1);
  });

  it('never waits past the 120 s cap, and still spreads waits near it', () => {
    expect(retryDelay('600', 0, () => 0.999_999)).toBe(120_000);
    expect(retryDelay('600', 0, () => 0)).toBe(96_000);
    expect(retryDelay('110', 0, () => 0.999_999)).toBe(120_000);
    expect(retryDelay('110', 0, () => 0)).toBe(88_000);
    // Below the cap the window is the full ±20 %; at it, the window ends at the cap instead of piling up on it.
    expect(retryDelay('600', 0, () => 0.5)).toBe(108_000);
  });

  it('spreads an HTTP-date Retry-After as well', () => {
    const at = new Date(Date.now() + 10_000).toUTCString();
    const early = retryDelay(at, 0, () => 0);
    const late = retryDelay(at, 0, () => 0.999_999);
    expect(early).toBeLessThan(late);
    expect(late).toBeLessThanOrEqual(12_000);
  });

  it('keeps Retry-After: 0 at zero', () => {
    expect(retryDelay('0', 0, () => 0.999_999)).toBe(0);
  });
});

describe('the HTTP client and ARM polling use the spread wait', () => {
  // The low end of the window, so a wait that ignores the spread shows.
  beforeEach(() => void vi.spyOn(Math, 'random').mockReturnValue(0));
  afterEach(() => vi.restoreAllMocks());

  it('a throttled call sleeps within ±20 % of Retry-After (here its low end) before trying again', async () => {
    const f = fakeFetch([
      { status: 429, headers: { 'retry-after': '5' } },
      { status: 200, body: {} },
    ]);
    const sleep = vi.fn(async (_ms: number) => {});
    const http = createHttpClient({ getToken: async () => 't', fetch: f.fetch, sleep });
    await http.send({ url: 'https://graph.microsoft.com/v1.0/users' });
    expect(sleep.mock.calls).toEqual([[4000]]);
  });

  it('an ARM long-running operation polls within ±20 % of its Retry-After (here its low end)', async () => {
    const op = 'https://management.azure.com/subscriptions/s/providers/Microsoft.Web/operations/op1';
    const f = fakeFetch([
      { status: 202, headers: { 'azure-asyncoperation': op, 'retry-after': '20' } },
      { status: 200, body: { status: 'Succeeded' } },
    ]);
    const sleep = vi.fn(async (_ms: number) => {});
    const arm = createArmClient({ getToken: async () => 't', fetch: f.fetch, sleep });
    await arm.requestAndWait({ method: 'POST', path: '/subscriptions/s/restart', apiVersion: '2022-03-01' });
    expect(sleep.mock.calls[0]).toEqual([16_000]);
  });
});
