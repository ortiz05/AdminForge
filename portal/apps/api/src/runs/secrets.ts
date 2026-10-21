import type { SecretDelivery, SecretSink } from '@adminforge/engine';
import type { AuditWriter } from '../audit/writer';
import { rootOf } from './run-worker';
import type { RunRepository } from './types';

/**
 * Show-once secrets on the API side. The engine masks secret outputs and hands the values to `sink()`; they never
 * touch a table. The broker then:
 * - writes them to the live event streams (SSE) of the run's initiator — the session bound to the root run — that are
 *   open at that moment (`{type:'secret', …}`, no event id, never stored), or
 * - holds them in memory for at most 5 minutes for the first `GET /api/runs/:id/secret/:stepPath` from that session,
 *   then drops them.
 * Either way `run.secret.revealed` is audited (field names only). The run worker is part of the API process
 * (ADR-016), so a secret never crosses a process boundary and never reaches the database, not even sealed.
 */

export const SECRET_TTL_MS = 5 * 60_000;

interface Held {
  runId: string;
  rootRunId: string;
  stepId: string;
  stepPath: string;
  values: Record<string, unknown>;
  hints: Record<string, string>;
  sessionHash: string;
  initiatorOid: string | null;
  initiatorUpn: string | null;
  correlationId: string;
  producedAt: string;
}

/** What the browser receives (stream message or fetch response). */
export interface SecretMessage {
  type: 'secret';
  runId: string;
  stepId: string;
  stepPath: string;
  values: Record<string, unknown>;
  hints: Record<string, string>;
  producedAt: string;
}

export interface SecretStream {
  runId: string;
  sessionHash: string;
  send(message: SecretMessage): void;
}

type Log = { warn(obj: object, msg: string): void };

const keyOf = (runId: string, stepPath: string) => `${runId}|${stepPath}`;
const message = (h: Held): SecretMessage => ({
  type: 'secret',
  runId: h.runId,
  stepId: h.stepId,
  stepPath: h.stepPath,
  values: h.values,
  hints: h.hints,
  producedAt: h.producedAt,
});

export class SecretBroker {
  private readonly held = new Map<string, { secret: Held; timer: NodeJS.Timeout }>();
  private readonly streams = new Set<SecretStream>();

  constructor(
    private readonly deps: {
      repo: RunRepository;
      audit: AuditWriter;
      ttlMs?: number;
      log?: Log;
      /**
       * Whether a session hash still belongs to a signed-in session (not signed out, expired or idle). A secret is
       * written only to streams of a live session (APP-02); without this check every attached stream counts.
       */
      sessionLive?: (sessionHash: string) => Promise<boolean>;
    },
  ) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    for (const { timer } of this.held.values()) clearTimeout(timer);
    this.held.clear();
    this.streams.clear();
  }

  /** Number of secrets currently held in memory (tests/metrics). */
  get heldCount(): number {
    return this.held.size;
  }

  /** The engine's SecretSink: resolve who may see it (the root run's initiator session), then hand off. */
  sink(): SecretSink {
    return {
      deliver: async (run, s: SecretDelivery) => {
        const row = await this.deps.repo.getRun(run.id);
        if (!row) return { status: 'discarded', reason: 'The run no longer exists.' };
        const root = await rootOf(this.deps.repo, row);
        if (root.identity !== 'delegated' || !root.sessionHash)
          return { status: 'discarded', reason: 'Nobody is signed in to receive it (scheduled run).' };
        const held: Held = {
          runId: row.id,
          rootRunId: root.id,
          stepId: s.stepId,
          stepPath: s.stepPath,
          values: s.values,
          hints: s.hints,
          sessionHash: root.sessionHash,
          initiatorOid: root.initiatorOid,
          initiatorUpn: root.initiatorUpn,
          correlationId: row.correlationId,
          producedAt: s.producedAt,
        };
        return { status: await this.handoff(held) };
      },
    };
  }

  /** Registers a live stream (SSE) of a session watching a run; returns the detach function. */
  attach(stream: SecretStream): () => void {
    this.streams.add(stream);
    return () => this.streams.delete(stream);
  }

  /**
   * Delivers to matching live streams, else holds it for one fetch. A stream whose session ended (signed out, expired,
   * idle) since it opened doesn't count: the secret is held instead, and only that session could fetch it.
   */
  async handoff(h: Held): Promise<'delivered' | 'held'> {
    let targets = [...this.streams].filter(
      (s) => s.sessionHash === h.sessionHash && (s.runId === h.runId || s.runId === h.rootRunId),
    );
    if (targets.length && this.deps.sessionLive) {
      const live = await this.deps.sessionLive(h.sessionHash).catch(() => false);
      if (!live) targets = [];
    }
    let sent = 0;
    for (const t of targets) {
      try {
        t.send(message(h));
        sent++;
      } catch {
        // a broken stream just doesn't count
      }
    }
    if (sent) {
      await this.revealed(h, 'stream', sent);
      return 'delivered';
    }
    const k = keyOf(h.runId, h.stepPath);
    const previous = this.held.get(k);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => void this.expire(k), this.deps.ttlMs ?? SECRET_TTL_MS);
    timer.unref?.();
    this.held.set(k, { secret: h, timer });
    return 'held';
  }

  /** The first fetch by the initiator's session takes it; everyone else (and every later fetch) gets nothing. */
  async claim(runId: string, stepPath: string, sessionHash: string): Promise<SecretMessage | null> {
    const k = keyOf(runId, stepPath);
    const entry = this.held.get(k);
    if (!entry || entry.secret.sessionHash !== sessionHash) return null;
    this.held.delete(k);
    clearTimeout(entry.timer);
    await this.revealed(entry.secret, 'fetch', 1);
    return message(entry.secret);
  }

  private async expire(k: string) {
    const entry = this.held.get(k);
    if (!entry) return;
    this.held.delete(k);
    const h = entry.secret;
    await this.deps.audit
      .append({
        actorOid: h.initiatorOid,
        actorUpn: h.initiatorUpn,
        mode: null,
        action: 'run.secret.expired',
        targetType: 'run',
        targetId: h.runId,
        details: {
          stepId: h.stepId,
          stepPath: h.stepPath,
          fields: Object.keys(h.values),
          reason: 'Not fetched within 5 minutes; discarded.',
        },
        result: 'failure',
        correlationId: h.correlationId,
      })
      .catch(() => undefined);
  }

  private async revealed(h: Held, channel: 'stream' | 'fetch', count: number) {
    await this.deps.audit.append({
      actorOid: h.initiatorOid,
      actorUpn: h.initiatorUpn,
      sessionHash: h.sessionHash,
      mode: null,
      action: 'run.secret.revealed',
      targetType: 'run',
      targetId: h.runId,
      details: {
        stepId: h.stepId,
        stepPath: h.stepPath,
        fields: Object.keys(h.values),
        channel,
        ...(channel === 'stream' ? { streams: count } : {}),
      },
      result: 'success',
      correlationId: h.correlationId,
    });
  }
}
