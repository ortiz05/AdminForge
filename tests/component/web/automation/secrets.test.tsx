import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { __resetClaimedSecretsForTests } from '@adminforge/web/src/runs/secrets';
import { CHILD_TAP_VALUE, IDS, secretMessage, TAP_VALUE } from '../../../support/web/fixtures/automation';
import { axeViolations } from '../../axe';
import { FakeEventSource } from './fake-event-source';
import { renderApp } from './render';

const stream = async (run: string) => {
  await waitFor(() => expect(FakeEventSource.last(`/api/runs/${run}/events`)).toBeDefined());
  return FakeEventSource.last(`/api/runs/${run}/events`)!;
};

describe('Show-once secrets on the run page', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
    __resetClaimedSecretsForTests();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a live secret message (no id) shows a masked, copyable, dismissable panel; stored outputs stay masked', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp({ path: `/runs/${IDS.tapRun}` });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Issue Temporary Access Pass' }),
    ).toBeInTheDocument();
    // Masked in stored outputs, with the explanation.
    expect(screen.getAllByText(/•••• one-time use · valid 60 min/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Shown once to the person who ran this/).length).toBeGreaterThan(0);

    const es = await stream(IDS.tapRun);
    // The stream already used ids for other events; the secret has none and must not be dropped as a duplicate.
    act(() =>
      es.emit(
        {
          id: 1,
          type: 'log',
          ts: '2026-10-15T14:00:00Z',
          stepSeq: 2,
          data: { level: 'info', message: 'issued', path: 'issue' },
        },
        { id: '1' },
      ),
    );
    act(() => es.emit(secretMessage(), { id: '1' }));
    const panel = await screen.findByRole('region', { name: 'Copy now — it won’t be shown again' });
    expect(within(panel).getByText(/From “Issue the Temporary Access Pass”/)).toBeInTheDocument();
    expect(within(panel).queryByText(TAP_VALUE)).not.toBeInTheDocument();
    expect(within(panel).getByText('One-time use · valid for 60 minutes')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);

    await userEvent.click(within(panel).getByRole('button', { name: 'Show Temporary access pass' }));
    expect(within(panel).getByText(TAP_VALUE)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Hide Temporary access pass' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Copy Temporary access pass' }));
    expect(writeText).toHaveBeenCalledWith(TAP_VALUE);

    await userEvent.click(within(panel).getByRole('button', { name: 'I’ve copied it — dismiss' }));
    expect(
      screen.queryByRole('region', { name: 'Copy now — it won’t be shown again' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(TAP_VALUE)).not.toBeInTheDocument();
    // Nothing persisted outside memory.
    expect(JSON.stringify(localStorage)).not.toContain(TAP_VALUE);
    expect(window.location.href).not.toContain(TAP_VALUE);
  });

  it('a child run’s secret reaches the parent stream and says where it came from', async () => {
    renderApp({ path: `/runs/${IDS.onboardRun}` });
    await screen.findByRole('heading', { level: 1, name: 'Onboard a new starter' });
    const es = await stream(IDS.onboardRun);
    act(() => es.emit(secretMessage(IDS.onboardChild, CHILD_TAP_VALUE)));
    const panel = await screen.findByRole('region', { name: 'Copy now — it won’t be shown again' });
    expect(
      within(panel).getByText(/From “Issue Temporary Access Pass · Issue” \(child run\)/),
    ).toBeInTheDocument();
  });

  it('a replayed "held" notice claims the secret once, with the CSRF header', async () => {
    const { calls } = renderApp({ path: `/runs/${IDS.onboardRun}` });
    await screen.findByRole('heading', { level: 1, name: 'Onboard a new starter' });
    const es = await stream(IDS.onboardRun);
    const held = {
      runId: IDS.onboardChild,
      stepId: 'issue',
      stepPath: 'issue',
      fields: ['temporaryAccessPass'],
      status: 'held',
    };
    act(() =>
      es.emit(
        {
          id: 1,
          type: 'log',
          stepSeq: 2,
          data: { level: 'info', message: 'held', path: 'tap', secret: held },
        },
        { id: '1' },
      ),
    );
    act(() =>
      es.emit(
        {
          id: 2,
          type: 'log',
          stepSeq: 2,
          data: { level: 'info', message: 'held again', path: 'tap', secret: held },
        },
        { id: '2' },
      ),
    );
    const panel = await screen.findByRole('region', { name: 'Copy now — it won’t be shown again' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Show Temporary access pass' }));
    expect(within(panel).getByText(CHILD_TAP_VALUE)).toBeInTheDocument();
    const claims = calls.filter((c) => c.url === `/api/runs/${IDS.onboardChild}/secret/issue`);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ method: 'GET', csrf: 'e2e-csrf-token' });
  });

  it('a held secret that was already taken says so', async () => {
    renderApp({
      path: `/runs/${IDS.onboardRun}`,
      handlers: [
        ({ path }) =>
          path.endsWith('/secret/issue')
            ? {
                status: 404,
                body: {
                  error: {
                    code: 'secret_not_available',
                    message: 'This secret was already shown or has expired.',
                  },
                },
              }
            : undefined,
      ],
    });
    await screen.findByRole('heading', { level: 1, name: 'Onboard a new starter' });
    const es = await stream(IDS.onboardRun);
    act(() =>
      es.emit(
        {
          id: 1,
          type: 'log',
          data: {
            message: 'held',
            secret: {
              runId: IDS.onboardChild,
              stepId: 'issue',
              stepPath: 'issue',
              fields: ['temporaryAccessPass'],
              status: 'held',
            },
          },
        },
        { id: '1' },
      ),
    );
    expect(await screen.findByText('This secret was already shown or has expired.')).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Copy now — it won’t be shown again' }),
    ).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('a delivered secret seen on replay is explained, not fetched', async () => {
    const { calls } = renderApp({ path: `/runs/${IDS.tapRun}` });
    await screen.findByRole('heading', { level: 1, name: 'Issue Temporary Access Pass' });
    const es = await stream(IDS.tapRun);
    act(() =>
      es.emit(
        {
          id: 3,
          type: 'log',
          data: {
            message: 'issued',
            secret: {
              runId: IDS.tapRun,
              stepId: 'issue',
              stepPath: 'issue',
              fields: ['temporaryAccessPass'],
              status: 'delivered',
            },
          },
        },
        { id: '3' },
      ),
    );
    expect(
      await screen.findByText(/shown once to the person who ran this and isn’t available any more/),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/secret/'))).toBe(false);
  });
});
