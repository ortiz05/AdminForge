/**
 * The runs harness: `runsApp` builds the API (support/app.ts) with the runs module wired to fakes — published
 * playbooks/runbooks from `StaticDefinitions`, Microsoft calls answered and recorded by `FakeExecutor` (or any
 * `OutboundExecutor`, e.g. the real one on the fixture fetch), an in-process run queue and an in-memory (or given) run
 * repository — and signs people in with `login(person, roles, { armed })`. `drain()` waits for the worker to go idle.
 *
 * Used by the runs* tests, run-role-recheck and schedule-approval-binding. The people and role sets come from
 * support/people.ts (re-exported here).
 */
import { createHash } from 'node:crypto';
import { MemoryAuditWriter, type AuditWriter } from '@adminforge/api/src/audit/writer';
import type { Database } from '@adminforge/api/src/db/client';
import type { DefinitionResolver } from '@adminforge/api/src/definitions/types';
import { AppError } from '@adminforge/api/src/errors';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { InProcessRunQueue, MemoryRunRepository, type RunRepository } from '@adminforge/api/src/runs';
import type { RunsOptions } from '@adminforge/api/src/runs/module';
import type { Config } from '@adminforge/api/src/config';
import { Playbook, Runbook, type Kind } from '@adminforge/schemas';
import { Clock } from '../lib/clock';
import { buildTestApp, sessionFor } from './support/app';
import type { TestPerson } from './support/people';

export { ALL_ROLES, AVERY, BLAKE, CASEY, DREW } from './support/people';

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

export interface RunsAppOptions<E extends OutboundExecutor = FakeExecutor> {
  config: Config;
  definitions: StaticDefinitions;
  /** Microsoft calls (default: a new FakeExecutor). The real executor works too (runs-real-executor-compensate). */
  outbound?: E;
  database?: Database | null;
  repository?: RunRepository;
  /** Audit writer (default: in memory). */
  audit?: AuditWriter;
  runs?: Partial<RunsOptions>;
}

/** The API on in-memory stores with the runs module wired to fakes; sessions for any synthetic user via `login`. */
export async function runsApp<E extends OutboundExecutor = FakeExecutor>(o: RunsAppOptions<E>) {
  const clock = new Clock();
  const memoryAudit = new MemoryAuditWriter(clock.now);
  const audit = o.audit ?? memoryAudit;
  const outbound = o.outbound ?? (new FakeExecutor() as OutboundExecutor as E);
  const queue = new InProcessRunQueue(undefined, 10);
  const repository = o.repository ?? new MemoryRunRepository(clock.now);
  const { app, sessions } = await buildTestApp(o.config, {
    clock,
    audit,
    deps: {
      database: o.database ?? null,
      runs: { definitions: o.definitions, outbound, queue, repository, sweep: false, ...o.runs },
    },
  });
  await app.ready();

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
    /** Creates a session for a synthetic user and returns request headers and helpers for it. */
    login: (user: TestPerson, roles: string[], opts: { armed?: boolean } = {}) =>
      sessionFor({ app, sessions, clock }, user, roles, opts),
    /** Waits for the in-process worker to go idle. */
    drain: () => queue.drain(),
    close: () => app.close(),
  };
}
