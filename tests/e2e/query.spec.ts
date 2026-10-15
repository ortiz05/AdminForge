import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { NavResponse } from '@adminforge/schemas';
import { answerQuery, CAPABILITIES_NO_DEFENDER } from './fixtures/query';
import { NAV } from './fixtures/session';
import { growViewportToPage, mockApi, setPrefs, settle, type MockHandler } from './support/mock-api';

/**
 * Query Studio end to end in mock mode with the real Monaco editor: highlighting, Ctrl+Enter, results as a table
 * and a chart, the Defender licence note, and "Save as report". Screenshots in Steel and Daylight.
 */

const THEMES = ['steel', 'daylight'] as const;

const NAV_WITH_QUERY: NavResponse = {
  sections: NAV.sections.map((s) =>
    s.key === 'automation' ? { ...s, items: [...s.items, { key: 'query', label: 'Query Studio', href: '/query', icon: 'terminal' }] } : s,
  ),
};

const queryApi: MockHandler = ({ method, path, body }) => {
  if (method === 'GET' && path === '/api/nav') return { body: NAV_WITH_QUERY };
  if (method === 'GET' && path === '/api/me/capabilities') return { body: CAPABILITIES_NO_DEFENDER };
  if (method === 'POST' && path.startsWith('/api/query')) return answerQuery(path, (body ?? {}) as Record<string, unknown>);
  return undefined;
};

async function noAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')})`)).toEqual([]);
}

/** The Monaco editor is ready: its text area exists and the first line is rendered. */
async function editorReady(page: Page) {
  const editor = page.getByTestId('kql-editor');
  await expect(editor.locator('.monaco-editor .view-lines')).toBeVisible();
  return editor;
}

