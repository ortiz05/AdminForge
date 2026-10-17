import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { playbookHref } from '../../portal/apps/web/src/playbooks/url';
import { CHILD_TAP_VALUE, IDS, TAP_VALUE } from '../support/web/fixtures/automation';
import { FIXED_NOW, armedMe, me } from '../support/web/fixtures/session';
import { mockApi, setPrefs } from './support/mock-api';
import { automationApi } from '../support/web/mock-automation';

/**
 * Automation flows end to end in mock mode: the playbook drawer (read, write with arm + typed confirm, bulk), live run
 * timeline, approvals, runbooks, schedules, synthetic monitoring, audit, and the appearance contrast gate.
 */

const APPROVER = me({ roles: ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver'] });
const ADMIN = me({ roles: ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver', 'Portal.Admin'] });

async function noAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map(
      (v) =>
        `${v.id}: ${v.help} (${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 3)
          .join(', ')})`,
    ),
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await setPrefs(page, { theme: 'steel' });
});

test('read playbook from a link: prefilled form → dry run → plan and outputs', async ({ page }) => {
  const auto = automationApi();
  await mockApi(page, { handlers: [auto.handler] });
  await page.goto(
    playbookHref({ playbook: 'diagnostics.user-sign-in-check', inputs: { userId: IDS.mChen } }, '/'),
  );

  const drawer = page.getByRole('dialog', { name: 'Check a user’s sign-ins' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Read-only', { exact: true }).first()).toBeVisible();
  // The prefilled id resolves to a name through /api/search.
  await expect(drawer.getByText('Ming Chen')).toBeVisible();

  await drawer.getByRole('button', { name: 'Preview (dry run)' }).click();
  await expect(drawer.getByText('Nothing changes: this run only reads.')).toBeVisible();
  await expect(drawer.getByRole('region', { name: 'Outputs' }).getByText('46')).toBeVisible();
  expect(auto.state.runPosts[0]).toEqual({
    playbook: 'diagnostics.user-sign-in-check',
    version: '1.2.0',
    inputs: { userId: IDS.mChen, window: 'PT24H' },
    dryRun: true,
  });
  // The preview is in the URL, so the drawer can be shared or reloaded.
  await expect(page).toHaveURL(new RegExp(`preview=${IDS.readRun}`));
  await noAxeViolations(page);
});

test('write playbook: locked in read mode → preview → arm → typed confirmation → live run timeline', async ({
  page,
}) => {
  const auto = automationApi();
  const { calls } = await mockApi(page, { handlers: [auto.handler] });
  await page.goto(
    playbookHref(
      {
        playbook: 'identity.disable-user',
        inputs: { userId: IDS.aLee, reason: 'INC-4821 account compromised' },
      },
      '/runs',
    ),
  );

  const drawer = page.getByRole('dialog', { name: 'Disable sign-in' });
  const runButton = drawer.getByRole('button', { name: 'Disable sign-in', exact: true });
  await expect(runButton).toHaveAttribute('aria-disabled', 'true');
  await expect(runButton).toHaveAccessibleDescription(/Arm write access to use this\./);
  await expect(drawer.getByText('Changes your tenant · High risk')).toBeVisible();
  // User Administrator is only eligible: the drawer says to activate it in PIM.
  await expect(drawer.getByText('Activate User Administrator in PIM to use this')).toBeVisible();

  await drawer.getByRole('button', { name: 'Preview (dry run)' }).click();
  const plan = drawer.getByRole('region', { name: 'What this run will change' });
  await expect(plan.getByText('Set accountEnabled to false')).toBeVisible();
  await expect(plan.getByText('2 changes')).toBeVisible();
  await expect(drawer.getByText(/^Preview ready\. Expires in \d+ min\.$/)).toBeVisible();
  await runButton.click({ force: true });
  expect(auto.state.runPosts).toHaveLength(1); // locked: nothing was started

  // Arm from the drawer; mock sign-in comes straight back to the same URL (returnTo) with the preview restored.
  await drawer.getByRole('button', { name: 'Arm write access' }).click();
  const arm = page.getByRole('dialog', { name: 'Arm write access' });
  await arm.getByLabel('Reason').fill('INC-4821 account compromised');
  await arm.getByRole('button', { name: 'Arm now' }).click();
  await expect(page.getByText(/Armed · 47:12/)).toBeVisible();
  const armCall = calls.find((c) => c.path === '/auth/arm');
  expect(armCall?.body).toEqual({ minutes: 60, reason: 'INC-4821 account compromised' });

  const armedDrawer = page.getByRole('dialog', { name: 'Disable sign-in' });
  await expect(armedDrawer.getByRole('region', { name: 'What this run will change' })).toBeVisible();
  await armedDrawer.getByRole('button', { name: 'Disable sign-in', exact: true }).click();

  const confirm = page.getByRole('dialog', { name: 'Disable sign-in?' });
  await expect(confirm.getByText('Set accountEnabled to false')).toBeVisible();
  const go = confirm.getByRole('button', { name: 'Disable sign-in' });
  await expect(go).toHaveAttribute('aria-disabled', 'true');
  await confirm.getByLabel(/to confirm/).fill('a.lee@example.com');
  await go.click();

  await expect(page).toHaveURL(new RegExp(`/runs/${IDS.liveRun}$`));
  // Preview then confirm: the run carries the dry run it was confirmed against, and what was typed.
  expect(auto.state.runPosts.at(-1)).toEqual({
    playbook: 'identity.disable-user',
    version: '1.0.0',
    inputs: { userId: IDS.aLee, reason: 'INC-4821 account compromised' },
    dryRun: false,
    previewRunId: IDS.previewRun,
    confirmation: 'a.lee@example.com',
  });
  // The timeline fills in from the SSE stream (disable → revoke → succeeded) and the logs stream in.
  const steps = page.getByRole('list', { name: 'Steps of Disable sign-in' });
  await expect(steps.getByText('Revoke refresh tokens and session cookies')).toBeVisible();
  await expect(page.locator('header').getByText('Succeeded')).toBeVisible();
  await expect(steps.locator('[data-status="succeeded"]')).toHaveCount(4);
  await expect(page.getByRole('log', { name: 'Run logs' })).toContainText('Graph throttled once (429)');
  await noAxeViolations(page);
});

test('bulk run: items from a selection, shared inputs asked once, one child run per item', async ({
  page,
}) => {
  const auto = automationApi();
  await mockApi(page, { me: armedMe(), handlers: [auto.handler] });
  const items = [
    { userId: IDS.aLee, $label: 'Adele Lee' },
    { userId: IDS.mChen, $label: 'Ming Chen' },
    { userId: IDS.jDoe, $label: 'Jordan Doe' },
  ];
  await page.goto(playbookHref({ playbook: 'identity.revoke-sessions', items }, '/'));

  const drawer = page.getByRole('dialog', { name: 'Revoke sessions' });
  const table = drawer.getByRole('table', { name: 'Inputs per item' });
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.getByRole('rowheader', { name: 'Jordan Doe' })).toBeVisible();
  await expect(drawer.getByText('User comes from each item.')).toBeVisible();

  const run = drawer.getByRole('button', { name: 'Revoke sessions · 3 items' });
  await run.click();
  await expect(drawer.getByText('Reason is required.')).toBeVisible();
  await drawer.getByLabel('Reason').fill('Quarterly leaver sweep');
  await run.click();
  const confirm = page.getByRole('dialog', { name: 'Revoke sessions for 3 items?' });
  await confirm.getByRole('button', { name: 'Revoke sessions · 3 items' }).click();

  await expect(page).toHaveURL(new RegExp(`/runs/${IDS.bulkRun}$`));
  expect(auto.state.bulkPosts[0]).toEqual({
    playbook: 'identity.revoke-sessions',
    version: '1.0.0',
    items: [{ userId: IDS.aLee }, { userId: IDS.mChen }, { userId: IDS.jDoe }],
    inputsTemplate: { reason: 'Quarterly leaver sweep' },
  });
  await expect(page.getByText('2 of 3 finished')).toBeVisible();
});

test('approval: approving needs write access, rejecting needs a comment', async ({ page }) => {
  const auto = automationApi();
  await mockApi(page, { me: APPROVER, handlers: [auto.handler] });
  await page.goto('/approvals');

  const card = page.getByRole('article', { name: 'Approval: Disable sign-in' });
  await expect(card.getByText('Requested by')).toContainText('r.patel@example.com');
  const approve = card.getByRole('button', { name: 'Approve and continue' });
  await expect(approve).toHaveAttribute('aria-disabled', 'true');
  await expect(card.getByText('Approving needs write access')).toBeVisible();
  await noAxeViolations(page);

  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(card.getByText('Say why you’re rejecting')).toBeVisible();
  expect(auto.state.decisions).toHaveLength(0);
  await card.getByLabel(/Comment/).fill('Wrong account: HR-2231 is for j.doe2');
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('Rejected: Disable sign-in')).toBeVisible();
  expect(auto.state.decisions[0]).toEqual({
    path: `/api/runs/${IDS.approvalRun}/approvals/%24approval`,
    body: { decision: 'reject', comment: 'Wrong account: HR-2231 is for j.doe2' },
  });
});

test('approval while armed: approve and continue', async ({ page }) => {
  const auto = automationApi();
  await mockApi(page, { me: { ...armedMe(), roles: APPROVER.roles }, handlers: [auto.handler] });
  await page.goto(`/runs/${IDS.approvalRun}`);
  const card = page.getByRole('article', { name: /Approval: Disable sign-in/ });
  await card.getByRole('button', { name: 'Approve and continue' }).click();
  await expect(page.getByText(/^Approved: Disable sign-in/)).toBeVisible();
  expect(auto.state.decisions[0]?.body).toEqual({ decision: 'approve' });
});

test('runbook: the guided document confirms a manual checklist step', async ({ page }) => {
  const auto = automationApi();
  await mockApi(page, { handlers: [auto.handler] });
  await page.goto(`/runbooks/identity.offboard-leaver?run=${IDS.runbookRun}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Offboard a leaver' })).toBeVisible();
  const rail = page.getByRole('navigation', { name: 'Runbook progress' });
  await expect(rail.getByText('2 of 4 steps', { exact: false })).toBeVisible();

  const done = page.getByRole('button', { name: 'Mark done' });
  await expect(done).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('checkbox', { name: 'Mailbox converted to shared' }).click();
  await page.getByRole('checkbox', { name: 'Manager has Full Access' }).click();
  await page.getByLabel(/Notes/).fill('Converted at 14:05; manager confirmed access.');
  await done.click();
  await expect(page.getByText('Done: Convert the mailbox')).toBeVisible();
  expect(auto.state.manual[0]).toEqual({
    path: `/api/runs/${IDS.runbookRun}/manual/mailbox`,
    body: { confirmed: true, notes: 'Converted at 14:05; manager confirmed access.' },
  });
});

test('schedules: cadence in words, pause, enable a write-capable job (approval), run now, history', async ({
  page,
}) => {
  const auto = automationApi();
  await mockApi(page, { handlers: [auto.handler] });
  await page.goto('/schedules');

  const grid = page.getByRole('grid', { name: 'Schedules' });
  // The sentence, and the zone on the cron line under it.
  await expect(grid.getByText('Every Monday at 07:00', { exact: true })).toBeVisible();
  await expect(grid.getByText('0 7 * * 1 · UTC')).toBeVisible();
  await expect(grid.getByText('Every day at 06:00', { exact: true })).toBeVisible();
  await expect(grid.getByText('0 6 * * * · Europe/London')).toBeVisible();
  await expect(page.getByText('Who schedules run as')).toBeVisible();
  await expect(page.getByText('1 schedule failed on the last run')).toBeVisible();

  await grid.getByRole('switch', { name: 'Disable Weekly app credential expiry report' }).click();
  await expect(page.getByText('Weekly app credential expiry report paused')).toBeVisible();
  expect(auto.state.schedulePatches[0]).toEqual({
    key: 'reports.app-credential-expiry',
    body: { enabled: false },
  });

  await grid.getByRole('switch', { name: 'Enable Disable stale guest accounts' }).click();
  const ask = page.getByRole('alertdialog', { name: /Ask for approval/ });
  await ask.getByRole('button', { name: 'Request approval' }).click();
  await expect(page.getByText('Approval requested')).toBeVisible();
  await expect(grid.getByText('Awaiting approval')).toBeVisible();

  await grid.getByRole('button', { name: 'Run Monthly licence usage now' }).click();
  await expect(page.getByText('Monthly licence usage started')).toBeVisible();
  expect(auto.state.scheduleRuns).toEqual(['reports.licence-usage-monthly']);

  await grid.getByRole('link', { name: 'Weekly app credential expiry report' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Weekly app credential expiry report' }),
  ).toBeVisible();
  const history = page.getByRole('table', { name: /Runs of Weekly app credential expiry report/ });
  await expect(history.getByRole('link', { name: /app-credential-expiry-2026-10-12\.xlsx/ })).toHaveAttribute(
    'href',
    /artifacts\/sr-1/,
  );
  await expect(
    history.getByText('Microsoft Graph throttled the request (429) after 3 retries.'),
  ).toBeVisible();
  // Paused above, so no next runs are scheduled.
  await expect(page.getByText('Disabled: no runs scheduled.')).toBeVisible();
  await noAxeViolations(page);
});

test('synthetic monitoring: grouped probe tiles, worst first, detail chart', async ({ page }) => {
  const auto = automationApi();
  await mockApi(page, { handlers: [auto.handler] });
  await page.goto('/monitoring');
  const headings = page.getByRole('main').getByRole('heading', { level: 2 });
  // Grouped by service: Identity holds the failing app-credential check.
  await expect(headings.first()).toHaveText(/Identity/);
  await expect(page.getByRole('button', { name: /Microsoft Graph reachability: Healthy/ })).toBeVisible();
  await page.getByRole('button', { name: /Portal TLS certificate: Degraded/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Portal TLS certificate' });
  await expect(
    drawer.getByText('Certificate for portal.example.com expires in 12 days.').first(),
  ).toBeVisible();
  await expect(drawer.getByRole('figure', { name: /Portal TLS certificate, last 24 hours/ })).toBeVisible();
  await expect(page).toHaveURL(/probe=probes\.portal-tls-certificate/);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await page.getByRole('radio', { name: 'Problems' }).click();
  await expect(page.getByRole('button', { name: /Microsoft Graph reachability/ })).toHaveCount(0);
});

test('audit: chain verified, server-side filters, event detail', async ({ page }) => {
  const auto = automationApi();
  const { calls } = await mockApi(page, { me: ADMIN, handlers: [auto.handler] });
  await page.goto('/audit');
  await expect(page.getByText('Chain verified ✓ · 12,408 events')).toBeVisible();
  const grid = page.getByRole('grid', { name: 'Audit events' });
  await expect(grid.getByText('session.armed')).toBeVisible();
  await page.getByRole('textbox', { name: 'Who' }).fill('r.patel');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/actor=r\.patel/);
  expect(calls.some((c) => c.path === '/api/audit' && c.method === 'GET')).toBe(true);
  await grid.getByText('run.created').first().click();
  const drawer = page.getByRole('dialog', { name: 'run.created' });
  await expect(drawer.getByText('r.patel@example.com')).toBeVisible();
  await expect(drawer.getByRole('link', { name: IDS.approvalRun })).toBeVisible();
});

test('appearance: an accent that fails contrast cannot be published; a good one is', async ({ page }) => {
  const auto = automationApi();
  await mockApi(page, { me: ADMIN, handlers: [auto.handler] });
  await page.goto('/appearance');
  await expect(page.getByText('Published version 3')).toBeVisible();

  const steelHex = page.getByRole('textbox', { name: 'Steel accent hex value' });
  await steelHex.fill('#2A3440');
  await expect(page.getByText('This can’t be published: some text would be hard to read')).toBeVisible();
  const publish = page.getByRole('button', { name: 'Publish' });
  await expect(publish).toHaveAttribute('aria-disabled', 'true');
  await publish.click({ force: true });
  expect(auto.state.appearancePuts).toHaveLength(0);

  await steelHex.fill('#9CC2FF');
  await expect(page.getByText('This can’t be published')).toHaveCount(0);
  await noAxeViolations(page);
  await publish.click();
  await expect(page.getByText(/Appearance published \(version 4\)/)).toBeVisible();
  expect(auto.state.appearancePuts[0]).toEqual({ version: 3, overrides: { steel: { accent: '#9CC2FF' } } });
});

test('settings: environment facts and provisioned apps', async ({ page }) => {
  const auto = automationApi();
  await mockApi(page, { me: ADMIN, handlers: [auto.handler] });
  await page.goto('/settings');
  await expect(page.getByText('Mock sign-in is on')).toBeVisible();
  await expect(page.getByText('Not provisioned: Automation identity')).toBeVisible();
  await expect(page.getByText('60 minutes')).toBeVisible();
  await expect(page.getByText(/Fresh sign-in only/)).toBeVisible();
  await noAxeViolations(page);
});

test('run dock lists my active runs and opens one', async ({ page }) => {
  const auto = automationApi();
  await mockApi(page, { handlers: [auto.handler] });
  await page.goto('/');
  const dock = page.getByRole('contentinfo', { name: 'Runs' });
  await expect(dock.getByRole('link', { name: /Disable sign-in: Awaiting approval/ })).toBeVisible();
  await dock.getByRole('link', { name: /Disable sign-in: Awaiting approval/ }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${IDS.approvalRun}$`));
});

test('show-once secret: live message → masked panel → reveal, copy, dismiss; outputs stay masked', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const auto = automationApi();
  await mockApi(page, { handlers: [auto.handler] });
  await page.goto(`/runs/${IDS.tapRun}`);
  const panel = page.getByRole('region', { name: 'Copy now — it won’t be shown again' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(TAP_VALUE)).toHaveCount(0);
  await noAxeViolations(page);
  await panel.getByRole('button', { name: 'Show Temporary access pass' }).click();
  await expect(panel.getByText(TAP_VALUE)).toBeVisible();
  await panel.getByRole('button', { name: 'Copy Temporary access pass' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TAP_VALUE);
  await panel.getByRole('button', { name: 'I’ve copied it — dismiss' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByText(TAP_VALUE)).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Result' }).getByText(/•••• one-time use · valid 60 min/),
  ).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage) + location.href)).not.toContain(TAP_VALUE);
});

