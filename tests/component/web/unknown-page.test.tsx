import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { axeViolations } from '../axe';
import { renderPage } from './render-page';

// D-08: the hard-coded "Coming soon" catalogue is gone (every page it described exists). Any address without a page —
// a mistyped link, a retired coded route, a navigation entry pointing nowhere — lands on one designed not-found state.
describe('an address without a page', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('says so, shows the address, and offers the palette and the overview', async () => {
    const { router } = renderPage('/nothing/here');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'There’s no page at this address' }),
    ).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).getByText('/nothing/here')).toBeInTheDocument();
    expect(within(main).getByText(/may have moved/)).toBeInTheDocument();
    expect(within(main).getByRole('button', { name: /Open the command palette/ })).toBeInTheDocument();
    await userEvent.click(within(main).getByRole('link', { name: 'Go to Overview' }));
    expect(router.state.location.pathname).toBe('/');
    expect(await axeViolations()).toEqual([]);
  });

  it('a navigation entry without a page is not found either — no "Coming soon" placeholder', async () => {
    // The test navigation lists /identity/users, which no route serves.
    renderPage('/identity/users');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'There’s no page at this address' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Coming soon')).toBeNull();
    expect(screen.queryByText(/What you’ll be able to do here/)).toBeNull();
  });
});
