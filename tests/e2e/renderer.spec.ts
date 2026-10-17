import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, me } from '../support/web/fixtures/session';
import { CAPABILITIES_NO_INTUNE, PROBES } from '../support/web/fixtures/renderer';
import { backendUrl, routeContentBackend, type BackendOptions } from './support/content-backend';
import { growViewportToPage, mockApi, setPrefs, settle } from './support/mock-api';

/**
 * The content renderer (/p/$key) end to end: real published content, the real BFF pipeline over synthetic
 * fixtures (see support/content-backend.ts), and the browser doing filters, saved views, selection, the inspector,
 * playbook launch params and export.
 */

const THEMES = ['steel', 'daylight'] as const;

async function expectNoAxeViolations(page: Page) {
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

/** base64url JSON → value (what the playbook drawer decodes). */
function decode(param: string | null): unknown {
  if (!param) return undefined;
  const b64 = param.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64').toString('utf8'));
}

async function open(
  page: Page,
  path: string,
  opts: { theme?: string; live?: boolean; backend?: BackendOptions } = {},
) {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockApi(page, opts.live ? { me: me({ dataMode: 'live' }) } : {});
  await routeContentBackend(page, {
    ...opts.backend,
    override: async (route, url) => {
      if (opts.backend?.override && (await opts.backend.override(route, url))) return true;
      return false;
    },
  });
  // Probe results come from the scheduler's API (not part of the content backend).
  await page.route('**/api/probes', (route) => route.fulfill({ json: PROBES }));
  await setPrefs(page, { theme: opts.theme ?? 'steel', density: 'comfortable' });
  await page.goto(path);
}

const usersGrid = (page: Page) => page.getByRole('grid', { name: 'Results' });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

test.describe('identity.users (list-detail)', () => {
  test('filters and search go to the URL and re-query the BFF', async ({ page }) => {
    const calls: NonNullable<BackendOptions['calls']> = [];
    await open(page, '/p/identity.users', { backend: { calls } });
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
    await expect(usersGrid(page).getByRole('row').nth(1)).toContainText('Avery Engineer');

    // Facet (server-side param).
    await page
      .getByRole('search', { name: 'Filters' })
      .getByRole('button', { name: 'Type', exact: true })
      .click();
    await page.getByRole('checkbox', { name: 'Guest' }).click();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/userType=Guest/);
    await expect
      .poll(() =>
        calls.some(
          (c) =>
            c.path === '/api/datasources/execute-many' &&
            (c.body as { params: Record<string, unknown> }).params.userType === 'Guest',
        ),
      )
      .toBe(true);
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText('Type:Guest');

    // Server search box (debounced) → q.
    await page.getByRole('searchbox', { name: 'Search' }).fill('casey');
    await expect(page).toHaveURL(/q=casey/);

    // Clear → back to the definition defaults (nothing in the URL).
    await page
      .getByRole('search', { name: 'Filters' })
      .getByRole('button', { name: 'Clear', exact: true })
      .click();
    await expect(page).not.toHaveURL(/userType=|q=/);
  });

  test('the advanced filter goes to the BFF as a structured filter (base64url JSON in the URL)', async ({
    page,
  }) => {
    const calls: NonNullable<BackendOptions['calls']> = [];
    await open(page, '/p/identity.users', { backend: { calls } });
    await expect(usersGrid(page).getByRole('row').nth(1)).toBeVisible();
    await page.getByRole('button', { name: 'Advanced filter' }).click();
    const builder = page.getByRole('dialog', { name: 'Advanced filter' });
    await builder.getByRole('combobox', { name: 'Condition 1 operator' }).click();
    await page.getByRole('option', { name: 'starts with' }).click();
    await builder.getByRole('textbox', { name: 'Condition 1 value' }).fill('IT');
    await builder.getByRole('button', { name: 'Add condition' }).click();
    await builder.getByRole('combobox', { name: 'Condition 2 field' }).click();
    await page.getByRole('option', { name: 'Created' }).click();
    await builder.getByRole('textbox', { name: 'Condition 2 value' }).fill('-365d');
    await builder.getByRole('button', { name: 'Apply' }).click();
    const expected = {
      all: [
        { field: 'department', op: 'startsWith', value: 'IT' },
        { field: 'createdDateTime', op: 'ge', value: '-365d' },
      ],
    };
    await expect(page).toHaveURL(/[?&]adv=[A-Za-z0-9_-]+/);
    expect(decode(new URL(page.url()).searchParams.get('adv'))).toEqual(expected);
    await expect
      .poll(() =>
        calls.some(
          (c) =>
            c.path === '/api/datasources/execute-many' &&
            JSON.stringify((c.body as { params: { adv?: unknown } }).params.adv) === JSON.stringify(expected),
        ),
      )
      .toBe(true);
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText('2 conditions');
  });

  test('a filter the BFF rejects shows its problems in the builder', async ({ page }) => {
    const bad = Buffer.from(
      JSON.stringify({
        all: [
          { field: 'nope', op: 'eq', value: 'x' },
          { field: 'createdDateTime', op: 'ge', value: 'yesterday-ish' },
        ],
      }),
    ).toString('base64url');
    await open(page, `/p/identity.users?adv=${bad}`);
    await expect(page.getByText(/The advanced filter was rejected: .*unknown field "nope"/)).toBeVisible();
    await page.getByRole('button', { name: /Advanced filter, 2 conditions/ }).click();
    const alert = page.getByRole('dialog', { name: 'Advanced filter' }).getByRole('alert');
    await expect(alert).toContainText('unknown field "nope"');
    await expect(alert).toContainText('createdDateTime ge: expects an ISO date');
  });

  test('table state (sort, columns, client filters) lives in the URL and survives a reload', async ({
    page,
  }) => {
    await open(page, '/p/identity.users');
    const grid = usersGrid(page);
    await expect(grid.getByRole('row').nth(1)).toBeVisible();
    await grid.getByRole('button', { name: 'Name', exact: true }).click();
    await expect(page).toHaveURL(/users\.sort=displayName/);
    await grid.getByRole('button', { name: 'Name', exact: true }).click();
    await expect(page).toHaveURL(/users\.sort=-displayName/);
    await page.getByRole('button', { name: 'Columns' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Job title' }).click();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/users\.cols=/);
    await page.reload();
    await expect(grid.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'descending');
    await expect(grid.getByRole('columnheader', { name: /Job title/ })).toHaveCount(0);
  });

  test('bulk selection launches the playbook drawer with one inputs object per row', async ({ page }) => {
    await open(page, '/p/identity.users');
    const grid = usersGrid(page);
    const rowBoxes = grid.getByRole('checkbox', { name: /^Select (?!all rows)/ });
    await rowBoxes.nth(0).click();
    await rowBoxes.nth(1).click();
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    await expect(bar).toContainText('2 selected');
    await bar
      .getByRole('button', { name: /sign-in/ })
      .first()
      .click();
    await expect(page).toHaveURL(/playbook=identity\./);
    const items = decode(new URL(page.url()).searchParams.get('items')) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(items.map((i) => i.userId)).size).toBe(2);
  });

  test('a row action launches its playbook with rendered inputs', async ({ page }) => {
    await open(page, '/p/identity.users');
    const first = usersGrid(page)
      .getByRole('button', { name: /^Actions for / })
      .first();
    await first.click();
    await page.getByRole('menuitem', { name: /Revoke sessions/ }).click();
    await expect(page).toHaveURL(/playbook=identity\.revoke-sessions/);
    expect(decode(new URL(page.url()).searchParams.get('inputs'))).toMatchObject({
      userId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  test('saved views: save, reopen, and the standard view', async ({ page }) => {
    const calls: NonNullable<BackendOptions['calls']> = [];
    await open(page, '/p/identity.users?userType=Guest', { backend: { calls } });
    await expect(usersGrid(page).getByRole('row').nth(1)).toBeVisible();
    await page.getByRole('button', { name: /Saved views/ }).click();
    await page.getByRole('menuitem', { name: 'Save as new view…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save view' });
    await dialog.getByLabel('Name').fill('Guests to review');
    await dialog.getByRole('switch', { name: 'Share with everyone' }).click();
    await dialog.getByRole('button', { name: 'Save view' }).click();
    await expect(page.getByText('Saved view “Guests to review”', { exact: true })).toBeVisible();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/views');
    expect(post?.body).toMatchObject({
      page: 'identity.users',
      name: 'Guests to review',
      shared: true,
      state: { params: { userType: 'Guest' } },
    });
    await expect(page).toHaveURL(/view=/);

    // Back to the standard view, then reopen the saved one from the menu.
    await page.getByRole('button', { name: /Saved views/ }).click();
    await page.getByRole('menuitem', { name: 'Standard view' }).click();
    await expect(page).not.toHaveURL(/userType=/);
    await page.getByRole('button', { name: /Saved views/ }).click();
    await page.getByRole('menuitem', { name: /Guests to review/ }).click();
    await expect(page).toHaveURL(/userType=Guest/);
    await expect(page.getByRole('button', { name: /Saved views: Guests to review/ })).toBeVisible();
  });

  test('export posts the current params and visible columns and downloads the file', async ({ page }) => {
    const calls: NonNullable<BackendOptions['calls']> = [];
    await open(page, '/p/identity.users?userType=Member', { backend: { calls } });
    await expect(usersGrid(page).getByRole('row').nth(1)).toBeVisible();
    await page.getByRole('button', { name: 'Export' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: /CSV/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    const post = calls.find((c) => c.path === '/api/reports/identity.users/export');
    expect(post?.body).toMatchObject({ format: 'csv', params: { userType: 'Member' } });
    expect((post?.body as { columns: string[] }).columns).toContain('displayName');
    await expect(page.getByText(/Exported .*\.csv/)).toBeVisible();
  });

  for (const theme of THEMES) {
    test(`visual · users · ${theme}`, async ({ page }) => {
      await open(page, '/p/identity.users', { theme });
      await expect(usersGrid(page).getByRole('row').nth(6)).toBeVisible();
      await usersGrid(page)
        .getByRole('checkbox', { name: /^Select (?!all rows)/ })
        .nth(1)
        .click();
      await settle(page);
      await growViewportToPage(page);
      await expect(page).toHaveScreenshot(`renderer-users-${theme}.png`);
      await expectNoAxeViolations(page);
    });
  }
});

test.describe('inspector (entity page in the drawer)', () => {
  test('clicking a row opens identity.user in the inspector, deep-linkable', async ({ page }) => {
    await open(page, '/p/identity.users');
    const row = usersGrid(page).getByRole('row').nth(2);
    const name = (await row.getByRole('gridcell').nth(1).locator('span span').first().textContent())!.trim();
    await row.click();
    await expect(page).toHaveURL(/inspect=page%3Aidentity\.user/);
    await expect(page).toHaveURL(/i\.id=[0-9a-f-]{36}/);
    const drawer = page.getByRole('dialog', { name });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('tab', { name: 'Overview' })).toBeVisible();
    await expect(row).toHaveClass(/af-row-active/);
    // Deep link: a fresh load opens the same entity.
    await page.reload();
    await expect(page.getByRole('dialog', { name })).toBeVisible();
    await page.getByRole('dialog', { name }).getByRole('button', { name: 'Close' }).click();
    await expect(page).not.toHaveURL(/inspect=/);
  });

  for (const theme of THEMES) {
    test(`visual · inspector · ${theme}`, async ({ page }) => {
      await open(page, '/p/identity.users', { theme });
      const row = usersGrid(page).getByRole('row').nth(1);
      const name = (await row
        .getByRole('gridcell')
        .nth(1)
        .locator('span span')
        .first()
        .textContent())!.trim();
      await row.click();
      const drawer = page.getByRole('dialog', { name });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole('tabpanel')).toBeVisible();
      await expect(drawer.getByRole('tabpanel').getByText('didn’t load')).toHaveCount(0);
      await settle(page);
      await expect(page).toHaveScreenshot(`renderer-inspector-${theme}.png`);
      await expectNoAxeViolations(page);
    });
  }
});

test.describe('dashboard', () => {
  for (const theme of THEMES) {
    test(`visual · m365.overview · ${theme}`, async ({ page }) => {
      await open(page, '/p/m365.overview', { theme });
      await expect(page.getByRole('heading', { level: 1, name: 'Microsoft 365 overview' })).toBeVisible();
      await expect(page.getByRole('list', { name: 'Service health' })).toBeVisible();
      await expect(page.locator('figure svg').first()).toBeVisible();
      await settle(page);
      await growViewportToPage(page);
      await settle(page);
      await expect(page).toHaveScreenshot(`renderer-dashboard-${theme}.png`);
      await expectNoAxeViolations(page);
    });
  }

  test('probe dashboard renders probe results and the markdown guidance', async ({ page }) => {
    await open(page, '/p/automation.monitoring');
    await expect(page.getByRole('heading', { level: 1, name: 'Synthetic monitoring' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Token acquisition (automation identity)' })).toContainText(
      'Failing',
    );
    await page
      .getByRole('list', { name: 'Token acquisition (automation identity)' })
      .getByRole('button', { name: /Token acquisition · Exchange Online/ })
      .click();
    await expect(
      page.getByRole('list', { name: 'Token acquisition (automation identity)' }).getByText(/AADSTS7000215/),
    ).toBeVisible();
  });
});

test.describe('report', () => {
  test('parameters re-run the report; the export bar exports every row', async ({ page }) => {
    const calls: NonNullable<BackendOptions['calls']> = [];
    await open(page, '/p/identity.app-credential-expiry', { backend: { calls } });
    await expect(page.getByRole('heading', { level: 1, name: 'App credential expiry' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Expiring within' }).click();
    await page.getByRole('option', { name: '90 days' }).click();
    await expect(page).toHaveURL(/days=90/);
    await expect
      .poll(() =>
        calls.some(
          (c) =>
            c.path === '/api/datasources/execute-many' &&
            (c.body as { params: { days?: number } }).params.days === 90,
        ),
      )
      .toBe(true);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export report' }).click();
    await page.getByRole('menuitem', { name: /Excel/ }).click();
    expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
  });

  for (const theme of THEMES) {
    test(`visual · report · ${theme}`, async ({ page }) => {
      await open(page, '/p/identity.app-credential-expiry', { theme });
      await expect(page.getByRole('grid', { name: 'Results' }).getByRole('row').nth(1)).toBeVisible();
      await settle(page);
      await growViewportToPage(page);
      await expect(page).toHaveScreenshot(`renderer-report-${theme}.png`);
      await expectNoAxeViolations(page);
    });
  }
});

test.describe('licence gate', () => {
  const noIntune: BackendOptions = {
    override: async (route, url) => {
      if (url.pathname !== '/api/me/capabilities') return false;
      await route.fulfill({ json: CAPABILITIES_NO_INTUNE });
      return true;
    },
  };

  test('live tenant without Intune: the page explains what is missing and loads no data', async ({
    page,
  }) => {
    const calls: NonNullable<BackendOptions['calls']> = [];
    await open(page, '/p/endpoint.devices', { live: true, backend: { ...noIntune, calls } });
    const gate = page.getByRole('region', { name: /Microsoft Intune isn’t licensed/ });
    await expect(gate).toBeVisible();
    await expect(gate).toContainText('INTUNE_A');
    expect(calls.some((c) => c.path.startsWith('/api/datasources'))).toBe(false);
  });

  for (const theme of THEMES) {
    test(`visual · licence gate · ${theme}`, async ({ page }) => {
      await open(page, '/p/endpoint.devices', { theme, live: true, backend: noIntune });
      await expect(page.getByRole('region', { name: /isn’t licensed/ })).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`renderer-licence-gate-${theme}.png`);
      await expectNoAxeViolations(page);
    });
  }

  test('mock mode keeps sample data under a “Preview with sample data” banner', async ({ page }) => {
    await open(page, '/p/endpoint.devices', { backend: noIntune });
    await expect(page.getByRole('note', { name: 'Preview with sample data' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Managed devices' })).toBeVisible();
  });
});

test.describe('navigation and palette', () => {
  test('the command palette shows directory search results by type', async ({ page }) => {
    await open(page, '/p/identity.users');
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('avery');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette.getByRole('group', { name: 'Users' })).toContainText('Avery Engineer');
    await palette
      .getByRole('option', { name: /Avery Engineer/ })
      .first()
      .click();
    await expect(page).toHaveURL(/identity\.user/);
  });

  test('nav items for unlicensed features carry a quiet “Requires …” lock', async ({ page }) => {
    await open(page, '/p/identity.users', {
      backend: {
        override: async (route, url) => {
          if (url.pathname !== '/api/nav') return false;
          const res = await fetch(`${await backendUrl()}/api/nav`);
          const nav = (await res.json()) as {
            sections: Array<{ key: string; items: Array<{ key: string; badge?: string }> }>;
          };
          for (const s of nav.sections)
            for (const i of s.items) if (s.key === 'endpoint') i.badge = 'Requires INTUNE_A or EMS';
          await route.fulfill({ json: nav });
          return true;
        },
      },
    });
    // Sections start collapsed: open Endpoint to see its pages.
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await nav.getByRole('button', { name: /^Endpoint/ }).click();
    const link = nav.getByRole('link', { name: /Managed devices/ });
    await expect(link).toContainText('Intune');
    await expect(link).toHaveAccessibleName(/Requires INTUNE_A or EMS/);
  });
});
