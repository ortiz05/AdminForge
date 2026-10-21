import type { DefinitionSource } from '../definitions/types';

/** An event for browsers (`GET /api/events`). `userOid` restricts delivery to one user's connections. */
export interface PortalEvent {
  type: 'definitions.changed' | 'session.mode' | 'session.ended' | 'run.updated' | (string & {});
  data: unknown;
  userOid?: string;
}

type Listener = (event: PortalEvent) => void;

const OID_FIELDS = ['initiatorOid', 'userOid', 'actorOid'] as const;

/**
 * Who sees a run event: when the payload names users (initiatorOid / userOid / actorOid, or an `audience` array of
 * oids for approvers), only those users; otherwise everyone signed in (the payload then carries no user data).
 */
export function runEventAudience(payload: unknown): string[] | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const oids = OID_FIELDS.map((k) => p[k]).filter((v): v is string => typeof v === 'string' && !!v);
  if (Array.isArray(p.audience)) oids.push(...p.audience.filter((v): v is string => typeof v === 'string'));
  return oids.length ? [...new Set(oids)] : undefined;
}

/**
 * In-process fan-out for SSE. Sources: definition changes (fs watcher, or the `definitions_changed` signal), the run
 * worker's notifications (`relayRun`; the worker runs in this process, ADR-016), and anything in-process calls
 * `publish` with.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();
  private unsubscribe: (() => void) | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: PortalEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // a broken connection must not stop delivery to the others
      }
    }
  }

  /** Relays definition changes. */
  wire(opts: { definitions: DefinitionSource }): void {
    this.unsubscribe = opts.definitions.onChange((change) =>
      this.publish({ type: 'definitions.changed', data: change }),
    );
  }

  /**
   * A run notification from the worker, relayed as `run.updated` to the people it concerns (everyone signed in when it
   * names nobody). Streamed log/progress lines are for the run's own stream (GET /api/runs/:id/events), not the dock.
   */
  relayRun(n: unknown): void {
    const kind = (n as { type?: unknown } | null)?.type;
    if (kind === 'log' || kind === 'progress') return;
    const audience = runEventAudience(n);
    if (!audience) this.publish({ type: 'run.updated', data: n });
    else for (const userOid of audience) this.publish({ type: 'run.updated', data: n, userOid });
  }

  get size(): number {
    return this.listeners.size;
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.listeners.clear();
  }
}
