import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { encodeParam } from '@adminforge/web/src/playbooks/url';
import { IDS } from '../../../support/web/fixtures/automation';
import { armedMe, FIXED_NOW, me } from '../../../support/web/fixtures/session';
import { axeViolations } from '../../axe';
import { renderApp } from './render';

const APPROVER = me({ roles: ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver'] });

describe('Runs, run page, approvals, runbooks, run dock', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
    // Fixture times (armedUntil, run timestamps) are relative to FIXED_NOW: fake only Date, timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('/runs lists my runs with status facets; Everyone’s widens the scope', async () => {
    const { calls } = renderApp({ path: '/runs' });
    const grid = await screen.findByRole('grid', { name: 'Runs' });
    expect(await within(grid).findAllByText('Disable sign-in')).not.toHaveLength(0);
    expect(within(grid).getByText('Rolled back')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/runs?scope=mine')).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: 'Everyone’s' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/runs?scope=all')).toBe(true));
    expect(await axeViolations()).toEqual([]);
  });

  it('a failed run explains the error with its hint, request id and correlation id', async () => {
    renderApp({ path: `/runs/${IDS.failedRun}` });
    expect(await screen.findByRole('heading', { level: 1, name: 'Disable sign-in' })).toBeInTheDocument();
    const alert = (await screen.findAllByRole('alert')).find((a) =>
      a.textContent?.includes('The run failed'),
    )!;
    expect(alert).toHaveTextContent('Microsoft Graph refused this change (403).');
    expect(alert).toHaveTextContent('Activate User Administrator in PIM');
    expect(within(alert).getByRole('button', { name: /Copy Microsoft request-id/ })).toBeInTheDocument();
    const steps = await screen.findByRole('list', { name: 'Steps of Disable sign-in' });
    // Named from the definition; the step that never ran is "Not started".
    expect(within(steps).getByText('Set accountEnabled to false')).toBeInTheDocument();
    expect(within(steps).getByText('Revoke refresh tokens and session cookies')).toBeInTheDocument();
    expect(within(steps).getAllByText('Not started:')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('a running run can be cancelled (with confirmation)', async () => {
    const { state } = renderApp({ path: `/runs/${IDS.liveRun}` });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel this run?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(state.cancelled).toEqual([IDS.liveRun]));
  });

  it('a run waiting for approval shows the approval panel; approving is locked until armed', async () => {
    renderApp({ session: APPROVER, path: `/runs/${IDS.approvalRun}` });
    const card = await screen.findByRole('article', { name: /Approval: Disable sign-in/ });
    expect(within(card).getByRole('button', { name: 'Approve and continue' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(card).getByText('Approving needs write access')).toBeInTheDocument();
    expect(within(card).getByText(/contract ended early/)).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('/approvals: armed approvers approve; the decision goes to the run’s step path', async () => {
    const { state } = renderApp({ session: { ...armedMe(), roles: APPROVER.roles }, path: '/approvals' });
    const card = await screen.findByRole('article', { name: 'Approval: Disable sign-in' });
    await userEvent.type(within(card).getByLabelText(/Comment/), 'Checked with HR');
    await userEvent.click(within(card).getByRole('button', { name: 'Approve and continue' }));
    await waitFor(() => expect(state.decisions).toHaveLength(1));
    expect(state.decisions[0]).toEqual({
      path: `/api/runs/${IDS.approvalRun}/approvals/%24approval`,
      body: { decision: 'approve', comment: 'Checked with HR' },
    });
  });

  it('/approvals for someone without the approver role explains instead of failing', async () => {
    renderApp({
      path: '/approvals',
      handlers: [
        ({ path }) =>
          path === '/api/approvals'
            ? {
                status: 403,
                body: {
                  error: {
                    code: 'forbidden',
                    message: 'The approval inbox needs the Playbook.Approver role.',
                  },
                },
              }
            : undefined,
      ],
    });
    expect(await screen.findByText('The approval inbox is for Playbook Approvers')).toBeInTheDocument();
  });

  it('runbook: sections, progress rail, and the manual step waiting for me', async () => {
    const { state } = renderApp({ path: `/runbooks/identity.offboard-leaver?run=${IDS.runbookRun}` });
    expect(await screen.findByRole('heading', { level: 1, name: 'Offboard a leaver' })).toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: 'Runbook progress' });
    expect(await within(rail).findByRole('link', { name: /Confirm the request.*done/ })).toBeInTheDocument();
    expect(
      within(rail).getByRole('link', { name: /Hand over mail and files.*in progress/ }),
    ).toBeInTheDocument();
    const done = await screen.findByRole('button', { name: 'Mark done' });
    for (const label of ['Mailbox converted to shared', 'Manager has Full Access'])
      await userEvent.click(
        screen.getAllByRole('checkbox', { name: label }).find((c) => !c.hasAttribute('disabled'))!,
      );
    await userEvent.click(done);
    await waitFor(() => expect(state.manual).toHaveLength(1));
    expect(state.manual[0]!.body).toEqual({ confirmed: true });
    expect(await axeViolations()).toEqual([]);
  });

  it('runbook without a run: start it with its inputs', async () => {
    const { state, router } = renderApp({ path: '/runbooks/identity.offboard-leaver' });
    await userEvent.click(await screen.findByRole('button', { name: 'Start runbook' }));
    expect(await screen.findByText('Leaver is required.')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('combobox', { name: 'Leaver' }), IDS.jDoe);
    await userEvent.click(await screen.findByRole('option', { name: /Jordan Doe/ }));
    await userEvent.type(screen.getByLabelText('HR ticket'), 'HR-2231');
    await userEvent.click(screen.getByRole('button', { name: 'Start runbook' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ run: IDS.runbookRun }));
    expect(state.runPosts[0]).toEqual({
      playbook: 'identity.offboard-leaver',
      version: '2.1.0',
      inputs: { userId: IDS.jDoe, ticket: 'HR-2231' },
      dryRun: false,
    });
  });

  it('runbook links prefill the start form (plain params and base64url inputs), validated first', async () => {
    renderApp({ path: `/runbooks/identity.offboard-leaver?userId=${IDS.jDoe}&ticket=HR-2231` });
    expect(await screen.findByText('Jordan Doe')).toBeInTheDocument();
    expect(screen.getByLabelText('HR ticket')).toHaveValue('HR-2231');
    expect(screen.queryByText('Check the prefilled values')).not.toBeInTheDocument();
  });

  it('runbook prefill: base64url inputs; invalid values are dropped and explained', async () => {
    renderApp({
      path: `/runbooks/identity.offboard-leaver?userId=nope&inputs=${encodeParam({ ticket: 'HR-77' })}`,
    });
    expect(await screen.findByText('Check the prefilled values')).toBeInTheDocument();
    expect(screen.getByText('The link’s Leaver wasn’t used: Expected a GUID.')).toBeInTheDocument();
    expect(screen.getByLabelText('HR ticket')).toHaveValue('HR-77');
    expect(screen.getByRole('combobox', { name: 'Leaver' })).toHaveValue('');
    expect(await axeViolations()).toEqual([]);
  });

  it('the run dock shows my active runs and links to them', async () => {
    renderApp();
    const dock = await screen.findByRole('contentinfo', { name: 'Runs' });
    const link = await within(dock).findByRole('link', { name: /Disable sign-in: Awaiting approval/ });
    expect(link).toHaveAttribute('href', `/runs/${IDS.approvalRun}`);
    expect(within(dock).getByLabelText('3 active')).toBeInTheDocument();
  });
});
