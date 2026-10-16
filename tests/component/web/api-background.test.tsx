import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { api, BACKGROUND_HEADER, rememberCsrf } from '@adminforge/web/src/lib/api';
import {
  ACTIVITY_WINDOW_MS,
  isUserActive,
  noteActivity,
  trackActivity,
} from '@adminforge/web/src/lib/activity';

// IAM-05: requests the tab makes on its own (polling, refetches on focus or after a server event) carry
// X-AdminForge-Background: 1 so they don't slide the session's idle timeout; requests right after the person
// interacted don't.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Sent = { url: string; background: string | null };

function stubFetch(answer: (url: string) => Response = () => json({ ok: true })) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, background: (init?.headers as Record<string, string>)[BACKGROUND_HEADER] ?? null });
      return answer(url);
    }),
  );
  return sent;
}

/** Long enough ago that the person counts as away. */
const idle = () => noteActivity(Date.now() - ACTIVITY_WINDOW_MS - 1);

afterEach(() => {
  vi.unstubAllGlobals();
  noteActivity();
});

describe('api(): background requests', () => {
  it('a request right after an interaction is the person’s: no background header', async () => {
    const sent = stubFetch();
    noteActivity();
    await api('/api/users');
    expect(sent).toEqual([{ url: '/api/users', background: null }]);
  });

  it('a request when nobody has interacted for a while is background', async () => {
    const sent = stubFetch();
    idle();
    await api('/api/runs?mine=1');
    expect(sent).toEqual([{ url: '/api/runs?mine=1', background: '1' }]);
  });

  it('`background` overrides the activity rule either way', async () => {
    const sent = stubFetch();
    noteActivity();
    await api('/api/news', { background: true });
    idle();
    await api('/api/views', { method: 'POST', body: {}, background: false });
    expect(sent.map((s) => s.background)).toEqual(['1', null]);
  });

  it('the CSRF refresh and the retry keep the original request’s classification', async () => {
    rememberCsrf('old-token');
    let first = true;
    const sent = stubFetch((url) => {
      if (url === '/api/me') return json({ csrf: 'new-token' });
      if (first) {
        first = false;
        return json({ error: { code: 'csrf', message: 'This page is out of date with your sign-in.' } }, 403);
      }
      return json({ ok: true });
    });
    idle();
    const pending = api('/api/views', { method: 'POST', body: {} });
    // The person interacting mid-flight doesn't turn the retry into activity.
    noteActivity();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(sent).toEqual([
      { url: '/api/views', background: '1' },
      { url: '/api/me', background: '1' },
      { url: '/api/views', background: '1' },
    ]);
  });

  it('a polling query: the first load follows the person, the timed refetches are background', async () => {
    const sent = stubFetch(() => json({ items: [] }));
    noteActivity();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Poller() {
      const q = useQuery({
        queryKey: ['poll'],
        queryFn: ({ signal }) => api('/api/runs?active=1', { signal }),
        refetchInterval: 40,
        // jsdom has no focus; refetchInterval only runs while focused unless told otherwise.
        refetchIntervalInBackground: true,
      });
      return <p>{q.isSuccess ? 'loaded' : 'loading'}</p>;
    }
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <Poller />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('loaded')).toBeInTheDocument();
    const first = sent.length;
    idle();
    await waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(first + 2));
    unmount();
    client.clear();
    expect(sent[0]!.background).toBeNull();
    expect(sent.slice(first).every((s) => s.background === '1')).toBe(true);
  });
});

describe('activity tracking', () => {
  it('pointer, key, wheel and back/forward count; hovering and focus changes do not', () => {
    const stop = trackActivity(window);
    try {
      for (const type of ['pointerdown', 'keydown', 'wheel', 'popstate']) {
        idle();
        window.dispatchEvent(new Event(type));
        expect(isUserActive(), type).toBe(true);
      }
      for (const type of ['pointermove', 'mousemove', 'focus', 'visibilitychange', 'scroll']) {
        idle();
        window.dispatchEvent(new Event(type));
        expect(isUserActive(), type).toBe(false);
      }
    } finally {
      stop();
    }
  });

  it('interactions inside the page count even when a widget stops propagation (capture phase)', () => {
    const stop = trackActivity(window);
    const input = document.createElement('input');
    input.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.append(input);
    try {
      idle();
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
      expect(isUserActive()).toBe(true);
    } finally {
      input.remove();
      stop();
    }
  });

  it('the cleanup stops listening', () => {
    trackActivity(window)();
    idle();
    window.dispatchEvent(new Event('pointerdown'));
    expect(isUserActive()).toBe(false);
  });

  it('the window is a few seconds', () => {
    noteActivity(1_000_000);
    expect(isUserActive(1_000_000 + ACTIVITY_WINDOW_MS - 1)).toBe(true);
    expect(isUserActive(1_000_000 + ACTIVITY_WINDOW_MS)).toBe(false);
  });
});
