import { createFixtureFetch, evaluate, fixtureKey, type ServiceId } from '@adminforge/connectors';
import type { Connection } from '@adminforge/schemas';
import type { AuditInput, AuditWriter } from '../audit/writer';
import { MemorySettingsStore, SqliteSettingsStore, type SettingsStore } from '../admin/settings-store';
import {
  createAppIdentityRegistry,
  createAutomationTokenProvider,
  type AppIdentityRegistry,
  type AutomationTokenProvider,
} from '../auth/automation';
import type { TokenBroker } from '../auth/token-broker';
import type { AuthClient } from '../auth/types';
import { LicenceService } from '../capabilities/licences';
import type { Config } from '../config';
import type { Database } from '../db/client';
import { createDefinitionRegistry } from '../definitions/registry';
import type { DefinitionRegistry } from '../definitions/types';
import { EventBus } from '../events/bus';
import { isPaused } from '../execution/emergency';
import { createOutboundExecutor, templatePath, type SensitiveRead } from '../execution/outbound';
import { identityName, type OutboundExecutor } from '../execution/types';
import { liveRunner } from './runner';
import { MemoryViewStore, SqliteViewStore, type ViewStore } from '../views/store';
import { contentEnv } from './env';
import { DatasourceRunner, fixtureRunner } from './executor';

/** Content, outbound and portal services on AppContext (definitions, executor, datasources, events, views, settings). */
export interface ContentServices {
  /** Registry of published content; also the DefinitionResolver port for runs and schedules. */
  definitions: DefinitionRegistry;
  /** The single outbound path (policy → token → connector). */
  outbound: OutboundExecutor;
  /** App-only tokens of the automation identity (null when not configured). */
  automation: AutomationTokenProvider | null;
  /** The automation identity and the named app identities schedules may run as (ADR-014). */
  identities: AppIdentityRegistry;
  licences: LicenceService;
  datasources: DatasourceRunner;
  events: EventBus;
  views: ViewStore;
  settings: SettingsStore;
  /** `env` scope for content expressions (non-secret AF_* configuration). */
  contentEnv: () => Record<string, string>;
}

export type ContentDeps = Partial<ContentServices> & { fetch?: typeof fetch };

type Log = { info?(obj: object, msg: string): void; warn(obj: object, msg: string): void };

