import { useSyncExternalStore } from 'react';
import { onUnauthenticated } from '../lib/api';
import { isSource, type QuerySource } from './contracts';

/**
 * Query history, per signed-in user in this browser (localStorage, keyed by the user's oid). Queries can name tenant
 * objects, so the next person on a shared browser never sees them: the shell sets the owner when it loads the session,
 * and sign-out (here or in another tab) or any 401 — the session ended, perhaps in a tab left open — removes every
 * user's history. Without an owner nothing is stored.
 * A convenience only: storage can be full, blocked or disabled (private windows, policy), so every access is wrapped
 * and failure simply means no history.
 */

/** Prefix of the storage keys (`<prefix>:<oid>`); the bare prefix is the old, unkeyed key (removed when seen). */
export const HISTORY_KEY = 'adminforge.query.history';
export const historyKey = (oid: string) => `${HISTORY_KEY}:${oid}`;
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
    if (!isSource(o.source) || typeof o.query !== 'string' || !o.query.trim() || typeof o.ranAt !== 'string')
      return [];
    return [
      {
        source: o.source,
        query: o.query.slice(0, QUERY_MAX),
        ranAt: o.ranAt,
        ...(typeof o.workspace === 'string' ? { workspace: o.workspace } : {}),
        ...(Array.isArray(o.subscriptions)
          ? { subscriptions: o.subscriptions.filter((s): s is string => typeof s === 'string').slice(0, 100) }
          : {}),
        ...(typeof o.timespan === 'string' ? { timespan: o.timespan } : {}),
        ...(typeof o.rowCount === 'number' ? { rowCount: o.rowCount } : {}),
        ...(typeof o.ms === 'number' ? { ms: o.ms } : {}),
        ...(o.failed === true ? { failed: true } : {}),
      },
    ];
  });
}

let owner: string | null = null;

export function readHistory(): HistoryEntry[] {
  if (!owner) return [];
  try {
    return sanitize(JSON.parse(localStorage.getItem(historyKey(owner)) ?? '[]')).slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

function write(entries: HistoryEntry[]): void {
  if (!owner) return;
  try {
    localStorage.setItem(historyKey(owner), JSON.stringify(entries));
  } catch {
    // Full or blocked storage: keep the in-memory copy for this session.
  }
}

/** Every history key in this browser (all users, and the old unkeyed one). */
function storedKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === HISTORY_KEY || k?.startsWith(`${HISTORY_KEY}:`)) keys.push(k);
    }
  } catch {
    // Blocked storage: nothing stored either.
  }
  return keys;
}

const remove = (key: string) => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to do.
  }
};

let cache: HistoryEntry[] | null = null;
const listeners = new Set<() => void>();
const current = () => (cache ??= readHistory());
const emit = () => listeners.forEach((l) => l());

/** Adds a run at the top; the same query on the same source moves up instead of repeating. */
export function recordRun(entry: HistoryEntry): void {
  const key = (e: HistoryEntry) => `${e.source}\u0000${e.query.trim()}`;
  const next = [
    { ...entry, query: entry.query.slice(0, QUERY_MAX) },
    ...current().filter((e) => key(e) !== key(entry)),
  ].slice(0, HISTORY_MAX);
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
  if (owner) remove(historyKey(owner));
  emit();
}

/** The signed-in user whose history is shown and stored (the shell calls this with `me.user.oid`). */
export function setHistoryOwner(oid: string | null): void {
  if (oid === owner) return;
  owner = oid;
  cache = null;
  // History written before it was kept per user can't be attributed to anyone: drop it.
  remove(HISTORY_KEY);
  emit();
}

/** Every user's stored history leaves this browser; without `keepOwner` nothing is stored again until `setHistoryOwner`. */
function forget({ keepOwner }: { keepOwner: boolean }): void {
  for (const k of storedKeys()) remove(k);
  if (!keepOwner) owner = null;
  cache = [];
  emit();
}

/** Sign-out: every user's history leaves this browser. */
export const forgetAllHistory = (): void => forget({ keepOwner: false });

// Any 401 takes the stored history out of the browser, as sign-out does. When the session ended (or the answer isn't
// AdminForge's) nothing is stored again until a signed-in session names its owner; after `reauth` — Microsoft wants a
// fresh sign-in, the session and its person stay — the same person keeps recording.
onUnauthenticated((code) => forget({ keepOwner: code === 'reauth' }));

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHistory(): HistoryEntry[] {
  return useSyncExternalStore(subscribe, current, current);
}

/** Test seam: forget the in-memory copy so the next read goes back to storage (`owner` sets who is signed in). */
export function __resetHistoryForTests(nextOwner: string | null = owner): void {
  owner = nextOwner;
  cache = null;
  emit();
}
