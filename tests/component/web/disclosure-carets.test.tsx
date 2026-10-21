import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { DASHBOARD, RESULTS, USERS_PAGE } from './renderer-fixtures';
import { renderPage } from './render-page';

// L15: one caret convention for everything that folds — right when closed, down when open — so the key figures' fold
// reads like the navigation's sections (it pointed down when closed and up when open).
const definitions = { 'page/test.users': USERS_PAGE, 'dashboard/test.health': DASHBOARD };
const SLOW = { timeout: 8_000 };

const caretOf = (control: HTMLElement) => control.querySelector('svg')!;
const pathOf = (svg: SVGElement) => svg.querySelector('path')!.getAttribute('d');
/** Right: the down caret turned a quarter back. Down: not turned. */
const pointsRight = (svg: SVGElement) => svg.classList.contains('-rotate-90');
const turned = (svg: SVGElement) =>
  [...svg.classList].some((c) => /rotate/.test(c) && !/^transition/.test(c));

describe('disclosure carets', { timeout: 20_000 }, () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('the key figures fold and the navigation sections point the same way: right closed, down open', async () => {
    renderPage('/p/test.users', { definitions, results: RESULTS });
    expect(await screen.findByRole('region', { name: 'Key figures' }, SLOW)).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Primary' });

    const hide = screen.getByRole('button', { name: 'Hide key figures' });
    expect(turned(caretOf(hide))).toBe(false);
    await userEvent.click(hide);
    const show = screen.getByRole('button', { name: 'Show key figures' });
    expect(pointsRight(caretOf(show))).toBe(true);

    const closed = within(nav).getByRole('button', { name: /^Microsoft 365 \(/ });
    expect(closed).toHaveAttribute('aria-expanded', 'false');
    expect(pointsRight(caretOf(closed))).toBe(true);
    await userEvent.click(closed);
    const open = within(nav).getByRole('button', { name: 'Microsoft 365' });
    expect(open).toHaveAttribute('aria-expanded', 'true');
    expect(turned(caretOf(open))).toBe(false);

    // The same glyph in both places.
    expect(pathOf(caretOf(show))).toBe(pathOf(caretOf(open)));
  });
});