test('show-once secret: a held child secret is claimed once (CSRF), then reported as gone', async ({
  page,
}) => {
  const auto = automationApi();
  await mockApi(page, { handlers: [auto.handler] });
  await page.goto(`/runs/${IDS.onboardRun}`);
  const panel = page.getByRole('region', { name: 'Copy now — it won’t be shown again' });
  await expect(panel.getByText(/\(child run\)/)).toBeVisible();
  await panel.getByRole('button', { name: 'Show Temporary access pass' }).click();
  await expect(panel.getByText(CHILD_TAP_VALUE)).toBeVisible();
  expect(auto.state.secretClaims).toEqual([
    { path: `/api/runs/${IDS.onboardChild}/secret/issue`, csrf: true },
  ]);

  await page.reload();
  await expect(page.getByText('This secret was already shown or has expired.')).toBeVisible();
  await expect(panel).toHaveCount(0);
  expect(auto.state.secretClaims).toHaveLength(2);
});

test('runbook link prefill: plain params named like inputs are validated and fill the start form', async ({
  page,
}) => {
  const auto = automationApi();
  await mockApi(page, { handlers: [auto.handler] });
  await page.goto(`/runbooks/identity.offboard-leaver?userId=${IDS.jDoe}&ticket=HR-2231`);
  await expect(page.getByText('Jordan Doe')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'HR ticket' })).toHaveValue('HR-2231');
  await page.getByRole('button', { name: 'Start runbook' }).click();
  await expect(page).toHaveURL(new RegExp(`run=${IDS.runbookRun}`));
  expect(auto.state.runPosts[0]).toEqual({
    playbook: 'identity.offboard-leaver',
    version: '2.1.0',
    inputs: { userId: IDS.jDoe, ticket: 'HR-2231' },
    dryRun: false,
  });
});

