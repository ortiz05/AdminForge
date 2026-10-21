/**
 * The mock portal API for the Playwright specs: `mockApi(page, opts)` answers every /api and /auth request in the
 * browser — feature handlers first (`opts.handlers`, e.g. tests/support/web/mock-automation.ts `automationApi()` or
 * mock-reports.ts `reportsApi()`), then defaults for the session (`me`, sign-in/out, arm/disarm), navigation,
 * overview, preferences and capabilities from tests/support/web/fixtures — and records every call so specs can assert
 * on writes. Also: `setPrefs` (stored preferences before load), `settle` (fonts and animations done) and
 * `growViewportToPage` (full-page screenshots).
 *
 * The handler types live in tests/support/web/mock-handler.ts (shared with the component tests) and are re-exported
 * here for the specs.
 */
import type { Page, Route } from '@playwright/test';
import type { MeResponse } from '@adminforge/schemas';
import { overview } from '../../support/web/fixtures/overview';
import { FIXED_NOW, me, NAV } from '../../support/web/fixtures/session';
import type { MockHandler } from '../../support/web/mock-handler';
import { schedulePreview } from '../../support/web/mock-schedule-preview';

export type { MockHandler, MockReply, MockRequest } from '../../support/web/mock-handler';

export interface MockOptions {
  me?: MeResponse;
  overview?: unknown;
  /** Status for GET /api/overview (e.g. 503 to exercise the error state). */
  overviewStatus?: number;
  handlers?: MockHandler[];
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  });

/** Answers every /api and /auth call from fixtures; records writes so tests can assert on them. */
export async function mockApi(page: Page, opts: MockOptions = {}) {
  const calls: Array<{ method: string; path: string; body: unknown; csrf: string | null }> = [];
  let session = opts.me ?? me();

  await page.route(
    (url) => url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/'),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const method = req.method();
      const body = req.postData() ? JSON.parse(req.postData()!) : undefined;
      const csrf = await req.headerValue('x-adminforge-csrf');
      calls.push({ method, path: url.pathname, body, csrf });

      for (const handler of opts.handlers ?? []) {
        const reply = handler({ method, path: url.pathname, url, body, csrf });
        if (!reply) continue;
        if (reply.text !== undefined)
          return route.fulfill({
            status: reply.status ?? 200,
            contentType: reply.contentType ?? 'text/plain',
            headers: { 'cache-control': 'no-store' },
            body: reply.text,
          });
        return json(route, reply.body ?? {}, reply.status ?? 200);
      }

      switch (`${method} ${url.pathname}`) {
        case 'GET /api/me':
          return json(route, session);
        case 'GET /api/nav':
          return json(route, NAV);
        case 'GET /api/overview':
          return opts.overviewStatus
            ? json(
                route,
                {
                  error: {
                    code: 'upstream_unavailable',
                    message: 'Microsoft Graph did not answer in time.',
                    hint: 'Try again in a minute.',
                    correlationId: '5f0c2e81-7a4d-4b39-8c6e-1d2f3a4b5c6d',
                  },
                },
                opts.overviewStatus,
              )
            : json(route, opts.overview ?? overview());
        case 'GET /api/search':
          return json(route, { query: url.searchParams.get('q') ?? '', results: [], sources: {} });
        case 'PUT /api/me/prefs':
          return json(route, { ok: true });
        case 'POST /auth/arm/extend': {
          const armedUntil = new Date(FIXED_NOW + 60 * 60_000).toISOString();
          session = { ...session, armedUntil, armExtended: true };
          return json(route, { armedUntil });
        }
        case 'POST /auth/disarm':
          session = { ...session, mode: 'read', armedUntil: null, armExtended: false };
          return json(route, { ok: true });
        case 'POST /auth/arm': {
          // Mock sign-in arms at once and comes back to where the user was (returnTo), like the mock BFF.
          session = {
            ...session,
            mode: 'armed',
            armedUntil: new Date(FIXED_NOW + (47 * 60 + 12) * 1000).toISOString(),
            armExtended: false,
          };
          return json(route, { redirect: url.searchParams.get('returnTo') ?? '/?armed=1' });
        }
        case 'GET /api/runs':
          return json(route, { items: [] });
        case 'POST /api/schedules/preview':
          // The schedule editors' live preview: what the BFF would answer (shared describer and grammar).
          return json(route, schedulePreview(body));
        case 'GET /api/news/summary':
          // The shell reads it on every page: nothing unread or breaking unless a spec says otherwise.
          return json(route, {
            unread: 0,
            breakingUnread: 0,
            breaking: [],
            lastUpdatedAt: null,
            seenAt: null,
            feeds: [],
          });
        case 'GET /api/probes':
          // The navigation rail reads it on every page (each section's check status): no probes unless a spec says
          // otherwise (feature handlers and page.route answer first).
          return json(route, { items: [], groups: [] });
        case 'GET /api/emergency':
          // The shell's emergency-stop banner reads it on every page: nothing paused unless a spec says otherwise.
          return json(route, {
            writes: { paused: false, reason: null, by: null, at: null },
            automation: { paused: false, reason: null, by: null, at: null },
            canPause: false,
            canResume: false,
          });
        case 'GET /api/events':
          // One-shot stream; the long retry keeps EventSource from reconnecting during a test.
          return route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: 'retry: 600000\n\nevent: ready\ndata: {"mode":"read"}\n\n',
          });
        case 'GET /api/appearance.css':
          return route.fulfill({ status: 200, contentType: 'text/css', body: '/* no overrides */\n' });
        case 'POST /auth/logout':
          return json(route, { redirect: '/signed-out' });
        default:
          return json(
            route,
            { error: { code: 'not_found', message: `No mock for ${method} ${url.pathname}` } },
            404,
          );
      }
    },
  );
  return { calls };
}

/** Theme, density and navigation state before the app boots (what theme-init.js reads). */
export async function setPrefs(
  page: Page,
  prefs: { theme?: string; density?: string; navCollapsed?: boolean },
) {
  await page.addInitScript((p) => localStorage.setItem('adminforge.prefs', JSON.stringify(p)), prefs);
}

/** Fonts loaded and lazy chunks (icons, charts) settled. */
export async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

/**
 * The shell's rail, nav and run dock are position: fixed, so Playwright's fullPage capture would paint them
 * mid-page. Grow the viewport to the document height instead, so the screenshot shows the page as laid out.
 */
export async function growViewportToPage(page: Page, width = 1440) {
  const height = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  await page.setViewportSize({ width, height: Math.max(900, height) });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
