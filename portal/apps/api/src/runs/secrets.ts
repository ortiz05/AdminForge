import type { SecretDelivery, SecretSink } from '@adminforge/engine';
import type { AuditWriter } from '../audit/writer';
import type { Database } from '../db/client';
import { PgListener } from '../definitions/notify';
import { open, seal } from '../security/envelope';
import { rootOf } from './run-worker';
import type { RunRepository } from './types';

/**
 * Show-once secrets on the API side. The engine masks secret outputs and hands the values to `sink()`; they never
 * touch a table. The broker then:
 * - writes them to the live event streams (SSE) of the run's initiator — the session bound to the root run — that are
 *   open at that moment (`{type:'secret', …}`, no event id, never stored), or
 * - holds them in memory for at most 5 minutes for the first `GET /api/runs/:id/secret/:stepPath` from that session,
 *   then drops them.
 * Either way `run.secret.revealed` is audited (field names only). With Postgres the hand-off from a worker process to
 * the API process(es) is a `NOTIFY run_secrets` whose payload is sealed with the AES-256-GCM envelope
 * (TOKEN_CACHE_KEY; AAD = run + step), so Postgres only ever sees ciphertext; a `revealed` notice makes every other
 * replica drop its copy.
 */

export const SECRETS_CHANNEL = 'run_secrets';
export const SECRET_TTL_MS = 5 * 60_000;
/** Postgres NOTIFY payloads are limited to 8000 bytes. */
const MAX_NOTIFY_BYTES = 7900;

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
const message = (h: Held): SecretMessage => ({ type: 'secret', runId: h.runId, stepId: h.stepId, stepPath: h.stepPath, values: h.values, hints: h.hints, producedAt: h.producedAt });

export class SecretBroker {
  private readonly held = new Map<string, { secret: Held; timer: NodeJS.Timeout }>();
  private readonly streams = new Set<SecretStream>();
  private readonly listener: PgListener | null;
  private started: Promise<void> | null = null;
  readonly transport: 'memory' | 'notify';

  constructor(
    private readonly deps: {
      repo: RunRepository;
      audit: AuditWriter;
      /** 32-byte envelope key (TOKEN_CACHE_KEY) for the cross-process hand-off. */
      key: Buffer;
      /** Postgres for NOTIFY; null keeps everything in this process. */
      database: Database | null;
      listenUrl?: string | null;
      /** This process serves browsers (API). Worker processes only publish. */
      serve: boolean;
      ttlMs?: number;
      log?: Log;
    },
  ) {
    this.transport = deps.database && deps.listenUrl ? 'notify' : 'memory';
    this.listener =
      this.transport === 'notify' && deps.serve ? new PgListener(deps.listenUrl!, SECRETS_CHANNEL, (p) => void this.onNotify(p), deps.log ? { log: deps.log } : {}) : null;
  }

  start(): Promise<void> {
    this.started ??= this.listener?.start() ?? Promise.resolve();
    return this.started;
  }

  async stop(): Promise<void> {
    this.started = null;
    for (const { timer } of this.held.values()) clearTimeout(timer);
    this.held.clear();
    this.streams.clear();
    await this.listener?.stop();
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
        if (root.identity !== 'delegated' || !root.sessionHash) return { status: 'discarded', reason: 'Nobody is signed in to receive it (scheduled run).' };
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
        if (this.transport === 'notify') {
          await this.publish(held);
          return { status: 'sent' };
        }
        return { status: await this.handoff(held) };
      },
    };
  }

  /** Registers a live stream (SSE) of a session watching a run; returns the detach function. */
  attach(stream: SecretStream): () => void {
    this.streams.add(stream);
    return () => this.streams.delete(stream);
  }

  /** Delivers to matching live streams, else holds it for one fetch. */
  async handoff(h: Held): Promise<'delivered' | 'held'> {
    const targets = [...this.streams].filter((s) => s.sessionHash === h.sessionHash && (s.runId === h.runId || s.runId === h.rootRunId));
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
        details: { stepId: h.stepId, stepPath: h.stepPath, fields: Object.keys(h.values), reason: 'Not fetched within 5 minutes; discarded.' },
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
      details: { stepId: h.stepId, stepPath: h.stepPath, fields: Object.keys(h.values), channel, ...(channel === 'stream' ? { streams: count } : {}) },
      result: 'success',
      correlationId: h.correlationId,
    });
    if (this.transport === 'notify') await this.notify({ t: 'revealed', k: keyOf(h.runId, h.stepPath) }).catch(() => undefined);
  }

  private aad = (k: string) => `adminforge.run-secret:${k}`;

  private async publish(h: Held) {
    const k = keyOf(h.runId, h.stepPath);
    const payload = { t: 'secret', k, s: seal(JSON.stringify(h), this.deps.key, this.aad(k)) };
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_NOTIFY_BYTES) throw new Error('The secret output is too large to hand over.');
    await this.notify(payload);
  }

  private async notify(payload: Record<string, unknown>) {
    await this.deps.database!.pool.query('select pg_notify($1, $2)', [SECRETS_CHANNEL, JSON.stringify(payload)]);
  }

  private async onNotify(raw: string) {
    let p: { t?: string; k?: string; s?: string };
    try {
      p = JSON.parse(raw) as typeof p;
    } catch {
      return;
    }
    if (typeof p.k !== 'string') return;
    if (p.t === 'revealed') {
      const entry = this.held.get(p.k);
      if (entry) {
        clearTimeout(entry.timer);
        this.held.delete(p.k);
      }
      return;
    }
    if (p.t !== 'secret' || typeof p.s !== 'string') return;
    let h: Held;
    try {
      h = JSON.parse(open(p.s, this.deps.key, this.aad(p.k))) as Held;
    } catch (err) {
      this.deps.log?.warn({ err: { message: (err as Error).message } }, 'run secret could not be opened (TOKEN_CACHE_KEY differs between processes?)');
      return;
    }
    if (keyOf(h.runId, h.stepPath) !== p.k) return;
    await this.handoff(h).catch((err) => this.deps.log?.warn({ err: { message: (err as Error).message } }, 'run secret hand-off failed'));
  }
}
