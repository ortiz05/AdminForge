import '../web/ensure-route-tree';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NewsSummaryResponse } from '@adminforge/schemas';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { __resetPrefsForTests, readLocalPrefs } from '@adminforge/web/src/lib/prefs';
import { NAV_WITH_NEWS, newsSummary } from '../../e2e/fixtures/news';
import { overview } from '../../e2e/fixtures/overview';
import { FIXED_NOW, me, NAV } from '../../e2e/fixtures/session';

// The shell's news signals: an unread count on the News and changes navigation item (pill, or a bubble in the icon
// rail) and a top-bar pill for unread breaking items. Neither appears when there's nothing — or when the endpoint
// isn't there (an older API), which must never get in the way.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderShell(summary: NewsSummaryResponse | { status: number } | undefined, nav = NAV_WITH_NEWS) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/me') return json(me());
      if (url === '/api/nav') return json(nav);
      if (url === '/api/overview') return json(overview());
      if (url === '/api/news/summary')
        return summary && 'status' in summary
          ? json({ error: { code: 'not_found', message: 'No route.' } }, summary.status)
          : json(summary);
      return json({ ok: true });
    }),
  );
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter(queryClient, { initialPath: '/' });
  render(<App router={router} queryClient={queryClient} />);
  return { router };
}

describe('News signals in the shell', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the unread count on the News and changes item, with words for screen readers', async () => {
    renderShell(newsSummary());
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    const link = await within(nav).findByRole('link', { name: /News and changes \(3 unread changes\)/ });
    expect(link).toHaveAttribute('href', '/news');
    expect(within(link).getAllByText('3')).toHaveLength(2); // pill (expanded) and bubble (icon rail)
  });

  it('caps the count at 99+', async () => {
    renderShell(newsSummary({ unread: 250 }));
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    const link = await within(nav).findByRole('link', { name: /News and changes \(99\+ unread changes\)/ });
    expect(within(link).getAllByText('99+')).toHaveLength(2);
  });

  it('no count when everything is read (and the collapsed section keeps it out of the way)', async () => {
    renderShell(newsSummary({ unread: 0, breakingUnread: 0 }));
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    // Sections start collapsed; with nothing unread the item doesn't stay visible on its own.
    await userEvent.click(
      await within(nav).findByRole('button', { name: /^Overview \(\d+ pages hidden\)$/ }),
    );
    expect(await within(nav).findByRole('link', { name: 'News and changes' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /unread breaking/ })).not.toBeInTheDocument();
  });

  it('the top bar shows unread breaking items and opens the feed filtered to them', async () => {
    const { router } = renderShell(newsSummary());
    const pill = await screen.findByRole('link', {
      name: '2 unread breaking changes: open News and changes',
    });
    // In the session rail (the top bar), not on the page.
    expect(pill.closest('header')).toHaveClass('af-rail');
    expect(pill).toHaveTextContent('2new breaking');
    expect(pill).toHaveAttribute('href', '/news?breaking=true');
    await userEvent.click(pill);
    await waitFor(() => expect(router.state.location.pathname).toBe('/news'));
    expect(router.state.location.search).toMatchObject({ breaking: true });
  });

  it('the pill follows the rail in write mode instead of adding a second alarm colour', async () => {
    renderShell(newsSummary({ breakingUnread: 1 }));
    const pill = await screen.findByRole('link', { name: '1 unread breaking change: open News and changes' });
    expect(pill.className).toContain('armed:text-on-armed');
    expect(pill.className).not.toMatch(/(^|\s)(bg|text|border)-armed/);
  });

  it('nothing appears when the news endpoint is missing or answers something else', async () => {
    renderShell({ status: 404 }, NAV);
    expect(await screen.findByRole('heading', { level: 1, name: 'Example Org' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /breaking/ })).not.toBeInTheDocument();
  });

  it('keeps a valid newsSeenAt from the local preference copy and drops anything else', () => {
    localStorage.setItem('adminforge.prefs', JSON.stringify({ newsSeenAt: '2026-10-15T08:30:00.000Z' }));
    expect(readLocalPrefs()).toEqual({ newsSeenAt: '2026-10-15T08:30:00.000Z' });
    localStorage.setItem('adminforge.prefs', JSON.stringify({ newsSeenAt: 'yesterday-ish' }));
    expect(readLocalPrefs()).toEqual({});
  });
});
