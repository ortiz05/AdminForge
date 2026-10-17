import { expect, test, type Page } from '@playwright/test';
import { scale } from '@adminforge/design-tokens';
import { FIXED_NOW } from '../support/web/fixtures/session';
import { PROBES } from '../support/web/fixtures/renderer';
import { routeContentBackend } from './support/content-backend';
import { mockApi, setPrefs, settle } from './support/mock-api';

/**
 * The inspector drawer: `inspector-wide-factor` × the standard drawer width, never over the navigation rail; when that
 * leaves less than 24rem of the list beside it, it covers the list (light scrim that closes it, the page inert) instead
 * of sharing the screen. "Open full page" sits in the header, keeps the inspector's tab, and focus moves through the
 * header in order and returns to the row on close. Expected widths come from the design tokens, not from numbers here.
 */
const px = (value: string) => Number.parseFloat(value);
const L = scale.layout;
const navWidth = (collapsed: boolean) => px(collapsed ? L['nav-w-collapsed'] : L['nav-w']);
const drawerWidth = (viewport: number, collapsed: boolean) =>
  Math.min(Number(L['inspector-wide-factor']) * px(L['inspector-w']), viewport - navWidth(collapsed));
const covers = (viewport: number, collapsed: boolean) =>
  viewport - navWidth(collapsed) - drawerWidth(viewport, collapsed) < 24 * 16;

async function openInspector(
  page: Page,
  opts: { theme?: string; width?: number; navCollapsed?: boolean; list?: string; row?: number } = {},
) {
  await page.setViewportSize({ width: opts.width ?? 1440, height: 900 });
  await page.clock.setFixedTime(FIXED_NOW);
  await mockApi(page, {});
  await routeContentBackend(page, {});
  await page.route('**/api/probes', (route) => route.fulfill({ json: PROBES }));
  await setPrefs(page, {
    theme: opts.theme ?? 'steel',
    density: 'comfortable',
    ...(opts.navCollapsed !== undefined ? { navCollapsed: opts.navCollapsed } : {}),
  });
  await page.goto(`/p/${opts.list ?? 'identity.users'}`);
  const row = page
    .getByRole('grid', { name: 'Results' })
    .getByRole('row')
    .nth(opts.row ?? 1);
  await expect(row).toBeVisible();
  // A click focuses the row too (focus must come back to it on close).
  await row.click();
  const drawer = page.getByRole('dialog').first();
  await expect(drawer.getByRole('tabpanel')).toBeVisible();
  return { drawer, row };
}

for (const width of [1280, 1440, 1920]) {
  for (const navCollapsed of [false, true]) {
    test(`width and cover mode · ${width}px · rail ${navCollapsed ? 'collapsed' : 'expanded'}`, async ({
      page,
    }) => {
      const { drawer } = await openInspector(page, { width, navCollapsed });
      const box = (await drawer.boundingBox())!;
      const nav = (await page
        .getByRole('navigation', { name: /main|primary|sections/i })
        .first()
        .boundingBox())!;
      expect(box.width).toBeCloseTo(drawerWidth(width, navCollapsed), 0);
      // Never over the navigation rail.
      expect(box.x).toBeGreaterThanOrEqual(nav.x + nav.width - 1);
      const scrim = page.locator('[data-drawer-cover]');
      if (covers(width, navCollapsed)) {
        await expect(scrim).toBeVisible();
        await expect(page.locator('main#main')).toHaveAttribute('inert', '');
      } else {
        await expect(scrim).toHaveCount(0);
        await expect(page.locator('main#main')).not.toHaveAttribute('inert');
      }
    });
  }
}

test('covering the list: the scrim over the visible sliver closes the inspector', async ({ page }) => {
  // 1920px with the rail expanded: a sliver of the list stays visible beside the drawer, too narrow to use.
  expect(covers(1920, false)).toBe(true);
  const { row } = await openInspector(page, { width: 1920, navCollapsed: false });
  await page.locator('[data-drawer-cover]').click({ position: { x: 20, y: 200 } });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/inspect=/);
  await expect(page.locator('main#main')).not.toHaveAttribute('inert');
  await expect(row).toBeFocused();
});

test('beside the list on a wide screen: rows stay clickable and switch what the inspector shows', async ({
  page,
}) => {
  expect(covers(1920, true)).toBe(false);
  const grid = page.getByRole('grid', { name: 'Results' });
  const nameOf = async (n: number) =>
    (await grid
      .getByRole('row')
      .nth(n)
      .getByRole('gridcell')
      .nth(1)
      .locator('span span')
      .first()
      .textContent())!.trim();
  const { drawer } = await openInspector(page, { width: 1920, navCollapsed: true });
  await expect(page.getByRole('dialog', { name: await nameOf(1) })).toBeVisible();
  const second = await nameOf(2);
  // Click inside the part of the row the drawer leaves visible.
  await grid
    .getByRole('row')
    .nth(2)
    .click({ position: { x: 200, y: 10 } });
  await expect(page.getByRole('dialog', { name: second })).toBeVisible();
  await expect(drawer).toBeVisible();
});

test('"Open full page": in the header, first in Tab order, keeps the tab', async ({ page }) => {
  const { drawer } = await openInspector(page);
  const link = drawer.getByRole('link', { name: 'Open full page' });
  const close = drawer.getByRole('button', { name: 'Close' });
  // In the header: above the tabs, level with Close.
  const linkBox = (await link.boundingBox())!;
  const tabsBox = (await drawer.getByRole('tablist').boundingBox())!;
  const closeBox = (await close.boundingBox())!;
  expect(linkBox.y + linkBox.height).toBeLessThan(tabsBox.y);
  expect(Math.abs(linkBox.y + linkBox.height / 2 - (closeBox.y + closeBox.height / 2))).toBeLessThan(4);
  // Focus starts on the drawer itself: Tab walks the header in order, then the page.
  await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('tabpanel')).toBeVisible();
  expect(
    await drawer.evaluate((d) => d.contains(document.activeElement) && document.activeElement !== d),
  ).toBe(true);
  // It opens the entity page on the inspector's current tab.
  await drawer.getByRole('tab', { name: 'Groups' }).click();
  await expect(page).toHaveURL(/itab=groups/);
  await link.click();
  await expect(page).toHaveURL(/\/p\/identity\.user\?(.*&)?id=/);
  await expect(page).toHaveURL(/[?&]tab=groups/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const closeWith of ['Escape', 'Close'] as const) {
  test(`focus returns to the row after ${closeWith}`, async ({ page }) => {
    const { drawer, row } = await openInspector(page);
    await settle(page);
    if (closeWith === 'Escape') await page.keyboard.press('Escape');
    else await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row).toBeFocused();
  });
}

for (const theme of ['steel', 'daylight'] as const) {
  for (const width of [1280, 1920]) {
    // The group inspector has a KPI strip: one row of KPIs when the drawer is wide.
    test(`visual · group inspector · ${width}px · ${theme}`, async ({ page }) => {
      await openInspector(page, { theme, width, list: 'identity.groups' });
      await settle(page);
      await expect(page).toHaveScreenshot(`inspector-group-${width}-${theme}.png`);
    });
  }

  test(`visual · inspector on a phone · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { drawer } = await openInspector(page, { theme, width: 390 });
    const box = (await drawer.boundingBox())!;
    expect(box.width).toBeCloseTo(drawerWidth(390, true), 0);
    // Icon-only on a phone, still named for screen readers.
    await expect(drawer.getByRole('link', { name: 'Open full page' })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(`inspector-phone-${theme}.png`);
  });
}
