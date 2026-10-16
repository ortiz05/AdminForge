import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { NAV_WITH_NEWS, NEWS_ITEMS, newsList, newsSummary } from '../support/web/fixtures/news';
import { FIXED_NOW } from '../support/web/fixtures/session';
import { growViewportToPage, mockApi, setPrefs, settle, type MockHandler } from './support/mock-api';

// News and changes in mock mode: every /api call is answered here (synthetic items in fixtures/news.ts), so only the
// Vite dev server runs. Breaking strip, filters in the URL, the detail panel, the nav badge and the top-bar pill,
// screenshots in steel and daylight (desktop and phone), and axe.

const news: MockHandler = ({ method, path, url }) => {
  if (method !== 'GET') return undefined;
  if (path === '/api/nav') return { body: NAV_WITH_NEWS };
  if (path === '/api/news/summary') return { body: newsSummary() };
  if (path === '/api/news') return { body: newsList(url.searchParams) };
  const one = /^\/api\/news\/([^/]+)$/.exec(path);
  if (one) {
    const item = NEWS_ITEMS.find((i) => i.id === decodeURIComponent(one[1]!));
    return item
      ? { body: item }
      : { status: 404, body: { error: { code: 'news_not_found', message: 'No such item.' } } };
  }
  return undefined;
};

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map(
      (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
    ),
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

test('breaking first, then the day-grouped feed with citations; filters and the detail panel', async ({
  page,
}) => {
  const { calls } = await mockApi(page, { handlers: [news] });
  await setPrefs(page, { theme: 'steel' });
  await page.goto('/news');
  await expect(page.getByRole('heading', { level: 1, name: 'News and changes' })).toBeVisible();

  const strip = page.getByRole('region', { name: /Breaking/ });
  await expect(strip.getByRole('listitem')).toHaveCount(3);
  await expect(page.getByRole('heading', { level: 2, name: /^Today/ })).toBeVisible();

  const incident = page.getByRole('article', { name: /Outlook on the web/ });
  const cite = incident.getByRole('link', { name: /Microsoft 365 service health/ });
  await expect(cite).toHaveAttribute('target', '_blank');
  await expect(cite).toHaveAttribute('rel', 'noopener noreferrer');

  await page.getByRole('group', { name: 'Area' }).getByRole('button', { name: 'Azure' }).click();
  await expect(page).toHaveURL(/[?&]area=azure/);
  await expect(page.getByRole('article')).toHaveCount(2);
  expect(calls.some((c) => c.path === '/api/news' && c.method === 'GET')).toBe(true);

  await page
    .getByRole('article', { name: /Retirement/ })
    .getByRole('button', { name: /Retirement:/ })
    .click();
  const panel = page.getByRole('dialog', { name: /Retirement: an older alerting experience/ });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('link', { name: /Read at the source/ })).toHaveAttribute(
    'href',
    'https://azure.microsoft.com/updates?id=500001',
  );
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(page).not.toHaveURL(/item=/);
});

test('mark all as read sends the marker with the CSRF header', async ({ page }) => {
  const { calls } = await mockApi(page, { handlers: [news] });
  await page.goto('/news');
  await page.getByRole('button', { name: 'Mark all as read (3 unread)' }).click();
  await expect(page.getByText('Marked all as read', { exact: true })).toBeVisible();
  const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/me/prefs')!;
  expect(put.body).toEqual({ newsSeenAt: new Date(FIXED_NOW).toISOString() });
  expect(put.csrf).toBe('e2e-csrf-token');
});

test('the nav badge and the top-bar pill lead to the breaking news', async ({ page }) => {
  await mockApi(page, { handlers: [news] });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: 'News and changes (3 unread changes)' })).toBeVisible();
  await page.getByRole('link', { name: '2 unread breaking changes: open News and changes' }).click();
  await expect(page).toHaveURL(/\/news\?breaking=true/);
  await expect(page.getByRole('button', { name: 'Remove filter Breaking only' })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(3);
});

for (const theme of ['steel', 'daylight'] as const) {
  test(`news page · ${theme}`, async ({ page }) => {
    await mockApi(page, { handlers: [news] });
    await setPrefs(page, { theme });
    await page.goto('/news');
    await expect(page.getByRole('article')).toHaveCount(NEWS_ITEMS.length);
    await settle(page);
    await growViewportToPage(page);
    await expect(page).toHaveScreenshot(`news-${theme}.png`);
    await expectNoAxeViolations(page);
  });

  test(`news page · phone · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page, { handlers: [news] });
    await setPrefs(page, { theme });
    await page.goto('/news');
    await expect(page.getByRole('article')).toHaveCount(NEWS_ITEMS.length);
    // Nothing on the page may be wider than the window.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await settle(page);
    await growViewportToPage(page, 390);
    await expect(page).toHaveScreenshot(`news-phone-${theme}.png`);
  });

  test(`news detail and sources · ${theme}`, async ({ page }) => {
    await mockApi(page, { handlers: [news] });
    await setPrefs(page, { theme });
    await page.goto('/news?item=n-change');
    await expect(page.getByRole('dialog', { name: 'Meeting recordings get a default expiry' })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(`news-detail-${theme}.png`);
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: /^Sources: 8/ }).click();
    await expect(page.getByRole('dialog').getByText('Azure Service Health', { exact: true })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(`news-sources-${theme}.png`);
  });
}
