import { expect, test } from '@playwright/test';
import { FIXED_NOW } from '../fixtures/session';
import { PROBES } from '../fixtures/renderer';
import { routeContentBackend } from '../support/content-backend';
import { mockApi, setPrefs } from '../support/mock-api';

// In the production build the ECharts runtime once lost its registrations to tree-shaking: every bar/line chart stayed
// an empty box with "… is not a constructor" in the console, while the dev server (and the main e2e suite) worked.

test('charts render in the production build, without page errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.setFixedTime(FIXED_NOW);
  await mockApi(page);
  await routeContentBackend(page, {});
  await page.route('**/api/probes', (route) => route.fulfill({ json: PROBES }));
  await setPrefs(page, { theme: 'steel' });
  await page.goto('/p/azure.resources');

  // A horizontal bar chart (long resource-type names) drawn by ECharts' SVG renderer.
  // The panel's own toggle icons are SVGs too (2 paths), so wait for the chart's axis labels and bars.
  const bars = page.getByRole('figure', { name: 'Top resource types' });
  await expect.poll(() => bars.locator('svg path, svg text').count(), { timeout: 15_000 }).toBeGreaterThan(5);
  expect(errors).toEqual([]);
});
