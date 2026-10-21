import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { playbookHref } from '../../portal/apps/web/src/playbooks/url';
import { IDS, previewDetail } from '../support/web/fixtures/automation';
import { FIXED_NOW, armedMe } from '../support/web/fixtures/session';
import { automationApi } from '../support/web/mock-automation';
import type { MockHandler } from '../support/web/mock-handler';
import { mockApi, setPrefs } from './support/mock-api';

// The confirm dialog marks what in the text to type can make a name pass for another one. jsdom computes accessible
// descriptions differently from Chrome (it let an aria-label on the note hide the list), so the wiring is checked in
// the browser: the field's description is the whole note, and the code-point tag shown for an invisible character is
// neither read out nor copied. (Escapes only: no invisible characters in this source.)

const SHADY = 'PDF\u{200b} Convert\u{435}r';
const PREVIEW = 'a9d0c4f2-2222-4b6e-9c3a-5e7f9a1b3c5d';
const INPUTS = { userId: IDS.aLee, reason: 'INC-4821 account compromised' };

/** The disable-user preview, with the confirmation the API rendered: an attacker-named value. */
const handler: MockHandler = ({ method, path, body }) => {
  if (method === 'POST' && path === '/api/runs' && (body as { dryRun?: boolean }).dryRun)
    return { status: 202, body: { runId: PREVIEW, status: 'queued' } };
  if (method === 'GET' && path === `/api/runs/${PREVIEW}`) {
    const base = previewDetail(INPUTS, { id: PREVIEW, endedAgoMs: 30_000 });
    return {
      body: { ...base, run: { ...base.run, confirm: { type: 'typed', value: SHADY, message: null } } },
    };
  }
  return undefined;
};

async function openConfirm(page: Page, theme: string) {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockApi(page, { me: armedMe(), handlers: [handler, automationApi().handler] });
  await setPrefs(page, { theme, density: 'comfortable' });
  await page.goto(playbookHref({ playbook: 'identity.disable-user', inputs: INPUTS }, '/runs'));
  const drawer = page.getByRole('dialog', { name: 'Disable sign-in' });
  await drawer.getByRole('button', { name: 'Preview (dry run)' }).click();
  await expect(drawer.getByRole('region', { name: 'What this run will change' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Disable sign-in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Disable sign-in?' });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const theme of ['steel', 'daylight'] as const) {
  test(`confirm dialog · look-alike name · ${theme}`, async ({ page }) => {
    const dialog = await openConfirm(page, theme);
    const field = dialog.getByLabel(/to confirm/);
    await expect(field).toHaveAccessibleName('Type PDF Convert\u{435}r to confirm');
    await expect(field).toHaveAccessibleDescription(
      /^Check the name: it has characters that can make it pass for another — an invisible character \(U\+200B\) and a Cyrillic “\u{435}” \(U\+0435\)\. Make sure it’s the one you meant to change\. To confirm, copy the name from the line above; case, spaces and invisible characters don’t count\.$/u,
    );
    // Selecting the name copies the visible name only (it confirms just the same): the code-point tag standing in
    // for the invisible character can't be selected.
    const copied = await dialog.locator('label code').evaluate((code) => {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
    expect(copied).toBe('PDF Convert\u{435}r');
    // Plain Latin letters don't confirm it; the name as shown does (case and the invisible character don't count).
    const go = dialog.getByRole('button', { name: 'Disable sign-in' });
    await field.fill('PDF Converter');
    await expect(go).toHaveAttribute('aria-disabled', 'true');
    await field.fill('pdf convert\u{435}r');
    await expect(go).not.toHaveAttribute('aria-disabled');
    const results = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`)).toEqual([]);
  });
}
