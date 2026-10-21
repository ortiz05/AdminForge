import { screen, within } from '@testing-library/react';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { axeViolations } from '../axe';
import { PERSON_PAGE, RESULTS, USERS_PAGE } from './renderer-fixtures';
import { renderPage } from './render-page';

// F-11 / F-19: a definition flagged `preview: true` (not yet run against a live tenant, or on Microsoft Graph beta)
// says so with a quiet "Preview" badge beside its title — on list pages, entity pages and in the inspector. Quiet:
// an outline badge, never a warning colour (and never ember).
const PREVIEW_LIST = { ...USERS_PAGE, id: 'test.preview-list', preview: true };
const PREVIEW_ENTITY = { ...PERSON_PAGE, id: 'test.preview-person', preview: true };
const definitions = {
  'page/test.preview-list': PREVIEW_LIST,
  'page/test.preview-person': PREVIEW_ENTITY,
  'page/test.users': USERS_PAGE,
};

const badgeIn = (heading: HTMLElement) => heading.parentElement!;

describe('preview badge', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows beside the title of a list page and explains itself to screen readers', async () => {
    renderPage('/p/test.preview-list', { definitions, results: RESULTS });
    const h1 = await screen.findByRole('heading', { level: 1, name: 'People' });
    const badge = within(badgeIn(h1)).getByText('Preview');
    expect(badge.closest('[data-badge="preview"]')).toHaveTextContent(
      /Preview.*not yet checked against a live tenant/i,
    );
    // Quiet: an outline badge, not a warning, critical or armed colour.
    expect(badge.closest('[data-badge="preview"]')!.className).not.toMatch(/warn|crit|armed/);
    expect(await axeViolations()).toEqual([]);
  });

  it('shows on an entity page too', async () => {
    renderPage('/p/test.preview-person?id=0a1b2c3d-0000-4000-8000-000000000001', {
      definitions,
      results: RESULTS,
    });
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Adele Vance' });
    expect(within(h1.closest('header')!).getByText('Preview')).toBeInTheDocument();
  });

  it('is absent when the definition is not a preview', async () => {
    renderPage('/p/test.users', { definitions, results: RESULTS });
    await screen.findByRole('heading', { level: 1, name: 'People' });
    expect(screen.queryByText('Preview')).toBeNull();
  });
});
