import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  getPrefs,
  KPI_COLLAPSED_MAX,
  readLocalPrefs,
  setKpiCollapsed,
  __resetPrefsForTests,
} from '@adminforge/web/src/lib/prefs';
import { me } from '../../support/web/fixtures/session';
import { axeViolations } from '../axe';
import { DASHBOARD, RESULTS, USERS_PAGE } from './renderer-fixtures';
import { renderPage } from './render-page';

// D-11 (platform review 2026-10-21): list pages put the first rows above the fold on a laptop. The header is three
// short lines — eyebrow; title with the actions at its end; the description on one line with "More" — the KPI strip
// folds to one line (remembered per page in the person's preferences) and the filter bar stays at the top while the
// list scrolls under it. Dashboards keep the default header.
const definitions = { 'page/test.users': USERS_PAGE, 'dashboard/test.health': DASHBOARD };
const SLOW = { timeout: 8_000 };

/** jsdom has no layout: say how wide the description's text is and how much room it has. */
function layoutText(scrollWidth: number, clientWidth: number) {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth);
}

describe('list-detail header economics', { timeout: 20_000 }, () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('puts the actions on the title row and the description after them', async () => {
    renderPage('/p/test.users', { definitions, results: RESULTS });
    const h1 = await screen.findByRole('heading', { level: 1, name: 'People' });
    const header = h1.closest('header')!;
    const actions = header.querySelector('[data-header-actions]')!;
    expect(within(actions as HTMLElement).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    // Same row as the title: the title row and the actions share a parent; the description comes after both.
    expect(actions.parentElement).toBe(h1.parentElement!.parentElement);
    const description = within(header).getByText('Synthetic people for renderer tests.');
    expect(actions.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the description on one line, with "More" only when it is cut off; focus stays on the toggle', async () => {
    layoutText(900, 400);
    renderPage('/p/test.users', { definitions, results: RESULTS });
    const text = 'Synthetic people for renderer tests.';
    expect(await screen.findByText(text)).toHaveClass('truncate');
    const more = await screen.findByRole('button', { name: 'Show more of the description' });
    expect(more).toHaveTextContent('More');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    more.focus();
    await userEvent.keyboard('{Enter}');
    // Open: the whole text with "Less" right after it, and focus on "Less".
    const less = screen.getByRole('button', { name: 'Show less of the description' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    expect(less).toHaveFocus();
    expect(less.closest('p')).toHaveTextContent(text);
    expect(less.closest('p')).not.toHaveClass('truncate');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Show more of the description' })).toHaveFocus();
    expect(screen.getByText(text)).toHaveClass('truncate');
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no "More" when the description fits', async () => {
    layoutText(300, 400);
    renderPage('/p/test.users', { definitions, results: RESULTS });
    await screen.findByText('Synthetic people for renderer tests.');
    expect(screen.queryByRole('button', { name: /more of the description/ })).toBeNull();
  });

  it('folds the key figures to one line, keeps their warnings and focus, and remembers it for this page', async () => {
    const { calls } = renderPage('/p/test.users', { definitions, results: RESULTS });
    expect(await screen.findByRole('region', { name: 'Key figures' }, SLOW)).toBeInTheDocument();
    screen.getByRole('button', { name: 'Hide key figures' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('region', { name: 'Key figures' })).toBeNull();
    const show = screen.getByRole('button', { name: 'Show key figures' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    expect(show).toHaveFocus();
    expect(screen.getByText('2 hidden')).toBeInTheDocument();
    // A folded KPI that needs attention still says so (Guests: 1, status warn).
    expect(await screen.findByText('Guests: Needs review', {}, SLOW)).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
    expect(getPrefs().kpiCollapsed).toEqual(['test.users']);
    await waitFor(
      () =>
        expect(
          calls.find((c) => c.method === 'PUT' && c.url === '/api/me/prefs')?.body as {
            kpiCollapsed?: string[];
          },
        ).toMatchObject({ kpiCollapsed: ['test.users'] }),
      SLOW,
    );
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('region', { name: 'Key figures' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide key figures' })).toHaveFocus();
    expect(getPrefs().kpiCollapsed).toEqual([]);
  });

  it('remembers the most recent pages first, each once, and at most KPI_COLLAPSED_MAX of them', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );
    for (let i = 0; i < KPI_COLLAPSED_MAX + 5; i++) setKpiCollapsed(`identity.page-${i}`, true);
    setKpiCollapsed('identity.page-3', true);
    const kept = getPrefs().kpiCollapsed!;
    expect(kept).toHaveLength(KPI_COLLAPSED_MAX);
    expect(kept[0]).toBe('identity.page-3');
    expect(new Set(kept).size).toBe(kept.length);
    expect(readLocalPrefs().kpiCollapsed).toEqual(kept);
    setKpiCollapsed('identity.page-3', false);
    expect(getPrefs().kpiCollapsed).not.toContain('identity.page-3');
  });

  it('never stores a key the API would refuse (one bad entry would fail every later preferences save)', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );
    setKpiCollapsed(`identity.${'x'.repeat(130)}`, true);
    setKpiCollapsed('Not A Key', true);
    expect(getPrefs().kpiCollapsed ?? []).toEqual([]);
    localStorage.setItem('adminforge.prefs', JSON.stringify({ kpiCollapsed: ['identity.users', '<b>', 7] }));
    expect(readLocalPrefs().kpiCollapsed).toEqual(['identity.users']);
  });

  it('a folded KPI hidden by its `when` stays quiet', async () => {
    const page = {
      ...USERS_PAGE,
      id: 'test.quiet',
      layout: USERS_PAGE.layout.map((b) =>
        b.widget === 'kpi' && b.label === 'Guests' ? { ...b, when: false } : b,
      ),
    };
    renderPage('/p/test.quiet', {
      definitions: { 'page/test.quiet': page },
      results: RESULTS,
      session: me({ prefs: { kpiCollapsed: ['test.quiet'] } }),
    });
    expect(await screen.findByRole('button', { name: 'Show key figures' }, SLOW)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('2 hidden')).toBeInTheDocument(), SLOW);
    expect(screen.queryByText(/Guests: Needs review/)).toBeNull();
  });

  it('opens folded when the preferences say so', async () => {
    renderPage('/p/test.users', {
      definitions,
      results: RESULTS,
      session: me({ prefs: { kpiCollapsed: ['test.users'] } }),
    });
    expect(await screen.findByRole('button', { name: 'Show key figures' }, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Key figures' })).toBeNull();
  });

  it('keeps the filter bar at the top while the list scrolls', async () => {
    renderPage('/p/test.users', { definitions, results: RESULTS });
    const filters = await screen.findByRole('search', { name: 'Filters' }, SLOW);
    expect(filters).toHaveAttribute('data-sticky');
    expect(filters.className).toMatch(/\bsticky\b/);
    expect(filters.className).toMatch(/top-\(--af-layout-rail-h\)/);
  });

  it('leaves dashboards with the default header and no fold', async () => {
    layoutText(900, 400);
    renderPage('/p/test.health', { definitions, results: RESULTS });
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Health' });
    expect(h1.closest('header')!.querySelector('[data-header-actions]')!.parentElement).not.toBe(
      h1.parentElement!.parentElement,
    );
    expect(screen.queryByRole('button', { name: /key figures/ })).toBeNull();
  });
});
