import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, me } from '../support/web/fixtures/session';
import { mockApi, setPrefs, settle, type MockHandler } from './support/mock-api';
import { automationApi } from '../support/web/mock-automation';

/**
 * Visual baselines for a degraded probe's detail: what it found (the rows behind the result), what to do with a link to
 * act, and what the check is for — in Steel (dark) and Daylight (light).
 */
const THEMES = ['steel', 'daylight'] as const;
const OPERATOR = me({ roles: ['Portal.Reader', 'Portal.Operator'] });
const at = (h: number) => new Date(FIXED_NOW - h * 3_600_000).toISOString();
const days = (d: number) => new Date(FIXED_NOW + d * 86_400_000).toISOString();
const KEY = 'probes.saml-certificates-expiring';
const message = (n: number) => `${n} item${n === 1 ? '' : 's'} counted; warn ≥ 1.`;
const PROBE = {
  key: KEY,
  title: 'SAML signing certificates expiring within 30 days',
  kind: 'graphCount',
  group: 'identity',
  summary:
    'Counts the enabled SAML enterprise applications whose newest token-signing certificate expires within 30 days, so a replacement can be created, activated and uploaded to the application before single sign-on breaks.',
  remedy:
    'A SAML app’s signing certificate expires soon. Before it does: in Entra ID › Enterprise applications › the app › Single sign-on, create a new certificate, upload it to the app (or send its vendor the federation metadata), then make it active.',
  link: { label: 'Open SAML certificate expiry', href: '/p/identity.saml-certificate-expiry' },
  latest: { ts: at(1), metric: 2, status: 'warn', unit: 'items', message: message(2) },
  series: Array.from({ length: 24 }, (_, i) => ({ ts: at(24 - i), metric: i < 18 ? 1 : 2, status: 'warn' })),
  thresholds: { warn: 1, unit: 'items', worse: 'higher' },
};
const ROWS = [
  { displayName: 'Example Org Payroll', expires: days(9), daysRemaining: 9 },
  { displayName: 'Example Org Travel', expires: days(23), daysRemaining: 23 },
];
const handler: MockHandler = ({ method, path }) => {
  if (method === 'GET' && path === '/api/probes')
    return {
      body: { items: [PROBE], groups: [{ key: 'identity', label: 'Identity', icon: 'identification-card' }] },
    };
  if (method === 'GET' && path === `/api/probes/${KEY}/results`)
    return {
      body: {
        items: PROBE.series
          .map((p) => ({
            ...p,
            unit: 'items',
            message: message(p.metric),
            details: { rows: ROWS.slice(0, p.metric), totalRows: p.metric },
          }))
          .reverse(),
      },
    };
  return undefined;
};

async function open(page: Page, theme: string) {
  await mockApi(page, { me: OPERATOR, handlers: [handler, automationApi().handler] });
  await setPrefs(page, { theme, density: 'comfortable' });
  await page.goto(`/monitoring?probe=${KEY}`);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

for (const theme of THEMES)
  test(`monitoring detail · what it found · ${theme}`, async ({ page }) => {
    await open(page, theme);
    const drawer = page.getByRole('dialog', { name: PROBE.title });
    await expect(
      drawer.getByRole('region', { name: 'What it found' }).getByText('Example Org Payroll'),
    ).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Open SAML certificate expiry' })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
    await settle(page);
    await expect(page).toHaveScreenshot(`monitoring-detail-found-${theme}.png`);
  });
