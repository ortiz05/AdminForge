import { expect, test, type Locator, type Page } from '@playwright/test';
import { FIXED_NOW, armedMe, me } from '../support/web/fixtures/session';
import type { MockHandler } from './support/mock-api';
import { mockApi, setPrefs } from './support/mock-api';

// The session rail fits every window from a 360 px phone up: no control is pushed off-screen or squeezed, whether
// read-only or armed, with the widest breaking count ("99+"; two digits on a 360 px phone) and PIM counts showing; from
// `sm` the jump-to field shows its whole label.

const ROLES = {
  roles: {
    active: [{ roleDefinitionId: '88d8e3e3-8f55-4a1e-953a-9b9898b8876b', displayName: 'Directory Readers' }],
    eligible: [
      { roleDefinitionId: 'fe930be7-5e62-47db-91af-98c3a49a38b1', displayName: 'User Administrator' },
      { roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', displayName: 'Global Administrator' },
    ],
  },
};

/** The widest breaking count ("99+") from 375 px; a 360 px phone fits up to two digits. */
const breakingFor = (width: number) => (width < 375 ? 12 : 120);

const handlers = (width: number): MockHandler[] => [
  ({ method, path }) => (method === 'GET' && path === '/api/me/capabilities' ? { body: ROLES } : undefined),
  ({ method, path }) =>
    method === 'GET' && path === '/api/news/summary'
      ? {
          body: {
            unread: 140,
            breakingUnread: breakingFor(width),
            breaking: [],
            lastUpdatedAt: null,
            seenAt: null,
            feeds: [],
          },
        }
      : undefined,
];

/** From `sm` jump-to is a field: its label is never cut off. */
async function expectWholeLabel(page: Page, control: Locator) {
  if (page.viewportSize()!.width < 640) return;
  const label = control.locator('span').first();
  expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth), 'label not cut off').toBe(true);
}

async function expectInside(page: Page, control: Locator, minWidth = 24) {
  await expect(control).toBeVisible();
  const box = (await control.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x, 'starts on screen').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'ends on screen').toBeLessThanOrEqual(width);
  expect(box.width, 'not squeezed').toBeGreaterThanOrEqual(minWidth);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await setPrefs(page, { theme: 'steel' });
});

for (const width of [360, 390, 768, 1023, 1024, 1280, 1440]) {
  test(`read-only rail fits · ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockApi(page, { me: me(), handlers: handlers(width) });
    await page.goto('/');
    const rail = page.getByRole('banner');
    await expect(
      rail.getByRole('button', { name: 'PIM (privileged roles): 1 active · 2 eligible' }),
    ).toBeVisible();

    expect(await rail.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(width);
    await expectInside(page, rail.getByRole('button', { name: /Jump to a page or action/ }), 32);
    await expectWholeLabel(page, rail.getByRole('button', { name: /Jump to a page or action/ }));
    await expectInside(page, rail.getByRole('link', { name: /^(12|99\+) new breaking changes/ }));
    await expectInside(page, rail.getByRole('button', { name: /^PIM \(privileged roles\)/ }));
    await expectInside(page, rail.getByText('Read-only'));
    await expectInside(page, rail.getByRole('button', { name: 'Arm write access' }));
    await expectInside(page, rail.getByRole('button', { name: /^Account and appearance/ }));
  });

  test(`armed rail fits · ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockApi(page, { me: armedMe(), handlers: handlers(width) });
    await page.goto('/');
    const rail = page.getByRole('banner');
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'armed');
    await expect(
      rail.getByRole('button', { name: 'PIM (privileged roles): 1 active · 2 eligible' }),
    ).toBeVisible();

    expect(await rail.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(width);
    await expectInside(page, rail.getByRole('button', { name: /Jump to a page or action/ }), 32);
    await expectWholeLabel(page, rail.getByRole('button', { name: /Jump to a page or action/ }));
    await expectInside(page, rail.locator('[aria-live="off"]'));
    await expectInside(page, rail.getByRole('button', { name: 'Disarm' }));
    await expectInside(page, rail.getByRole('button', { name: /^Account and appearance/ }));
  });
}
