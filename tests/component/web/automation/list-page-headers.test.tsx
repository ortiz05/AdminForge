import { screen, within } from '@testing-library/react';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { me } from '../../../support/web/fixtures/session';
import { renderApp } from './render';

// M8 (design review): two page-header layouts. Content list pages put the actions on the title row and the description
// on one line after it; the coded list pages (Runs, Audit, Schedules, Reports) centred their actions beside a wrapped
// description, and on a phone the order differed. They now use the list layout too.
const ADMIN = me({ roles: ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver', 'Portal.Admin'] });

describe('coded list pages use the list page header', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  for (const { path, title } of [
    { path: '/runs', title: 'Runs' },
    { path: '/admin/audit', title: 'Audit' },
    { path: '/schedules', title: 'Schedules' },
    { path: '/reports', title: 'Reports' },
  ])
    it(`${title}: the actions on the title row, the description after them on one line`, async () => {
      renderApp({ session: ADMIN, path });
      const h1 = await screen.findByRole('heading', { level: 1, name: title }, { timeout: 8_000 });
      const header = h1.closest('header')!;
      const actions = header.querySelector('[data-header-actions]')!;
      expect(actions).not.toBeNull();
      // The title row and the actions share a parent (the title bar).
      expect(actions.parentElement).toBe(h1.parentElement!.parentElement);
      const description = within(header).getByText(/./, { selector: 'p.truncate' });
      expect(actions.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});
