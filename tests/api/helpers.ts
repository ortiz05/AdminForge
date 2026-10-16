/**
 * The API test kit every tests/api suite starts from: configurations (`mockConfig`, `entraConfig`), the app on
 * in-memory stores (`makeApp`, built on support/app.ts), mock sign-in (`mockLogin`, `getMe`), cookie helpers for the
 * Entra round trip, a fake Entra client (`FakeAuthClient`) and fetch helpers (`json`, `orgResponse`, `noNetwork`).
 *
 * Feature harnesses add their fakes on top: runs-helpers.ts (playbooks), schedules-helpers.ts and
 * portal-schedules-helpers.ts (schedules, reports), content-helpers.ts (synthetic content + connector fixtures).
 * Also used by the e2e content backend (tests/e2e/support/backend-server.ts). Synthetic identifiers only.
 */
import type { AuthClient, AuthUrlInput, IdClaims } from '@adminforge/api/src/auth/types';
import { loadConfig, type Config } from '@adminforge/api/src/config';
import type { AppDeps } from '@adminforge/api/src/context';
import { MeResponse } from '@adminforge/schemas';
import { Clock } from '../lib/clock';
import { buildTestApp, noNetwork, TEST_KEY, type App } from './support/app';

export { Clock, noNetwork, TEST_KEY };

/** The bits of an inject() response these helpers read (fastify's types aren't a tests dependency). */
export interface InjectResponse {
  headers: Record<string, string | string[] | number | undefined>;
}

// Synthetic identifiers only (never a real tenant).
export const TENANT_ID = '11111111-2222-4333-8444-555555555555';
export const READ_CLIENT_ID = '22222222-3333-4444-8555-666666666666';
export const WRITE_CLIENT_ID = '33333333-4444-4555-8666-777777777777';
export const USER_OID = '44444444-5555-4666-8777-888888888888';

export function mockConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:5173',
    AUTH_MODE: 'mock',
    DATA_MODE: 'fixtures',
    ...overrides,
  });
}

export function entraConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:5173',
    AUTH_MODE: 'entra',
    DATA_MODE: 'live',
    DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
    TOKEN_CACHE_KEY: TEST_KEY,
    AF_TENANT_ID: TENANT_ID,
    AF_READ_CLIENT_ID: READ_CLIENT_ID,
    AF_READ_CLIENT_SECRET: 'synthetic-read-secret',
    AF_WRITE_CLIENT_ID: WRITE_CLIENT_ID,
    AF_WRITE_CLIENT_SECRET: 'synthetic-write-secret',
    ...overrides,
  });
}

export const MINUTE = 60_000;

export type TestApp = Awaited<ReturnType<typeof makeApp>>;

/** Builds the app on in-memory stores (returned for inspection); `extra` swaps the AuthClient, fetch, or database. */
export async function makeApp(config: Config, extra: Pick<AppDeps, 'auth' | 'fetch' | 'database'> = {}) {
  const clock = new Clock();
  if (extra.auth instanceof FakeAuthClient) extra.auth.now = clock.now;
  return buildTestApp(config, { clock, deps: extra });
}

/** "name=value" from a response's Set-Cookie for `name`. */
export function cookieFrom(res: InjectResponse, name = 'adminforge-dev'): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const hit = list.find((c) => c.startsWith(`${name}=`));
  return hit?.split(';')[0];
}

/** "name=value" of the browser-binding cookie set when a sign-in or arm round trip starts (send it to the callback). */
export const bindingCookie = (res: InjectResponse): string | undefined =>
  cookieFrom(res, 'adminforge-dev-pre') ?? cookieFrom(res, '__Host-adminforge-pre');

export function setCookieHeader(res: InjectResponse, name = 'adminforge-dev'): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list.find((c) => c.startsWith(`${name}=`));
}

export async function getMe(app: App, cookie: string) {
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { res, me: res.statusCode === 200 ? MeResponse.parse(res.json()) : undefined };
}

/** Mock sign-in → { cookie, csrf, me }. */
export async function mockLogin(app: App) {
  const res = await app.inject({ method: 'GET', url: '/auth/login' });
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error('mock login set no cookie');
  const { me } = await getMe(app, cookie);
  return { cookie, csrf: me!.csrf, me: me! };
}

