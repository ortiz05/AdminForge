import { randomBytes } from 'node:crypto';
import { chainKeysFrom } from './audit/keys';
import {
  MemoryAuditWriter,
  SqliteAuditWriter,
  stdoutCheckpoints,
  VERIFY_BATCH,
  type AuditInput,
  type AuditWriter,
  type ChainPrepared,
} from './audit/writer';
import { createMsalAuthClient, type MsalLogger } from './auth/msal-client';
import { MemoryPreauthStore, SqlitePreauthStore, type PreauthStore } from './auth/preauth-store';
import {
  isArmed,
  MemorySessionStore,
  SqliteSessionStore,
  type SessionRecord,
  type SessionStore,
} from './auth/session-store';
import { TokenBroker } from './auth/token-broker';
import {
  createTokenCache,
  MemorySealedBlobStore,
  SqliteSealedBlobStore,
  type TokenCacheStore,
} from './auth/token-cache';
import type { AuthClient } from './auth/types';
import { tokenCacheKey, type Config } from './config';
import { createDatabase, databaseOptions, type Database } from './db/client';
import { createContentServices, type ContentServices } from './datasources/services';
import { MemoryPrefsStore, SqlitePrefsStore, type PrefsStore } from './prefs/prefs-store';
import type { RunsOptions } from './runs/module';

/**
 * Everything route handlers need. Built once per app; tests swap pieces via AppDeps.
 * ContentServices adds: definitions (DefinitionResolver), outbound (OutboundExecutor), automation, licences,
 * datasources, events, views, settings, contentEnv.
 */
export interface AppContext extends ContentServices {
  config: Config;
  now: () => Date;
  database: Database | null;
  sessions: SessionStore;
  preauth: PreauthStore;
  tokenCache: TokenCacheStore;
  audit: AuditWriter;
  prefs: PrefsStore;
  /** Entra client (AUTH_MODE=entra); null in mock mode. */
  auth: AuthClient | null;
  broker: TokenBroker | null;
  /** fetch used for Microsoft APIs (tests inject a fake). */
  fetch: typeof fetch;
}

/** `runs` overrides the runs module's repository/queue/ports (tests, worker entry point). */
export type AppDeps = Partial<Omit<AppContext, 'config' | 'broker'>> & {
  runs?: RunsOptions;
  /** The process's name in signal origins and leases: api (default), scheduler, cli. */
  databaseName?: string;
  /**
   * Whether this process may append the audit chain's cut-over at start (S-10; default true). Only the API does: a
   * scheduler one-shot started with another environment must not move the chain to its key.
   */
  prepareAuditChain?: boolean;
};

