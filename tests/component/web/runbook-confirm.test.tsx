import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { IDS } from '../../support/web/fixtures/automation';
import { FIXED_NOW, me } from '../../support/web/fixtures/session';
import { axeViolations } from '../axe';
import { renderApp } from './automation/render';

// A runbook with a `confirm` block (identity.leaver, identity.compromised-account) starts only from a preview, like a
// playbook: the runbook page posted `dryRun: false` without one, and the API answered 409 `preview_required`. Now it
// previews (reads run, checklists are skipped, writes are planned), shows the plan, and asks for the confirmation the
// API rendered from the preview before it starts the run with that preview.

const START = `/runbooks/identity.offboard-leaver?userId=${IDS.jDoe}&ticket=HR-2231`;

describe('runbook: preview, then confirm, then start', () => {
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

  it('previews, shows what it will change, confirms with the rendered message, and starts from the preview', async () => {
    const { state, router } = renderApp({ path: START });
    expect(await screen.findByText('Jordan Doe')).toBeInTheDocument();
    // Without a preview, Start says why it can't go yet and sends nothing.
    const start = await screen.findByRole('button', { name: 'Start runbook' });
    await userEvent.click(start);
    expect(
      screen.getByText('Preview first: the plan shows every change before it runs.'),
    ).toBeInTheDocument();
    expect(state.runPosts).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Preview (dry run)' }));
    const preview = await screen.findByRole('region', { name: 'Preview' });
    expect(await within(preview).findByText('Disable sign-in and revoke sessions')).toBeInTheDocument();
    expect(within(preview).getByText('Remove all licences')).toBeInTheDocument();
    // The checklists were skipped by the dry run: they aren't listed as checks that ran.
    expect(within(preview).queryByRole('region', { name: 'Checks that ran' })).not.toBeInTheDocument();
    expect(state.runPosts[0]).toEqual({
      playbook: 'identity.offboard-leaver',
      version: '2.1.0',
      inputs: { userId: IDS.jDoe, ticket: 'HR-2231' },
      dryRun: true,
    });

    await userEvent.click(screen.getByRole('button', { name: 'Start runbook' }));
    const dialog = await screen.findByRole('dialog', { name: 'Offboard a leaver?' });
    expect(
      within(dialog).getByText('Start the leaver process for j.doe@example.com (HR-2231)?'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/\$\{/)).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start runbook' }));

    await waitFor(() => expect(router.state.location.search).toMatchObject({ run: IDS.runbookRun }));
    expect(state.runPosts.at(-1)).toEqual({
      playbook: 'identity.offboard-leaver',
      version: '2.1.0',
      inputs: { userId: IDS.jDoe, ticket: 'HR-2231' },
      dryRun: false,
      previewRunId: IDS.runbookPreview,
    });
  });

  it('starting a write runbook doesn’t need write access: its write steps wait for it', async () => {
    const { state } = renderApp({ path: START });
    await userEvent.click(await screen.findByRole('button', { name: 'Preview (dry run)' }));
    await within(await screen.findByRole('region', { name: 'Preview' })).findByText('Remove all licences');
    const start = screen.getByRole('button', { name: 'Start runbook' });
    expect(start).not.toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByText(/Steps that change the tenant wait until write access is armed/),
    ).toBeInTheDocument();
    await userEvent.click(start);
    const dialog = await screen.findByRole('dialog', { name: 'Offboard a leaver?' });
    // Not write mode: the confirm button isn't ember.
    expect(within(dialog).getByRole('button', { name: 'Start runbook' }).className).not.toMatch(/armed/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start runbook' }));
    await waitFor(() => expect(state.runPosts).toHaveLength(2));
  });

  it('inputs edited after the preview hold Start until it is previewed again', async () => {
    renderApp({ path: START });
    await userEvent.click(await screen.findByRole('button', { name: 'Preview (dry run)' }));
    await within(await screen.findByRole('region', { name: 'Preview' })).findByText('Remove all licences');
    // Inputs edited after the preview: Start is held until the preview matches them again.
    await userEvent.type(screen.getByLabelText('HR ticket'), '9');
    expect(await screen.findByText('Inputs changed — preview again.')).toBeInTheDocument();
  });

  it('someone without the Portal Operator role can preview a write runbook but not start it', async () => {
    const { state } = renderApp({ path: START, session: me({ roles: ['Portal.Reader'], canArm: false }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Preview (dry run)' }));
    await within(await screen.findByRole('region', { name: 'Preview' })).findByText('Remove all licences');
    expect(screen.getByText('Starting this needs the Portal Operator role.')).toBeInTheDocument();
    const start = screen.getByRole('button', { name: 'Start runbook' });
    expect(start).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(start);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(state.runPosts).toHaveLength(1); // the preview only
  });
});