/** Fake Entra: records calls; ID token claims are produced by `claims` (nonce echoed unless overridden). */
export class FakeAuthClient implements AuthClient {
  authUrls: AuthUrlInput[] = [];
  redeems: Array<{ kind: string; code: string; verifier: string; nonce: string; partitionKey: string }> = [];
  tokens: Array<{
    kind: string;
    partitionKey: string;
    homeAccountId: string;
    scopes: string[];
    claims?: string;
    forceRefresh?: boolean;
  }> = [];
  forgets: Array<{ kind: string; partitionKey: string }> = [];
  claims: (kind: 'read' | 'write') => Partial<IdClaims> = () => ({});
  /** The app's clock (wired by makeApp): ID tokens carry auth_time = now, as after a fresh interactive sign-in. */
  now: () => Date = () => new Date();
  tokenImpl?: (input: { kind: string; claims?: string }) => Promise<string>;

  async authUrl(input: AuthUrlInput) {
    this.authUrls.push(input);
    const q = new URLSearchParams({
      app: input.kind,
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.challenge,
    });
    if (input.loginHint) q.set('login_hint', input.loginHint);
    if (input.claims) q.set('claims', input.claims);
    if (input.prompt) q.set('prompt', input.prompt);
    if (input.maxAge !== undefined) q.set('max_age', String(input.maxAge));
    return `https://login.example.test/authorize?${q.toString()}`;
  }

  async redeem(input: {
    kind: 'read' | 'write';
    code: string;
    verifier: string;
    nonce: string;
    partitionKey: string;
  }) {
    this.redeems.push(input);
    if (input.code === 'bad-code') throw new Error('invalid_grant');
    const claims: IdClaims = {
      oid: USER_OID,
      tid: TENANT_ID,
      nonce: input.nonce,
      name: 'Avery Engineer',
      preferred_username: 'avery@example.com',
      roles: ['Portal.Reader', 'Portal.Operator', 'Not.A.Portal.Role'],
      auth_time: Math.floor(this.now().getTime() / 1000),
      // A member of the tenant (provisioning adds the optional acct claim to both apps).
      acct: 0,
      ...this.claims(input.kind),
    };
    return { homeAccountId: `${claims.oid}.${claims.tid}`, claims };
  }

  async token(input: {
    kind: 'read' | 'write';
    partitionKey: string;
    homeAccountId: string;
    scopes: string[];
    claims?: string;
    forceRefresh?: boolean;
  }) {
    this.tokens.push(input);
    return this.tokenImpl ? this.tokenImpl(input) : `token-${input.kind}${input.claims ? '-claims' : ''}`;
  }

  /** Roles (and other claims) Entra would put in a refreshed ID token; `refreshImpl` simulates failures. */
  refreshes: Array<{ kind: string; partitionKey: string }> = [];
  refreshImpl?: () => Promise<Partial<IdClaims>>;
  async refreshClaims(input: { kind: 'read' | 'write'; partitionKey: string; homeAccountId: string }) {
    this.refreshes.push({ kind: input.kind, partitionKey: input.partitionKey });
    const extra = this.refreshImpl ? await this.refreshImpl() : this.claims(input.kind);
    return {
      oid: USER_OID,
      tid: TENANT_ID,
      roles: ['Portal.Reader', 'Portal.Operator', 'Not.A.Portal.Role'],
      ...extra,
    } as IdClaims;
  }

  async forget(input: { kind: 'read' | 'write'; partitionKey: string }) {
    this.forgets.push(input);
  }

  logoutUrl(input: { postLogoutRedirectUri: string }) {
    return `https://login.example.test/logout?post_logout_redirect_uri=${encodeURIComponent(input.postLogoutRedirectUri)}`;
  }
}

/** JSON Response helper for fake fetches. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Org lookup done at sign-in. */
export const orgResponse = () =>
  json(
    { value: [{ displayName: 'Example Org', verifiedDomains: [{ name: 'example.com', isDefault: true }] }] },
    200,
    { 'request-id': 'req-org' },
  );
