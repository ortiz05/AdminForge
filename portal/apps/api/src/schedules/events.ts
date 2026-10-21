import type { Signals } from '../db/signals';
import type { EventBus } from '../events/bus';

/**
 * Scheduler events. The scheduler runs in the API process (ADR-016), but a scheduler one-shot (`--once`, `--probe`,
 * `--schedule`) or the CLI is another process, so events also go out as the `schedule_events` signal:
 * - to browsers (SSE `GET /api/events`): `schedule.failed`, `schedule.updated`, `probe.updated`, `news.updated`
 *   (counts only: {new, updated});
 * - to the scheduler: `schedule.run_requested` and `schedules.changed` (wake up now instead of at the next tick).
 * In-process listeners get every event directly; remote copies of our own events are ignored.
 */

export const SCHEDULE_EVENTS_CHANNEL = 'schedule_events';

export type ScheduleEventType =
  | 'schedule.failed'
  | 'schedule.updated'
  | 'probe.updated'
  | 'news.updated'
  | 'schedule.run_requested'
  | 'schedules.changed';
export interface ScheduleEvent {
  type: ScheduleEventType;
  data: Record<string, unknown>;
}

/** Events browsers see. */
const PUBLIC = new Set<ScheduleEventType>([
  'schedule.failed',
  'schedule.updated',
  'probe.updated',
  'news.updated',
]);

type Log = { warn(obj: object, msg: string): void };

export class ScheduleEvents {
  private readonly listeners = new Set<(e: ScheduleEvent) => void>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly opts: {
      bus?: EventBus | null;
      signals?: Pick<Signals, 'publish' | 'on'> | null;
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
    const signals = this.opts.signals;
    if (!signals) return;
    let payload = JSON.stringify(e);
    // Signals stay small: a large event goes out without its data.
    if (payload.length > 7900)
      payload = JSON.stringify({ type: e.type, data: { truncated: true, key: e.data.key ?? null } });
    try {
      // In-process listeners already have it (deliver above): the signal is for other processes only.
      signals.publish(SCHEDULE_EVENTS_CHANNEL, payload, { local: false });
    } catch (err) {
      this.opts.log?.warn({ err: { message: (err as Error).message } }, 'schedule event signal failed');
    }
  }

  /** Receives other processes' events. */
  async start(): Promise<void> {
    if (this.unsubscribe || !this.opts.signals) return;
    this.unsubscribe = this.opts.signals.on(SCHEDULE_EVENTS_CHANNEL, (payload) => {
      try {
        const e = JSON.parse(payload) as ScheduleEvent;
        if (typeof e.type !== 'string') return;
        this.deliver({ type: e.type, data: e.data && typeof e.data === 'object' ? e.data : {} });
      } catch {
        // ignore malformed payloads
      }
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }
}
