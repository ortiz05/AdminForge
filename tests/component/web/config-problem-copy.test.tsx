import { screen, within } from '@testing-library/react';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { axeViolations } from '../axe';
import { RESULTS, USERS_PAGE } from './renderer-fixtures';
import { renderPage } from './render-page';

// D-19 (b): a widget whose configuration is wrong says, for the person in front of the browser, that this part can't
// be shown and the rest works. The widget type, the details and the CLI hint stay — they're how the author fixes it —
// but under a "For the content author" label, not as advice to the reader.
const PAGE = {
  ...USERS_PAGE,
  id: 'test.broken',
  layout: [
    { widget: 'kpi', data: 'counts.members', label: 'Members' },
    { widget: 'keyValue', title: 'Profile', data: 'users', fields: 'not a list' },
  ],
};

describe('configuration problem card', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('tells the reader plainly and keeps the details for the content author', async () => {
    renderPage('/p/test.broken', { definitions: { 'page/test.broken': PAGE }, results: RESULTS });
    const card = await screen.findByRole('region', { name: 'Profile configuration' });
    const alert = within(card).getByRole('alert');
    expect(alert).toHaveTextContent('“Profile” can’t be shown');
    expect(alert).toHaveTextContent(/The rest of the page works/);

    // The widget type, the problems and the command are under the author label.
    const author = within(card).getByRole('group', { name: 'For the content author' });
    expect(author).toHaveTextContent('For the content author');
    expect(author).toHaveTextContent('The keyValue widget’s configuration');
    expect(within(author).getByText('fields', { exact: false })).toBeInTheDocument();
    expect(author).toHaveTextContent('Fix the page definition, then run pnpm adminforge validate.');

    // The CLI command appears only under the author label.
    const outside = alert.textContent!.replace(author.textContent!, '');
    expect(outside).not.toMatch(/pnpm|adminforge validate|keyValue/);
    // The rest of the page still renders.
    expect(screen.getByRole('region', { name: 'Key figures' })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });
});
