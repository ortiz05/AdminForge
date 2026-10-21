import { screen, within } from '@testing-library/react';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import {
  approvalRunDetail,
  failedDetail,
  IDS,
  liveDetail,
  offboardRunbook,
  runbookRunDetail,
} from '../../support/web/fixtures/automation';
import { FIXED_NOW } from '../../support/web/fixtures/session';
import { axeViolations } from '../axe';
import { renderApp } from './automation/render';
import type { MockHandler } from '../../support/web/mock-handler';

// S-25: someone else's delegated run shows what ran, who, when and how each step ended — not what it ran with or
// found. The page says who can see the rest instead of showing empty panels.

const HIDDEN =
  'The details are shown only to the person who started this run, its approvers and Portal Admins.';
/** Someone other than the signed-in engineer (mock.engineer@example.com). */
const OWNER = { initiatorUpn: 'r.patel@example.com', initiatorOid: IDS.rPatel };

type Detail = ReturnType<typeof failedDetail>;

/** The run as the API sends it to a metadata-only viewer (runs/views.ts). */
function metadataOnly<T extends Detail>(d: T): T {
  const hide = (e: { code: string; status?: number; requestId?: string; stepId?: string } | null) =>
    e && {
      code: e.code,
      message: HIDDEN,
      ...(e.status ? { status: e.status } : {}),
      ...(e.requestId ? { requestId: e.requestId } : {}),
      ...(e.stepId ? { stepId: e.stepId } : {}),
    };
  return {
    ...d,
    run: { ...d.run, ...OWNER, access: 'metadata', inputs: {}, outputs: null, error: hide(d.run.error) },
    steps: d.steps.map((s) => ({ ...s, request: null, plan: null, output: null, error: hide(s.error) })),
    plan: [],
  };
}

const serve =
  (id: string, body: unknown): MockHandler =>
  ({ method, path }) =>
    method === 'GET' && path === `/api/runs/${id}` ? { body } : undefined;