export function createContext(config: Config, deps: AppDeps = {}, log?: MsalLogger): AppContext {
  const now = deps.now ?? (() => new Date());
  const database =
    deps.database !== undefined
      ? deps.database
      : config.DATABASE_PATH
        ? createDatabase(config.DATABASE_PATH, databaseOptions(config, deps.databaseName ?? 'api'))
        : null;
  const db = database?.db;
  // Mock mode never stores real tokens; an ephemeral key keeps the code path identical.
  const key = tokenCacheKey(config) ?? randomBytes(32);
  const tokenCache =
    deps.tokenCache ??
    createTokenCache(db ? new SqliteSealedBlobStore(db) : new MemorySealedBlobStore(), key, log);
  const auth =
    deps.auth !== undefined
      ? deps.auth
      : config.AUTH_MODE === 'entra'
        ? createMsalAuthClient(config, tokenCache, log)
        : null;
  const broker = auth ? new TokenBroker(auth, config, now) : null;
  // Each verification leaves its tail in the api container's log: the audit chain's external anchor (shipped off the
  // cluster).
  const checkpoints = log?.info ? (cp: object) => log.info!(cp, 'audit chain checkpoint') : stdoutCheckpoints;
  // AUDIT_CHAIN_KEY (S-10): the chain is HMAC-keyed from a cut-over event on; the key stays in the Secret.
  // The pin (AUDIT_CHAIN_KEYED_SINCE) anchors a chain that persists; an in-memory one starts empty every time.
  const chainKeys = chainKeysFrom(db ? config : { ...config, AUDIT_CHAIN_KEYED_SINCE: undefined });
  const audit =
    deps.audit ??
    (db
      ? new SqliteAuditWriter(db, now, checkpoints, VERIFY_BATCH, chainKeys)
      : new MemoryAuditWriter(now, chainKeys));
  // Before anything else is audited: the cut-over to the configured key, or a refusal of a keyed chain without one.
  if (!deps.audit && deps.prepareAuditChain !== false && audit.prepareChain) {
    let prepared: ChainPrepared;
    try {
      prepared = audit.prepareChain();
    } catch (err) {
      // The process doesn't start: the connection it opened is closed with it.
      if (deps.database === undefined) void database?.close();
      throw err;
    }
    if (db) reportChain(prepared, log);
  }
  const content = createContentServices(
    config,
    { database, broker, auth, audit, fetch: deps.fetch ?? fetch, now },
    deps,
    log,
  );
  return {
    ...content,
    config,
    now,
    database,
    sessions: deps.sessions ?? (db ? new SqliteSessionStore(db) : new MemorySessionStore()),
    preauth: deps.preauth ?? (db ? new SqlitePreauthStore(db) : new MemoryPreauthStore()),
    tokenCache,
    audit,
    prefs: deps.prefs ?? (db ? new SqlitePrefsStore(db) : new MemoryPrefsStore()),
    auth,
    broker,
    fetch: deps.fetch ?? fetch,
  };
}

/**
 * The audit chain's state at every start of a process with a database, in its log: a cut-over line (with the seq,
 * hash and prev hash to check later with `adminforge audit verify --checkpoint`), the keyed state with the tail, or a
 * warning that it is unkeyed. A new cut-over without a new key in the Secret, or a tail lower than the last one logged,
 * means events were removed: compare with the shipped log. Key ids only, never a key. (An in-memory chain — mock mode —
 * has nothing to anchor, so it logs nothing.)
 */
function reportChain({ state, cutOver, tail }: ChainPrepared, log: MsalLogger | undefined) {
  const line = (level: 'info' | 'warn', obj: object, msg: string) => {
    if (level === 'warn' && log) log.warn(obj, msg);
    else if (log?.info) log.info(obj, msg);
    else process.stdout.write(`${JSON.stringify({ level, msg, ...obj })}\n`);
  };
  if (cutOver) {
    line('warn', cutOver, 'audit chain cut-over: events from this seq on are keyed with AUDIT_CHAIN_KEY');
    if (cutOver.previousKeyLost)
      line(
        'warn',
        { keyId: cutOver.previousKeyId },
        'audit chain: the key the events before the cut-over were keyed with is declared lost (AUDIT_CHAIN_LOST_KEY_IDS); they can no longer be verified',
      );
  }
  const at = tail ? { tailSeq: tail.seq, tailHash: tail.hash } : {};
  if (state.keyed)
    line(
      'info',
      { since: state.since, keyId: state.keyId, pinned: state.pinned, ...at },
      'audit chain keyed',
    );
  else
    line(
      'warn',
      at,
      'audit chain unkeyed: AUDIT_CHAIN_KEY is not set, so whoever holds a copy of the database volume can rewrite the audit log and re-hash it',
    );
}

/** Actor fields for an audit event from the request's session. */
export function auditActor(
  ctx: AppContext,
  request: { id: string; ip: string },
  session: SessionRecord | null,
): Omit<AuditInput, 'action' | 'result'> {
  return {
    actorOid: session?.userOid,
    actorUpn: session?.upn,
    sessionHash: session?.idHash,
    mode: session ? (isArmed(session, ctx.now()) ? 'write' : 'read') : null,
    correlationId: request.id,
    ip: request.ip,
  };
}
