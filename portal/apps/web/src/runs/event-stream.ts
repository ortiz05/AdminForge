import { useEffect, useRef } from 'react';

/**
 * One shared `EventSource('/api/events')` for the whole tab (session.mode, definitions.changed, run.updated …).
 * Subscribers register per event name; the stream opens with the first subscriber and closes with the last.
 * Browsers without EventSource (and jsdom) simply never deliver events — callers keep a polling fallback.
 */

type Handler = (data: unknown) => void;

const handlers = new Map<string, Set<Handler>>();
const attached = new Map<string, (e: MessageEvent) => void>();
let source: EventSource | null = null;

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function attach(type: string) {
  if (!source || attached.has(type)) return;
  const listener = (e: MessageEvent) => {
    const data = parse(typeof e.data === 'string' ? e.data : '');
    for (const h of handlers.get(type) ?? []) h(data);
  };
  attached.set(type, listener);
  source.addEventListener(type, listener as EventListener);
}

function open() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/events', { withCredentials: true });
  for (const type of handlers.keys()) attach(type);
}

function closeIfIdle() {
  if (handlers.size > 0 || !source) return;
  source.close();
  source = null;
  attached.clear();
}

export function subscribePortalEvent(type: string, handler: Handler): () => void {
  let set = handlers.get(type);
  if (!set) handlers.set(type, (set = new Set()));
  set.add(handler);
  open();
  attach(type);
  return () => {
    set.delete(handler);
    if (set.size === 0) {
      handlers.delete(type);
      const listener = attached.get(type);
      if (listener && source) source.removeEventListener(type, listener as EventListener);
      attached.delete(type);
    }
    closeIfIdle();
  };
}

/** React binding: `handler` may change every render without re-subscribing. */
export function usePortalEvent(type: string, handler: Handler): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => subscribePortalEvent(type, (data) => ref.current(data)), [type]);
}

/** Whether this browser can stream events at all (polling intervals relax when it can). */
export const canStream = () => typeof EventSource !== 'undefined';
