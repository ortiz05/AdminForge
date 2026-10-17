import type { Gate, Mode, Provenance, ServiceId } from '@adminforge/connectors';
import type { Requires } from '@adminforge/schemas';
import type { SessionRecord } from '../auth/session-store';
import type { WriteTarget } from './protected';

/**
 * Who an outbound call runs as.
 * - delegated: the signed-in engineer (Read app tokens, or Write app tokens while armed) — interactive work.
 * - automation: the app-only automation identity — unattended schedules on this host (ADR-011).
 */
export type ExecutionIdentity =
  { kind: 'delegated'; session: SessionRecord; mode: Mode } | { kind: 'automation'; mode: Mode };

/** A fully rendered call to a Microsoft API or a configured connection. Built only from published content. */
export interface ServiceCall {
  service: ServiceId;
  method: string;
  /** Relative to the service base. Graph paths exclude the version segment. */
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  body?: unknown;
  /** Graph: use /beta. */
  beta?: boolean;
  /** ARM: required api-version. */
  apiVersion?: string;
  /** function: connection key; path/method come from the connection's named operation. */
  connection?: string;
  /** Set only when published content declares this call `mode: write`. */
  declaredWrite?: boolean;
  /** Set only when a connection declares this POST operation read-only. */
  declaredRead?: boolean;
  /**
   * Set only by AdminForge's own notifier (delivery/notifier.ts) for its sendMail as the automation identity: a
   * message about AdminForge, not a change to the tenant, so the emergency stop doesn't hold it back.
   */
  notification?: boolean;
  /** Paging: `none` (single response), `all` (collect up to maxItems), or a cursor page. */
  paging?: 'none' | 'all' | { cursor?: string; pageSize?: number };
  maxItems?: number;

  // ── Additive (outbound.ts) ──────────────────────────────────────────────────
  /** function: named operation of the connection (falls back to `path` when it is a bare operation name). */
  operation?: string;
  /** function: values for `{name}` placeholders in the operation path. */
  pathParams?: Record<string, unknown>;
  /** ARM writes: wait for long-running operations (default true for non-GET). */
  poll?: boolean;
  pollTimeoutMs?: number;
  /** Provenance path template, e.g. "/users/{id}" (default: ids in `path` are replaced automatically). */
  pathTemplate?: string;
  /** The definition's requirements, used to name missing scopes/roles/licences in 403 hints. */
  requires?: Requires;
}

export interface ServiceCallResult<T = unknown> {
  data: T;
  status: number;
  provenance: Provenance;
  /** Opaque cursor for the next page when paging is a cursor. */
  nextCursor?: string;
  /**
   * `paging: all` stopped before the end (maxItems or the page limit), or a `$batch` collection answered with its
   * first page only: `data` holds part of the result.
   */
  truncated?: boolean;
}

/**
 * The one path every outbound call takes: request policy (ADR-003) → token for the identity/mode →
 * connector (or fixtures in DATA_MODE=fixtures) → normalised errors and provenance.
 * Implemented in ./outbound.ts; used by the datasource executor, the playbook engine, and the scheduler.
 */
export interface OutboundExecutor {
  execute<T = unknown>(
    identity: ExecutionIdentity,
    call: ServiceCall,
    opts?: { correlationId?: string; signal?: AbortSignal },
  ): Promise<ServiceCallResult<T>>;
  /**
   * Whether a declared write that doesn't go through `execute` (the PowerShell runner) may go ahead: refused while
   * changes are paused or when it names one of AdminForge's protected objects (./protected.ts).
   */
  assertWritable?(identity: ExecutionIdentity, targets: WriteTarget[], correlationId?: string): Promise<void>;
  /**
   * The executor's concurrency slot for one attempt of a call made with a connector directly (the overview's
   * `$batch`), so such calls share the same limits as everything else.
   */
  gate?(identity: ExecutionIdentity, service: ServiceId, signal?: AbortSignal): Gate;
}
