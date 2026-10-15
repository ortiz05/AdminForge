import { queryOptions } from '@tanstack/react-query';
import { api } from '../lib/api';
import { bool, listOf, num, parser, pick, query, rec } from '../runs/json';

/**
 * GET /api/audit?actor=&action=&from=&to=&cursor= → { items: AuditEvent[], cursor? }   (Portal.Admin)
 * GET /api/audit/verify                          → { ok, checked, brokenAt? }
 */

export interface AuditEvent {
  seq: number;
  ts: string;
  actorUpn: string | null;
  mode: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  result: string;
  correlationId: string | null;
  details: unknown;
}

export function readAuditEvent(raw: unknown): AuditEvent | null {
  const o = rec(raw);
  const seq = num(o.seq) ?? (typeof o.seq === 'string' && /^\d+$/.test(o.seq) ? Number(o.seq) : undefined);
  const ts = pick(o, 'ts');
  const action = pick(o, 'action');
  if (seq === undefined || !ts || !action) return null;
  return {
    seq,
    ts,
    actorUpn: pick(o, 'actorUpn') ?? null,
    mode: pick(o, 'mode') ?? null,
    action,
    targetType: pick(o, 'targetType') ?? null,
    targetId: pick(o, 'targetId') ?? null,
    result: pick(o, 'result') ?? 'unknown',
    correlationId: pick(o, 'correlationId') ?? null,
    details: o.details ?? null,
  };
}

export interface AuditFilter {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
}

export const auditPage = (f: AuditFilter, cursor: string | null, signal?: AbortSignal) =>
  api(`/api/audit${query({ actor: f.actor, action: f.action, from: f.from, to: f.to, cursor })}`, {
    schema: listOf(readAuditEvent),
    signal,
  });

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // Neutralise spreadsheet formulas, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** CSV of the events loaded so far (the server applies the filters; the API has no export endpoint yet). */
export function auditCsv(events: AuditEvent[]): string {
  const head = ['seq', 'ts', 'actorUpn', 'mode', 'action', 'targetType', 'targetId', 'result', 'correlationId', 'details'];
  const rows = events.map((e) => [e.seq, e.ts, e.actorUpn, e.mode, e.action, e.targetType, e.targetId, e.result, e.correlationId, e.details].map(csvCell).join(','));
  return [head.join(','), ...rows].join('\r\n');
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenAt: number | null;
}

export const auditVerifyQuery = queryOptions({
  queryKey: ['audit', 'verify'] as const,
  queryFn: ({ signal }) =>
    api('/api/audit/verify', {
      signal,
      schema: parser((input): ChainVerification => {
        const o = rec(input);
        const ok = bool(o.ok);
        if (ok === undefined) throw new TypeError('Expected { ok }');
        return { ok, checked: num(o.checked) ?? 0, brokenAt: num(o.brokenAt) ?? null };
      }),
    }),
  staleTime: 5 * 60_000,
  retry: false,
});

/** Results in the audit log: success / failure / denied, or anything else as-is. */
export function resultTone(result: string): 'ok' | 'crit' | 'warn' | 'neutral' {
  const r = result.toLowerCase();
  if (['success', 'succeeded', 'ok', 'allowed'].includes(r)) return 'ok';
  if (['failure', 'failed', 'error'].includes(r)) return 'crit';
  if (['denied', 'forbidden', 'rejected', 'blocked'].includes(r)) return 'warn';
  return 'neutral';
}
