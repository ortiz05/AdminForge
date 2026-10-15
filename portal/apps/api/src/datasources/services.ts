import { createFixtureFetch } from '@adminforge/connectors';
import type { Connection } from '@adminforge/schemas';
import type { AuditWriter } from '../audit/writer';
import { MemorySettingsStore, PgSettingsStore, type SettingsStore } from '../admin/settings-store';
import { createAutomationTokenProvider, type AutomationTokenProvider } from '../auth/automation';
import type { TokenBroker } from '../auth/token-broker';
import type { AuthClient } from '../auth/types';
import { LicenceService } from '../capabilities/licences';
import type { Config } from '../config';
import type { Database } from '../db/client';
import { createDefinitionRegistry } from '../definitions/registry';
import type { DefinitionRegistry } from '../definitions/types';
import { EventBus } from '../events/bus';
import { createOutboundExecutor, templatePath, type SensitiveRead } from '../execution/outbound';
import type { OutboundExecutor } from '../execution/types';
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
  const automation =
    deps.automation !== undefined ? deps.automation : createAutomationTokenProvider(config, { log });
  // Secret-bearing reads (App Service app settings): values are stripped by the executor; the read is audited.
  const onSensitiveRead = async (r: SensitiveRead) => {
    const s = r.identity.kind === 'delegated' ? r.identity.session : null;
    await base.audit.append({
      actorOid: s?.userOid ?? null,
      actorUpn: s?.upn ?? (r.identity.kind === 'automation' ? 'automation identity' : null),
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
      },
    });
  };
  const outbound =
    deps.outbound ??
    createOutboundExecutor({
      config,
      broker: base.broker,
      auth: base.auth,
      automation,
      // DATA_MODE=fixtures: synthetic responses from ADMINFORGE_FIXTURES_DIR, never Microsoft.
      fetch:
        config.DATA_MODE === 'fixtures' ? createFixtureFetch(config.ADMINFORGE_FIXTURES_DIR) : base.fetch,
      connection: async (key) => (await definitions.resolve('connection', key)).def as Connection,
      env,
      now: base.now,
      onSensitiveRead,
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
    deps.datasources ?? new DatasourceRunner({ definitions, outbound, runner, licences, env, now: base.now });
  const events = deps.events ?? new EventBus();
  if (!deps.events)
    events.wire({ definitions, databaseUrl: config.DATABASE_URL, database: base.database, log });
  return {
    definitions,
    outbound,
    automation,
    licences,
    datasources,
    events,
    views: deps.views ?? (db ? new PgViewStore(db) : new MemoryViewStore()),
    settings: deps.settings ?? (db ? new PgSettingsStore(db) : new MemorySettingsStore()),
    contentEnv: env,
  };
}
