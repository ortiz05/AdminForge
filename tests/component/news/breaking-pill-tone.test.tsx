import '../web/ensure-route-tree';
import { render, screen } from '@testing-library/react';
import type { NewsSummaryResponse } from '@adminforge/schemas';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { NAV_WITH_NEWS, newsSummary } from '../../support/web/fixtures/news';
import { overview } from '../../support/web/fixtures/overview';
import { FIXED_NOW, me } from '../../support/web/fixtures/session';
import { axeViolations } from '../axe';

// D-13: the "N new breaking" pill sits in the top bar on every page. "Breaking" includes advisories and deadlines, not
// only incidents in this tenant, so the rail carries it in the info tone with its count — never the crit (alarm) tone,
// and without a pulsing siren. The News page keeps its own treatment of each item.

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function renderShell(summary: NewsSummaryResponse) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/me') return json(me());
      if (url === '/api/nav') return json(NAV_WITH_NEWS);
      if (url === '/api/overview') return json(overview());
      if (url === '/api/news/summary') return json(summary);
      return json({ ok: true });
    }),
  );
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  return render(
    <App router={createAppRouter(queryClient, { initialPath: '/' })} queryClient={queryClient} />,
  );
}

const TONE = /(^|\s)(?:[a-z-]+:)*(?:bg|text|border)-(crit|warn|ok|armed)(?:[-/][\w-]+)?(?=\s|$)/;

describe('Breaking-news pill tone', () => {
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

  it('uses the info tone with the count, not the alarm tone', async () => {
    const { container } = renderShell(newsSummary({ breakingUnread: 4 }));
    const pill = await screen.findByRole('link', {
      name: '4 new breaking changes: open News and changes',
    });
    expect(pill).toHaveTextContent('4new breaking');
    // Its name starts with what it shows (WCAG 2.5.3), and only the mode pill beside it is outlined.
    expect(pill.getAttribute('aria-label')).toMatch(/^4 new breaking/);
    expect(pill).toHaveClass('text-info', 'bg-accent-subtle');
    expect(pill.className).not.toMatch(TONE);
    expect(pill.className).not.toMatch(/(^|\s)border(\s|-|$)/);
    expect(await axeViolations(container)).toEqual([]);
  });

  it('does not pulse: a quiet signal on every page', async () => {
    renderShell(newsSummary({ breakingUnread: 2 }));
    const pill = await screen.findByRole('link', {
      name: '2 new breaking changes: open News and changes',
    });
    expect(pill.querySelector('svg')).not.toBeNull();
    expect(pill.innerHTML).not.toMatch(/animate-/);
  });

  it('caps the count at 99+ and keeps following the rail in write mode', async () => {
    renderShell(newsSummary({ breakingUnread: 140 }));
    const pill = await screen.findByRole('link', {
      name: '99+ new breaking changes: open News and changes',
    });
    expect(pill).toHaveTextContent('99+new breaking');
    expect(pill.className).toContain('armed:text-on-armed');
  });
});
