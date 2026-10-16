import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { loadEnv } from '@adminforge/config';
import { mkdirSync } from 'node:fs';
import { signInWithEntra } from '../lib/entra-login';

// Live sweep: sign in as the validation user, render every area, run read playbooks (dry run), arm, and run
// reversible writes against AF-Test-* objects only. Prints statuses and counts — never tenant identifiers.
const env = loadEnv(process.env, { admin: true });
const creds = {
  upn: env.AF_TEST_USER_UPN!,
  password: env.AF_TEST_USER_PASSWORD!,
  totpSecret: env.AF_TEST_USER_TOTP_SECRET,
};
const shots = `${process.env.AF_LIVE_OUT ?? '/tmp/adminforge-live'}/shots`;
mkdirSync(shots, { recursive: true });

test.describe.configure({ mode: 'serial' });
let page: Page;
let api: APIRequestContext;
let csrf = '';
const findings: string[] = [];

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await api.fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'x-adminforge-csrf': csrf, 'content-type': 'application/json' },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status(), json: (text ? JSON.parse(text) : undefined) as T };
}

async function waitRun(
  id: string | undefined,
  created?: { status: number; json: unknown },
): Promise<{ status: string; error?: unknown }> {
  if (!id)
    return {
      status: `not created (${created?.status})`,
      error: (created?.json as { error?: unknown } | undefined)?.error,
    };
  for (let i = 0; i < 90; i++) {
    const { json } = await call<{ run: { status: string; error?: unknown } }>('GET', `/api/runs/${id}`);
    if (
      ['succeeded', 'failed', 'cancelled', 'compensated', 'needs_review'].includes(json.run.status) ||
      json.run.status.startsWith('awaiting')
    )
      return json.run;
    await page.waitForTimeout(2000);
  }
  return { status: 'timeout' };
}

type RunDetail = {
  run: { status: string };
  steps: Array<{ stepId: string; status: string; output?: unknown }>;
};

/**
 * Preview then confirm (enforced server-side for playbooks with a confirm block): dry-run with the same inputs, then
 * execute with previewRunId and — for typed confirms — the text the UI would ask for, read from the preview's outputs.
 */
async function previewThenRun(
  playbook: string,
  inputs: Record<string, unknown>,
  confirmFrom?: (preview: RunDetail) => string | undefined,
) {
  // Graph is eventually consistent: a preview right after a write may still see the old state, so retry briefly.
  let p = await call<{ runId: string }>('POST', '/api/runs', { playbook, inputs, dryRun: true });
  let preview = await waitRun(p.json?.runId, p);
  for (let attempt = 1; preview.status === 'failed' && attempt <= 5; attempt++) {
    await page.waitForTimeout(10_000);
    p = await call<{ runId: string }>('POST', '/api/runs', { playbook, inputs, dryRun: true });
    preview = await waitRun(p.json?.runId, p);
  }
  if (preview.status !== 'succeeded') return { preview, created: undefined };
  const detail = await call<RunDetail>('GET', `/api/runs/${p.json.runId}`);
  const confirmation = confirmFrom?.(detail.json);
  const created = await call<{ runId: string }>('POST', '/api/runs', {
    playbook,
    inputs,
    dryRun: false,
    previewRunId: p.json.runId,
    ...(confirmation !== undefined ? { confirmation } : {}),
  });
  return { preview, created };
}

/** A step's output from a preview, as the UI reads it for the confirmation prompt. */
const outputOf = (detail: RunDetail, stepId: string) =>
  detail.steps.filter((s) => s.stepId === stepId && s.status === 'succeeded').at(-1)?.output as
    Record<string, unknown> | undefined;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  page = await context.newPage();
  api = context.request;
  await page.goto('/auth/login?returnTo=%2F');
  await signInWithEntra(page, creds);
  await page.waitForURL((u) => u.pathname === '/' && !/login\.microsoftonline/.test(u.host), {
    timeout: 60_000,
  });
  csrf = (await call<{ csrf: string }>('GET', '/api/me')).json.csrf;
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
  const r = await call<{ runId: string }>('POST', '/api/runs', {
    playbook: 'identity.add-group-members',
    inputs: { groupId, userIds: [userId], reason: 'AdminForge live validation' },
    dryRun: true,
  });
  expect(r.status).toBe(202);
  const run = await waitRun(r.json.runId);
  const detail = await call<{ plan: unknown[] }>('GET', `/api/runs/${r.json.runId}`);
  console.log('dry run', run.status, { planEntries: detail.json.plan.length });
  expect(run.status).toBe('succeeded');
});

test('write without arming is refused', async () => {
  const unconfirmed = await call('POST', '/api/runs', {
    playbook: 'identity.add-group-members',
    inputs: { groupId, userIds: [userId], reason: 'AdminForge live validation' },
    dryRun: false,
  });
  console.log('write without a preview', unconfirmed.status);
  expect(unconfirmed.status).toBe(409);
  const { preview, created: r } = await previewThenRun('identity.add-group-members', {
    groupId,
    userIds: [userId],
    reason: 'AdminForge live validation',
  });
  const run =
    r?.status === 202
      ? await waitRun(r.json.runId)
      : { status: `preview ${preview.status} / http ${r?.status}` };
  console.log('unarmed write', run.status);
  expect(run.status === 'awaiting_arm' || run.status.startsWith('http 4')).toBeTruthy();
  if (r?.status === 202) await call('POST', `/api/runs/${r.json.runId}/cancel`);
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

test('write: add then remove group member (AF-Test objects)', async () => {
  const { created: add } = await previewThenRun('identity.add-group-members', {
    groupId,
    userIds: [userId],
    reason: 'live validation',
  });
  const a = await waitRun(add?.json?.runId, add);
  console.log('add member', a.status, a.error ?? '');
  expect(a.status).toBe('succeeded');
  const { created: rem } = await previewThenRun('identity.remove-group-members', {
    groupId,
    memberIds: [userId],
    reason: 'live validation cleanup',
  });
  const r = await waitRun(rem?.json?.runId, rem);
  console.log('remove member', r.status, r.error ?? '');
  expect(r.status).toBe('succeeded');
});

test('write: disable then re-enable a test user', async () => {
  // disable-user confirms with a typed sign-in name: the UI shows the previewed user's UPN and the engineer types it.
  const { created: dis } = await previewThenRun(
    'identity.disable-user',
    { userId: user2Id, reason: 'AdminForge live validation' },
    (p) => outputOf(p, 'lookup')?.userPrincipalName as string | undefined,
  );
  const d = await waitRun(dis?.json?.runId, dis);
  console.log('disable user', d.status, d.error ?? '');
  const { created: en } = await previewThenRun('identity.enable-user', {
    userId: user2Id,
    reason: 'AdminForge live validation cleanup',
  });
  const e = await waitRun(en?.json?.runId, en);
  console.log('enable user', e.status, e.error ?? '');
  expect(d.status).toBe('succeeded');
  expect(e.status).toBe('succeeded');
});

test('audit chain verifies', async () => {
  const v = await call<{ ok: boolean; checked: number }>('GET', '/api/audit/verify');
  console.log('audit verify', v.status, v.json);
  expect(v.json.ok).toBe(true);
});

test('disarm', async () => {
  const d = await call<{ mode: string }>('POST', '/auth/disarm');
  expect(d.json.mode).toBe('read');
});
