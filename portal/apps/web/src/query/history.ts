import { useSyncExternalStore } from 'react';
import { isSource, type QuerySource } from './contracts';

/**
 * Query history, per browser (localStorage). A convenience only: storage can be full, blocked or disabled
 * (private windows, policy), so every access is wrapped and failure simply means no history.
 */

export const HISTORY_KEY = 'adminforge.query.history';
export const HISTORY_MAX = 50;
const QUERY_MAX = 20_000;

export interface HistoryEntry {
  source: QuerySource;
  query: string;
  /** ISO time of the last run. */
  ranAt: string;
  workspace?: string;
  subscriptions?: string[];
  timespan?: string;
  /** Outcome of the last run. */
  rowCount?: number;
  ms?: number;
  failed?: boolean;
}

function sanitize(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e): HistoryEntry[] => {
    if (typeof e !== 'object' || e === null) return [];
    const o = e as Record<string, unknown>;
    if (!isSource(o.source) || typeof o.query !== 'string' || !o.query.trim() || typeof o.ranAt !== 'string') return [];
    return [
      {
        source: o.source,
        query: o.query.slice(0, QUERY_MAX),
        ranAt: o.ranAt,
        ...(typeof o.workspace === 'string' ? { workspace: o.workspace } : {}),
        ...(Array.isArray(o.subscriptions) ? { subscriptions: o.subscriptions.filter((s): s is string => typeof s === 'string').slice(0, 100) } : {}),
        ...(typeof o.timespan === 'string' ? { timespan: o.timespan } : {}),
        ...(typeof o.rowCount === 'number' ? { rowCount: o.rowCount } : {}),
        ...(typeof o.ms === 'number' ? { ms: o.ms } : {}),
        ...(o.failed === true ? { failed: true } : {}),
      },
    ];
  });
}

export function readHistory(): HistoryEntry[] {
  try {
    return sanitize(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')).slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

function write(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    // Full or blocked storage: keep the in-memory copy for this session.
  }
}

let cache: HistoryEntry[] | null = null;
const listeners = new Set<() => void>();
const current = () => (cache ??= readHistory());
const emit = () => listeners.forEach((l) => l());

/** Adds a run at the top; the same query on the same source moves up instead of repeating. */
export function recordRun(entry: HistoryEntry): void {
  const key = (e: HistoryEntry) => `${e.source}\u0000${e.query.trim()}`;
  const next = [{ ...entry, query: entry.query.slice(0, QUERY_MAX) }, ...current().filter((e) => key(e) !== key(entry))].slice(0, HISTORY_MAX);
  cache = next;
  write(next);
  emit();
}

export function removeRun(ranAt: string): void {
  cache = current().filter((e) => e.ranAt !== ranAt);
  write(cache);
  emit();
}

export function clearHistory(): void {
  cache = [];
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // Nothing to do: the in-memory copy is already empty.
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHistory(): HistoryEntry[] {
  return useSyncExternalStore(subscribe, current, current);
}

/** Test seam: forget the in-memory copy so the next read goes back to storage. */
export function __resetHistoryForTests(): void {
  cache = null;
  emit();
}
