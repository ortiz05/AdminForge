import type { Mode, Provenance, ServiceId } from '@adminforge/connectors';
import type { SessionRecord } from '../auth/session-store';

/**
 * Who an outbound call runs as.
 * - delegated: the signed-in engineer (Read app tokens, or Write app tokens while armed) — interactive work.
 * - automation: the app-only automation identity — unattended schedules on this host (ADR-011).
 */
export type ExecutionIdentity =
  | { kind: 'delegated'; session: SessionRecord; mode: Mode }
  | { kind: 'automation'; mode: Mode };

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
  /** Paging: `none` (single response), `all` (collect up to maxItems), or a cursor page. */
  paging?: 'none' | 'all' | { cursor?: string; pageSize?: number };
  maxItems?: number;
}

export interface ServiceCallResult<T = unknown> {
  data: T;
  status: number;
  provenance: Provenance;
  /** Opaque cursor for the next page when paging is a cursor. */
  nextCursor?: string;
}

/**
 * The one path every outbound call takes: request policy (ADR-003) → token for the identity/mode →
 * connector (or fixtures in DATA_MODE=fixtures) → normalised errors and provenance.
 * Implemented in ./outbound.ts; used by the datasource executor, the playbook engine, and the scheduler.
 */
export interface OutboundExecutor {
  execute<T = unknown>(identity: ExecutionIdentity, call: ServiceCall, opts?: { correlationId?: string; signal?: AbortSignal }): Promise<ServiceCallResult<T>>;
}
