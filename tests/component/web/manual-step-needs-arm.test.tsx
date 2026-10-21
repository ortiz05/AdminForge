import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { IDS, runbookRunDetail } from '../../support/web/fixtures/automation';
import { FIXED_NOW } from '../../support/web/fixtures/session';
import type { MockHandler } from '../../support/web/mock-handler';
import { axeViolations } from '../axe';
import { renderApp } from './automation/render';

// Marking a manual step done when write steps follow it needs write access (the API answers 403 `not_armed`, as for
// approving such a gate): the step card asks to arm, with the button, instead of showing an error.

const serve =
  (id: string, body: unknown): MockHandler =>
  ({ method, path }) =>
    method === 'GET' && path === `/api/runs/${id}` ? { body } : undefined;
/** A callout's text and actions, found by its title. */
const callout = async (title: string) => (await screen.findByText(title)).parentElement!;

describe('runbook: marking a step done that has writes after it', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a refusal for lack of write access offers to arm, instead of an error', async () => {
    const refuse: MockHandler = ({ method, path }) =>
      method === 'POST' && path === `/api/runs/${IDS.runbookRun}/manual/mailbox`
        ? {
            status: 403,
            body: {
              error: {
                code: 'not_armed',
                message: 'The steps after this one change data and will run as you.',
                hint: 'Arm write access, then confirm.',
              },
            },
          }
        : undefined;
    renderApp({
      path: `/runbooks/identity.offboard-leaver?run=${IDS.runbookRun}`,
      handlers: [serve(IDS.runbookRun, runbookRunDetail()), refuse],
    });
    const done = await screen.findByRole('button', { name: 'Mark done' });
    for (const label of ['Mailbox converted to shared', 'Manager has Full Access'])
      await userEvent.click(
        screen.getAllByRole('checkbox', { name: label }).find((c) => !c.hasAttribute('disabled'))!,
      );
    await userEvent.click(done);
    const prompt = await callout('Marking this done needs write access');
    expect(prompt).toHaveTextContent('The steps after this one change the tenant and run as you.');
    expect(within(prompt).getByRole('button', { name: 'Arm write access' })).toBeInTheDocument();
    expect(screen.queryByText('That wasn’t recorded')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('when writes follow the step, it says so up front, locks Mark done until armed, then moves focus to it', async () => {
    const detail = runbookRunDetail();
    const withWrites = {
      ...detail,
      tasks: detail.tasks.map((t) => ({ ...t, policy: { ...t.policy, writesAfter: true } })),
    };
    const { state } = renderApp({
      path: `/runbooks/identity.offboard-leaver?run=${IDS.runbookRun}`,
      handlers: [serve(IDS.runbookRun, withWrites)],
    });
    const prompt = await callout('Marking this done needs write access');
    expect(prompt.closest('[role="alert"]')).toBeNull(); // said up front, not as an error
    const done = screen.getByRole('button', { name: 'Mark done' });
    for (const label of ['Mailbox converted to shared', 'Manager has Full Access'])
      await userEvent.click(
        screen.getAllByRole('checkbox', { name: label }).find((c) => !c.hasAttribute('disabled'))!,
      );
    expect(done).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(done);
    expect(state.manual).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });
});
