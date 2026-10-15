import { createHash } from 'node:crypto';
import { buildApp } from '@adminforge/api/src/app';
import { MemoryAuditWriter, type AuditWriter } from '@adminforge/api/src/audit/writer';
import { MemoryPreauthStore } from '@adminforge/api/src/auth/preauth-store';
import { MemorySessionStore, type SessionRecord } from '@adminforge/api/src/auth/session-store';
import { createTokenCache, MemorySealedBlobStore } from '@adminforge/api/src/auth/token-cache';
import type { Database } from '@adminforge/api/src/db/client';
import type { DefinitionResolver } from '@adminforge/api/src/definitions/types';
import { AppError } from '@adminforge/api/src/errors';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { MemoryPrefsStore } from '@adminforge/api/src/prefs/prefs-store';
import { InProcessRunQueue, MemoryRunRepository, type RunRepository } from '@adminforge/api/src/runs';
import type { RunsOptions } from '@adminforge/api/src/runs/module';
import type { Config } from '@adminforge/api/src/config';
import { Playbook, Runbook, type Kind } from '@adminforge/schemas';
import { Clock, noNetwork, TEST_KEY } from './helpers';

// Synthetic people (never a real tenant).
export const AVERY = { oid: '00000000-0000-4000-8000-0000000000a1', upn: 'avery@example.com' };
export const BLAKE = { oid: '00000000-0000-4000-8000-0000000000b2', upn: 'blake@example.com' };
export const CASEY = { oid: '00000000-0000-4000-8000-0000000000c3', upn: 'casey@example.com' };
export const DREW = { oid: '00000000-0000-4000-8000-0000000000d4', upn: 'drew@example.com' };

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Published definitions by key (latest = last added); resolve() mirrors the registry's 404. */
export class StaticDefinitions implements DefinitionResolver {
  readonly defs = new Map<string, Array<{ kind: Kind; def: unknown; version: string; sha256: string }>>();
  add(def: Playbook | Runbook) {
    const parsed = def.kind === 'playbook' ? Playbook.parse(def) : Runbook.parse(def);
    const list = this.defs.get(def.id) ?? [];
    list.push({ kind: def.kind, def: parsed, version: def.version, sha256: sha(JSON.stringify(def)) });
    this.defs.set(def.id, list);
    return this;
  }
  async resolve(kind: Kind, key: string, version?: string) {
    const hit = (this.defs.get(key) ?? [])
      .filter((d) => d.kind === kind && (!version || d.version === version))
      .at(-1);
    if (!hit) throw new AppError(404, 'definition_not_found', `No published ${kind} "${key}".`);
    return { def: hit.def, version: hit.version, sha256: hit.sha256 } as never;
  }
}

export type OutboundCall = {
  call: ServiceCall;
  kind: ExecutionIdentity['kind'];
  mode: string;
  user: string | null;
};

/** Records calls with who made them; `respond` returns data or throws. */
export class FakeExecutor implements OutboundExecutor {
  readonly calls: OutboundCall[] = [];
  constructor(public respond: (call: ServiceCall) => unknown = () => ({ ok: true })) {}
  async execute<T>(identity: ExecutionIdentity, call: ServiceCall) {
    this.calls.push({
      call,
      kind: identity.kind,
      mode: identity.mode,
      user: identity.kind === 'delegated' ? identity.session.upn : null,
    });
    const data = (await this.respond(call)) as T;
    return {
      data,
      status: 200,
      provenance: { service: call.service, path: call.path, ms: 1, requestId: `req-${this.calls.length}` },
    };
  }
}

export interface RunsAppOptions {
  config: Config;
  definitions: StaticDefinitions;
  outbound?: FakeExecutor;
  database?: Database | null;
  repository?: RunRepository;
  /** Audit writer (default: in memory). */
  audit?: AuditWriter;
  runs?: Partial<RunsOptions>;
}

/** The API on in-memory stores with the runs module wired to fakes; sessions for any synthetic user via `login`. */
export async function runsApp(o: RunsAppOptions) {
  const clock = new Clock();
  const sessions = new MemorySessionStore();
  const memoryAudit = new MemoryAuditWriter(clock.now);
  const audit = o.audit ?? memoryAudit;
  const outbound = o.outbound ?? new FakeExecutor();
  const queue = new InProcessRunQueue(undefined, 10);
  const repository = o.repository ?? new MemoryRunRepository(clock.now);
  const app = await buildApp(o.config, {
    database: o.database ?? null,
    now: clock.now,
    sessions,
    preauth: new MemoryPreauthStore(),
    audit,
    prefs: new MemoryPrefsStore(),
    tokenCache: createTokenCache(new MemorySealedBlobStore(), Buffer.from(TEST_KEY, 'base64')),
    fetch: noNetwork,
    runs: { definitions: o.definitions, outbound, queue, repository, sweep: false, ...o.runs },
  });
  await app.ready();

  let n = 0;
  /** Creates a session for a synthetic user and returns request headers for it. */
  async function login(user: { oid: string; upn: string }, roles: string[], opts: { armed?: boolean } = {}) {
    const sid = `sid-${++n}-${user.oid}`;
    const now = clock.now();
    const record: SessionRecord = {
      idHash: sha(sid),
      userOid: user.oid,
      upn: user.upn,
      displayName: user.upn,
      tenantId: '00000000-0000-4000-8000-00000000e0e0',
      tenantName: 'Example Org',
      tenantDomain: 'example.com',
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
    return {
      record,
      headers,
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
      post: (url: string, payload: unknown = {}) =>
        app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> }),
    };
  }

  return {
    app,
    clock,
    sessions,
    audit: memoryAudit,
    auditWriter: audit,
    outbound,
    queue,
    repository,
    runs: app.runs,
    login,
    /** Waits for the in-process worker to go idle. */
    drain: () => queue.drain(),
    close: () => app.close(),
  };
}

export const ALL_ROLES = [
  'Portal.Reader',
  'Portal.Operator',
  'Playbook.Author',
  'Playbook.Approver',
  'Portal.Admin',
];
