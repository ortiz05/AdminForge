import { MeResponse } from '@adminforge/schemas';
import { api, ApiRequestError, CSRF_HEADER, loginUrl, rememberCsrf } from '@adminforge/web/src/lib/api';
import { browser } from '@adminforge/web/src/lib/browser';
import {
  __resetPrefsForTests,
  applyPrefs,
  getPrefs,
  hydratePrefs,
  PREFS_KEY,
  readLocalPrefs,
  resolveTheme,
  updatePrefs,
} from '@adminforge/web/src/lib/prefs';
import { me } from '../../e2e/fixtures/session';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    rememberCsrf(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('validates responses against the zod contract', async () => {
    fetchMock.mockResolvedValue(json(me()));
    const result = await api('/api/me', { schema: MeResponse });
    expect(result.tenant.name).toBe('Example Org');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/me',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
  });

  it('sends the CSRF token from /api/me on writes only', async () => {
    rememberCsrf('csrf-123');
    fetchMock.mockImplementation(async () => json({ ok: true }));
    await api('/api/me/prefs', { method: 'PUT', body: { density: 'compact' } });
    await api('/api/nav');
    const [, put] = fetchMock.mock.calls[0]!;
    const [, get] = fetchMock.mock.calls[1]!;
    expect(put.headers[CSRF_HEADER]).toBe('csrf-123');
    expect(put.body).toBe('{"density":"compact"}');
    expect(get.headers[CSRF_HEADER]).toBeUndefined();
  });

  it('turns error bodies into ApiRequestError with code, hint and correlation id', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            code: 'forbidden',
            message: 'Graph said no.',
            hint: 'Activate a role.',
            correlationId: 'c0ffee00-0000-4000-8000-000000000001',
          },
        },
        403,
      ),
    );
    const err = await api('/api/overview').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'Graph said no.',
      hint: 'Activate a role.',
      correlationId: 'c0ffee00-0000-4000-8000-000000000001',
    });
  });

  it('sends the browser to sign in on 401 with error.login, keeping the current page', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    window.history.replaceState(null, '', '/identity/users?inspect=user:1');
    fetchMock.mockResolvedValue(
      json(
        { error: { code: 'unauthenticated', message: 'Sign in.', login: '/auth/login?returnTo=%2F' } },
        401,
      ),
    );
    await expect(api('/api/me')).rejects.toMatchObject({ status: 401 });
    expect(assign).toHaveBeenCalledWith('/auth/login?returnTo=%2Fidentity%2Fusers%3Finspect%3Duser%3A1');
    assign.mockRestore();
  });

  it('reports contract drift and network failures in plain words', async () => {
    fetchMock.mockResolvedValueOnce(json({ unexpected: true }));
    await expect(api('/api/me', { schema: MeResponse })).rejects.toMatchObject({ code: 'contract' });
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api('/api/me')).rejects.toMatchObject({ code: 'network', status: 0 });
  });

  it('builds login URLs relative to the current origin', () => {
    expect(
      loginUrl('/auth/login?returnTo=%2F', {
        origin: 'http://localhost',
        pathname: '/design',
        search: '',
      } as Location),
    ).toBe('/auth/login?returnTo=%2Fdesign');
  });
});

describe('preferences', () => {
  const root = document.documentElement;
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ok: true })),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('applies theme, density and navigation to <html>', () => {
    applyPrefs({ theme: 'daylight', density: 'compact', navCollapsed: true });
    expect(root.dataset).toMatchObject({ theme: 'daylight', density: 'compact', nav: 'collapsed' });
    applyPrefs({});
    expect(root.dataset).toMatchObject({ theme: 'steel', density: 'comfortable', nav: 'expanded' });
  });

  it('"Match system" follows prefers-color-scheme and prefers-contrast', () => {
    const mm = vi
      .spyOn(window, 'matchMedia')
      .mockImplementation(
        (q: string) => ({ matches: q === '(prefers-color-scheme: light)' }) as MediaQueryList,
      );
    expect(resolveTheme('system')).toBe('daylight');
    mm.mockImplementation((q: string) => ({ matches: q === '(prefers-contrast: more)' }) as MediaQueryList);
    expect(resolveTheme('system')).toBe('contrast');
    expect(resolveTheme('steel')).toBe('steel');
    mm.mockRestore();
  });

  it('mirrors changes to localStorage and saves them to the server (debounced)', async () => {
    updatePrefs({ theme: 'contrast' });
    updatePrefs({ density: 'compact' });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({ theme: 'contrast', density: 'compact' });
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      '/api/me/prefs',
      expect.objectContaining({ method: 'PUT', body: '{"theme":"contrast","density":"compact"}' }),
    );
  });

  it('ignores junk in localStorage', () => {
    localStorage.setItem(PREFS_KEY, '{"theme":"neon","density":"compact","navCollapsed":"yes"}');
    expect(readLocalPrefs()).toEqual({ density: 'compact' });
    localStorage.setItem(PREFS_KEY, 'not json');
    expect(readLocalPrefs()).toEqual({});
  });

  it('server preferences win when the session loads, without echoing them back', async () => {
    updatePrefs({ theme: 'steel' }, { save: false });
    hydratePrefs({ theme: 'daylight' });
    expect(getPrefs().theme).toBe('daylight');
    expect(root.dataset.theme).toBe('daylight');
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).not.toHaveBeenCalled();
  });
});
