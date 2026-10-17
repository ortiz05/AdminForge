import { api, ApiRequestError, BACKGROUND_HEADER } from '@adminforge/web/src/lib/api';
import { noteActivity } from '@adminforge/web/src/lib/activity';
import { browser } from '@adminforge/web/src/lib/browser';
import { SIGN_IN_REDIRECT_WINDOW_MS } from '@adminforge/web/src/lib/sign-in-guard';
import { capabilitiesQuery as rendererCapabilities } from '@adminforge/web/src/renderer/api';
import { capabilitiesQuery as playbookCapabilities } from '@adminforge/web/src/playbooks/contracts';
import { defenderFeatureQuery } from '@adminforge/web/src/query/contracts';

// The inspector "refreshing loop": a read that keeps answering 401 `reauth` sent the browser to sign in, single
// sign-on brought it straight back to the same deep link, the read failed again, and so on forever. Now a second
// automatic sign-in within the window isn't taken, and auxiliary lookups (capabilities) never start one.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const reauth = () =>
  json(
    {
      error: {
        code: 'reauth',
        message: 'Microsoft needs you to sign in again.',
        login: '/auth/login?returnTo=%2F',
        reauth: { url: '/auth/login?returnTo=%2F' },
      },
    },
    401,
  );

describe('automatic sign-in after a 401', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    noteActivity();
  });

  it('goes to sign-in once; a 401 right after the round trip shows the error instead of looping', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reauth()),
    );
    noteActivity();
    await expect(api('/api/datasources/execute-many')).rejects.toMatchObject({
      status: 401,
      signingIn: true,
    });
    expect(assign).toHaveBeenCalledTimes(1);

    // Back from sign-in (same tab): the page loads, the person's request fails the same way.
    noteActivity();
    const again = await api('/api/datasources/execute-many').catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ApiRequestError);
    expect(again).toMatchObject({
      status: 401,
      code: 'reauth',
      signingIn: false,
      login: '/auth/login?returnTo=%2F',
    });
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('goes to sign-in again once the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reauth()),
    );
    noteActivity();
    await api('/api/users').catch(() => undefined);
    vi.setSystemTime(Date.now() + SIGN_IN_REDIRECT_WINDOW_MS + 1);
    noteActivity();
    await expect(api('/api/users')).rejects.toMatchObject({ signingIn: true });
    expect(assign).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['renderer feature gates', rendererCapabilities],
    ['playbook preflight and PIM badge', playbookCapabilities],
    ['Defender licence gate', defenderFeatureQuery],
  ])('capabilities for %s are background: they never start a sign-in', async (_name, query) => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    const headers: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        headers.push((init?.headers as Record<string, string>)[BACKGROUND_HEADER] ?? null);
        return reauth();
      }),
    );
    noteActivity();
    const queryFn = query.queryFn as (ctx: { signal: AbortSignal }) => Promise<unknown>;
    await expect(queryFn({ signal: new AbortController().signal })).rejects.toMatchObject({
      status: 401,
      signingIn: false,
    });
    expect(headers).toEqual(['1']);
    expect(assign).not.toHaveBeenCalled();
  });
});
