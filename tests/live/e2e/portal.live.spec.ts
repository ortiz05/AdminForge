import { expect, test, type Page } from '@playwright/test';
import { loadEnv } from '@adminforge/config';
import { signInWithEntra, testUserCredentials } from '../lib/entra-login';
import { why } from '../lib/mask';
import { liveOutDir } from '../lib/output';
import { createApiCall, type ApiCall } from '../lib/portal-session';
import {
  createRun,
  previewThenRun,
  settle,
  stepOutput,
  type PreviewThenRunOptions,
  type RunClient,
} from '../lib/runs';

/**
 * The live sweep (`pnpm test:live`): sign in as the validation user, render every area, run read playbooks (dry run),
 * arm, and run reversible writes against AF-Test-* objects only.
 *
 * Inputs: a running stack at PUBLIC_BASE_URL (playwright.config.ts), the env file and <env>.admin.env; global-setup.ts
 * enables the validation user for the run and global-teardown.ts disables it again.
 * Output: statuses, counts and error codes on the console — never tenant identifiers; messages are masked
 * (lib/mask.ts). Screenshots go to `<AF_LIVE_OUT>/shots` (lib/output.ts), outside the repository.
 * Safety: writes only on AF-Test-* objects, each reversed in the same test (add → remove, disable → enable), always
 * preview first (lib/runs.ts); disarms at the end.
 */
const creds = testUserCredentials(loadEnv(process.env, { admin: true }));
const shots = liveOutDir('shots');

test.describe.configure({ mode: 'serial' });
let page: Page;
let call: ApiCall;
/** Runs through lib/runs.ts with Playwright's own waits. */
let runs: RunClient;
const findings: string[] = [];

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  page = await context.newPage();
  call = createApiCall(context.request);
  runs = { api: call, sleep: (ms) => page.waitForTimeout(ms) };
  await page.goto('/auth/login?returnTo=%2F');
  await signInWithEntra(page, creds);
  await page.waitForURL((u) => u.pathname === '/' && !/login\.microsoftonline/.test(u.host), {
    timeout: 60_000,
  });
});

test('session: roles and read mode', async () => {
  const { status, json } = await call<{ roles: string[]; mode: string; authMode: string; dataMode: string }>(
    'GET',
    '/api/me',
  );
  expect(status).toBe(200);
  console.log('me', {
    roles: json.roles.length,
    mode: json.mode,
    authMode: json.authMode,
    dataMode: json.dataMode,
  });
  expect(json.mode).toBe('read');
  expect(json.authMode).toBe('entra');
});

const PAGES = [
  '/',
  'identity.users',
  'identity.groups',
  'identity.roles',
  'identity.app-registrations',
  'identity.enterprise-apps',
  'identity.devices',
  'identity.conditional-access',
  'identity.sign-ins',
  'identity.audit-logs',
  'identity.health',
  'm365.overview',
  'm365.service-health',
  'm365.licences',
  'security.overview',
  'endpoint.devices',
  'azure.overview',
  'azure.resources',
  'azure.arc-servers',
  'azure.function-apps',
  'azure.rbac',
  'identity.app-credential-expiry',
  'identity.privileged-roles',
];

for (const key of PAGES) {
  test(`page renders: ${key}`, async () => {
    const errors: string[] = [];
    const onResponse = async (res: import('@playwright/test').Response) => {
      if (!/\/api\/datasources\/execute/.test(res.url())) return;
      try {
        const body = (await res.json()) as {
          results?: Record<string, { error?: { code: string } }>;
          error?: { code: string };
        };
        if (body.error) errors.push(body.error.code);
        for (const r of Object.values(body.results ?? {})) if (r?.error) errors.push(r.error.code);
      } catch {
        /* streamed or empty */
      }
    };
    page.on('response', onResponse);
    await page.goto(key === '/' ? '/' : `/p/${key}`);
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    page.off('response', onResponse);
    const text = await page
      .locator('main')
      .innerText()
      .catch(() => '');
    const gated = /Requires|isn't licensed|not licensed/i.test(text);
    await page.screenshot({ path: `${shots}/${key.replace(/[^a-z0-9.]/gi, '_')}.png`, fullPage: true });
    console.log(
      `page ${key}: ${gated ? 'licence-gated' : 'rendered'}; datasource errors: ${errors.length ? [...new Set(errors)].join(',') : 'none'}`,
    );
    expect(await page.locator('text=Something went wrong').count()).toBe(0);
    const unexpected = errors.filter(
      (e) => !['licence_required', 'forbidden', 'graph_forbidden', 'Authorization_RequestDenied'].includes(e),
    );
    if (unexpected.length) findings.push(`${key}: ${[...new Set(unexpected)].join(', ')}`);
  });
}