test('preview then confirm: edits invalidate the preview; a stale preview is refreshed on Run; the server’s mismatch shows under the field', async ({
  page,
}) => {
  const auto = automationApi({ stalePreview: true, mismatchOnce: true });
  await mockApi(page, { me: armedMe(), handlers: [auto.handler] });
  await page.goto(
    playbookHref(
      {
        playbook: 'identity.disable-user',
        inputs: { userId: IDS.aLee, reason: 'INC-4821 account compromised' },
      },
      '/runs',
    ),
  );
  const drawer = page.getByRole('dialog', { name: 'Disable sign-in' });
  const run = drawer.getByRole('button', { name: 'Disable sign-in', exact: true });

  await drawer.getByRole('button', { name: 'Preview (dry run)' }).click();
  await expect(drawer.getByText('This preview expired')).toBeVisible();
  // Any edit invalidates the preview.
  await drawer.getByLabel(/Reason/).fill('INC-4821 account compromised, confirmed by SOC');
  await expect(drawer.getByText('Inputs changed — preview again').first()).toBeVisible();
  await expect(run).toHaveAttribute('aria-disabled', 'true');
  await drawer.getByLabel(/Reason/).fill('INC-4821 account compromised');
  await expect(run).toHaveAttribute('aria-disabled', 'true');

  // Preview again → still the stale fixture? No: the second dry run is fresh. Run refreshes stale previews itself.
  await drawer.getByRole('button', { name: 'Preview again' }).first().click();
  await expect(drawer.getByText(/Expires in 15 min|Preview expires in 15 min/)).toBeVisible();
  await run.click();
  const confirm = page.getByRole('dialog', { name: 'Disable sign-in?' });
  await confirm.getByLabel(/to confirm/).fill('a.lee@example.com');
  await confirm.getByRole('button', { name: 'Disable sign-in' }).click();
  await expect(
    confirm.getByText('That doesn’t match. Type the sign-in name exactly as shown.'),
  ).toBeVisible();
  await confirm.getByRole('button', { name: 'Disable sign-in' }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${IDS.liveRun}$`));
  expect(auto.state.runPosts.filter((p) => (p as { dryRun: boolean }).dryRun)).toHaveLength(2);
  expect(auto.state.runPosts.at(-1)).toMatchObject({
    previewRunId: IDS.previewRun2,
    confirmation: 'a.lee@example.com',
  });
});

test('preview then confirm: Run with an expired preview previews again, then asks to confirm', async ({
  page,
}) => {
  const auto = automationApi({ stalePreview: true });
  await mockApi(page, { me: armedMe(), handlers: [auto.handler] });
  await page.goto(
    playbookHref(
      {
        playbook: 'identity.disable-user',
        inputs: { userId: IDS.aLee, reason: 'INC-4821 account compromised' },
      },
      '/runs',
    ),
  );
  const drawer = page.getByRole('dialog', { name: 'Disable sign-in' });
  await drawer.getByRole('button', { name: 'Preview (dry run)' }).click();
  await expect(drawer.getByText('This preview expired')).toBeVisible();
  await drawer.getByRole('button', { name: 'Disable sign-in', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Disable sign-in?' });
  await expect(confirm).toBeVisible();
  expect(auto.state.runPosts.filter((p) => (p as { dryRun: boolean }).dryRun)).toHaveLength(2);
  await confirm.getByLabel(/to confirm/).fill('a.lee@example.com');
  await confirm.getByRole('button', { name: 'Disable sign-in' }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${IDS.liveRun}$`));
  expect(auto.state.runPosts.at(-1)).toMatchObject({ previewRunId: IDS.previewRun2 });
});

