import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  asRunStatus,
  isTerminal,
  readError,
  readLog,
  readStep,
  type LogLine,
  type RunDetail,
  type RunStep,
} from './contracts';
import { num, pick, rec } from './json';
import { runDetailQuery } from './queries';
import {
  claimHeldSecret,
  readSecretMessage,
  readSecretNotice,
  secretKey,
  type SecretMessage,
  type SecretNotice,
} from './secrets';

export interface SecretNoticeState extends SecretNotice {
  /** Set when a held secret couldn't be claimed (already shown, expired, refused). */
  error: string | null;
}

const MAX_LOG_LINES = 5000;

function parse(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Applies a `run` event (status, timestamps, error, outputs, progress) to the cached detail. */
export function applyRunEvent(old: RunDetail, data: unknown): RunDetail {
  const o = rec(rec(data).run ?? data);
  const run = { ...old.run };
  if (typeof o.status === 'string') run.status = asRunStatus(o.status);
  const startedAt = pick(o, 'startedAt');
  const endedAt = pick(o, 'endedAt');
  if (startedAt) run.startedAt = startedAt;
  if (endedAt) run.endedAt = endedAt;
  if ('error' in o) run.error = readError(o.error);
  if (o.outputs && typeof o.outputs === 'object') run.outputs = o.outputs as Record<string, unknown>;
  const p = rec(o.progress);
  if (num(p.total) !== undefined)
    run.progress = { done: num(p.done) ?? 0, total: num(p.total)!, failed: num(p.failed) };
  const current = pick(o, 'currentStep');
  if (current) run.currentStep = current;
  return { ...old, run };
}

/**
 * Applies a `step` event (`{ path, stepId, type, status, attempt, error? }`): it updates the record with the same
 * path, or adds one (the next GET fills in output and plan).
 */
export function applyStepEvent(old: RunDetail, data: unknown, stepSeq?: number | null): RunDetail {
  const o = rec(rec(data).step ?? data);
  const path = pick(o, 'path') ?? pick(o, 'stepId');
  if (!path) return old;
  const existing = old.steps.filter((s) => s.path === path).sort((a, b) => b.seq - a.seq)[0];
  const seq =
    stepSeq ?? num(o.seq) ?? (existing ? existing.seq : Math.max(0, ...old.steps.map((s) => s.seq)) + 1);
  const parsed = readStep({ ...o, seq, path, stepId: pick(o, 'stepId') ?? existing?.stepId ?? path }, seq);
  if (!parsed) return old;
  const merged: RunStep = existing
    ? {
        ...existing,
        status: parsed.status,
        attempt: num(o.attempt) ?? existing.attempt,
        error: 'error' in o ? parsed.error : existing.error,
        type: pick(o, 'type') ?? existing.type,
      }
    : parsed;
  const steps = existing ? old.steps.map((s) => (s === existing ? merged : s)) : [...old.steps, merged];
  return { ...old, steps };
}

export function applyProgressEvent(old: RunDetail, data: unknown): RunDetail {
  const o = rec(data);
  const total = num(o.total);
  if (total === undefined) return old;
  return {
    ...old,
    run: {
      ...old.run,
      progress: { done: num(o.done) ?? num(o.completed) ?? 0, total, failed: num(o.failed) },
    },
  };
}

/** One run/step/progress event applied to the detail (logs are kept separately). */
export function applyEnvelope(
  old: RunDetail,
  type: string,
  data: unknown,
  stepSeq: number | null,
): RunDetail {
  if (type === 'run') return applyRunEvent(old, data);
  if (type === 'step') return applyStepEvent(old, data, stepSeq);
  if (type === 'progress') return applyProgressEvent(old, data);
  return old;
}

/**
 * A run with live updates: GET /api/runs/:id, then SSE /api/runs/:id/events (`run`, `step`, `log`, `progress`).
 * EventSource resends Last-Event-ID on reconnect, so the server can resume the stream where it broke. Each event
 * patches the cache immediately; a debounced refetch reconciles. The stream closes on `event: end` (finished runs
 * still connect once, to replay their logs).
 * Without EventSource (old browsers, tests) the query polls instead.
 */
export function useRunLive(id: string, { enabled = true }: { enabled?: boolean } = {}) {
  const queryClient = useQueryClient();
  const key = runDetailQuery(id).queryKey;
  const q = useQuery({
    ...runDetailQuery(id),
    enabled,
    refetchInterval: (query) => {
      const s = query.state.data?.run.status;
      if (s && isTerminal(s)) return false;
      return typeof EventSource === 'undefined' ? 3000 : 20_000;
    },
  });
  const [streamLogs, setStreamLogs] = useState<LogLine[]>([]);
  // Show-once secrets: component memory only (never the query cache, storage or the URL).
  const [secrets, setSecrets] = useState<SecretMessage[]>([]);
  const [notices, setNotices] = useState<Record<string, SecretNoticeState>>({});
  const dismissed = useRef(new Set<string>());
  const liveSecrets = useRef(new Set<string>());
  const [connected, setConnected] = useState(false);
  const terminal = Boolean(q.data && isTerminal(q.data.run.status));
  const reconcile = useRef<number | undefined>(undefined);
  // Events that arrive before the first GET answers are kept and applied once it does; an `end` seen meanwhile
  // asks for one more read (the first GET may predate the end of the run).
  const early = useRef<Array<{ type: string; data: unknown; stepSeq: number | null }>>([]);
  const endedEarly = useRef(false);
  const hasData = q.data !== undefined;
  useEffect(() => {
    if (!hasData) return;
    const queued = early.current;
    early.current = [];
    if (queued.length)
      queryClient.setQueryData<RunDetail>(key, (old) =>
        old ? queued.reduce((d, e) => applyEnvelope(d, e.type, e.data, e.stepSeq), old) : old,
      );
    if (queued.length || endedEarly.current) {
      endedEarly.current = false;
      void queryClient.invalidateQueries({ queryKey: key });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasData, queryClient]);

  useEffect(() => {
    // Finished runs connect too: the stream replays their logs (and show-once secret notices), then sends `end`.
    if (!enabled || typeof EventSource === 'undefined') return;
    const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`, { withCredentials: true });
    const seen = new Set<string>();
    let anon = 0;
    const reconcileSoon = (ms = 800) => {
      window.clearTimeout(reconcile.current);
      reconcile.current = window.setTimeout(() => {
        reconcile.current = undefined;
        void queryClient.invalidateQueries({ queryKey: key });
      }, ms);
    };
    const addSecret = (secret: SecretMessage) => {
      const k = secretKey(secret);
      if (dismissed.current.has(k)) return;
      setSecrets((all) => (all.some((s) => secretKey(s) === k) ? all : [...all, secret]));
    };
    /** One event: `{ id, type: run|step|log|progress, ts, stepSeq, data }` (the API's envelope). */
    const handle = (env: Record<string, unknown>) => {
      const type = pick(env, 'type');
      // Show-once secrets come without an `id:` line; they are never replayed, so they aren't deduplicated by id.
      if (type === 'secret') {
        const secret = readSecretMessage(env.values ? env : env.data);
        if (secret) {
          liveSecrets.current.add(secretKey(secret));
          addSecret(secret);
        }
        return;
      }
      const eventId = env.id !== undefined ? String(env.id) : '';
      if (eventId) {
        if (seen.has(eventId)) return;
        seen.add(eventId);
      }
      const data = env.data;
      const stepSeq = num(env.stepSeq) ?? null;
      if (type === 'log') {
        const notice = readSecretNotice(rec(data).secret);
        if (notice) {
          const k = secretKey(notice);
          setNotices((all) => ({ ...all, [k]: { ...notice, error: all[k]?.error ?? null } }));
          if (notice.status === 'held' && !liveSecrets.current.has(k))
            void claimHeldSecret(notice).then((r) => {
              if (!r) return;
              if (r.ok) addSecret(r.secret);
              else setNotices((all) => ({ ...all, [k]: { ...notice, error: r.message } }));
            });
        }
        const line = readLog(
          { ...rec(data), id: eventId || undefined, ts: env.ts, stepSeq },
          eventId || `live-${++anon}`,
        );
        if (line) setStreamLogs((all) => [...all, line].slice(-MAX_LOG_LINES));
        return;
      }
      if (!type) return;
      if (queryClient.getQueryData(key) === undefined) {
        early.current.push({ type, data, stepSeq });
        return;
      }
      queryClient.setQueryData<RunDetail>(key, (old) =>
        old ? applyEnvelope(old, type, data, stepSeq) : old,
      );
      reconcileSoon();
    };
    es.onmessage = (e) => {
      const env = rec(parse(e.data));
      if (pick(env, 'type')) handle(env);
    };
    // Servers that name their events instead (event: step / data: {…}).
    const named = (['run', 'step', 'log', 'progress', 'secret'] as const).map(
      (t) =>
        [
          t,
          (e: MessageEvent) =>
            handle({
              type: t,
              ...(t === 'secret' ? rec(parse(e.data)) : { data: parse(e.data) }),
              id: e.lastEventId || undefined,
            }),
        ] as const,
    );
    for (const [t, l] of named) es.addEventListener(t, l as EventListener);
    // `event: end` — the run is over: stop (EventSource would otherwise reconnect and replay).
    const onEnd = () => {
      es.close();
      setConnected(false);
      if (queryClient.getQueryData(key) === undefined) endedEarly.current = true;
      else reconcileSoon(0);
    };
    es.addEventListener('end', onEnd);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => {
      // A pending reconcile still runs: the stream may close because the run just finished (final timings, outputs).
      if (reconcile.current !== undefined) {
        window.clearTimeout(reconcile.current);
        reconcile.current = undefined;
        void queryClient.invalidateQueries({ queryKey: key });
      }
      for (const [t, l] of named) es.removeEventListener(t, l as EventListener);
      es.removeEventListener('end', onEnd);
      es.close();
      setConnected(false);
    };
    // `key` is derived from `id`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, enabled, queryClient]);

  const initialLogs = q.data?.logs ?? [];
  const known = new Set(initialLogs.map((l) => l.id));
  const logs = [...initialLogs, ...streamLogs.filter((l) => !known.has(l.id))];
  const dismissSecret = (key: string) => {
    dismissed.current.add(key);
    setSecrets((all) => all.filter((s) => secretKey(s) !== key));
  };
  return {
    query: q,
    detail: q.data,
    logs,
    live: connected && !terminal,
    secrets,
    notices: Object.values(notices),
    dismissSecret,
  };
}

/** Child records grouped under their top-level step (`items[3].run` → `items`). */
export function topLevelKey(path: string): string {
  const m = /^[^.[#]+/.exec(path);
  return m ? m[0] : path;
}

export const isNested = (path: string) => /[.[]/.test(path) && !path.includes('#');
