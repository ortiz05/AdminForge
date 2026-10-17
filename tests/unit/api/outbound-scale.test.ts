import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import {
  createOutboundExecutor,
  type CallRecord,
  type OutboundDeps,
} from '@adminforge/api/src/execution/outbound';
import {
  DEFAULT_TIMEOUT_OVERRIDES,
  TimeoutOverrideList,
  timeoutOverride,
} from '@adminforge/api/src/execution/timeouts';
import type { ExecutionIdentity } from '@adminforge/api/src/execution/types';

// Enterprise scale in the outbound executor: a concurrency slot per attempt (released while a throttled call waits),
// a bounded wait for a person (503 outbound_busy) while schedules queue, one longer attempt for the known slow reads,
// retried throttling visible in telemetry, and partial results flagged.

const NOW = new Date('2026-10-17T12:00:00.000Z');
const session = (oid = 'u1'): SessionRecord =>
  ({
    idHash: `h-${oid}`,
    userOid: oid,
    upn: `${oid}@example.com`,
    displayName: oid,
    tenantId: '11111111-2222-4333-8444-555555555555',
    tenantName: 'Example Org',
    tenantDomain: 'example.com',
    roles: ['Portal.Reader'],
    csrf: 'x',
    readAccountId: 'read-acct',
    writeAccountId: null,
    writeExpiresAt: null,
    writeExtended: false,
    writeReason: null,
    createdAt: NOW,
    lastSeenAt: NOW,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    ip: null,
    userAgent: null,
  }) as SessionRecord;
const read = (oid = 'u1'): ExecutionIdentity => ({ kind: 'delegated', session: session(oid), mode: 'read' });
const AUTOMATION: ExecutionIdentity = { kind: 'automation', mode: 'read' };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

function executor(
  route: Route,
  config: Partial<OutboundDeps['config']> = {},
  over: Partial<OutboundDeps> = {},
) {
  const auth = { token: async (i: { kind: string }) => `token-${i.kind}` } as unknown as AuthClient;
  const urls: string[] = [];
  const records: CallRecord[] = [];
  const deps: OutboundDeps = {
    config: {
      DATA_MODE: 'live',
      AF_SPO_TENANT_NAME: undefined,
      OUTBOUND_CONCURRENCY: 16,
      OUTBOUND_USER_CONCURRENCY: 6,
      OUTBOUND_TIMEOUT_MS: 5000,
      TOKEN_CACHE_KEY: undefined,
      ...config,
    },
    broker: new TokenBroker(auth, {}, () => NOW),
    auth,
    automation: { clientId: 'automation-app', credential: 'secret', token: async () => 'token-app' },
    fetch: (async (input: string | URL, init?: RequestInit) => {
      urls.push(String(input));
      return route(String(input), init ?? {});
    }) as typeof fetch,
    now: () => NOW,
    sleep: async () => undefined,
    maxRetries: 0,
    onCall: (r) => records.push(r),
    ...over,
  };
  return { out: createOutboundExecutor(deps), urls, records };
}

/** A response that waits for `release()` (or rejects when the request is aborted). */
function held() {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const route: Route = (_url, init) =>
    new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      void released.then(() => resolve(json({ value: [] })));
    });
  return { route, release };
}

const get = (path: string) => ({ service: 'graph' as const, method: 'GET', path });

