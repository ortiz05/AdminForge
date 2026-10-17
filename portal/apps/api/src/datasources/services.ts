import { createFixtureFetch } from '@adminforge/connectors';
import type { Connection } from '@adminforge/schemas';
import type { AuditInput, AuditWriter } from '../audit/writer';
import { MemorySettingsStore, PgSettingsStore, type SettingsStore } from '../admin/settings-store';
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
import { MemoryViewStore, PgViewStore, type ViewStore } from '../views/store';
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
  const settings = deps.settings ?? (db ? new PgSettingsStore(db) : new MemorySettingsStore());
  const outbound =
    deps.outbound ??
    createOutboundExecutor({
      config,
      broker: base.broker,
      auth: base.auth,
      automation,
      identities,
      // DATA_MODE=fixtures: synthetic responses from ADMINFORGE_FIXTURES_DIR, never Microsoft.
      fetch:
        config.DATA_MODE === 'fixtures' ? createFixtureFetch(config.ADMINFORGE_FIXTURES_DIR) : base.fetch,
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
  if (!deps.events)
    events.wire({ definitions, databaseUrl: config.DATABASE_URL, database: base.database, log });
  return {
    definitions,
    outbound,
    automation,
    identities,
    licences,
    datasources,
    events,
    views: deps.views ?? (db ? new PgViewStore(db) : new MemoryViewStore()),
    settings,
    contentEnv: env,
  };
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