test('preview then confirm: a 409 from the server closes the confirmation and offers Preview again', async ({
  page,
}) => {
  const auto = automationApi({ refuseStaleOnce: true });
  await mockApi(page, { me: armedMe(), handlers: [auto.handler] });
  await page.goto(
    playbookHref(
      {
        playbook: 'identity.disable-user',
        inputs: { userId: IDS.aLee, reason: 'INC-4821 account compromised' },
      },
      '/runs',
    ),
  );
  const drawer = page.getByRole('dialog', { name: 'Disable sign-in' });
  await drawer.getByRole('button', { name: 'Preview (dry run)' }).click();
  await drawer.getByRole('button', { name: 'Disable sign-in', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Disable sign-in?' });
  await confirm.getByLabel(/to confirm/).fill('a.lee@example.com');
  await confirm.getByRole('button', { name: 'Disable sign-in' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(
    drawer.getByText('The preview is more than 15 minutes old, or its inputs changed.'),
  ).toBeVisible();
  await drawer.getByRole('button', { name: 'Preview again' }).first().click();
  await drawer.getByRole('button', { name: 'Disable sign-in', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Disable sign-in?' })
    .getByLabel(/to confirm/)
    .fill('a.lee@example.com');
  await page
    .getByRole('dialog', { name: 'Disable sign-in?' })
    .getByRole('button', { name: 'Disable sign-in' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/runs/${IDS.liveRun}$`));
  expect(auto.state.runPosts.at(-1)).toMatchObject({
    previewRunId: IDS.previewRun2,
    confirmation: 'a.lee@example.com',
  });
});

test('bulk with typed confirmation: bulk dry run, then type the number of items', async ({ page }) => {
  const auto = automationApi();
  await mockApi(page, { me: armedMe(), handlers: [auto.handler] });
  const items = [
    { userId: IDS.aLee, $label: 'Adele Lee' },
    { userId: IDS.mChen, $label: 'Ming Chen' },
  ];
  await page.goto(
    playbookHref(
      { playbook: 'identity.disable-user', items, inputs: { reason: 'Leaver sweep HR-2240' } },
      '/runs',
    ),
  );
  const drawer = page.getByRole('dialog', { name: 'Disable sign-in' });
  const run = drawer.getByRole('button', { name: 'Disable sign-in · 2 items' });
  await expect(run).toHaveAttribute('aria-disabled', 'true');
  await drawer.getByRole('button', { name: 'Preview (dry run)' }).click();
  await expect(
    drawer.getByRole('region', { name: 'Items in the preview' }).getByText('2 of 2 ready'),
  ).toBeVisible();
  expect(auto.state.bulkPosts[0]).toMatchObject({
    dryRun: true,
    items: [{ userId: IDS.aLee }, { userId: IDS.mChen }],
  });
  await run.click();
  const confirm = page.getByRole('dialog', { name: 'Disable sign-in for 2 items?' });
  await expect(confirm.getByText(/to confirm changing 2 objects/)).toBeVisible();
  await confirm.getByLabel(/to confirm/).fill('2');
  await confirm.getByRole('button', { name: 'Disable sign-in · 2 items' }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${IDS.bulkRun}$`));
  expect(auto.state.bulkPosts[1]).toEqual({
    playbook: 'identity.disable-user',
    version: '1.0.0',
    items: [{ userId: IDS.aLee }, { userId: IDS.mChen }],
    inputsTemplate: { reason: 'Leaver sweep HR-2240' },
    previewRunId: IDS.bulkPreview,
    confirmation: '2',
  });
});
