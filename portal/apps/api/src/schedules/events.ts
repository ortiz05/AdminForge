import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client';
import { PgListener } from '../definitions/notify';
import type { EventBus } from '../events/bus';

/**
 * Scheduler events across processes. The scheduler service and the API are separate processes (R6), so events go
 * through Postgres `NOTIFY schedule_events`:
 * - to browsers (SSE `GET /api/events`): `schedule.failed`, `schedule.updated`, `probe.updated`;
 * - to the scheduler: `schedule.run_requested` and `schedules.changed` (wake up now instead of at the next tick).
 * In-process listeners get every event directly; remote copies of our own events are ignored.
 */

export const SCHEDULE_EVENTS_CHANNEL = 'schedule_events';

export type ScheduleEventType =
  'schedule.failed' | 'schedule.updated' | 'probe.updated' | 'schedule.run_requested' | 'schedules.changed';
export interface ScheduleEvent {
  type: ScheduleEventType;
  data: Record<string, unknown>;
}

/** Events browsers see. */
const PUBLIC = new Set<ScheduleEventType>(['schedule.failed', 'schedule.updated', 'probe.updated']);

type Log = { warn(obj: object, msg: string): void };

export class ScheduleEvents {
  private readonly origin = randomUUID();
  private readonly listeners = new Set<(e: ScheduleEvent) => void>();
  private listener: PgListener | null = null;

  constructor(
    private readonly opts: {
      bus?: EventBus | null;
      database?: Database | null;
      listenUrl?: string | null;
      log?: Log;
    } = {},
  ) {}

  /** Subscribes to events from this process and (once started) from others. */
  on(fn: (e: ScheduleEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private deliver(e: ScheduleEvent) {
    if (PUBLIC.has(e.type)) this.opts.bus?.publish({ type: e.type, data: e.data });
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  publish(e: ScheduleEvent): void {
    this.deliver(e);
    const db = this.opts.database;
    if (!db) return;
    let payload = JSON.stringify({ ...e, origin: this.origin });
    // NOTIFY payloads are limited to 8000 bytes.
    if (payload.length > 7900)
      payload = JSON.stringify({
        type: e.type,
        data: { truncated: true, key: e.data.key ?? null },
        origin: this.origin,
      });
    db.pool
      .query('select pg_notify($1, $2)', [SCHEDULE_EVENTS_CHANNEL, payload])
      .catch((err: unknown) =>
        this.opts.log?.warn({ err: { message: (err as Error).message } }, 'schedule event NOTIFY failed'),
      );
  }

  /** LISTEN for other processes' events (needs a database URL). */
  async start(): Promise<void> {
    if (this.listener || !this.opts.listenUrl || !this.opts.database) return;
    this.listener = new PgListener(
      this.opts.listenUrl,
      SCHEDULE_EVENTS_CHANNEL,
      (payload) => {
        try {
          const e = JSON.parse(payload) as ScheduleEvent & { origin?: string };
          if (e.origin === this.origin || typeof e.type !== 'string') return;
          this.deliver({ type: e.type, data: e.data && typeof e.data === 'object' ? e.data : {} });
        } catch {
          // ignore malformed payloads
        }
      },
      { log: this.opts.log },
    );
    await this.listener.start();
  }

  async stop(): Promise<void> {
    await this.listener?.stop();
    this.listener = null;
    this.listeners.clear();
  }
}
