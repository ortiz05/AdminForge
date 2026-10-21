import { screen, waitFor } from '@testing-library/react';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { axeViolations } from '../axe';
import { PERSON_PAGE, RESULTS, guid } from './renderer-fixtures';
import { renderPage } from './render-page';

// Design review M4 (2026-10-21): an entity header's `status` of `neutral` names a category (a group's kind:
// "Security"), not a state that is fine or not. It shows as a quiet outline badge — the look of the header's other
// facts — instead of a status pill with a "no data" dot. ok, warn, crit and info keep their pill.

const SLOW = { timeout: 8_000 };
const page = (status: string, statusLabel: string) => ({
  ...PERSON_PAGE,
  id: 'test.thing',
  header: { ...PERSON_PAGE.header, status, statusLabel },
});
const path = `/p/test.thing?id=${guid(1)}`;

describe('entity header status', { timeout: 20_000 }, () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('neutral: an outline badge with the label, no status pill', async () => {
    const { view } = renderPage(path, {
      definitions: { 'page/test.thing': page('neutral', 'Security group') },
      results: RESULTS,
    });
    const badge = await screen.findByText('Security group', {}, SLOW);
    await screen.findByRole('heading', { level: 1, name: 'Adele Vance' }, SLOW);
    expect(badge.closest('[data-status]')).toBeNull();
    expect(badge.closest('[data-header-category]')).not.toBeNull();
    expect(await axeViolations(view.container)).toEqual([]);
  });

  it('a state keeps its status pill', async () => {
    renderPage(path, {
      definitions: { 'page/test.thing': page('warn', 'Role-assignable') },
      results: RESULTS,
    });
    const pill = await screen.findByText('Role-assignable', {}, SLOW);
    await waitFor(() => expect(pill.closest('[data-status]')).toHaveAttribute('data-status', 'warn'));
  });
});
