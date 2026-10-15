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
