import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { playbookHref } from '@adminforge/web/src/playbooks/url';
import { IDS } from '../../../support/web/fixtures/automation';
import { armedMe, FIXED_NOW } from '../../../support/web/fixtures/session';
import { axeViolations } from '../../axe';
import { renderApp } from './render';

const disableLink = (inputs: Record<string, unknown>) =>
  playbookHref({ playbook: 'identity.disable-user', inputs }, '/');

describe('Playbook drawer', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
    // Fixture times are relative to FIXED_NOW; only Date is faked, timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens from the URL, generates the form from inputs, and locks Run in read mode', async () => {
    renderApp({ path: disableLink({ userId: IDS.aLee }) });
    const drawer = await screen.findByRole('dialog', { name: 'Disable sign-in' });
    expect(within(drawer).getByText('Changes your tenant · High risk')).toBeInTheDocument();
    // The entity picker resolves the prefilled id to a person.
    expect(await within(drawer).findByText('Adele Lee')).toBeInTheDocument();
    expect(within(drawer).getByLabelText(/Reason/)).toHaveValue('');
    const run = within(drawer).getByRole('button', { name: 'Disable sign-in' });
    expect(run).toHaveAttribute('aria-disabled', 'true');
    expect(run).toHaveAccessibleDescription(/Arm write access to use this\./);
    expect(within(drawer).getByText('Needs write access.')).toBeInTheDocument();
    // Requirements: the portal role is held; User Administrator is only eligible.
    expect(
      await within(drawer).findByText('Activate User Administrator in PIM to use this'),
    ).toBeInTheDocument();
    expect(within(drawer).getByText('You have it')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('validates on Preview with zod (field errors in words) and sends nothing until valid', async () => {
    const { state } = renderApp({ path: disableLink({ userId: IDS.aLee }) });
    const drawer = await screen.findByRole('dialog', { name: 'Disable sign-in' });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Preview (dry run)' }));
    expect(await within(drawer).findByText('Reason is required.')).toBeInTheDocument();
    expect(state.runPosts).toHaveLength(0);
    await userEvent.type(within(drawer).getByLabelText(/Reason/), 'short');
    expect(await within(drawer).findByText('Must be at least 10 characters.')).toBeInTheDocument();
    await userEvent.type(within(drawer).getByLabelText(/Reason/), ' but now long enough');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Preview (dry run)' }));
    await waitFor(() => expect(state.runPosts).toHaveLength(1));
    expect(state.runPosts[0]).toEqual({
      playbook: 'identity.disable-user',
      version: '1.0.0',
      inputs: { userId: IDS.aLee, reason: 'short but now long enough' },
      dryRun: true,
    });
  });

  it('shows the dry-run plan and the read checks that ran', async () => {
    renderApp({ path: disableLink({ userId: IDS.aLee, reason: 'INC-4821 account compromised' }) });
    const drawer = await screen.findByRole('dialog', { name: 'Disable sign-in' });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Preview (dry run)' }));
    const plan = await within(drawer).findByRole('region', { name: 'What this run will change' });
    expect(within(plan).getByText('2 changes')).toBeInTheDocument();
    expect(within(plan).getByText('Set accountEnabled to false')).toBeInTheDocument();
    expect(within(plan).getByText(`/users/${IDS.aLee}/revokeSignInSessions`)).toBeInTheDocument();
    await userEvent.click(within(plan).getByRole('button', { name: 'Show request body' }));
    expect(within(plan).getByRole('region', { name: 'Request body (redacted)' })).toHaveTextContent(
      '"accountEnabled": false',
    );
    const checks = within(drawer).getByRole('region', { name: 'Checks that ran' });
    expect(within(checks).getByText('Look up the user')).toBeInTheDocument();
    expect(within(checks).getByText('Check the account is enabled')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('armed: typed confirmation with the user’s sign-in name, then the run starts and opens', async () => {
    const { state, router } = renderApp({
      session: armedMe(),
      path: disableLink({ userId: IDS.aLee, reason: 'INC-4821 account compromised' }),
    });
    const drawer = await screen.findByRole('dialog', { name: 'Disable sign-in' });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Preview (dry run)' }));
    await within(drawer).findByRole('region', { name: 'What this run will change' });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Disable sign-in' }));
    const confirm = await screen.findByRole('dialog', { name: 'Disable sign-in?' });
    const go = within(confirm).getByRole('button', { name: 'Disable sign-in' });
    await userEvent.click(go);
    expect(state.runPosts).toHaveLength(1);
    await userEvent.type(within(confirm).getByLabelText(/to confirm/), 'a.lee@example.com');
    await userEvent.click(go);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/runs/${IDS.liveRun}`));
    expect(state.runPosts[1]).toMatchObject({
      dryRun: false,
      version: '1.0.0',
      previewRunId: IDS.previewRun,
      confirmation: 'a.lee@example.com',
    });
  });

  it('preview then confirm: shows when the preview expires; any edit invalidates it', async () => {
    renderApp({
      session: armedMe(),
      path: disableLink({ userId: IDS.aLee, reason: 'INC-4821 account compromised' }),
    });
    const drawer = await screen.findByRole('dialog', { name: 'Disable sign-in' });
    const run = within(drawer).getByRole('button', { name: 'Disable sign-in' });
    expect(run).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Preview (dry run)' }));
    await within(drawer).findByRole('region', { name: 'What this run will change' });
    expect(within(drawer).getByText('Preview expires in 15 min.')).toBeInTheDocument();
    expect(run).not.toHaveAttribute('aria-disabled');
    await userEvent.type(within(drawer).getByLabelText(/Reason/), '!');
    expect(await within(drawer).findAllByText('Inputs changed — preview again')).not.toHaveLength(0);
    expect(run).toHaveAttribute('aria-disabled', 'true');
    // Undoing the edit doesn't bring the preview back: preview again.
    await userEvent.type(within(drawer).getByLabelText(/Reason/), '{Backspace}');
    expect(run).toHaveAttribute('aria-disabled', 'true');
    expect(await axeViolations()).toEqual([]);
  });

  it('preview then confirm: a confirmation the server rejects (422) is explained under the field, dialog stays open', async () => {
    const { state } = renderApp({
      session: armedMe(),
      automation: { mismatchOnce: true },
      path: disableLink({ userId: IDS.aLee, reason: 'INC-4821 account compromised' }),
    });
    const drawer = await screen.findByRole('dialog', { name: 'Disable sign-in' });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Preview (dry run)' }));
    await within(drawer).findByRole('region', { name: 'What this run will change' });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Disable sign-in' }));
    const confirm = await screen.findByRole('dialog', { name: 'Disable sign-in?' });
    await userEvent.type(within(confirm).getByLabelText(/to confirm/), 'a.lee@example.com');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Disable sign-in' }));
    expect(
      await within(confirm).findByText('That doesn’t match. Type the sign-in name exactly as shown.'),
    ).toBeInTheDocument();
    expect(within(confirm).getByLabelText(/to confirm/)).toHaveAttribute('aria-invalid', 'true');
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Disable sign-in' }));
    await waitFor(() =>
      expect(state.runPosts.filter((p) => !(p as { dryRun: boolean }).dryRun)).toHaveLength(2),
    );
  });

  it('preview then confirm: Run with an expired preview previews again first, then asks to confirm', async () => {
    const { state } = renderApp({
      session: armedMe(),
      automation: { stalePreview: true },
      path: disableLink({ userId: IDS.aLee, reason: 'INC-4821 account compromised' }),
    });
    const drawer = await screen.findByRole('dialog', { name: 'Disable sign-in' });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Preview (dry run)' }));
    expect(await within(drawer).findByText('This preview expired')).toBeInTheDocument();
    expect(
      within(drawer).getByText('Previews are good for 15 minutes. Select Run to preview again and confirm.'),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByText('Preview expired. Select Run to preview again and confirm.'),
    ).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Disable sign-in' }));
    expect(await screen.findByRole('dialog', { name: 'Disable sign-in?' })).toBeInTheDocument();
    expect(state.runPosts.filter((p) => (p as { dryRun: boolean }).dryRun)).toHaveLength(2);
  });

  it('preview then confirm: a 409 closes the confirmation and the drawer offers Preview again', async () => {
    renderApp({
      session: armedMe(),
      automation: { refuseStaleOnce: true },
      path: disableLink({ userId: IDS.aLee, reason: 'INC-4821 account compromised' }),
    });
    const drawer = await screen.findByRole('dialog', { name: 'Disable sign-in' });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Preview (dry run)' }));
    await within(drawer).findByRole('region', { name: 'What this run will change' });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Disable sign-in' }));
    const confirm = await screen.findByRole('dialog', { name: 'Disable sign-in?' });
    await userEvent.type(within(confirm).getByLabelText(/to confirm/), 'a.lee@example.com');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Disable sign-in' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Disable sign-in?' })).not.toBeInTheDocument(),
    );
    expect(
      await within(drawer).findByText('The preview is more than 15 minutes old, or its inputs changed.'),
    ).toBeInTheDocument();
    expect(within(drawer).getAllByRole('button', { name: 'Preview again' }).length).toBeGreaterThan(0);
    // Run now previews again first and asks for the confirmation again.
    await userEvent.click(within(drawer).getByRole('button', { name: 'Disable sign-in' }));
    expect(await screen.findByRole('dialog', { name: 'Disable sign-in?' })).toBeInTheDocument();
  });

  it('bulk with typed confirmation asks for the number of items', async () => {
    const items = [
      { userId: IDS.aLee, $label: 'Adele Lee' },
      { userId: IDS.mChen, $label: 'Ming Chen' },
    ];
    const { state } = renderApp({
      session: armedMe(),
      path: playbookHref(
        { playbook: 'identity.disable-user', items, inputs: { reason: 'Leaver sweep HR-2240' } },
        '/',
      ),
    });
    const drawer = await screen.findByRole('dialog', { name: 'Disable sign-in' });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Preview (dry run)' }));
    expect(await within(drawer).findByText('2 of 2 ready')).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Disable sign-in · 2 items' }));
    const confirm = await screen.findByRole('dialog', { name: 'Disable sign-in for 2 items?' });
    expect(within(confirm).getByText(/to confirm changing 2 objects/)).toBeInTheDocument();
    await userEvent.type(within(confirm).getByLabelText(/to confirm/), '2');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Disable sign-in · 2 items' }));
    await waitFor(() => expect(state.bulkPosts).toHaveLength(2));
    expect(state.bulkPosts[1]).toMatchObject({ previewRunId: IDS.bulkPreview, confirmation: '2' });
  });

  it('bulk: items table, shared inputs only, posts /api/runs/bulk without display labels', async () => {
    const items = [
      { userId: IDS.aLee, $label: 'Adele Lee' },
      { userId: IDS.mChen, $label: 'Ming Chen' },
    ];
    const { state } = renderApp({
      session: armedMe(),
      path: playbookHref({ playbook: 'identity.revoke-sessions', items }, '/'),
    });
    const drawer = await screen.findByRole('dialog', { name: 'Revoke sessions' });
    const table = within(drawer).getByRole('table', { name: 'Inputs per item' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(drawer).queryByRole('combobox')).not.toBeInTheDocument();
    await userEvent.type(within(drawer).getByLabelText(/Reason/), 'Quarterly leaver sweep');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Revoke sessions · 2 items' }));
    const confirm = await screen.findByRole('dialog', { name: 'Revoke sessions for 2 items?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Revoke sessions · 2 items' }));
    await waitFor(() => expect(state.bulkPosts).toHaveLength(1));
    expect(state.bulkPosts[0]).toEqual({
      playbook: 'identity.revoke-sessions',
      version: '1.0.0',
      items: [{ userId: IDS.aLee }, { userId: IDS.mChen }],
      inputsTemplate: { reason: 'Quarterly leaver sweep' },
    });
  });

  it('a key that isn’t published says so', async () => {
    renderApp({ path: playbookHref({ playbook: 'identity.does-not-exist' }, '/') });
    const drawer = await screen.findByRole('dialog', { name: 'Playbook unavailable' });
    expect(within(drawer).getByText('There’s no published playbook with this key')).toBeInTheDocument();
  });

  it('the entity picker searches by name and fills the object id', async () => {
    renderApp({ path: playbookHref({ playbook: 'diagnostics.user-sign-in-check' }, '/') });
    const drawer = await screen.findByRole('dialog', { name: 'Check a user’s sign-ins' });
    const box = within(drawer).getByRole('combobox', { name: 'User' });
    await userEvent.type(box, 'ming');
    const option = await screen.findByRole('option', { name: /Ming Chen/ });
    await userEvent.click(option);
    expect(await within(drawer).findByText('m.chen@example.com')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Remove Ming Chen from User' })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });
});
