import { hostname } from 'node:os';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { settings } from '../db/schema';

/** Background components that report they're working (the API answers /healthz itself). */
export type Component = 'worker' | 'scheduler';
export const COMPONENTS: readonly Component[] = ['worker', 'scheduler'];

/** At most one heartbeat write per component this often. */
export const HEARTBEAT_MS = 30_000;
/** No progress for longer than this → `stale` (stopped, hung, or failing every time). */
export const STALE_MS = 2 * 60_000;

const keyOf = (c: Component) => `heartbeat:${c}`;

/**
 * `heartbeat:<component>` in `settings`, so /readyz (and the portal-readiness probe) can tell when the run worker or
 * the scheduler has stopped working — runs and schedules would otherwise just quietly wait.
 *
 * The API process answers /readyz itself, so a timer that beats only proves the process is alive, which /healthz
 * says already (D-09). A component calls `progress()` when it did its job — the scheduler after every tick that
 * succeeded while it leads — and a scheduler whose ticks throw, or that lost its lease, goes stale while the process
 * runs on. `start()` (a plain 30 s timer) remains only for a component that can't report progress yet.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private last = Number.NEGATIVE_INFINITY;
  private writing: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly component: Component,
    private readonly now: () => Date = () => new Date(),
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  async beat(): Promise<void> {
    const value = { at: this.now().toISOString(), pid: process.pid, host: hostname() };
    await this.db
      .insert(settings)
      .values({ key: keyOf(this.component), value, updatedBy: 'system' })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: this.now() } });
  }

  /**
   * The component made progress: beats now unless it beat less than `HEARTBEAT_MS` ago (or a beat is being
   * written). Never throws; a failed write goes to `onError` and the next progress tries again.
   */
  progress(): void {
    const t = this.now().getTime();
    if (this.writing || t - this.last < HEARTBEAT_MS) return;
    this.writing = this.beat()
      .then(() => {
        this.last = t;
      })
      .catch(this.onError)
      .finally(() => {
        this.writing = null;
      });
  }

  /** Waits for a beat being written (tests). */
  async settled(): Promise<void> {
    await this.writing;
  }

  /** A timer that beats every 30 s while the process runs: liveness only (see the class comment). */
  start(): void {
    if (this.timer) return;
    const tick = () => void this.beat().catch(this.onError);
    tick();
    this.timer = setInterval(tick, HEARTBEAT_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export type ComponentState = 'ok' | 'stale' | 'missing';

/** A component's state and when it last made progress (null: never). */
export interface ComponentHealth {
  state: ComponentState;
  at: string | null;
}

/** Each component's state and last heartbeat. */
export async function componentHealth(db: Db, now: Date): Promise<Record<Component, ComponentHealth>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, COMPONENTS.map(keyOf)));
  const out = {} as Record<Component, ComponentHealth>;
  for (const c of COMPONENTS) {
    const at = (rows.find((r) => r.key === keyOf(c))?.value as { at?: string } | undefined)?.at;
    const ms = at ? Date.parse(at) : Number.NaN;
    out[c] = {
      state: Number.isNaN(ms) ? 'missing' : now.getTime() - ms > STALE_MS ? 'stale' : 'ok',
      at: Number.isNaN(ms) ? null : new Date(ms).toISOString(),
    };
  }
  return out;
}

/** Each component's state from its last heartbeat (/readyz). */
export async function componentStates(db: Db, now: Date): Promise<Record<Component, ComponentState>> {
  const health = await componentHealth(db, now);
  return Object.fromEntries(COMPONENTS.map((c) => [c, health[c].state])) as Record<Component, ComponentState>;
}