test('page sweep summary', () => {
  console.log(`datasource findings (${findings.length}):\n  ${findings.join('\n  ') || 'none'}`);
});

for (const route of [
  '/runs',
  '/approvals',
  '/schedules',
  '/monitoring',
  '/query',
  '/audit',
  '/appearance',
  '/settings',
  '/news',
]) {
  test(`ops page: ${route}`, async () => {
    await page.goto(route);
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${shots}/ops${route.replace(/\//g, '_')}.png`, fullPage: true });
    expect(await page.locator('text=Something went wrong').count()).toBe(0);
  });
}

test('query studio: Resource Graph and Log Analytics', async () => {
  const rg = await call<{ rowCount: number }>('POST', '/api/query', {
    source: 'resourceGraph',
    query: 'resourcecontainers | summarize count() by type',
  });
  console.log('query resourceGraph', rg.status, { rows: rg.json?.rowCount });
  expect(rg.status).toBe(200);
  const la = await call<{ rowCount: number }>('POST', '/api/query', {
    source: 'logAnalytics',
    query: 'AzureActivity | summarize count() by CategoryValue',
    timespan: 'P1D',
  });
  console.log('query logAnalytics', la.status, { rows: la.json?.rowCount });
  expect(la.status).toBe(200);
});

test('schedules and probes', async () => {
  const s = await call<{ items: Array<{ key: string; enabled: boolean; lastStatus?: string }> }>(
    'GET',
    '/api/schedules',
  );
  console.log('schedules', {
    count: s.json.items.length,
    enabled: s.json.items.filter((i) => i.enabled).length,
  });
  const p = await call<{ items: Array<{ latest: { status: string } | null }> }>('GET', '/api/probes');
  const counts: Record<string, number> = {};
  for (const i of p.json.items)
    counts[i.latest?.status ?? 'none'] = (counts[i.latest?.status ?? 'none'] ?? 0) + 1;
  console.log('probes', counts);
  expect(p.status).toBe(200);
});

test('news and changes: feeds collected, items listed, detail readable', async () => {
  const summary = await call<{
    unread: number;
    breaking: unknown[];
    lastUpdatedAt: string | null;
    feeds: Array<{ status: string; scope: string }>;
  }>('GET', '/api/news/summary');
  expect(summary.status).toBe(200);
  const statuses: Record<string, number> = {};
  for (const f of summary.json.feeds) statuses[f.status] = (statuses[f.status] ?? 0) + 1;
  console.log('news feeds', {
    feeds: summary.json.feeds.length,
    tenant: summary.json.feeds.filter((f) => f.scope === 'tenant').length,
    ...statuses,
    breaking: summary.json.breaking.length,
    collected: summary.json.lastUpdatedAt !== null,
  });
  expect(summary.json.feeds.length).toBeGreaterThan(0);
  const list = await call<{
    items: Array<{ id: string; areas: string[]; url: string }>;
    nextCursor: string | null;
  }>('GET', '/api/news?days=90&limit=100');
  expect(list.status).toBe(200);
  const areas: Record<string, number> = {};
  for (const i of list.json.items) for (const a of i.areas) areas[a] = (areas[a] ?? 0) + 1;
  console.log('news items (first page)', {
    items: list.json.items.length,
    more: !!list.json.nextCursor,
    areas,
  });
  expect(list.json.items.length).toBeGreaterThan(0);
  expect(list.json.items.every((i) => i.url.startsWith('https://'))).toBe(true);
  const detail = await call<{ id: string }>('GET', `/api/news/${list.json.items[0]!.id}`);
  expect(detail.status).toBe(200);
  const bad = await call('GET', '/api/news?days=0');
  expect(bad.status).toBe(400);
});

let groupId = '';
let userId = '';
let user2Id = '';

test('find AF-Test targets', async () => {
  const g = await call<{ results: Array<{ id?: string; title: string }> }>(
    'GET',
    '/api/search?q=AF-Test-Group-01&type=group',
  );
  const u = await call<{ results: Array<{ id?: string; title: string }> }>(
    'GET',
    '/api/search?q=AF-Test-User&type=user',
  );
  groupId = g.json.results.find((r) => r.title === 'AF-Test-Group-01')?.id ?? '';
  userId = u.json.results.find((r) => r.title === 'AF-Test-User-01')?.id ?? '';
  user2Id = u.json.results.find((r) => r.title === 'AF-Test-User-02')?.id ?? '';
  console.log('targets found', { group: Boolean(groupId), user1: Boolean(userId), user2: Boolean(user2Id) });
  expect(groupId && userId && user2Id).toBeTruthy();
});

test('dry run: add group member (read mode)', async () => {
  const created = await createRun(runs, {
    playbook: 'identity.add-group-members',
    inputs: { groupId, userIds: [userId], reason: 'AdminForge live validation' },
    dryRun: true,
  });
  expect(created.http).toBe(202);
  const detail = await settle(runs, created);
  console.log(`dry run: ${detail.run.status}${why(detail.run.error)}`, {
    planEntries: detail.plan?.length ?? 0,
  });
  expect(detail.run.status).toBe('succeeded');
});

test('write without arming is refused', async () => {
  const unconfirmed = await call('POST', '/api/runs', {
    playbook: 'identity.add-group-members',
    inputs: { groupId, userIds: [userId], reason: 'AdminForge live validation' },
    dryRun: false,
  });
  console.log('write without a preview', unconfirmed.status);
  expect(unconfirmed.status).toBe(409);
  const { preview, run: r } = await previewThenRun(runs, 'identity.add-group-members', {
    groupId,
    userIds: [userId],
    reason: 'AdminForge live validation',
  });
  // Either the run parks until write access is armed, or the API refuses it outright (4xx).
  const status = !r
    ? `preview ${preview.run.status}`
    : r.runId
      ? (await settle(runs, r)).run.status
      : `http ${r.http}`;
  console.log('unarmed write', status);
  expect(status === 'awaiting_arm' || status.startsWith('http 4')).toBeTruthy();
  if (r?.runId) await call('POST', `/api/runs/${r.runId}/cancel`);
});

test('arm write access (step-up sign-in to the Write app)', async () => {
  const { status, json } = await call<{ redirect: string }>('POST', '/auth/arm?returnTo=%2F', {
    minutes: 15,
    reason: 'AdminForge live validation of reversible test writes',
  });
  expect(status).toBe(200);
  await page.goto(json.redirect);
  await signInWithEntra(page, creds);
  await page.waitForURL((u) => !/login\.microsoftonline/.test(u.host), { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/armed-shell.png` });
  const me = await call<{ mode: string }>('GET', '/api/me');
  console.log('after arm', me.json.mode);
  expect(me.json.mode).toBe('armed');
});

/** Preview, run and settle one playbook; prints `<label>: <status>` (errors masked) and returns the status. */
async function runPlaybook(
  label: string,
  playbook: string,
  inputs: Record<string, unknown>,
  confirm?: PreviewThenRunOptions['confirm'],
): Promise<string> {
  const { preview, run } = await previewThenRun(runs, playbook, inputs, confirm ? { confirm } : {});
  const done = run ? await settle(runs, run) : preview;
  console.log(`${label}: ${run ? '' : 'preview '}${done.run.status}${why(done.run.error)}`);
  return run ? done.run.status : `preview ${done.run.status}`;
}

test('write: add then remove group member (AF-Test objects)', async () => {
  const added = await runPlaybook('add member', 'identity.add-group-members', {
    groupId,
    userIds: [userId],
    reason: 'live validation',
  });
  expect(added).toBe('succeeded');
  const removed = await runPlaybook('remove member', 'identity.remove-group-members', {
    groupId,
    memberIds: [userId],
    reason: 'live validation cleanup',
  });
  expect(removed).toBe('succeeded');
});

test('write: disable then re-enable a test user', async () => {
  // disable-user confirms with a typed sign-in name: the UI shows the previewed user's UPN and the engineer types it.
  const disabled = await runPlaybook(
    'disable user',
    'identity.disable-user',
    { userId: user2Id, reason: 'AdminForge live validation' },
    (p) => stepOutput(p, 'lookup')?.userPrincipalName as string | undefined,
  );
  const enabled = await runPlaybook('enable user', 'identity.enable-user', {
    userId: user2Id,
    reason: 'AdminForge live validation cleanup',
  });
  expect(disabled).toBe('succeeded');
  expect(enabled).toBe('succeeded');
});

test('audit chain verifies', async () => {
  const v = await call<{ ok: boolean; checked: number }>('GET', '/api/audit/verify');
  console.log('audit verify', v.status, { ok: v.json?.ok, checked: v.json?.checked });
  expect(v.json.ok).toBe(true);
});

test('disarm', async () => {
  const d = await call<{ mode: string }>('POST', '/auth/disarm');
  expect(d.json.mode).toBe('read');
});
