import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionButton } from '@adminforge/widgets';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { spyRuntime } from '../widgets/helpers';
import { PERSON_PAGE, RESULTS, guid } from './renderer-fixtures';
import { renderPage } from './render-page';

/** Waiting budget for whole-page queries (the default 1 s is too short under load). */
const SLOW = { timeout: 8_000 };

// S-11 (platform review 2026-10-21): content action hrefs are templated from data, so they go through safeUrl at
// both chokepoints — ActionButton (header buttons, action bars, empty states) and ActionGroup's "More actions" menu.
// A value that isn't a safe target (javascript:, //host, /\host, data:) shows as text and never navigates.
const UNSAFE = ['javascript:alert(1)', '//evil.example/x', '/\\evil.example/x', 'data:text/html,hi'];

describe('ActionButton hrefs', () => {
  it.each(UNSAFE)('%s renders as text, not a link', (href) => {
    const { runtime, navigate } = spyRuntime();
    render(<ActionButton action={{ label: 'Open details', href }} scope={runtime.scope} runtime={runtime} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Open details')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a templated unsafe value from data renders as text too', async () => {
    const { runtime } = spyRuntime({ data: { profile: { site: 'javascript:alert(document.cookie)' } } });
    render(
      <ActionButton
        action={{ label: 'Open site', href: '${ profile.site }' }}
        scope={runtime.scope}
        runtime={runtime}
      />,
    );
    expect(await screen.findByText('Open site')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('safe in-app and https targets stay links', () => {
    const { runtime } = spyRuntime();
    render(
      <>
        <ActionButton action={{ label: 'Runs', href: '/runs' }} scope={runtime.scope} runtime={runtime} />
        <ActionButton
          action={{ label: 'Entra', href: 'https://entra.microsoft.com/' }}
          scope={runtime.scope}
          runtime={runtime}
        />
      </>,
    );
    expect(screen.getByRole('link', { name: 'Runs' })).toHaveAttribute('href', '/runs');
    expect(screen.getByRole('link', { name: /Entra/ })).toHaveAttribute(
      'href',
      'https://entra.microsoft.com/',
    );
  });
});

// The entity header shows three actions and puts the rest under "More actions"; menu items run on select.
const PAGE = {
  ...PERSON_PAGE,
  id: 'test.links',
  actions: [
    { href: '/runs', label: 'Runs' },
    { href: '/admin/audit', label: 'Audit log' },
    { href: '/schedules', label: 'Schedules' },
    { href: '${ profile.website }', label: 'Website' },
    { href: '//evil.example/steal', label: 'Off-site' },
    { href: '/monitoring', label: 'Monitoring' },
  ],
};

// A whole page in jsdom: data arrives late and role queries over the shell are slow (more so on a busy machine), so this gets a larger budget.
describe('"More actions" hrefs', { timeout: 20_000 }, () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('unsafe items are shown as text (disabled) and never navigate or open a window', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const results = {
      ...RESULTS,
      profile: {
        ...RESULTS.profile,
        data: { ...(RESULTS.profile!.data as object), website: 'javascript:alert(1)' },
      },
    };
    const { router } = renderPage(`/p/test.links?id=${guid(1)}`, {
      definitions: { 'page/test.links': PAGE },
      results,
    });
    // The header re-renders as data arrives: wait for the menu with every action, then open it.
    await waitFor(
      () =>
        expect(
          within(screen.getByRole('group', { name: 'Actions' })).getByRole('button', {
            name: /More actions/,
          }),
        ).toBeInTheDocument(),
      SLOW,
    );
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Actions' })).getByRole('button', { name: /More actions/ }),
    );
    const website = await screen.findByRole('menuitem', { name: 'Website' }, SLOW);
    await waitFor(() => expect(website).toHaveAttribute('aria-disabled', 'true'), SLOW);
    expect(screen.getByRole('menuitem', { name: 'Off-site' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(website);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Off-site' }));
    expect(open).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/p/test.links');
    // A safe item still navigates in the app.
    await userEvent.click(screen.getByRole('menuitem', { name: 'Monitoring' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitoring'), SLOW);
    open.mockRestore();
  });
});