export function createContentServices(
  config: Config,
  base: {
    database: Database | null;
    broker: TokenBroker | null;
    auth: AuthClient | null;
    audit: AuditWriter;
    fetch: typeof fetch;
    now: () => Date;
  },
  deps: ContentDeps = {},
  log?: Log,
): ContentServices {
  const db = base.database?.db;
  const cachedEnv = deps.contentEnv ? {} : contentEnv(config);
  const env = deps.contentEnv ?? (() => cachedEnv);
  const definitions = deps.definitions ?? createDefinitionRegistry(config, base.database, log);
  // Mock sign-in never holds the automation identity: its schedules and probes would run on real tenant data.
  const automation =
    deps.automation !== undefined
      ? deps.automation
      : config.AUTH_MODE === 'mock'
        ? null
        : createAutomationTokenProvider(config, { log });
  // Named app identities (AF_SCHEDULE_IDENTITIES): never with mock sign-in either.
  const identities =
    deps.identities ??
    createAppIdentityRegistry(config.AUTH_MODE === 'mock' ? { ...config, SCHEDULE_IDENTITIES: [] } : config, {
      log,
      automation,
    });
  // Secret-bearing reads (App Service app settings): values are stripped by the executor; the read is audited.
  const onSensitiveRead = async (r: SensitiveRead) => {
    await base.audit.append(sensitiveReadAudit(r));
  };
  const settings = deps.settings ?? (db ? new SqliteSettingsStore(db) : new MemorySettingsStore());
  const outbound =
    deps.outbound ??
    createOutboundExecutor({
      config,
      broker: base.broker,
      auth: base.auth,
      automation,
      identities,
      // DATA_MODE=fixtures: synthetic responses from ADMINFORGE_FIXTURES_DIR, never Microsoft.
      fetch: config.DATA_MODE === 'fixtures' ? fixtureFetch(config, log) : base.fetch,
      connection: async (key) => (await definitions.resolve('connection', key)).def as Connection,
      env,
      now: base.now,
      onSensitiveRead,
      // One line per Microsoft call (template path, status, ms, throttling, request id) for troubleshooting by Reference.
      onCall: log?.info ? (r) => log.info?.({ call: r }, 'microsoft call') : undefined,
      // Emergency stop (Admin → Settings): declared writes are refused while changes are paused.
      writesPaused: () => isPaused(settings, 'writes'),
    });
  const licences = deps.licences ?? new LicenceService(outbound, base.now);
  // PowerShell datasources: fixture files in DATA_MODE=fixtures; the runs worker's runner adapter when configured.
  const runner =
    config.DATA_MODE === 'fixtures'
      ? fixtureRunner(config.ADMINFORGE_FIXTURES_DIR)
      : config.NODE_ENV !== 'test' && config.RUNNER_URL && config.RUNNER_SHARED_KEY
        ? liveRunner({
            url: config.RUNNER_URL,
            key: config.RUNNER_SHARED_KEY,
            broker: base.broker,
            config,
            fetch: base.fetch,
            now: base.now,
            log,
          })
        : undefined;
  const datasources =
    deps.datasources ??
    new DatasourceRunner({
      definitions,
      outbound,
      runner,
      licences,
      env,
      now: base.now,
      cacheMaxBytes: config.DATASOURCE_CACHE_MAX_MB * 1024 * 1024,
      deadlineMs: config.DATASOURCE_DEADLINE_MS,
      ...(log ? { log } : {}),
    });
  const events = deps.events ?? new EventBus();
  if (!deps.events) events.wire({ definitions });
  return {
    definitions,
    outbound,
    automation,
    identities,
    licences,
    datasources,
    events,
    views: deps.views ?? (db ? new SqliteViewStore(db) : new MemoryViewStore()),
    settings,
    contentEnv: env,
  };
}

/** What a request without a fixture answers with mock sign-in: no file path (the API log names the file to add). */
export const MOCK_NO_FIXTURE =
  'Mock mode has no synthetic data for this request. The API log names the fixture file to add.';

type FixtureError = { error?: { code?: string; message?: string } };
const isFixtureMissing = (body: unknown): body is FixtureError =>
  (body as FixtureError | null)?.error?.code === 'FixtureNotFound';

/** A POST that only reads (Resource Graph, KQL, `getByIds`, …: the request policy's list) is not a write to accept. */
function readsOnly(method: string, url: URL): boolean {
  if (method === 'GET' || method === 'HEAD') return true;
  const host = url.hostname.toLowerCase();
  const service: ServiceId | undefined =
    host === 'graph.microsoft.com'
      ? 'graph'
      : host === 'management.azure.com'
        ? 'arm'
        : host === 'api.loganalytics.io' || host === 'api.loganalytics.azure.com'
          ? 'logAnalytics'
          : undefined;
  if (!service) return false;
  const path = service === 'graph' ? url.pathname.replace(/^\/(v1\.0|beta)(?=\/)/, '') : url.pathname;
  return evaluate('read', { service, method, path }).allowed;
}

/**
 * The fixture fetch of DATA_MODE=fixtures (synthetic responses from ADMINFORGE_FIXTURES_DIR, never Microsoft).
 *
 * With **mock sign-in only** (AUTH_MODE=mock, which config.ts refuses in production, off loopback, without fixtures and
 * with any tenant credential) a write no fixture describes is accepted — 204, there is no tenant to change — so write
 * playbooks complete end to end. A read no fixture answers (GET, or a read-only POST such as a Resource Graph query)
 * still fails, with a mock-mode message that names no file — also inside a `$batch` — and the file to add goes to the
 * API log. With Entra sign-in on fixtures (allowed: a real person is signed in) nothing is accepted that a fixture
 * doesn't describe: an unfixtured write stays a 404 and fails the step.
 */
