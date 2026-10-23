import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { axeViolations } from '../../axe';
import { renderApp } from './render';

// Monitoring (Overview › Monitoring): one filter bar narrows the health checks and the schedules together — by
// service, function, tag and text, kept in the URL — and the key figures count what the filters let through.
const main = () => screen.getByRole('main');
const checks = () => within(main()).getByRole('region', { name: /^Health checks/ });
const schedules = () => within(main()).getByRole('region', { name: /^Schedules and reports/ });
const tiles = () =>
  within(checks()).queryAllByRole('button', { name: /: (Healthy|Degraded|Failing|No data)/ });

describe('Monitoring filters', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });

  it('shows everything: checks, the last 24 hours and the schedules', async () => {
    renderApp({ path: '/monitoring' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Monitoring' })).toBeInTheDocument();
    expect(
      await within(main()).findByRole('region', { name: 'Health over the last 24 hours' }),
    ).toBeInTheDocument();
    expect(await within(schedules()).findByText('Monthly licence usage')).toBeInTheDocument();
    expect(within(schedules()).getByText('Content health')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('narrows by function from the URL: synthetic transactions only, no schedule does that', async () => {
    renderApp({ path: '/monitoring?fn=transactions' });
    await screen.findByRole('main');
    await within(main()).findByRole('region', { name: /^Health checks · 3/ });
    expect(tiles().map((t) => t.getAttribute('aria-label') ?? t.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Mail flow/),
        expect.stringMatching(/^SharePoint files/),
        expect.stringMatching(/^Teams meetings/),
      ]),
    );
    expect(await within(schedules()).findByText('No schedules match')).toBeInTheDocument();
  });

  it('narrows by service: a probe sweep belongs to the services of its probes', async () => {
    renderApp({ path: '/monitoring?group=identity' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Monitoring' })).toBeInTheDocument();
    expect(await within(schedules()).findByText('Weekly app credential expiry report')).toBeInTheDocument();
    expect(within(schedules()).getByText('Disable stale guest accounts')).toBeInTheDocument();
    expect(within(schedules()).queryByText('Monthly licence usage')).not.toBeInTheDocument();
  });

  it('picks a function in the filter bar and searches across both lists', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/monitoring' });
    await screen.findByRole('main');
    await waitFor(() => expect(within(schedules()).getByText('Monthly licence usage')).toBeInTheDocument());
    // The filter bar's Function facet (the table's Function column header comes later in the page).
    await user.click(within(main()).getAllByRole('button', { name: /^Function/ })[0]!);
    await user.click(await screen.findByRole('checkbox', { name: /^Reports/ }));
    await waitFor(() => expect(within(schedules()).queryByText('Content health')).not.toBeInTheDocument());
    expect(within(schedules()).getByText('Monthly licence usage')).toBeInTheDocument();
    expect(within(main()).getByRole('region', { name: /^Health checks · 0/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // The filter bar's Clear (an empty list below offers Clear filters too).
    await user.click(within(main()).getAllByRole('button', { name: /clear/i })[0]!);
    await user.type(within(main()).getByPlaceholderText('Search checks and schedules…'), 'licence');
    await waitFor(() => expect(within(schedules()).queryByText('Content health')).not.toBeInTheDocument());
    expect(within(schedules()).getByText('Monthly licence usage')).toBeInTheDocument();
    expect(tiles().every((t) => /licen/i.test(t.textContent ?? ''))).toBe(true);
  });
});