/** Replaces the editor's text. insertText avoids Monaco's auto-closing quotes doubling up. */
async function setEditorText(page: Page, text: string) {
  const editor = await editorReady(page);
  await editor.locator('.monaco-editor').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

/** Moves focus off the editor so the cursor and current-line highlight don't vary between screenshots. */
async function blurEditor(page: Page) {
  await page.getByRole('heading', { level: 1, name: 'Query Studio' }).click();
}

// No page.clock here: Monaco records input latency with performance.mark/measure, which the fake clock replaces.
// Nothing on this page depends on a fixed "now" (result times are absolute; history says "just now").

test('Monaco loads locally, highlights KQL, and Ctrl+Enter runs the query', async ({ page }) => {
  const external: string[] = [];
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('request', (r) => {
    const host = new URL(r.url()).hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') external.push(r.url());
  });
  await setPrefs(page, { theme: 'steel' });
  const { calls } = await mockApi(page, { handlers: [queryApi] });
  await page.goto('/query');
  await expect(page.getByRole('heading', { level: 1, name: 'Query Studio' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Query Studio' })).toHaveAttribute('aria-current', 'page');

  await setEditorText(page, "resources\n| where type =~ 'microsoft.web/sites'\n| summarize count() by location");
  const editor = page.getByTestId('kql-editor');
  // Keywords, strings and functions get different token classes from plain identifiers.
  const keyword = editor.locator('.view-line span span', { hasText: /^\s*summarize\s*$/ });
  const str = editor.locator('.view-line span span', { hasText: /microsoft\.web\/sites/ });
  const ident = editor.locator('.view-line span span', { hasText: /^\s*location\s*$/ });
  await expect(keyword).toHaveCount(1);
  const [kw, st, id] = await Promise.all([keyword.getAttribute('class'), str.getAttribute('class'), ident.getAttribute('class')]);
  expect(new Set([kw, st, id]).size).toBe(3);

  await page.keyboard.press('ControlOrMeta+Enter');
  const grid = page.getByRole('grid', { name: 'Query results' });
  await expect(grid).toBeVisible();
  const runs = calls.filter((c) => c.method === 'POST' && c.path === '/api/query' && !/resourcecontainers/.test(String((c.body as { query?: string }).query)));
  expect(runs.map((c) => c.body)).toEqual([{ source: 'resourceGraph', query: "resources\n| where type =~ 'microsoft.web/sites'\n| summarize count() by location" }]);
  expect(runs[0]!.csrf).toBe('e2e-csrf-token');
  // The run is shareable: source and query are in the URL.
  await expect(page).toHaveURL(/\/query\?source=resourceGraph&q=resources/);
  // Nothing loads from a CDN (Monaco is bundled; CSP stays 'self'), and the editor worker starts cleanly.
  expect(external).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await noAxeViolations(page);
});

test('Ctrl+Enter from a starter, CSV export downloads the rows', async ({ page }) => {
  await setPrefs(page, { theme: 'steel' });
  await mockApi(page, { handlers: [queryApi] });
  await page.goto('/query');
  await editorReady(page);
  await page.getByRole('button', { name: /Inventory by type and region/ }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('grid', { name: 'Query results' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^query-resourcegraph-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.csv$/);
  const text = await (await file.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'));
  expect(text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe('type,location,resources');
  expect(text).toContain('microsoft.compute/virtualmachines,eastus,48');
});

for (const theme of THEMES) {
  test(`results table · ${theme}`, async ({ page }) => {
    await setPrefs(page, { theme, density: 'comfortable' });
    await mockApi(page, { handlers: [queryApi] });
    await page.goto('/query');
    await editorReady(page);
    await page.getByRole('button', { name: /Untagged resources/ }).click();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByRole('grid', { name: 'Query results' })).toBeVisible();
    await expect(page.getByText('40 of 1,312 rows', { exact: true })).toBeVisible();
    await blurEditor(page);
    await settle(page);
    await growViewportToPage(page);
    await expect(page).toHaveScreenshot(`query-table-${theme}.png`);
    await noAxeViolations(page);
  });

  test(`chart · log analytics · ${theme}`, async ({ page }) => {
    await setPrefs(page, { theme, density: 'comfortable' });
    await mockApi(page, { handlers: [queryApi] });
    await page.goto('/query?source=logAnalytics');
    await editorReady(page);
    await page.getByRole('button', { name: /Azure changes by caller/ }).click();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByRole('grid', { name: 'Query results' })).toBeVisible();
    await page.getByRole('radio', { name: 'Chart' }).click();
    await expect(page.locator('figure svg').first()).toBeVisible();
    await blurEditor(page);
    await settle(page);
    await growViewportToPage(page);
    await expect(page).toHaveScreenshot(`query-chart-${theme}.png`);
    await noAxeViolations(page);
  });

  test(`advanced hunting licence note and history · ${theme}`, async ({ page }) => {
    await setPrefs(page, { theme, density: 'comfortable' });
    await mockApi(page, { handlers: [queryApi] });
    await page.goto('/query?source=advancedHunting');
    await editorReady(page);
    await expect(page.getByText('Advanced hunting needs Microsoft Defender XDR')).toBeVisible();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByRole('grid', { name: 'Query results' })).toBeVisible();
    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByRole('list', { name: 'Query history' })).toBeVisible();
    await blurEditor(page);
    await settle(page);
    await expect(page).toHaveScreenshot(`query-hunting-${theme}.png`);
    await noAxeViolations(page);
  });

  test(`save as report · ${theme}`, async ({ page }) => {
    await setPrefs(page, { theme, density: 'comfortable' });
    const { calls } = await mockApi(page, { handlers: [queryApi] });
    await page.goto('/query');
    await editorReady(page);
    await page.getByRole('button', { name: /Storage accounts open to the public/ }).click();
    await page.getByRole('button', { name: /Save as/ }).click();
    await page.getByRole('menuitem', { name: /Probe/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Save as probe' });
    await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue('Storage accounts open to the public');
    await dialog.getByRole('button', { name: 'Create probe YAML' }).click();
    const ready = page.getByRole('dialog', { name: 'Your probe file is ready' });
    await expect(ready.getByText('adding-a-probe')).toBeVisible();
    expect(calls.find((c) => c.path === '/api/query/scaffold')?.body).toMatchObject({ as: 'probe', source: 'resourceGraph', title: 'Storage accounts open to the public' });
    await settle(page);
    await expect(page).toHaveScreenshot(`query-save-${theme}.png`);
    await noAxeViolations(page);
  });
}
