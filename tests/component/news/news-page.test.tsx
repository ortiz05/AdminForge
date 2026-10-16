import '../web/ensure-route-tree';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse, NewsItemDto, NewsSummaryResponse } from '@adminforge/schemas';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { NAV_WITH_NEWS, NEWS_FEEDS, NEWS_ITEMS, newsList, newsSummary } from '../../e2e/fixtures/news';
import { FIXED_NOW, me } from '../../e2e/fixtures/session';
import { axeViolations } from '../axe';

// News and changes (/news): breaking strip, day grouping, unread and mark-all-read, URL filters, citations, text-only
// summaries and the detail panel — real routes and shell, mocked BFF.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Options {
  session?: MeResponse;
  path?: string;
  summary?: NewsSummaryResponse;
  items?: NewsItemDto[];
}

function renderNews({
  session = me(),
  path = '/news',
  summary = newsSummary(),
  items = NEWS_ITEMS,
}: Options = {}) {
  const calls: Array<{ method: string; url: string; body?: string; csrf?: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        body: init?.body as string | undefined,
        csrf: (init?.headers as Record<string, string>)?.['X-AdminForge-CSRF'],
      });
      if (url === '/api/me') return json(session);
      if (url === '/api/nav') return json(NAV_WITH_NEWS);
      if (url === '/api/news/summary') return json(summary);
      if (url.startsWith('/api/news?') || url === '/api/news') {
        const params = new URL(url, 'http://localhost').searchParams;
        return json(newsList(params, items));
      }
      const one = /^\/api\/news\/([^/?]+)$/.exec(url);
      if (one) {
        const found = items.find((i) => i.id === decodeURIComponent(one[1]!));
        return found
          ? json(found)
          : json({ error: { code: 'news_not_found', message: 'No such item.' } }, 404);
      }
      if (url === '/api/me/prefs') return json({ prefs: JSON.parse((init?.body as string) ?? '{}') });
      return json({ ok: true });
    }),
  );
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter(queryClient, { initialPath: path });
  render(<App router={router} queryClient={queryClient} />);
  return { calls, router };
}

const listCalls = (calls: Array<{ url: string }>) => calls.filter((c) => c.url.startsWith('/api/news?'));

