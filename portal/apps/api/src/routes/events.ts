import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/guards';
import { isArmed, type SessionRecord } from '../auth/session-store';
import type { AppContext } from '../context';
import { AppError } from '../errors';
import type { PortalEvent } from '../events/bus';

const HEARTBEAT_MS = 25_000;
/** How often an open stream re-reads its session (mode changes, sign-out, expiry). */
export const SESSION_POLL_MS = 10_000;
/** Open streams per session (one per tab or window); a further one is refused with 429 until one closes. */
export const MAX_STREAMS_PER_SESSION = 5;

const modeOf = (s: SessionRecord, now: Date) =>
  isArmed(s, now)
    ? { mode: 'armed' as const, armedUntil: s.writeExpiresAt!.toISOString() }
    : { mode: 'read' as const, armedUntil: null };

/**
 * GET /api/events — Server-Sent Events for the signed-in session:
 *   ready               {mode, armedUntil}                 on connect
 *   definitions.changed {all: true}                        content published / reloaded → refetch (no keys: bus.ts)
 *   session.mode        {mode: read|armed, armedUntil}       armed, disarmed, extended or expired
 *   session.ended       {}                                   signed out or expired (the stream then closes)
 *   run.updated         <runs worker payload>              relayed from NOTIFY run_events
 * Comment lines (`: ping`) every 25 s keep proxies from closing the stream.
 */
export function eventRoutes(
  api: FastifyInstance,
  ctx: AppContext,
  opts: { pollMs?: number; maxStreams?: number } = {},
) {
  // Open streams (their end function → the session's id hash) would keep server.close() waiting; end them first.
  const open = new Map<() => void, string>();
  /** idHash → streams open for that session. */
  const perSession = new Map<string, number>();
  api.addHook('preClose', async () => {
    for (const end of [...open.keys()]) end();
  });
  // S-08: when a session's id is rotated (arming), its streams end without `session.ended` (which would read as
  // signed out): the browser reconnects with the new cookie, and a stream opened with the old id doesn't follow it.
  ctx.sessions.onRotate({
    sessionMoved: (from) => {
      for (const [end, idHash] of [...open]) if (idHash === from) end();
    },
  });
  api.get(
    '/events',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      let session = requireSession(request);
      const idHash = session.idHash;
      const streams = perSession.get(idHash) ?? 0;
      if (streams >= (opts.maxStreams ?? MAX_STREAMS_PER_SESSION))
        throw new AppError(
          429,
          'too_many_streams',
          'Live updates are already open in too many tabs or windows.',
          {
            hint: 'Close the AdminForge tabs or windows you don’t need, then reload this page.',
          },
        );
      perSession.set(idHash, streams + 1);
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-correlation-id': request.id,
      });
      let closed = false;
      const send = (type: string, data: unknown) => {
        if (!closed) raw.write(`event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
      };
      raw.write('retry: 5000\n\n');
      let mode = modeOf(session, ctx.now());
      send('ready', mode);

      const unsubscribe = ctx.events.subscribe((e: PortalEvent) => {
        if (!e.userOid || e.userOid === session.userOid) send(e.type, e.data);
      });

      let expiry: NodeJS.Timeout | null = null;
      const end = () => {
        if (closed) return;
        closed = true;
        open.delete(end);
        const left = (perSession.get(idHash) ?? 1) - 1;
        if (left > 0) perSession.set(idHash, left);
        else perSession.delete(idHash);
        unsubscribe();
        clearInterval(heartbeat);
        clearInterval(poll);
        if (expiry) clearTimeout(expiry);
        raw.end();
      };
      const check = async () => {
        if (closed) return;
        const now = ctx.now();
        const fresh = await ctx.sessions.get(session.idHash).catch(() => session);
        const idleMs = ctx.config.SESSION_IDLE_MINUTES * 60_000;
        if (
          !fresh ||
          now.getTime() >= fresh.expiresAt.getTime() ||
          now.getTime() - fresh.lastSeenAt.getTime() > idleMs
        ) {
          send('session.ended', {});
          end();
          return;
        }
        session = fresh;
        const next = modeOf(session, now);
        if (next.mode !== mode.mode || next.armedUntil !== mode.armedUntil) {
          mode = next;
          send('session.mode', mode);
        }
        scheduleExpiry();
      };
      // Fire exactly when the write window closes instead of up to one poll late.
      const scheduleExpiry = () => {
        if (expiry) clearTimeout(expiry);
        expiry = null;
        if (mode.mode !== 'armed' || !mode.armedUntil) return;
        const ms = Date.parse(mode.armedUntil) - ctx.now().getTime() + 50;
        if (ms > 0 && ms < 2 ** 31 - 1) {
          expiry = setTimeout(() => void check(), ms);
          expiry.unref?.();
        }
      };
      const heartbeat = setInterval(() => !closed && raw.write(': ping\n\n'), HEARTBEAT_MS);
      const poll = setInterval(() => void check(), opts.pollMs ?? SESSION_POLL_MS);
      heartbeat.unref?.();
      poll.unref?.();
      scheduleExpiry();
      request.raw.on('close', end);
      raw.on('error', end);
      open.set(end, idHash);
      // Gone before the listeners were attached: release its slot now.
      if (raw.destroyed) end();
    },
  );
}
