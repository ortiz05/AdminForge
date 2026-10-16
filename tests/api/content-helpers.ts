/**
 * Self-contained content and connector fixtures for the content/platform API tests (content routes, datasources,
 * advanced filters and rows, export, admin, views), so they don't depend on portal/content, which other work keeps
 * changing. Synthetic only.
 *
 * The data lives in tests/fixtures/content/platform/: `content/` is a content tree (navigation, pages incl. the
 * `deps.*` dependency-chain pages, a report, a playbook) and `responses/` the connector fixtures that answer it in
 * DATA_MODE=fixtures (same naming scheme as tests/fixtures/<service>/). `setupContent()` copies both into a temporary
 * directory per suite — tests add or change files there with `env.write()` — and returns the config overrides that
 * point the app at it; `fixturesApp()` / `liveApp()` build the app over it (mock sign-in + fixtures, or the fake
 * Entra client + a fetch the test answers). `TEST_USERS` are the users the `/users` fixture returns.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot } from '../lib/repo';
import {
  cookieFrom,
  entraConfig,
  FakeAuthClient,
  json,
  makeApp,
  mockConfig,
  orgResponse,
  bindingCookie,
} from './helpers';

/** The fixture set: `content/` (definitions) and `responses/` (connector fixtures). */
const FIXTURE_SET = path.join(repoRoot, 'tests/fixtures/content/platform');

export interface TestUser {
  id: string;
  displayName: string;
  userPrincipalName: string;
  accountEnabled: boolean;
  userType: 'Member' | 'Guest';
  department: string | null;
}

/** First page of `GET /users` in the fixtures (Avery, Blake, Casey the guest). */
export const TEST_USERS: TestUser[] = (
  JSON.parse(readFileSync(path.join(FIXTURE_SET, 'responses/graph/v1.0/users/GET.json'), 'utf8')) as {
    value: TestUser[];
  }
).value;

export interface ContentEnv {
  contentDir: string;
  fixturesDir: string;
  /** Config overrides pointing the app at this content and these fixtures. */
  overrides: Record<string, string>;
  write(rel: string, text: string): void;
  cleanup(): void;
}

/** A private copy of the fixture set in a temporary directory (remove it with `cleanup()`). */
export function setupContent(): ContentEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'af-api-content-'));
  const contentDir = path.join(root, 'content');
  const fixturesDir = path.join(root, 'fixtures');
  cpSync(path.join(FIXTURE_SET, 'content'), contentDir, { recursive: true });
  cpSync(path.join(FIXTURE_SET, 'responses'), fixturesDir, { recursive: true });
  return {
    contentDir,
    fixturesDir,
    overrides: { CONTENT_DIR: contentDir, ADMINFORGE_FIXTURES_DIR: fixturesDir, CONTENT_WATCH: 'false' },
    write: (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(contentDir, rel)), { recursive: true });
      writeFileSync(path.join(contentDir, rel), text);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Mock sign-in + DATA_MODE=fixtures over the synthetic content. */
export async function fixturesApp(env: ContentEnv, overrides: Record<string, string> = {}) {
  return makeApp(mockConfig({ ...env.overrides, ...overrides }));
}

/** Entra (fake AuthClient) + live data answered by `route`; returns a signed-in cookie. */
export async function liveApp(
  env: ContentEnv,
  route: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const auth = new FakeAuthClient();
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/organization') && !url.includes('$batch')) return orgResponse();
    calls.push({
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return route(url, init);
  };
  const t = await makeApp(entraConfig(env.overrides), { auth, fetch });
  const login = await t.app.inject({ method: 'GET', url: '/auth/login' });
  const state = new URL(login.headers.location as string).searchParams.get('state')!;
  const cb = await t.app.inject({
    method: 'GET',
    url: `/auth/callback?code=c&state=${state}`,
    headers: { cookie: bindingCookie(login)! },
  });
  const cookie = cookieFrom(cb)!;
  const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { ...t, auth, calls, cookie, csrf: (me.json() as { csrf: string }).csrf };
}

export { json };
