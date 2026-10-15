import {
  Engine,
  IdentityUnavailable,
  MemoryRunStore,
  VirtualClock,
  type Actor,
  type EngineOptions,
  type IdentityResolver,
  type OutboundPort,
  type ResolvedIdentity,
  type RunRecord,
  type ServiceCall,
  type StepRecord,
} from '@adminforge/engine';
import type { Mode } from '@adminforge/connectors';
import { Playbook, Runbook } from '@adminforge/schemas';

// Synthetic identities only.
export const INITIATOR: Actor = { kind: 'delegated', oid: '00000000-0000-4000-8000-0000000000a1', upn: 'avery@example.com' };
export const APPROVER: Actor = { kind: 'delegated', oid: '00000000-0000-4000-8000-0000000000b2', upn: 'blake@example.com' };
export const USER_ID = '00000000-0000-4000-8000-000000000001';

/** A valid playbook (parsed by the real schema, so defaults apply and mistakes in tests fail loudly). */
export function playbook(steps: unknown[], extra: Record<string, unknown> = {}): Playbook {
  return Playbook.parse({ kind: 'playbook', id: 'test.playbook', version: '1.0.0', title: 'Test playbook', owner: 'tests', risk: 'low', mode: 'write', steps, ...extra });
}

export function runbook(sections: unknown[], extra: Record<string, unknown> = {}): Runbook {
  return Runbook.parse({ kind: 'runbook', id: 'test.runbook', version: '1.0.0', title: 'Test runbook', owner: 'tests', risk: 'low', mode: 'write', sections, ...extra });
}

export const read = (id: string, path = `/users/${id}`, extra: Record<string, unknown> = {}) => ({ id, type: 'graph', mode: 'read', request: { method: 'GET', path }, ...extra });
export const write = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'graph',
  mode: 'write',
  describe: `Write ${id}`,
  request: { method: 'PATCH', path: `/things/${id}`, body: { value: id } },
  ...extra,
});

export type Responder = (call: ServiceCall, n: number, opts: { signal: AbortSignal }) => unknown;

/** Records every call; `respond` returns data or throws (default: `{ path }`). */
export class FakeOutbound implements OutboundPort {
  readonly calls: Array<{ call: ServiceCall; identity: ResolvedIdentity }> = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(public respond: Responder = (c) => ({ path: c.path })) {}
  async call(identity: ResolvedIdentity, call: ServiceCall, opts: { correlationId: string; signal: AbortSignal }) {
    this.calls.push({ call, identity });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const data = await this.respond(call, this.calls.length, { signal: opts.signal });
      return { data, requestId: `req-${this.calls.length}` };
    } finally {
      this.inFlight--;
    }
  }
  paths(method?: string) {
    return this.calls.filter((c) => !method || c.call.method === method).map((c) => c.call.path);
  }
}

/** Sessions by oid: signed in? armed? */
export class FakeIdentity implements IdentityResolver {
  readonly sessions = new Map<string, { armed: boolean }>();
  readonly resolves: Array<{ oid: string | null; mode: Mode }> = [];
  signIn(actor: Actor, armed = false) {
    this.sessions.set(actor.oid!, { armed });
    return this;
  }
  signOut(actor: Actor) {
    this.sessions.delete(actor.oid!);
  }
  async resolve(run: RunRecord, actor: Actor, mode: Mode): Promise<ResolvedIdentity> {
    this.resolves.push({ oid: actor.oid, mode });
    if (run.identity === 'automation') return { actor, mode, handle: 'automation' };
    const s = this.sessions.get(actor.oid ?? '');
    if (!s) throw new IdentityUnavailable('reauth');
    if (mode === 'write' && !s.armed) throw new IdentityUnavailable('not_armed');
    return { actor, mode, handle: actor.oid };
  }
}

export interface HarnessOptions {
  dryRun?: boolean;
  inputs?: Record<string, unknown>;
  armed?: boolean;
  respond?: Responder;
  run?: Partial<RunRecord>;
  engine?: Partial<EngineOptions>;
}

export function harness(def: Playbook | Runbook, o: HarnessOptions = {}) {
  const clock = new VirtualClock();
  const store = new MemoryRunStore(clock.now);
  const identity = new FakeIdentity().signIn(INITIATOR, o.armed ?? true);
  const outbound = new FakeOutbound(o.respond);
  const engine = new Engine({ store, clock, identity, outbound, ...o.engine });
  store.create({ id: 'run-1', kind: def.kind, definitionKey: def.id, dryRun: o.dryRun ?? false, inputs: o.inputs ?? {}, initiator: INITIATOR, ...o.run });
  const latest = () => store.latest('run-1');
  return {
    clock,
    store,
    identity,
    outbound,
    engine,
    exec: (signal?: AbortSignal) => engine.execute('run-1', def, signal ? { signal } : {}),
    run: async () => (await store.getRun('run-1'))!,
    latest,
    status: (path: string) => latest().get(path)?.status,
    record: (path: string): StepRecord | undefined => latest().get(path),
    all: () => store.listSteps('run-1'),
    plan: async () => (await store.listSteps('run-1')).flatMap((r) => r.plan ?? []),
    runEvents: () => store.events.filter((e) => e.type === 'status' && e.data.scope === 'run').map((e) => e.data.status),
    approve: (path: string, by: Actor = APPROVER, comment?: string) =>
      store.decide('run-1', path, { kind: 'approval', approved: true, actor: by, comment: comment ?? null, decidedAt: clock.now().toISOString() }),
    reject: (path: string, by: Actor = APPROVER, comment?: string) =>
      store.decide('run-1', path, { kind: 'approval', approved: false, actor: by, comment: comment ?? null, decidedAt: clock.now().toISOString() }),
  };
}

/** A promise you resolve from outside. */
export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending microtasks/IO settle. */
export const tick = (n = 5) => new Promise<void>((r) => setTimeout(r, n));