describe('News and changes', () => {
  const tz = process.env.TZ;
  beforeAll(() => {
    // Day groups are local days; pin the zone so "Today" / "Yesterday" don't depend on the machine.
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    process.env.TZ = tz;
  });
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

  it('shows the breaking strip first, with kind and severity in words', async () => {
    renderNews();
    expect(await screen.findByRole('heading', { level: 1, name: 'News and changes' })).toBeInTheDocument();
    const strip = await screen.findByRole('region', { name: /Breaking/ });
    const rows = within(strip).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Incident')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('High')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Critical')).toBeInTheDocument();
    expect(within(strip).getByRole('list')).toHaveAttribute('aria-live', 'polite');
    expect(await axeViolations()).toEqual([]);
  });

  it('says nothing is breaking when there is nothing', async () => {
    renderNews({ summary: newsSummary({ breaking: [], breakingUnread: 0 }) });
    expect(await screen.findByText(/Nothing breaking/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Breaking/ })).not.toBeInTheDocument();
  });

  it('groups the feed by day of the source’s last activity, newest first', async () => {
    renderNews();
    const today = await screen.findByRole('heading', { level: 2, name: /^Today/ });
    expect(today).toHaveTextContent('Today· 2 changes');
    expect(screen.getByRole('heading', { level: 2, name: /^Yesterday/ })).toHaveTextContent('2 changes');
    // Older days carry their date ("Tue 13 Oct" in en-GB; the format follows the browser's locale).
    expect(screen.getByRole('heading', { level: 2, name: /13/ })).toBeInTheDocument();
    const titles = screen
      .getAllByRole('article')
      .map((a) => within(a).getByRole('heading', { level: 3 }).textContent);
    expect(titles.slice(0, 3)).toEqual([
      'Some users can’t send mail from Outlook on the web',
      'Security update for an identity synchronisation component',
      'Meeting recordings get a default expiry',
    ]);
  });

  it('marks unread items and marks everything read through the person’s preferences', async () => {
    const { calls } = renderNews();
    const incident = await screen.findByRole('article', { name: /Outlook on the web/ });
    expect(within(incident).getByRole('img', { name: 'Unread' })).toBeInTheDocument();
    const graph = screen.getByRole('article', { name: /Microsoft Graph v1.0/ });
    expect(within(graph).queryByRole('img', { name: 'Unread' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Mark all as read (3 unread)' }));
    // Visiting the page also saves "recents" through the same endpoint: pick the newsSeenAt write.
    const isSeenWrite = (c: (typeof calls)[number]) =>
      c.method === 'PUT' && c.url === '/api/me/prefs' && (c.body ?? '').includes('newsSeenAt');
    await waitFor(() => expect(calls.some(isSeenWrite)).toBe(true));
    const put = calls.find(isSeenWrite)!;
    expect(JSON.parse(put.body!)).toEqual({ newsSeenAt: new Date(FIXED_NOW).toISOString() });
    expect(put.csrf).toBe('e2e-csrf-token');
    expect(await screen.findByText('Marked all as read')).toBeInTheDocument();
    // The summary and the list are read again after the marker moved.
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/news/summary').length).toBeGreaterThan(1));
  });

  it('filters live in the URL and are sent to the API', async () => {
    const { calls, router } = renderNews();
    await screen.findAllByRole('article');
    expect(listCalls(calls).at(-1)!.url).toBe('/api/news?days=30&limit=50');

    const areas = screen.getByRole('group', { name: 'Area' });
    await userEvent.click(within(areas).getByRole('button', { name: 'Azure' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ area: 'azure' }));
    await waitFor(() => expect(listCalls(calls).at(-1)!.url).toBe('/api/news?area=azure&days=30&limit=50'));
    expect(within(areas).getByRole('button', { name: 'Azure' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findAllByRole('article')).toHaveLength(2);

    await userEvent.click(screen.getByRole('radio', { name: 'Last 7 days' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ area: 'azure', days: 7 }));

    await userEvent.click(screen.getByRole('switch', { name: 'Unread only' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ unread: true }));
    await waitFor(() =>
      expect(listCalls(calls).at(-1)!.url).toBe('/api/news?area=azure&days=7&unread=true&limit=50'),
    );

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search changes' }), 'alert{Enter}');
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'alert' }));
    await waitFor(() => expect(listCalls(calls).at(-1)!.url).toContain('q=alert'));

    await userEvent.click(screen.getAllByRole('button', { name: 'Reset filters' })[0]!);
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.getByRole('searchbox', { name: 'Search changes' })).toHaveValue('');
  });

  it('filters by a tag from an item and shows it as a removable chip', async () => {
    const { router } = renderNews();
    const release = await screen.findByRole('article', { name: /ExchangeOnlineManagement/ });
    await userEvent.click(within(release).getByRole('button', { name: 'Show only powershell' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tag: 'powershell' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove filter #powershell' }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('tag'));
  });

  it('cites every item; only https links are rendered, in a new tab without a referrer', async () => {
    const unsafe = [
      { ...NEWS_ITEMS[3]!, id: 'n-js', title: 'Script link', url: 'javascript:alert(1)', breaking: false },
      {
        ...NEWS_ITEMS[3]!,
        id: 'n-http',
        title: 'Plain http link',
        url: 'http://example.com/x',
        breaking: false,
      },
    ];
    renderNews({ items: [NEWS_ITEMS[0]!, ...unsafe], summary: newsSummary({ breaking: [] }) });
    const incident = await screen.findByRole('article', { name: /Outlook on the web/ });
    const cite = within(incident).getByRole('link', { name: /Microsoft 365 service health/ });
    expect(cite).toHaveAttribute('href', NEWS_ITEMS[0]!.url);
    expect(cite).toHaveAttribute('target', '_blank');
    expect(cite).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(incident).getByText('EX000123')).toBeInTheDocument();

    for (const name of [/Script link/, /Plain http link/]) {
      const article = screen.getByRole('article', { name });
      expect(within(article).getByText('Azure Updates')).toBeInTheDocument();
      expect(within(article).queryByRole('link')).not.toBeInTheDocument();
    }
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('shows each item’s own publisher (community modules are not presented as Microsoft’s)', async () => {
    renderNews({ summary: newsSummary({ breaking: [] }) });
    const pnp = await screen.findByRole('article', { name: /PnP.PowerShell 3.2.0/ });
    expect(within(pnp).getByRole('link', { name: /PowerShell modules, PnP community/ })).toBeInTheDocument();
    expect(within(pnp).queryByText(/Microsoft/)).not.toBeInTheDocument();
  });

  it('renders titles and summaries as text, never as HTML', async () => {
    const hostile = {
      ...NEWS_ITEMS[4]!,
      id: 'n-html',
      title: '<b>Bold</b> claim',
      summary: '<img src=x onerror="alert(1)"> and <script>alert(2)</script>',
    };
    renderNews({ items: [hostile], summary: newsSummary({ breaking: [] }) });
    expect(await screen.findByText('<b>Bold</b> claim')).toBeInTheDocument();
    expect(screen.getByText(/<img src=x onerror="alert\(1\)">/)).toBeInTheDocument();
    expect(document.querySelector('main img')).toBeNull();
    expect(document.querySelector('main script')).toBeNull();
    expect(document.querySelector('main b')).toBeNull();
  });

  it('opens an item in the detail panel with its facts and the citation', async () => {
    const { router } = renderNews();
    const change = await screen.findByRole('article', { name: /Meeting recordings/ });
    await userEvent.click(
      within(change).getByRole('button', { name: 'Meeting recordings get a default expiry' }),
    );
    await waitFor(() => expect(router.state.location.search).toMatchObject({ item: 'n-change' }));
    const panel = await screen.findByRole('dialog', { name: 'Meeting recordings get a default expiry' });
    // Dates follow the browser's locale ("24 Oct 2026" or "Oct 24, 2026").
    expect(within(panel).getByText(/^Action required by (24 Oct|Oct 24,) 2026$/)).toBeInTheDocument();
    expect(within(panel).getByText('MC000101')).toBeInTheDocument();
    expect(within(panel).getByText('Major change')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /Read at the source/ })).toHaveAttribute(
      'href',
      NEWS_ITEMS[2]!.url,
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('item'));
  });

  it('reads an item that is not in the loaded feed from /api/news/:id (shared links)', async () => {
    const { calls } = renderNews({ path: '/news?item=n-graph&area=azure' });
    expect(await screen.findByRole('dialog', { name: /Microsoft Graph v1.0/ })).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/news/n-graph')).toBe(true);
  });

  it('lists the sources with scope and health; error details only when the API sends them', async () => {
    renderNews();
    await userEvent.click(await screen.findByRole('button', { name: /^Sources: 8, 2 need attention/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Azure Service Health')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Your tenant')).toHaveLength(3);
    expect(within(dialog).getByText('Last run failed')).toBeInTheDocument();
    expect(within(dialog).getByText(/can’t read Azure Service Health/)).toBeInTheDocument();
    expect(within(dialog).getByText('Stale')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Checked every 6 h')).toHaveLength(2);
    expect(within(dialog).getAllByText('Checked every hour')).toHaveLength(6);
    // A quiet source is a neutral note, not a failure.
    expect(within(dialog).getByText(/No new posts from this source since/)).toHaveTextContent(
      /since (3 Aug|Aug 3,) 2026/,
    );
    expect(within(dialog).getAllByText(/No new posts/)).toHaveLength(1);
  });

  it('before the first collection, tells operators where to run it', async () => {
    const never = NEWS_FEEDS.map((f) => ({ ...f, status: 'never' as const, lastSuccessAt: null, items: 0 }));
    renderNews({
      items: [],
      summary: newsSummary({ feeds: never, breaking: [], unread: 0, breakingUnread: 0, lastUpdatedAt: null }),
    });
    expect(await screen.findByText('Nothing collected yet')).toBeInTheDocument();
    expect(screen.getByText(/Operators can run the News refresh schedule now/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Schedules' })).toHaveAttribute('href', '/schedules');
    expect(screen.getByText('Not collected yet', { selector: 'span' })).toBeInTheDocument();
  });

  it('readers without the operator role get no Schedules link', async () => {
    renderNews({
      session: me({ roles: ['Portal.Reader'], canArm: false }),
      items: [],
      summary: newsSummary({
        feeds: NEWS_FEEDS.map((f) => ({ ...f, status: 'never' as const, error: null })),
        breaking: [],
      }),
    });
    expect(await screen.findByText(/ask an operator to run the News refresh schedule/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Schedules' })).not.toBeInTheDocument();
  });

  it('a filter with no results offers to reset the filters', async () => {
    renderNews({ path: '/news?q=nothing-matches' });
    expect(await screen.findByText('No changes match these filters')).toBeInTheDocument();
  });
});
