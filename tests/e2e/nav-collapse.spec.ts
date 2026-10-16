import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW } from './fixtures/session';
import { mockApi, setPrefs } from './support/mock-api';

// The rail's rendered width is what people see; the Collapse/Expand button must change it at every window width
// (below 1024 px the rail starts collapsed, and the button still expands and collapses it).

const rail = (page: Page) => page.getByRole('navigation', { name: /primary|main|navigation/i }).first();
const railWidth = async (page: Page) => (await rail(page).boundingBox())!.width;

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockApi(page);
  await setPrefs(page, { theme: 'steel' });
});

for (const { name, width, startsCollapsed } of [
  { name: 'wide window', width: 1440, startsCollapsed: false },
  { name: 'narrow window', width: 1000, startsCollapsed: true },
]) {
  test(`collapse and expand the navigation · ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Example Org' })).toBeVisible();

    const first = startsCollapsed ? 'Expand navigation' : 'Collapse navigation';
    const second = startsCollapsed ? 'Collapse navigation' : 'Expand navigation';
    const before = await railWidth(page);

    await page.getByRole('button', { name: first }).click();
    await expect(page.getByRole('button', { name: second })).toBeVisible();
    await expect.poll(() => railWidth(page)).not.toBe(before);
    const after = await railWidth(page);
    expect(startsCollapsed ? after > before : after < before).toBe(true);

    await page.getByRole('button', { name: second }).click();
    await expect(page.getByRole('button', { name: first })).toBeVisible();
    await expect.poll(() => railWidth(page)).toBe(before);
  });
}

for (const theme of ['steel', 'daylight'] as const) {
  test(`navigation sections start collapsed, open and stay open · ${theme}`, async ({ page }) => {
    await setPrefs(page, { theme });
    await page.goto('/identity/users');
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Primary' });
    // Every section starts collapsed; the page you're on stays visible in its section.
    await expect(nav.getByRole('link', { name: 'Users' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Groups' })).toBeHidden();
    await expect(nav.getByRole('link', { name: 'Licences' })).toBeHidden();
    await expect(nav.getByRole('button', { name: 'Microsoft 365 (4 pages hidden)' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await page.mouse.move(700, 500);
    await expect(nav).toHaveScreenshot(`nav-sections-closed-${theme}.png`);

    await nav.getByRole('button', { name: /^Identity \(/ }).click();
    await expect(nav.getByRole('link', { name: 'Groups' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Licences' })).toBeHidden();
    // The opened section is remembered (the reload itself is covered by the component tests: setPrefs re-seeds storage).
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('adminforge.prefs') ?? '{}').navOpenSections),
    ).toEqual(['identity']);
  });
}
