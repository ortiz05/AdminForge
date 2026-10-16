/**
 * The API test harness's core: `buildTestApp` builds the real Fastify app (`buildApp`) on in-memory stores with a
 * controllable clock and a fetch that refuses the network, and `sessionFor` signs a synthetic person in by writing a
 * session straight into the store — no Entra round trip — and returns request helpers bound to its cookie and CSRF
 * token.
 *
 * Inputs: a `Config` (helpers.ts `mockConfig()` / `entraConfig()`), optionally a clock, an audit writer and any
 * `AppDeps` to swap in (auth client, fetch, database, definitions, outbound executor, runs/schedules options).
 * Output: the app plus every store it was built on, for tests to seed and inspect.
 *
 * The feature harnesses build on it: `makeApp` (helpers.ts), `runsApp` (runs-helpers.ts), `schedulesApp`
 * (schedules-helpers.ts) and `portalApp` (portal-schedules-helpers.ts). Tests normally use those; reach for this
 * module when a test needs a different mix of fakes.
 */
import { createHash } from 'node:crypto';
import { buildApp } from '@adminforge/api/src/app';
import { MemoryAuditWriter, type AuditWriter } from '@adminforge/api/src/audit/writer';
import { MemoryPreauthStore } from '@adminforge/api/src/auth/preauth-store';
import {
  MemorySessionStore,
  type SessionRecord,
  type SessionStore,
} from '@adminforge/api/src/auth/session-store';
import { createTokenCache, MemorySealedBlobStore } from '@adminforge/api/src/auth/token-cache';
import type { Config } from '@adminforge/api/src/config';
import type { AppDeps } from '@adminforge/api/src/context';
import { MemoryPrefsStore } from '@adminforge/api/src/prefs/prefs-store';
import type { SchedulesOptions } from '@adminforge/api/src/schedules/module';
import { Clock } from '../../lib/clock';
import type { TestPerson } from './people';

/** Token-cache key for tests (32 bytes of 7s, base64). */
export const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

/** Tenant of the sessions `sessionFor` creates. */
export const SESSION_TENANT = {
  id: '00000000-0000-4000-8000-00000000e0e0',
  name: 'Example Org',
  domain: 'example.com',
} as const;

/** A fetch that fails loudly: tests must never reach the network. */
export const noNetwork: typeof fetch = async (input) => {
  throw new Error(`unexpected network call in test: ${String(input)}`);
};

export type App = Awaited<ReturnType<typeof buildApp>>;

export interface TestAppOptions {
  /** The app's clock (default: a new `Clock` at the test epoch). Pass a `FakeClock` to drive timers too. */
  clock?: Clock;
  /** The audit writer the app uses (default: the in-memory one returned as `audit`). */
  audit?: AuditWriter;
  /** Anything else to swap in (and the schedules module's options); it wins over the in-memory defaults. */
  deps?: AppDeps & { schedules?: SchedulesOptions };
}

/**
 * The API on in-memory sessions, pre-auth, audit, prefs and token cache, `now` from the test clock, no database and
 * no network unless `deps` says otherwise. Not yet `ready()` — callers that add routes or plugins do that first.
 */
export async function buildTestApp(config: Config, o: TestAppOptions = {}) {
  const clock = o.clock ?? new Clock();
  const tokenBlobs = new MemorySealedBlobStore();
  const sessions = new MemorySessionStore();
  const preauth = new MemoryPreauthStore();
  const audit = new MemoryAuditWriter(clock.now);
  const prefs = new MemoryPrefsStore();
  const tokenCache = createTokenCache(tokenBlobs, Buffer.from(TEST_KEY, 'base64'));
  const app = await buildApp(config, {
    database: null,
    now: clock.now,
    sessions,
    preauth,
    audit: o.audit ?? audit,
    prefs,
    tokenCache,
    fetch: noNetwork,
    ...o.deps,
  });
  return { app, clock, tokenBlobs, sessions, preauth, audit, prefs, tokenCache };
}

/** What `sessionFor` needs from a test app. */
export interface SessionTarget {
  app: App;
  sessions: SessionStore;
  clock: { now(): Date };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Sessions created per store, so ids and CSRF tokens read `sid-1-…`, `csrf-1` in every app. */
const created = new WeakMap<SessionStore, number>();

/**
 * Signs `user` in with `roles` by creating a session record directly (12 h lifetime; with `armed`, write access for an
 * hour). Returns the record, its request headers (cookie + CSRF) and inject helpers that send them.
 */
export async function sessionFor(
  target: SessionTarget,
  user: TestPerson,
  roles: string[],
  opts: { armed?: boolean } = {},
) {
  const { app, sessions, clock } = target;
  const n = (created.get(sessions) ?? 0) + 1;
  created.set(sessions, n);
  const sid = `sid-${n}-${user.oid}`;
  const now = clock.now();
  const record: SessionRecord = {
    idHash: sha(sid),
    userOid: user.oid,
    upn: user.upn,
    displayName: user.upn,
    tenantId: SESSION_TENANT.id,
    tenantName: SESSION_TENANT.name,
    tenantDomain: SESSION_TENANT.domain,
    roles,
    csrf: `csrf-${n}`,
    readAccountId: 'mock-read',
    writeAccountId: opts.armed ? 'mock-write' : null,
    writeExpiresAt: opts.armed ? new Date(now.getTime() + 60 * 60_000) : null,
    writeExtended: false,
    writeReason: opts.armed ? 'tests' : null,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 12 * 3_600_000),
    ip: '127.0.0.1',
    userAgent: 'vitest',
  };
  await sessions.create(record);
  const headers = { cookie: `adminforge-dev=${sid}`, 'x-adminforge-csrf': record.csrf };
  const send = (method: 'POST' | 'PATCH' | 'PUT', url: string, payload: unknown) =>
    app.inject({ method, url, headers, payload: payload as Record<string, unknown> });
  return {
    record,
    headers,
    /** Arms (default) or disarms the session from now, for an hour. */
    arm: async (on = true) => {
      await sessions.update(
        record.idHash,
        on
          ? { writeAccountId: 'mock-write', writeExpiresAt: new Date(clock.now().getTime() + 60 * 60_000) }
          : { writeAccountId: null, writeExpiresAt: null },
      );
    },
    get: (url: string, extra: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url, headers: { ...headers, ...extra } }),
    post: (url: string, payload: unknown = {}) => send('POST', url, payload),
    patch: (url: string, payload: unknown) => send('PATCH', url, payload),
    put: (url: string, payload: unknown) => send('PUT', url, payload),
    del: (url: string) => app.inject({ method: 'DELETE', url, headers }),
  };
}

export type TestSession = Awaited<ReturnType<typeof sessionFor>>;