describe('run page: someone else’s delegated run (S-25)', () => {
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

  it('says who can see the inputs and results, and shows the steps, states and references', async () => {
    renderApp({
      path: `/runs/${IDS.failedRun}`,
      handlers: [serve(IDS.failedRun, metadataOnly(failedDetail()))],
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Disable sign-in' })).toBeInTheDocument();
    const note = await screen.findByText('Only r.patel@example.com can see the inputs and results');
    expect(note.closest('div')!.parentElement).toHaveTextContent(/approvers and Portal Admins/);
    // What ran, when, and how each step ended.
    const steps = await screen.findByRole('list', { name: 'Steps of Disable sign-in' });
    expect(within(steps).getByText('Set accountEnabled to false')).toBeInTheDocument();
    // A failed step names its error code; the message it would have shown isn't sent.
    expect(within(steps).getByText('Authorization_RequestDenied')).toBeInTheDocument();
    expect(within(steps).queryByText(HIDDEN)).not.toBeInTheDocument();
    // The failure keeps its code and references, not what it said.
    const alert = (await screen.findAllByRole('alert')).find((a) =>
      a.textContent?.includes('The run failed'),
    )!;
    expect(alert).toHaveTextContent('Authorization_RequestDenied');
    expect(within(alert).getByRole('button', { name: /Copy Microsoft request-id/ })).toBeInTheDocument();
    expect(alert).not.toHaveTextContent('Microsoft Graph refused this change');
    // …and doesn't repeat the note in its own words.
    expect(alert).not.toHaveTextContent(HIDDEN);
    // No empty Inputs, Result or Logs panels.
    expect(screen.queryByText('What it ran with')).not.toBeInTheDocument();
    expect(screen.queryByText('Step output')).not.toBeInTheDocument();
    expect(screen.queryByText(/INC-4790/)).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('the initiator (full access) sees the inputs and no note', async () => {
    renderApp({ path: `/runs/${IDS.failedRun}` });
    expect(await screen.findByText('What it ran with')).toBeInTheDocument();
    expect(screen.getByText('INC-4790 suspicious sign-ins')).toBeInTheDocument();
    expect(screen.queryByText(/can see the inputs and results/)).not.toBeInTheDocument();
  });

  it('a pending approval shows who is asked, without the message, to an Operator who isn’t', async () => {
    const detail = approvalRunDetail();
    const restricted = {
      ...metadataOnly(detail as unknown as Detail),
      tasks: detail.tasks.map((t) => ({ ...t, canDecide: false, policy: { ...t.policy, message: null } })),
    };
    renderApp({ path: `/runs/${IDS.approvalRun}`, handlers: [serve(IDS.approvalRun, restricted)] });
    expect(
      await screen.findByText('Only r.patel@example.com can see the inputs and results'),
    ).toBeInTheDocument();
    const card = await screen.findByRole('article', { name: /Approval: Disable sign-in/ });
    expect(within(card).queryByText(/contract ended early/)).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Approve and continue' })).not.toBeInTheDocument();
    // Cancelling is for the person who started it (or a Portal Admin).
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('a run paused for its initiator’s write access says who it waits for, without their buttons', async () => {
    const detail = liveDetail('running') as unknown as Detail;
    const parked = metadataOnly({
      ...detail,
      run: {
        ...detail.run,
        status: 'awaiting_arm',
        waiting: { kind: 'arm', path: 'disable', stepId: 'disable', since: null },
      },
    } as unknown as Detail);
    renderApp({ path: `/runs/${IDS.liveRun}`, handlers: [serve(IDS.liveRun, parked)] });
    expect(await screen.findByText('Paused until r.patel@example.com arms write access')).toBeInTheDocument();
    expect(screen.queryByText(/Paused: the next step changes your tenant/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume run' })).not.toBeInTheDocument();
  });

  it('a runbook run: the note, and no checklist to tick for someone it isn’t waiting for', async () => {
    const detail = runbookRunDetail();
    const restricted = metadataOnly(detail as unknown as Detail);
    renderApp({
      path: `/runbooks/identity.offboard-leaver?run=${IDS.runbookRun}`,
      handlers: [serve(IDS.runbookRun, restricted)],
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Offboard a leaver' })).toBeInTheDocument();
    expect(
      await screen.findByText('Only r.patel@example.com can see the inputs and results'),
    ).toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: 'Runbook progress' });
    expect(await within(rail).findByRole('link', { name: /Confirm the request.*done/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();
    expect(
      screen.getByText('Waiting for r.patel@example.com to work through this checklist.'),
    ).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('runbook text shows “(hidden)” where it would show the run’s inputs', async () => {
    const templated = {
      ...offboardRunbook,
      sections: offboardRunbook.sections.map((x, i) =>
        i === 0 ? { ...x, body: 'Leaver ticket: **${ inputs.ticket }**.' } : x,
      ),
    };
    const definition: MockHandler = ({ method, path }) =>
      method === 'GET' && path === '/api/definitions/runbook/identity.offboard-leaver'
        ? { body: templated }
        : undefined;
    const path = `/runbooks/identity.offboard-leaver?run=${IDS.runbookRun}`;
    const restricted = metadataOnly(runbookRunDetail() as unknown as Detail);
    const view = renderApp({ path, handlers: [definition, serve(IDS.runbookRun, restricted)] });
    const hidden = await screen.findByText('(hidden)');
    expect(hidden.closest('p')).toHaveTextContent('Leaver ticket: (hidden).');
    expect(screen.queryByText(/HR-2231/)).not.toBeInTheDocument();
    view.unmount();
    vi.unstubAllGlobals();
    // The initiator's own view fills it in.
    renderApp({ path, handlers: [definition] });
    expect(await screen.findByText('HR-2231')).toBeInTheDocument();
  });
});
