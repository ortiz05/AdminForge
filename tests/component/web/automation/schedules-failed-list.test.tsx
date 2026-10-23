import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { schedules } from '../../../support/web/fixtures/automation';
import { axeViolations } from '../../axe';
import { renderApp } from './render';

// The Schedules page's "failed on the last run" alert names the five most recent failures and folds the rest behind
// "Show n more", so a tenant where many reports fail (an identity without Azure access) doesn't push the page down.
const base = schedules().items;
const failed = base.find((s) => s.lastStatus === 'failed')!;
const HOUR = 3_600_000;
const extra = Array.from({ length: 6 }, (_, i) => ({
  ...failed,
  key: `reports.failing-${i + 1}`,
  title: `Failing report ${i + 1}`,
  // Report 1 failed most recently, report 6 longest ago; the fixture's own failure was 9 hours ago.
  lastRunAt: new Date(Date.parse(failed.lastRunAt!) + (7 - i) * HOUR).toISOString(),
}));

function renderWithFailures() {
  return renderApp({
    path: '/schedules',
    handlers: [
      ({ method, path }) =>
        method === 'GET' && path === '/api/schedules' ? { body: { items: [...base, ...extra] } } : undefined,
    ],
  });
}

describe('Schedules: failed on the last run', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('names the five most recent failures and folds the rest behind Show more', async () => {
    renderWithFailures();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('7 schedules failed on the last run');
    const names = () =>
      within(alert)
        .getAllByRole('link')
        .map((a) => a.textContent);
    expect(names()).toEqual([
      'Failing report 1',
      'Failing report 2',
      'Failing report 3',
      'Failing report 4',
      'Failing report 5',
    ]);

    const more = within(alert).getByRole('button', { name: 'Show 2 more' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(names()).toEqual([
      'Failing report 1',
      'Failing report 2',
      'Failing report 3',
      'Failing report 4',
      'Failing report 5',
      'Failing report 6',
      failed.title,
    ]);
    const fewer = within(alert).getByRole('button', { name: 'Show fewer' });
    expect(fewer).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(fewer);
    expect(names()).toHaveLength(5);
    expect(await axeViolations()).toEqual([]);
  });

  it('shows no button when five or fewer failed', async () => {
    renderApp({ path: '/schedules' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('1 schedule failed on the last run');
    expect(within(alert).queryByRole('button')).toBeNull();
  });
});
