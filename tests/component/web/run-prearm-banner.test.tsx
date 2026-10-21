import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { IDS, liveDetail } from '../../support/web/fixtures/automation';
import { armedMe, FIXED_NOW } from '../../support/web/fixtures/session';
import type { MockHandler } from '../../support/web/mock-handler';
import { axeViolations } from '../axe';
import { renderApp } from './automation/render';

// S-08: a run started before its session last turned write access on changes nothing until its person resumes it.
// The run page says why it waits and asks them to check it's theirs (`waiting.reason: 'prearm'`), instead of the
// plain "write access is on, resume" banner.

type Detail = ReturnType<typeof liveDetail>;
/** A callout's text and actions, found by its title. */
const callout = async (title: string) => (await screen.findByText(title)).parentElement!;
const STARTED = new Date(FIXED_NOW - 20 * 60_000).toISOString();

const serve =
  (id: string, body: unknown): MockHandler =>
  ({ method, path }) =>
    method === 'GET' && path === `/api/runs/${id}` ? { body } : undefined;

function prearmed(owner?: { initiatorUpn: string; initiatorOid: string }): Detail {
  const d = liveDetail('running');
  return {
    ...d,
    run: {
      ...d.run,
      ...(owner ?? {}),
      ...(owner ? { access: 'metadata' } : {}),
      status: 'awaiting_arm',
      startedAt: STARTED,
      waiting: {
        kind: 'arm',
        path: 'disable',
        stepId: 'disable',
        since: STARTED,
        reason: 'prearm',
        startedAt: STARTED,
      },
    },
  } as unknown as Detail;
}

describe('run page: a run started before write access was turned on', () => {
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

  it('asks its person to check it is theirs, says when it started, and resumes it', async () => {
    const { calls } = renderApp({
      session: armedMe(),
      path: `/runs/${IDS.liveRun}`,
      handlers: [serve(IDS.liveRun, prearmed())],
    });
    const banner = await callout('Paused: check this run is yours, then resume it');
    expect(banner).toHaveTextContent(
      /before you last armed write access, so nothing changes until you resume it/,
    );
    expect(banner).toHaveTextContent(/Check the playbook, its inputs and the start time are yours/);
    expect(screen.getByText('Waiting to be resumed')).toBeInTheDocument();
    expect(banner).toHaveTextContent(/If you don’t recognise it, cancel it/);
    const when = within(banner).getByText('20 min ago');
    expect(when.closest('time')).toHaveAttribute('dateTime', STARTED);
    expect(screen.queryByText(/Write access is on\. Resume to continue/)).not.toBeInTheDocument();
    await userEvent.click(within(banner).getByRole('button', { name: 'Resume run' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === `/api/runs/${IDS.liveRun}/resume`)).toBe(
        true,
      ),
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('read-only again, it offers to arm first', async () => {
    renderApp({ path: `/runs/${IDS.liveRun}`, handlers: [serve(IDS.liveRun, prearmed())] });
    const banner = await callout('Paused: check this run is yours, then resume it');
    expect(banner).toHaveTextContent(/Arm write access, then resume it\. It started/);
    expect(within(banner).getByRole('button', { name: 'Arm write access' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume run' })).not.toBeInTheDocument();
  });

  it('someone else sees who it waits for, without the buttons', async () => {
    renderApp({
      session: armedMe(),
      path: `/runs/${IDS.liveRun}`,
      handlers: [
        serve(IDS.liveRun, prearmed({ initiatorUpn: 'r.patel@example.com', initiatorOid: IDS.rPatel })),
      ],
    });
    expect(await screen.findByText('Paused until r.patel@example.com resumes it')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume run' })).not.toBeInTheDocument();
  });
});
