import { screen, within } from '@testing-library/react';
import { runStatusView } from '@adminforge/web/src/runs/status';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { IDS, runbookRunDetail } from '../../support/web/fixtures/automation';
import { armedMe, FIXED_NOW } from '../../support/web/fixtures/session';
import type { MockHandler } from '../../support/web/mock-handler';
import { axeViolations } from '../axe';
import { renderApp } from './automation/render';

// M6 (design review): a run started before its session last turned write access on (S-08) read "Waiting to be resumed"
// on its run page but "Needs write access" in the Runs list, the run dock and on its runbook page, which also had no
// banner. One label now comes from the run's waiting reason everywhere, and the runbook page shows the run page's
// banner.

const ME_OID = '0b9e7c2d-41a5-4f68-b3d1-7e2c5a9f0d16';
const at = (ms: number) => new Date(FIXED_NOW + ms).toISOString();
const STARTED = at(-20 * 60_000);
const PREARM = 'c7a1e2d3-0001-4b5c-9d6e-7f8a9b0c1d2e';
const NEEDS_ARM = 'c7a1e2d3-0002-4b5c-9d6e-7f8a9b0c1d2e';

const row = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'playbook',
  definitionKey: 'identity.disable-user',
  definitionVersion: '1.0.0',
  title,
  status: 'awaiting_arm',
  dryRun: false,
  trigger: 'interactive',
  identity: 'delegated',
  identityName: null,
  initiatorOid: ME_OID,
  initiatorUpn: 'mock.engineer@example.com',
  parentRunId: null,
  scheduleId: null,
  createdAt: STARTED,
  startedAt: STARTED,
  endedAt: null,
  updatedAt: STARTED,
  ...extra,
});
const LIST = {
  items: [
    row(PREARM, 'Started before arming', { waitingReason: 'prearm' }),
    row(NEEDS_ARM, 'Write access ended'),
  ],
};
const listRuns: MockHandler = ({ method, path }) =>
  method === 'GET' && path === '/api/runs' ? { body: LIST } : undefined;

function prearmRunbookRun() {
  const d = runbookRunDetail();
  return {
    ...d,
    run: {
      ...d.run,
      status: 'awaiting_arm',
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
    tasks: [],
  };
}

describe('one label for a run that waits to be resumed', () => {
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

  it('comes from the waiting reason: prearm waits to be resumed, any other wait for arming needs write access', () => {
    expect(runStatusView('awaiting_arm', 'prearm')).toEqual({ tone: 'warn', label: 'Waiting to be resumed' });
    expect(runStatusView('awaiting_arm', null).label).toBe('Needs write access');
    expect(runStatusView('awaiting_arm').label).toBe('Needs write access');
    // Only a run waiting for write access has that reason.
    expect(runStatusView('running', 'prearm').label).toBe('Running');
  });

  it('the Runs list and the run dock say it as the run page does', async () => {
    renderApp({ path: '/runs', handlers: [listRuns] });
    const table = await screen.findByRole('grid');
    const prearm = (await within(table).findByText('Started before arming')).closest('[role="row"]')!;
    expect(within(prearm as HTMLElement).getByText('Waiting to be resumed')).toBeInTheDocument();
    const ended = within(table).getByText('Write access ended').closest('[role="row"]')!;
    expect(within(ended as HTMLElement).getByText('Needs write access')).toBeInTheDocument();

    const dock = screen.getByRole('list', { name: 'Active and recent runs' });
    expect(
      within(dock).getByRole('link', { name: /^Started before arming: Waiting to be resumed/ }),
    ).toBeInTheDocument();
    expect(
      within(dock).getByRole('link', { name: /^Write access ended: Needs write access/ }),
    ).toBeInTheDocument();
  });

  it('the runbook page shows the same label and the run page’s banner', async () => {
    const { calls } = renderApp({
      session: armedMe(),
      path: `/runbooks/identity.offboard-leaver?run=${IDS.runbookRun}`,
      handlers: [
        ({ method, path }) =>
          method === 'GET' && path === `/api/runs/${IDS.runbookRun}`
            ? { body: prearmRunbookRun() }
            : undefined,
      ],
    });
    const banner = (await screen.findByText('Paused: check this run is yours, then resume it'))
      .parentElement!;
    expect(screen.getByText('Waiting to be resumed')).toBeInTheDocument();
    expect(screen.queryByText('Needs write access')).not.toBeInTheDocument();
    expect(banner).toHaveTextContent(/Check the runbook, its inputs and the start time are yours/);
    within(banner).getByRole('button', { name: 'Resume run' }).click();
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === `/api/runs/${IDS.runbookRun}/resume`)).toBe(
        true,
      ),
    );
    expect(await axeViolations()).toEqual([]);
  });
});
