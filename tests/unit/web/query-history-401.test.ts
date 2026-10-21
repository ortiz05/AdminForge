import { api, ApiRequestError } from '@adminforge/web/src/lib/api';
import {
  __resetHistoryForTests,
  historyKey,
  readHistory,
  recordRun,
  setHistoryOwner,
} from '@adminforge/web/src/query/history';

// Query Studio history stays in this browser only while its owner is signed in. Sign-out already removed it; now any
// 401 from the BFF does too — the session ended (idle or absolute expiry, possibly in a tab left open) or Microsoft
// wants a fresh sign-in — so the next person on a shared browser never finds the queries (S-32).
const A = '0b9e7c2d-41a5-4f68-b3d1-7e2c5a9f0d16';
const B = '5d2c8e1a-7f3b-4c69-a0d4-2e9b6c1f8a37';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const entry = (query: string) => ({
  source: 'resourceGraph' as const,
  query,
  ranAt: '2026-10-15T12:00:00.000Z',
});

let storage: Storage;
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  __resetHistoryForTests(null);
  setHistoryOwner(B);
  recordRun(entry('resources | where name == "b-vm"'));
  setHistoryOwner(A);
  recordRun(entry('resources | where name == "a-secret-vm"'));
  storage.setItem('adminforge.prefs', '{}');
});
afterEach(() => {
  __resetHistoryForTests(null);
  vi.unstubAllGlobals();
});

async function call(response: Response): Promise<ApiRequestError> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  return api('/api/overview', { background: true }).then(
    () => {
      throw new Error('expected the call to fail');
    },
    (e: ApiRequestError) => e,
  );
}

describe('Query Studio history on a 401', () => {
  it('a session that ended takes every user’s history out of this browser', async () => {
    expect(storage.getItem(historyKey(A))).toContain('a-secret-vm');
    const err = await call(
      json(
        {
          error: {
            code: 'unauthenticated',
            message: 'Your AdminForge session has ended. Sign in to continue.',
            login: '/auth/login?returnTo=%2F',
          },
        },
        401,
      ),
    );
    expect(err.status).toBe(401);
    expect(storage.getItem(historyKey(A))).toBeNull();
    expect(storage.getItem(historyKey(B))).toBeNull();
    expect(readHistory()).toEqual([]);
    // Nothing else this browser keeps is touched.
    expect(storage.getItem('adminforge.prefs')).toBe('{}');
  });

  it('so does a request Microsoft wants a fresh sign-in for — the session stays, so the same person keeps recording', async () => {
    await call(json({ error: { code: 'reauth', message: 'Microsoft needs you to sign in again.' } }, 401));
    expect(storage.getItem(historyKey(A))).toBeNull();
    expect(storage.getItem(historyKey(B))).toBeNull();
    expect(readHistory()).toEqual([]);
    recordRun(entry('resources | take 1'));
    expect(storage.getItem(historyKey(A))).toContain('take 1');
  });

  it('so does a 401 without an AdminForge body (it is treated as a session that ended)', async () => {
    await call(new Response('<html>Unauthorized</html>', { status: 401, statusText: 'Unauthorized' }));
    expect(storage.getItem(historyKey(A))).toBeNull();
    recordRun(entry('resources | take 1'));
    expect(storage.getItem(historyKey(A))).toBeNull();
  });

  it('so does the 401 of the session check behind a stale-CSRF retry', async () => {
    const fetch = vi.fn(async (url: string) =>
      url === '/api/me'
        ? json({ error: { code: 'unauthenticated', message: 'Session ended.' } }, 401)
        : json({ error: { code: 'csrf', message: 'This page is out of date.' } }, 403),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(api('/auth/arm/extend', { method: 'POST', background: true })).rejects.toMatchObject({
      status: 403,
    });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(['/auth/arm/extend', '/api/me']);
    expect(storage.getItem(historyKey(A))).toBeNull();
    expect(storage.getItem(historyKey(B))).toBeNull();
  });

  it('after the 401 nothing is stored until a signed-in session names its owner again', async () => {
    await call(json({ error: { code: 'unauthenticated', message: 'Session ended.' } }, 401));
    recordRun(entry('resources | where name == "typed-after-expiry"'));
    expect(storage.getItem(historyKey(A))).toBeNull();
    setHistoryOwner(A);
    recordRun(entry('resources | take 2'));
    expect(storage.getItem(historyKey(A))).toContain('take 2');
  });

  it.each([403, 404, 429, 500])('a %i leaves the history alone', async (status) => {
    await call(json({ error: { code: 'other', message: 'Refused.' } }, status));
    expect(storage.getItem(historyKey(A))).toContain('a-secret-vm');
    expect(storage.getItem(historyKey(B))).toContain('b-vm');
    expect(readHistory().map((e) => e.query)).toEqual(['resources | where name == "a-secret-vm"']);
  });
});
