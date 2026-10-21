import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { IDS, liveDetail } from '../../support/web/fixtures/automation';
import { armedMe, FIXED_NOW } from '../../support/web/fixtures/session';
import type { MockHandler } from '../../support/web/mock-handler';
import { axeViolations } from '../axe';
import { renderApp } from './automation/render';

// Design review of M6: a parked run read "Waiting to be resumed" while its header said "running for 20 min" and its
// details "Ended: Still running". A run that waits isn't running: the header gives its start, Ended says "Not yet".
// Resuming it refreshes the run dock and the Runs list too, so they stop saying it waits.

const STARTED = new Date(FIXED_NOW - 20 * 60_000).toISOString();
function parked() {
  const d = liveDetail('running');
  return {
    ...d,
    run: {
      ...d.run,
      status: 'awaiting_arm',
      createdAt: STARTED,
      startedAt: STARTED,
      endedAt: null,
      waitingReason: 'prearm',
      waiting: {
        kind: 'arm',
        path: 'disable',
        stepId: 'disable',
        since: STARTED,
        reason: 'prearm',
        startedAt: STARTED,
      },
    },
  };
}
const serve: MockHandler = ({ method, path }) =>
  method === 'GET' && path === `/api/runs/${IDS.liveRun}` ? { body: parked() } : undefined;

describe('run page: a parked run is not running', () => {
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

  it('says when it started, not how long it has been running, and that it has not ended', async () => {
    renderApp({ session: armedMe(), path: `/runs/${IDS.liveRun}`, handlers: [serve] });
    const h1 = await screen.findByRole('heading', { level: 1 });
    const header = h1.closest('header')!;
    expect(within(header).getByText('Waiting to be resumed')).toBeInTheDocument();
    expect(header).toHaveTextContent(/Started by you · 20 min ago/);
    expect(header).not.toHaveTextContent(/running for/);
    const ended = screen.getByText('Ended');
    expect(ended.nextElementSibling).toHaveTextContent('Not yet');
    expect(screen.queryByText('Still running')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('resuming refreshes the run dock and the Runs list as well as the run', async () => {
    const { queryClient } = renderApp({
      session: armedMe(),
      path: `/runs/${IDS.liveRun}`,
      handlers: [serve],
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const banner = (await screen.findByText('Paused: check this run is yours, then resume it'))
      .parentElement!;
    await userEvent.click(within(banner).getByRole('button', { name: 'Resume run' }));
    const keys = () => invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    await waitFor(() => expect(keys()).toContain(JSON.stringify(['runs', 'active'])));
    expect(keys()).toContain(JSON.stringify(['runs', 'list']));
    expect(keys()).toContain(JSON.stringify(['runs', 'detail', IDS.liveRun]));
  });
});
