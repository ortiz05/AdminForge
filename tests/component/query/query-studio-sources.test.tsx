import '../web/ensure-route-tree';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@adminforge/schemas';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { __resetHistoryForTests, historyKey } from '@adminforge/web/src/query/history';
import { CAPABILITIES_NO_DEFENDER, answerQuery } from '../../support/web/fixtures/query';
import { me, NAV } from '../../support/web/fixtures/session';
import { axeViolations } from '../axe';

/**
 * Query Studio offers only the sources the installation switched on (GET /api/me `querySources`, from
 * AF_QUERY_SOURCES): the source picker, the page description, history and deep links. The API refuses the others.
 */
vi.mock('@adminforge/web/src/query/KqlEditor', async () => {
  const { createElement } = await import('react');
  return {
    default: (props: { value: string; onChange: (v: string) => void; ariaLabel: string }) =>
      createElement('textarea', {
        'aria-label': props.ariaLabel,
        value: props.value,
        onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
      }),
  };
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderStudio(path: string, overrides: Partial<MeResponse>) {
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (url === '/api/me') return json(me(overrides));
      if (url === '/api/nav') return json(NAV);
      if (url === '/api/me/capabilities') return json(CAPABILITIES_NO_DEFENDER);
      if (method === 'POST' && url.startsWith('/api/query')) {
        posts.push(body);
        const reply = answerQuery(url, body);
        if (reply) return json(reply.body, reply.status);
      }
      return json({ ok: true });
    }),
  );
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  render(<App router={createAppRouter(queryClient, { initialPath: path })} queryClient={queryClient} />);
  return { posts };
}

const OFF: Partial<MeResponse> = { querySources: ['resourceGraph', 'logAnalytics'] };

describe('Query Studio: sources switched off for the installation', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
    __resetHistoryForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers only the sources that are on, and the description names only those', async () => {
    renderStudio('/query', OFF);
    const picker = await screen.findByRole('radiogroup', { name: 'Source' });
    expect(
      within(picker)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Resource Graph', 'Log Analytics']);
    expect(
      screen.getByText(
        /^Read-only KQL across Azure Resource Graph and Log Analytics, with your own access\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/advanced hunting/i)).not.toBeInTheDocument();
  });

  it('a link to advanced hunting opens Resource Graph instead, without the link’s query, and says why', async () => {
    renderStudio('/query?source=advancedHunting&q=DeviceInfo%20%7C%20take%201', OFF);
    const box = await screen.findByRole('textbox', { name: /Azure Resource Graph query/ });
    expect(box).not.toHaveValue('DeviceInfo | take 1');
    expect(screen.getByRole('radio', { name: 'Resource Graph' })).toHaveAttribute('aria-checked', 'true');
    const title = screen.getByText('Defender advanced hunting is switched off for this AdminForge');
    expect(title.closest('div')!.parentElement!).toHaveTextContent(
      'You followed a link to it; Azure Resource Graph is shown instead. Whoever runs this AdminForge can switch it back on.',
    );
    expect(screen.queryByText('Advanced hunting needs Microsoft Defender XDR')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('hides history on a source that is off, and offers the rest', async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      historyKey(me().user.oid),
      JSON.stringify([
        {
          source: 'advancedHunting',
          query: 'EmailEvents | take 5',
          ranAt: '2026-10-16T09:00:00Z',
          rowCount: 5,
        },
        { source: 'logAnalytics', query: 'Heartbeat | take 5', ranAt: '2026-10-16T08:00:00Z', rowCount: 5 },
      ]),
    );
    renderStudio('/query', OFF);
    await screen.findByRole('textbox', { name: /Azure Resource Graph query/ });
    await user.click(screen.getByRole('tab', { name: 'History' }));
    const history = screen.getByRole('list', { name: 'Query history' });
    expect(within(history).getAllByRole('button', { name: /take 5/ })).toHaveLength(1);
    expect(within(history).queryByText(/EmailEvents/)).not.toBeInTheDocument();
    expect(within(history).getByText(/Heartbeat/)).toBeInTheDocument();
  });

  it('offers all three when the API names none (an older API)', async () => {
    renderStudio('/query?source=advancedHunting', {});
    expect(
      await screen.findByRole('textbox', { name: /Defender advanced hunting query/ }),
    ).toBeInTheDocument();
    const picker = screen.getByRole('radiogroup', { name: 'Source' });
    expect(within(picker).getAllByRole('radio')).toHaveLength(3);
    expect(screen.queryByText(/is switched off for this AdminForge/)).not.toBeInTheDocument();
  });
});
