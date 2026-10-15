import { hostname } from 'node:os';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { settings } from '../db/schema';

/** Background components that report they're alive (the API answers /healthz itself). */
export type Component = 'worker' | 'scheduler';
export const COMPONENTS: readonly Component[] = ['worker', 'scheduler'];

export const HEARTBEAT_MS = 30_000;
/** Silent for longer than this → `stale` (a stopped or hung process). */
export const STALE_MS = 2 * 60_000;

const keyOf = (c: Component) => `heartbeat:${c}`;

/**
 * Writes `heartbeat:<component>` every 30 s while the component runs, so /readyz (and the portal-readiness probe) can
 * tell when the run worker or the scheduler has stopped — runs and schedules would otherwise just quietly wait.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;

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

/** Each component's state from its last heartbeat. */
export async function componentStates(db: Db, now: Date): Promise<Record<Component, ComponentState>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, COMPONENTS.map(keyOf)));
  const out = {} as Record<Component, ComponentState>;
  for (const c of COMPONENTS) {
    const at = (rows.find((r) => r.key === keyOf(c))?.value as { at?: string } | undefined)?.at;
    out[c] = !at ? 'missing' : now.getTime() - Date.parse(at) > STALE_MS ? 'stale' : 'ok';
  }
  return out;
}
