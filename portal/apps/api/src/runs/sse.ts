import { isTerminal, type RunStatus } from '@adminforge/engine';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRecord } from '../auth/session-store';
import type { RunEventBus } from './events';
import type { SecretBroker } from './secrets';
import { notificationType } from './store';
import type { EventRow, RunRepository } from './types';

const HEARTBEAT_MS = 15_000;
const PAGE = 500;
/** How often an open run stream re-checks that its session may still watch the run (as GET /api/events does). */
export const RUN_STREAM_POLL_MS = 10_000;

/** A session that still counts as signed in: not deleted (sign-out), not past its expiry, not idle too long. */
export function sessionLive(
  s: Pick<SessionRecord, 'expiresAt' | 'lastSeenAt'> | null | undefined,
  now: Date,
  idleMinutes: number,
): boolean {
  return (
    !!s &&
    now.getTime() < s.expiresAt.getTime() &&
    now.getTime() - s.lastSeenAt.getTime() <= idleMinutes * 60_000
  );
}

/**
 * SSE payload for one stored event: `{ id, type: 'run'|'step'|'log'|'progress', ts, stepSeq, data }`.
 * - run: `{ scope:'run', status, error?, … }` — run status changes
 * - step: `{ scope:'step', path, stepId, type, status, attempt, error? }`
 * - log: `{ message, level, path? }` (runner `output` events arrive as log with `output`)
 * - progress: `{ path, done, total }` (forEach) or `{ percent, message }` (runner)
 * Live only, to the initiator's session, never replayed and without an `id:` line:
 * - secret: `{ type: 'secret', runId, stepId, stepPath, values, hints, producedAt }` — show once, then forget.
 */
export function sseData(e: EventRow) {
  const type = notificationType(e);
  const data =
    e.type === 'output'
      ? { level: 'info', message: 'Script output', output: (e.data as { data?: unknown }).data ?? null }
      : e.type === 'log'
        ? { level: e.level ?? 'info', ...e.data }
        : e.data;
  return { id: e.id, type, ts: e.ts.toISOString(), stepSeq: e.stepSeq ?? null, data };
}

/**
 * GET /api/runs/:id/events. Replays `run_step_events` after Last-Event-ID (or `?lastEventId=`), then streams new
 * ones as `run_events` notifications arrive. Each message carries `id:` (resumable) and JSON `data:` (see sseData).
 * When the run has ended, a final `event: end` is sent and the stream closes — clients should call `close()` on it
 * (otherwise EventSource reconnects, gets the replay, and `end` again).
 * Every 10 s the stream asks `stillAllowed` (APP-02): after sign-out, session expiry or idle timeout, or losing the
 * roles to see the run, it sends `event: session.ended` and closes (a reconnect is then refused).
 */
export async function streamRunEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: {
    repo: RunRepository;
    bus: RunEventBus;
    secrets?: SecretBroker;
    /** Whether the session may still watch this run (false ends the stream; an error keeps it open). */
    stillAllowed?: () => Promise<boolean>;
    pollMs?: number;
    /** Called once when the stream closes, however it ends (the route's per-session stream count). */
    onClose?: () => void;
    /**
     * What this viewer receives of each stored event (null skips it), asked after each read of new events so a change
     * in what they may see applies to the next event (S-25: metadata only for someone else's delegated run).
     */
    view?: () => Promise<(e: EventRow) => EventRow | null>;
  },
  runId: string,
  lastEventId: number,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-correlation-id': request.id,
  });
  raw.write('retry: 3000\n\n');

  let last = lastEventId;
  let closed = false;
  const heartbeat: NodeJS.Timeout = setInterval(() => {
    if (!closed) raw.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  let pumping = false;
  let again = false;
  let unsubscribe: () => void = () => undefined;
  let untrack: () => void = () => undefined;
  let detach: () => void = () => undefined;
  let poll: NodeJS.Timeout | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (poll) clearInterval(poll);
    unsubscribe();
    untrack();
    detach();
    deps.onClose?.();
    raw.end();
  };
  // The response closes when the client goes away (the request's own 'close' fires as soon as its body is read).
  raw.on('close', close);
  // Gone before the listener was attached: close now (and give back the stream's slot).
  if (raw.destroyed) {
    close();
    return;
  }

  const end = (status: RunStatus) => {
    if (closed) return;
    raw.write(`event: end\ndata: ${JSON.stringify({ status })}\n\n`);
    close();
  };

  const pump = async (): Promise<void> => {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        for (;;) {
          const events = await deps.repo.listEvents(runId, last, PAGE);
          const view = deps.view && events.length ? await deps.view() : undefined;
          for (const e of events) {
            if (closed) return;
            const shown = view ? view(e) : e;
            if (shown) raw.write(`id: ${e.id}\ndata: ${JSON.stringify(sseData(shown))}\n\n`);
            last = e.id;
          }
          if (events.length < PAGE) break;
        }
      } while (again && !closed);
      if (closed) return;
      const run = await deps.repo.getRun(runId);
      if (!run || isTerminal(run.status)) end(run?.status ?? 'failed');
    } catch (err) {
      request.log.warn({ err: { message: (err as Error).message }, runId }, 'run event stream failed');
      close();
    } finally {
      pumping = false;
    }
  };

  // APP-02: the access check above happened once; signing out, expiring or losing the role ends the stream.
  if (deps.stillAllowed) {
    const stillAllowed = deps.stillAllowed;
    let checking = false;
    poll = setInterval(() => {
      if (closed || checking) return;
      checking = true;
      void stillAllowed()
        .then((ok) => {
          if (ok || closed) return;
          raw.write('event: session.ended\ndata: {}\n\n');
          close();
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, deps.pollMs ?? RUN_STREAM_POLL_MS);
    poll.unref?.();
  }

  // Subscribe before the replay so nothing that lands in between is missed.
  unsubscribe = deps.bus.subscribe(runId, () => void pump());
  untrack = deps.bus.track(close);
  // Show-once secrets of this run reach only the initiator's own open streams, live, and are never stored (no id).
  if (deps.secrets && request.session)
    detach = deps.secrets.attach({
      runId,
      sessionHash: request.session.idHash,
      send: (m) => void (!closed && raw.write(`data: ${JSON.stringify(m)}\n\n`)),
      close,
    });
  await pump();
}
