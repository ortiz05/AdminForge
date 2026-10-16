import { randomUUID } from 'node:crypto';
import { isBreaking } from './breaking';
import { ACTIVE_INCIDENT_SEEN_DAYS } from './types';
import type {
  FeedState,
  NewsCursor,
  NewsFilter,
  NewsItemInput,
  NewsItemRow,
  NewsStore,
  PrunePolicy,
  UpsertResult,
} from './types';

const DAY_MS = 86_400_000;

/** Same semantics as the Postgres store (pg-store.ts), for mock mode and tests. */
export function matchesFilter(r: NewsItemRow, f: NewsFilter): boolean {
  if (!r.audience.every((role) => f.roles.includes(role))) return false;
  if (f.feeds && !f.feeds.includes(r.feedKey)) return false;
  if (f.area && !r.areas.includes(f.area)) return false;
  if (f.kind && r.kind !== f.kind) return false;
  if (f.feed && r.feedKey !== f.feed) return false;
  if (f.tag && !r.tags.includes(f.tag)) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!r.title.toLowerCase().includes(q) && !r.summary.toLowerCase().includes(q)) return false;
  }
  if (f.days !== undefined && r.activityAt.getTime() < f.now.getTime() - f.days * DAY_MS) return false;
  if (f.breaking !== undefined && isBreaking(r, f.now) !== f.breaking) return false;
  if (f.changedAfter && !(r.changedAt.getTime() > f.changedAfter.getTime())) return false;
  return true;
}

const order = (a: NewsItemRow, b: NewsItemRow) =>
  b.activityAt.getTime() - a.activityAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const before = (r: NewsItemRow, c: NewsCursor) =>
  r.activityAt.getTime() < c.activityAt.getTime() ||
  (r.activityAt.getTime() === c.activityAt.getTime() && r.id < c.id);

export class MemoryNewsStore implements NewsStore {
  readonly items = new Map<string, NewsItemRow>();
  readonly states = new Map<string, FeedState>();
  private readonly byExternal = new Map<string, string>();

  async upsert(feedKey: string, items: NewsItemInput[], now: Date): Promise<UpsertResult> {
    const result: UpsertResult = { inserted: 0, updated: 0 };
    for (const item of items) {
      const k = `${feedKey}\u0000${item.externalId}`;
      const id = this.byExternal.get(k);
      const existing = id ? this.items.get(id) : undefined;
      if (!existing) {
        const row: NewsItemRow = {
          ...structuredClone(item),
          feedKey,
          id: randomUUID(),
          firstSeenAt: now,
          lastSeenAt: now,
          changedAt: new Date(Math.min(now.getTime(), item.activityAt.getTime())),
        };
        this.items.set(row.id, row);
        this.byExternal.set(k, row.id);
        result.inserted++;
      } else if (existing.contentHash !== item.contentHash) {
        this.items.set(existing.id, {
          ...structuredClone(item),
          feedKey,
          id: existing.id,
          firstSeenAt: existing.firstSeenAt,
          lastSeenAt: now,
          changedAt: now,
        });
        result.updated++;
      } else existing.lastSeenAt = now;
    }
    return result;
  }

  async list(filter: NewsFilter, page: { limit: number; after?: NewsCursor }): Promise<NewsItemRow[]> {
    return [...this.items.values()]
      .filter((r) => matchesFilter(r, filter) && (!page.after || before(r, page.after)))
      .sort(order)
      .slice(0, page.limit)
      .map((r) => structuredClone(r));
  }

  async get(id: string, roles: readonly string[]): Promise<NewsItemRow | null> {
    const r = this.items.get(id);
    return r && r.audience.every((role) => roles.includes(role)) ? structuredClone(r) : null;
  }

  async count(filter: NewsFilter, cap: number): Promise<number> {
    let n = 0;
    for (const r of this.items.values()) if (matchesFilter(r, filter) && ++n >= cap) break;
    return n;
  }

  async countByFeed(roles: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const r of this.items.values())
      if (r.audience.every((role) => roles.includes(role))) out.set(r.feedKey, (out.get(r.feedKey) ?? 0) + 1);
    return out;
  }

  async newestByFeed(roles: readonly string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    for (const r of this.items.values()) {
      if (!r.audience.every((role) => roles.includes(role))) continue;
      const cur = out.get(r.feedKey);
      if (!cur || r.activityAt.getTime() > cur.getTime()) out.set(r.feedKey, r.activityAt);
    }
    return out;
  }

  async remove(feedKey: string, externalIds: readonly string[]): Promise<number> {
    let removed = 0;
    for (const externalId of externalIds) {
      const key = `${feedKey}\u0000${externalId}`;
      const id = this.byExternal.get(key);
      if (id === undefined) continue;
      this.items.delete(id);
      this.byExternal.delete(key);
      removed++;
    }
    return removed;
  }

  async totalForFeed(feedKey: string): Promise<number> {
    let n = 0;
    for (const r of this.items.values()) if (r.feedKey === feedKey) n++;
    return n;
  }

  async getState(feedKey: string): Promise<FeedState | null> {
    const s = this.states.get(feedKey);
    return s ? { ...s } : null;
  }

  async listStates(): Promise<FeedState[]> {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  async saveState(state: FeedState): Promise<void> {
    this.states.set(state.feedKey, { ...state });
  }

  async prune(policy: PrunePolicy): Promise<number> {
    const t = policy.now.getTime();
    let removed = 0;
    for (const r of [...this.items.values()]) {
      const days = policy.feeds.get(r.feedKey);
      const activeIncident =
        r.kind === 'incident' &&
        r.status !== 'resolved' &&
        r.lastSeenAt.getTime() >= t - ACTIVE_INCIDENT_SEEN_DAYS * DAY_MS;
      const cutoff = t - (days ?? policy.orphanDays) * DAY_MS;
      const old =
        days === undefined
          ? r.lastSeenAt.getTime() < cutoff
          : r.lastSeenAt.getTime() < cutoff && r.activityAt.getTime() < cutoff && !activeIncident;
      if (old) {
        this.items.delete(r.id);
        this.byExternal.delete(`${r.feedKey}\u0000${r.externalId}`);
        removed++;
      }
    }
    for (const s of [...this.states.values()])
      if (!policy.feeds.has(s.feedKey) && (s.lastRunAt?.getTime() ?? 0) < t - policy.orphanDays * DAY_MS)
        this.states.delete(s.feedKey);
    return removed;
  }
}