describe('concurrency slots per attempt', () => {
  it('a throttled call releases its slot while it waits, so the same person’s next call goes ahead', async () => {
    let resume!: () => void;
    const waiting = new Promise<void>((r) => (resume = r));
    let n = 0;
    const { out } = executor(
      (url) =>
        url.includes('/first') && ++n === 1 ? json({}, 429, { 'retry-after': '1' }) : json({ value: [url] }),
      { OUTBOUND_USER_CONCURRENCY: 1 },
      { maxRetries: 2, sleep: () => waiting },
    );
    const first = out.execute(read(), get('/first'));
    await new Promise((r) => setTimeout(r, 5));
    // `first` sleeps on Retry-After without the user's only slot.
    await expect(out.execute(read(), get('/second'))).resolves.toMatchObject({ status: 200 });
    resume();
    await expect(first).resolves.toMatchObject({ status: 200 });
  });

  it('a person who can’t get a slot within OUTBOUND_QUEUE_WAIT_MS gets 503 outbound_busy', async () => {
    const h = held();
    const { out } = executor(h.route, { OUTBOUND_USER_CONCURRENCY: 1, OUTBOUND_QUEUE_WAIT_MS: 20 });
    const first = out.execute(read(), get('/users'));
    await expect(out.execute(read(), get('/groups'))).rejects.toMatchObject({
      status: 503,
      code: 'outbound_busy',
    });
    h.release();
    await first;
    expect(out.active('graph')).toBe(0);
  });

  it('the automation identity waits as long as it takes', async () => {
    const h = held();
    const { out } = executor(h.route, { OUTBOUND_USER_CONCURRENCY: 1, OUTBOUND_QUEUE_WAIT_MS: 20 });
    const first = out.execute(AUTOMATION, get('/users'));
    const second = out.execute(AUTOMATION, get('/groups'));
    await new Promise((r) => setTimeout(r, 50));
    h.release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('an aborted call stops waiting for a slot and the request is cancelled', async () => {
    const h = held();
    const { out, urls } = executor(h.route, { OUTBOUND_USER_CONCURRENCY: 1, OUTBOUND_QUEUE_WAIT_MS: 0 });
    const c1 = new AbortController();
    const first = out.execute(read(), get('/users'), { signal: c1.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    c1.abort(new Error('page closed'));
    expect(await first).toMatchObject({ message: 'page closed' });
    expect(urls).toHaveLength(1);
    expect(out.active('graph')).toBe(0);
  });
});

describe('timeouts', () => {
  /** Never answers; rejects like fetch when the request's signal fires (our timeout or the caller). */
  const hang: Route = (_url, init) =>
    new Promise((_, reject) =>
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }),
    );
  // Built directly: config validation (1000–600000 ms) isn't what these tests are about.
  const overrides = [{ service: 'graph' as const, prefix: '/auditLogs/', ms: 60 }];

  it('an ordinary call that times out is tried once more', async () => {
    const { out, urls } = executor(hang, { OUTBOUND_TIMEOUT_MS: 30 }, { maxRetries: 4 });
    await expect(out.execute(read(), get('/users'))).rejects.toMatchObject({ code: 'Timeout' });
    expect(urls).toHaveLength(2);
  }, 10_000);

  it('a slow read in OUTBOUND_TIMEOUT_OVERRIDES gets one longer attempt', async () => {
    const { out, urls } = executor(
      hang,
      { OUTBOUND_TIMEOUT_MS: 30, OUTBOUND_TIMEOUT_OVERRIDES: overrides },
      { maxRetries: 4 },
    );
    const started = Date.now();
    await expect(out.execute(read(), get('/auditLogs/signIns'))).rejects.toMatchObject({ code: 'Timeout' });
    expect(urls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('parses overrides; the longest prefix wins over the service-wide entry', () => {
    const list = TimeoutOverrideList.parse(
      `${DEFAULT_TIMEOUT_OVERRIDES},graph=45000,graph:/auditLogs/signIns=90000`,
    );
    expect(timeoutOverride(list, 'graph', '/auditLogs/signIns')?.ms).toBe(90_000);
    expect(timeoutOverride(list, 'graph', '/auditLogs/directoryAudits')?.ms).toBe(120_000);
    expect(timeoutOverride(list, 'graph', '/users')?.ms).toBe(45_000);
    expect(timeoutOverride(list, 'logAnalytics', '/v1/workspaces/x/query')?.ms).toBe(120_000);
    expect(timeoutOverride(list, 'arm', '/subscriptions')).toBeUndefined();
    expect(() => TimeoutOverrideList.parse('exchange=1000')).toThrow(/service=ms/);
    expect(() => TimeoutOverrideList.parse('graph=10')).toThrow(/1000–600000/);
    expect(TimeoutOverrideList.parse(' , ')).toEqual([]);
  });
});

describe('telemetry and partial results', () => {
  it('retried throttling shows in the call record even when the call ends well', async () => {
    let n = 0;
    const { out, records } = executor(
      () => (++n === 1 ? json({}, 429, { 'retry-after': '0' }) : json({ value: [] })),
      {},
      { maxRetries: 2 },
    );
    await out.execute(read(), get('/users'));
    expect(records.at(-1)).toMatchObject({ status: 200, throttled: true, retries: 1, throttledRetries: 1 });
  });

  it('ARM paging all reaching maxItems is flagged', async () => {
    const { out } = executor(() =>
      json({ value: [{ id: 1 }, { id: 2 }], nextLink: 'https://management.azure.com/subscriptions?page=2' }),
    );
    const res = await out.execute(read(), {
      service: 'arm',
      method: 'GET',
      path: '/subscriptions',
      apiVersion: '2022-12-01',
      paging: 'all',
      maxItems: 2,
    });
    expect(res.truncated).toBe(true);
  });

  it('Resource Graph paging all keeps totalRecords and flags a cut', async () => {
    const { out } = executor(() => json({ data: [{ id: 1 }, { id: 2 }], totalRecords: 5, count: 2 }));
    const res = await out.execute<{ totalRecords: number; truncated?: boolean }>(read(), {
      service: 'arm',
      method: 'POST',
      path: '/providers/Microsoft.ResourceGraph/resources',
      apiVersion: '2022-10-01',
      body: { query: 'resources' },
      paging: 'all',
      maxItems: 2,
    });
    expect(res.data).toMatchObject({ totalRecords: 5, truncated: true });
    expect(res.truncated).toBe(true);
  });

  it('a $batch collection that answered with its first page only is flagged', async () => {
    const { out } = executor(() =>
      json({
        responses: [
          {
            id: 'a',
            status: 200,
            body: { value: [1], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/x?$skiptoken=2' },
          },
          { id: 'b', status: 200, body: { value: [2] } },
        ],
      }),
    );
    const res = await out.execute(read(), {
      service: 'graph',
      method: 'POST',
      path: '/$batch',
      body: {
        requests: [
          { id: 'a', method: 'GET', url: '/users' },
          { id: 'b', method: 'GET', url: '/groups' },
        ],
      },
    });
    expect(res.truncated).toBe(true);
  });
});

describe('lanes and who may be refused as busy', () => {
  /** An attempt that holds its slot until released. */
  const holder = () => {
    let release!: () => void;
    const done = new Promise<string>((r) => (release = () => r('done')));
    return { attempt: () => done, release };
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('only a read’s first attempt can be refused; writes and later attempts wait', async () => {
    const { out } = executor(() => json({}), { OUTBOUND_USER_CONCURRENCY: 1, OUTBOUND_QUEUE_WAIT_MS: 20 });
    const hold = holder();
    const held = out.gate(read(), 'graph')(hold.attempt);
    await expect(out.gate(read(), 'graph')(async () => 'x')).rejects.toMatchObject({ code: 'outbound_busy' });
    // A declared write is never refused as busy.
    const write = out.gate(read(), 'graph', undefined, { write: true })(async () => 'write');
    // A call whose first attempt went through: its next attempt (a retry, a page, a poll) waits too.
    const crawl = out.gate(read(), 'graph');
    const later = (async () => {
      await crawl(async () => 'first').catch(() => 'first-refused');
      return crawl(async () => 'second');
    })();
    await new Promise((r) => setTimeout(r, 60));
    hold.release();
    await expect(held).resolves.toBe('done');
    await expect(write).resolves.toBe('write');
    await expect(later).resolves.toBe('second');
  });

  it('crawls hold at most OUTBOUND_CRAWL_SHARE of the slots; list pages and entity reads go first', async () => {
    const { out } = executor(() => json({}), {
      OUTBOUND_CONCURRENCY: 4,
      OUTBOUND_CRAWL_SHARE: 0.5,
      OUTBOUND_USER_CONCURRENCY: 16,
      OUTBOUND_QUEUE_WAIT_MS: 0,
    });
    const crawls = [holder(), holder(), holder()];
    const running = crawls.map((h) => out.gate(read(), 'graph', undefined, { lane: 'crawl' })(h.attempt));
    await tick();
    expect(out.crawls('graph')).toBe(2); // the third waits
    const page = holder();
    const pageRun = out.gate(read(), 'graph')(page.attempt);
    await tick();
    expect(out.active('graph')).toBe(3); // a list page didn't wait behind the crawls
    const page2 = holder();
    const page2Run = out.gate(read(), 'graph')(page2.attempt);
    await tick();
    expect(out.active('graph')).toBe(4);
    // Both lanes wait now; the next free slot goes to the person, not the crawl.
    const page3 = holder();
    const page3Run = out.gate(read(), 'graph')(page3.attempt);
    page.release();
    await pageRun;
    await tick();
    expect(out.crawls('graph')).toBe(2);
    expect(out.active('graph')).toBe(4); // page3 took it
    for (const h of [page2, page3, ...crawls]) h.release();
    await Promise.all([...running, page2Run, page3Run]);
    expect(out.active('graph')).toBe(0);
  });

  it('the automation identity has its own slots: schedules neither take nor wait for people’s', async () => {
    const { out } = executor(() => json({}), {
      OUTBOUND_CONCURRENCY: 1,
      OUTBOUND_AUTOMATION_CONCURRENCY: 1,
      OUTBOUND_QUEUE_WAIT_MS: 20,
    });
    const hold = holder();
    const person = out.gate(read(), 'graph')(hold.attempt);
    await tick();
    await expect(out.gate(AUTOMATION, 'graph')(async () => 'scheduled')).resolves.toBe('scheduled');
    hold.release();
    await person;
  });
});