export function fixtureFetch(
  config: Pick<Config, 'AUTH_MODE' | 'ADMINFORGE_FIXTURES_DIR'>,
  log?: Log,
): typeof fetch {
  const fixtures = createFixtureFetch(config.ADMINFORGE_FIXTURES_DIR);
  if (config.AUTH_MODE !== 'mock') return fixtures;
  const missing = (method: string, url: string) =>
    log?.warn(
      { fixture: { method, candidates: fixtureKey(method, url).candidates } },
      'mock mode: no fixture for this request',
    );
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fixtures(input, init);
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const batch =
      method === 'POST' && url.hostname === 'graph.microsoft.com' && /\/\$batch\/?$/.test(url.pathname);
    if (res.status !== 404 && !(batch && res.ok)) return res;
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as (FixtureError & { responses?: Array<{ body?: unknown }> }) | null;
    if (batch && res.ok) {
      const subs = (body?.responses ?? []) as Array<{ id?: string; status?: number; body?: unknown }>;
      if (!subs.some((r) => isFixtureMissing(r.body))) return res;
      // The sub-requests, to tell a write (accepted) from a read (the mock message) by id.
      let requests: Array<{ id: string; method?: string; url: string }> = [];
      try {
        requests =
          (JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { requests?: typeof requests })
            .requests ?? [];
      } catch {
        // Not a body this can read: every sub-request counts as a read (the mock message, nothing accepted).
      }
      const sent = new Map(requests.map((r) => [String(r.id), r]));
      const version = url.pathname.split('/').filter(Boolean)[0] ?? 'v1.0';
      for (const r of subs) {
        if (!isFixtureMissing(r.body)) continue;
        const sub = sent.get(String(r.id));
        const subMethod = (sub?.method ?? 'GET').toUpperCase();
        const subUrl = new URL(`/${version}/${(sub?.url ?? '').replace(/^\//, '')}`, url.origin);
        if (sub && !readsOnly(subMethod, subUrl)) {
          r.status = 204;
          delete r.body;
          continue;
        }
        missing(subMethod, subUrl.href);
        r.body = { error: { code: 'FixtureNotFound', message: MOCK_NO_FIXTURE } };
      }
      return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
    }
    if (!isFixtureMissing(body)) return res;
    if (!readsOnly(method, url)) return new Response(null, { status: 204, headers: res.headers });
    missing(method, url.href);
    return new Response(JSON.stringify({ error: { code: 'FixtureNotFound', message: MOCK_NO_FIXTURE } }), {
      status: 404,
      headers: res.headers,
    });
  }) as typeof fetch;
}

/** The audit event of a secret-bearing read (values are never returned): who, and for unattended reads which identity and schedule. */
export function sensitiveReadAudit(r: SensitiveRead): AuditInput {
  const s = r.identity.kind === 'delegated' ? r.identity.session : null;
  const grant = r.identity.kind === 'grant' ? r.identity.grant : null;
  return {
    actorOid: s?.userOid ?? grant?.oid ?? null,
    actorUpn:
      s?.upn ??
      grant?.upn ??
      (r.identity.kind === 'automation'
        ? r.identity.app
          ? `app identity ${r.identity.app}`
          : 'automation identity'
        : null),
    sessionHash: s?.idHash ?? null,
    mode: r.identity.mode,
    action: 'outbound.sensitive_read',
    targetType: r.service,
    targetId: r.path,
    result: r.result,
    correlationId: r.correlationId,
    details: {
      method: r.method,
      template: templatePath(r.path),
      ...(r.names !== undefined ? { names: r.names } : {}),
      valuesReturned: false,
      // Unattended reads (ADR-014): which identity read it, for which schedule.
      ...(r.identity.kind !== 'delegated' ? { executedAs: identityName(r.identity) } : {}),
      ...(grant ? { schedule: grant.scheduleKey } : {}),
      ...(r.identity.kind === 'automation' && r.identity.schedule ? { schedule: r.identity.schedule } : {}),
    },
  };
}
