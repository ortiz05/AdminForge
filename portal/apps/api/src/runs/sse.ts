import { isTerminal, type RunStatus } from '@adminforge/engine';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RunEventBus } from './events';
import { notificationType } from './store';
import type { EventRow, RunRepository } from './types';

const HEARTBEAT_MS = 15_000;
const PAGE = 500;

/**
 * SSE payload for one stored event: `{ id, type: 'run'|'step'|'log'|'progress', ts, stepSeq, data }`.
 * - run: `{ scope:'run', status, error?, … }` — run status changes
 * - step: `{ scope:'step', path, stepId, type, status, attempt, error? }`
 * - log: `{ message, level, path? }` (runner `output` events arrive as log with `output`)
 * - progress: `{ path, done, total }` (forEach) or `{ percent, message }` (runner)
 */
export function sseData(e: EventRow) {
  const type = notificationType(e);
  const data = e.type === 'output' ? { level: 'info', message: 'Script output', output: (e.data as { data?: unknown }).data ?? null } : e.type === 'log' ? { level: e.level ?? 'info', ...e.data } : e.data;
  return { id: e.id, type, ts: e.ts.toISOString(), stepSeq: e.stepSeq ?? null, data };
}

/**
 * GET /api/runs/:id/events. Replays `run_step_events` after Last-Event-ID (or `?lastEventId=`), then streams new
 * ones as `run_events` notifications arrive. Each message carries `id:` (resumable) and JSON `data:` (see sseData).
 * When the run has ended, a final `event: end` is sent and the stream closes — clients should call `close()` on it
 * (otherwise EventSource reconnects, gets the replay, and `end` again).
 */
export async function streamRunEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: { repo: RunRepository; bus: RunEventBus },
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
  let unReconnect: () => void = () => undefined;
  let untrack: () => void = () => undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    unReconnect();
    untrack();
    raw.end();
  };
  // The response closes when the client goes away (the request's own 'close' fires as soon as its body is read).
  raw.on('close', close);

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
          for (const e of events) {
            if (closed) return;
            raw.write(`id: ${e.id}\ndata: ${JSON.stringify(sseData(e))}\n\n`);
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

  // Subscribe before the replay so nothing that lands in between is missed.
  unsubscribe = deps.bus.subscribe(runId, () => void pump());
  unReconnect = deps.bus.onReconnect(() => void pump());
  untrack = deps.bus.track(close);
  // LISTEN must be up before the replay, or an event landing in between would only show up with the next one.
  await Promise.race([deps.bus.start().catch(() => undefined), new Promise((r) => setTimeout(r, 2_000).unref?.())]);
  await pump();
}
