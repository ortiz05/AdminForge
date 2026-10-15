import { randomBytes } from 'node:crypto';
import { MemoryAuditWriter, PgAuditWriter, type AuditInput, type AuditWriter } from './audit/writer';
import { createMsalAuthClient, type MsalLogger } from './auth/msal-client';
import { MemoryPreauthStore, PgPreauthStore, type PreauthStore } from './auth/preauth-store';
import { isArmed, MemorySessionStore, PgSessionStore, type SessionRecord, type SessionStore } from './auth/session-store';
import { TokenBroker } from './auth/token-broker';
import { createTokenCache, MemorySealedBlobStore, PgSealedBlobStore, type TokenCacheStore } from './auth/token-cache';
import type { AuthClient } from './auth/types';
import { tokenCacheKey, type Config } from './config';
import { createDatabase, type Database } from './db/client';
import { MemoryPrefsStore, PgPrefsStore, type PrefsStore } from './prefs/prefs-store';

/** Everything route handlers need. Built once per app; tests swap pieces via AppDeps. */
export interface AppContext {
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

export type AppDeps = Partial<Omit<AppContext, 'config' | 'broker'>>;

export function createContext(config: Config, deps: AppDeps = {}, log?: MsalLogger): AppContext {
  const now = deps.now ?? (() => new Date());
  const database = deps.database !== undefined ? deps.database : config.DATABASE_URL ? createDatabase(config.DATABASE_URL) : null;
  const db = database?.db;
  // Mock mode never stores real tokens; an ephemeral key keeps the code path identical.
  const key = tokenCacheKey(config) ?? randomBytes(32);
  const tokenCache = deps.tokenCache ?? createTokenCache(db ? new PgSealedBlobStore(db) : new MemorySealedBlobStore(), key, log);
  const auth = deps.auth !== undefined ? deps.auth : config.AUTH_MODE === 'entra' ? createMsalAuthClient(config, tokenCache, log) : null;
  return {
    config,
    now,
    database,
    sessions: deps.sessions ?? (db ? new PgSessionStore(db) : new MemorySessionStore()),
    preauth: deps.preauth ?? (db ? new PgPreauthStore(db) : new MemoryPreauthStore()),
    tokenCache,
    audit: deps.audit ?? (db ? new PgAuditWriter(db, now) : new MemoryAuditWriter(now)),
    prefs: deps.prefs ?? (db ? new PgPrefsStore(db) : new MemoryPrefsStore()),
    auth,
    broker: auth ? new TokenBroker(auth, config, now) : null,
    fetch: deps.fetch ?? fetch,
  };
}

/** Actor fields for an audit event from the request's session. */
export function auditActor(ctx: AppContext, request: { id: string; ip: string }, session: SessionRecord | null): Omit<AuditInput, 'action' | 'result'> {
  return {
    actorOid: session?.userOid,
    actorUpn: session?.upn,
    sessionHash: session?.idHash,
    mode: session ? (isArmed(session, ctx.now()) ? 'write' : 'read') : null,
    correlationId: request.id,
    ip: request.ip,
  };
}
