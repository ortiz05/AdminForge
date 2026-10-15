import { api, rememberCsrf } from '@adminforge/web/src/lib/api';

// A stale CSRF token (the user signed in again in another tab) is refreshed from /api/me and the write retried once.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const csrfError = () =>
  json({ error: { code: 'csrf', message: 'This page is out of date with your sign-in.' } }, 403);

afterEach(() => vi.unstubAllGlobals());

describe('api(): stale CSRF token', () => {
  it('refreshes the token and retries the request once', async () => {
    rememberCsrf('old-token');
    const sent: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/me') return json({ csrf: 'new-token' });
        const token = (init?.headers as Record<string, string>)['X-AdminForge-CSRF'] ?? null;
        sent.push(token);
        return token === 'new-token' ? json({ ok: true }) : csrfError();
      }),
    );
    await expect(api('/api/views', { method: 'POST', body: { name: 'x' } })).resolves.toEqual({ ok: true });
    expect(sent).toEqual(['old-token', 'new-token']);
  });

  it('gives up after one retry with the server’s message', async () => {
    rememberCsrf('old-token');
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/me' ? json({ csrf: 'still-bad' }) : csrfError(),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/api/views', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'csrf' });
    expect(fetchMock.mock.calls.filter(([u]) => u === '/api/views')).toHaveLength(2);
  });
});
