import type { Database } from '../db/client';
import { PgListener } from '../definitions/notify';
import type { DefinitionSource } from '../definitions/types';

/** An event for browsers (`GET /api/events`). `userOid` restricts delivery to one user's connections. */
export interface PortalEvent {
  type: 'definitions.changed' | 'session.mode' | 'session.ended' | 'run.updated' | (string & {});
  data: unknown;
  userOid?: string;
}

type Listener = (event: PortalEvent) => void;

/** Postgres channel the runs worker NOTIFYs on (relayed as `run.updated`). */
export const RUN_EVENTS_CHANNEL = 'run_events';

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
 * In-process fan-out for SSE. Sources: definition changes (fs watcher or NOTIFY definitions_changed), the runs
 * worker's NOTIFY `run_events` (when a database is configured), and anything in-process calls `publish` with.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();
  private runListener: PgListener | null = null;
  private unsubscribe: (() => void) | null = null;
  private runStarted = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // LISTEN run_events only once someone is listening (worker processes never open a stream).
    if (this.runListener && !this.runStarted) {
      this.runStarted = true;
      void this.runListener.start();
    }
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

  /** Relays definition changes and (with a database URL) the runs worker's `run_events` notifications. */
  wire(opts: {
    definitions: DefinitionSource;
    databaseUrl?: string | null;
    database?: Database | null;
    log?: { warn(obj: object, msg: string): void };
  }): void {
    this.unsubscribe = opts.definitions.onChange((change) =>
      this.publish({ type: 'definitions.changed', data: change }),
    );
    if (opts.databaseUrl && opts.database) {
      this.runListener = new PgListener(
        opts.databaseUrl,
        RUN_EVENTS_CHANNEL,
        (payload) => {
          let data: unknown;
          try {
            data = JSON.parse(payload);
          } catch {
            data = { raw: payload };
          }
          // Streamed log/progress lines are for the run's own stream (GET /api/runs/:id/events), not the dock.
          const kind = (data as { type?: unknown } | null)?.type;
          if (kind === 'log' || kind === 'progress') return;
          const audience = runEventAudience(data);
          if (!audience) this.publish({ type: 'run.updated', data });
          else for (const userOid of audience) this.publish({ type: 'run.updated', data, userOid });
        },
        { log: opts.log },
      );
    }
  }

  get size(): number {
    return this.listeners.size;
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    await this.runListener?.stop();
    this.listeners.clear();
  }
}
