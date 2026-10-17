import { createHash } from 'node:crypto';
import type { Provenance } from '@adminforge/connectors';
import { KqlSource } from '@adminforge/schemas';
import { z } from 'zod';
import type { AuditInput, AuditWriter } from '../audit/writer';
import { requireRole } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import { outboundAppError } from '../execution/outbound';
import type { OutboundExecutor } from '../execution/types';
import { runKql, type KqlColumn } from '../probes/kql';
import { requireQuerySource } from './sources';

/**
 * Query Studio backend (R12): ad-hoc KQL against Resource Graph, Log Analytics or advanced hunting, run with the
 * signed-in engineer's **delegated read** identity (the read-mode request policy allows exactly these read POSTs).
 * At most 5000 rows come back. Every query is audited with its sha256 and first 200 characters.
 */

export const QUERY_MAX_ROWS = 5000;
const GUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Expected a GUID');
const ISO_DURATION = z
  .string()
  .regex(
    /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/,
    'Expected an ISO 8601 duration like PT1H or P7D',
  );

export const QueryRequest = z
  .object({
    source: KqlSource,
    query: z.string().trim().min(1).max(100_000),
    subscriptions: z.array(GUID).max(1000).optional(),
    managementGroups: z.array(z.string().min(1).max(90)).max(100).optional(),
    /** Log Analytics workspace (customer) id; default AF_LOG_ANALYTICS_WORKSPACE_ID. */
    workspace: GUID.optional(),
    timespan: ISO_DURATION.optional(),
  })
  .superRefine((b, ctx) => {
    if ((b.subscriptions?.length || b.managementGroups?.length) && b.source !== 'resourceGraph')
      ctx.addIssue({
        code: 'custom',
        path: ['subscriptions'],
        message: 'subscriptions and managementGroups apply to resourceGraph only',
      });
    if (b.workspace && b.source !== 'logAnalytics')
      ctx.addIssue({
        code: 'custom',
        path: ['workspace'],
        message: 'workspace applies to logAnalytics only',
      });
  });
export type QueryRequest = z.infer<typeof QueryRequest>;

export interface QueryResponse {
  columns: KqlColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  ms: number;
  provenance: Provenance;
}

export interface QueryCaller {
  session: SessionRecord;
  correlationId: string;
  ip: string | null;
}

export const queryHash = (q: string) => createHash('sha256').update(q, 'utf8').digest('hex');

export class QueryService {
  constructor(
    private readonly deps: {
      outbound: OutboundExecutor;
      audit: AuditWriter;
      env: () => Record<string, unknown>;
      /** Sources this installation offers (AF_QUERY_SOURCES); required, so a new caller can't fail open. */
      sources: readonly KqlSource[];
    },
  ) {}

  private actor(c: QueryCaller): Omit<AuditInput, 'action' | 'result'> {
    return {
      actorOid: c.session.userOid,
      actorUpn: c.session.upn,
      sessionHash: c.session.idHash,
      mode: 'read',
      correlationId: c.correlationId,
      ip: c.ip,
    };
  }

  async run(c: QueryCaller, body: QueryRequest, signal?: AbortSignal): Promise<QueryResponse> {
    requireRole(c.session, 'Portal.Reader', 'Query Studio');
    // A source switched off for this installation is refused before anything is sent (or audited as a query).
    requireQuerySource(this.deps.sources, body.source);
    const started = performance.now();
    const workspace =
      body.source === 'logAnalytics'
        ? (body.workspace ?? String(this.deps.env().AF_LOG_ANALYTICS_WORKSPACE_ID ?? ''))
        : undefined;
    const audit = (result: 'success' | 'failure', details: Record<string, unknown>) =>
      this.deps.audit.append({
        ...this.actor(c),
        action: 'query.executed',
        targetType: 'kql',
        targetId: body.source,
        result,
        details: {
          source: body.source,
          queryHash: queryHash(body.query),
          queryPreview: body.query.slice(0, 200),
          queryLength: body.query.length,
          ...(workspace ? { workspace } : {}),
          ...(body.subscriptions?.length ? { subscriptions: body.subscriptions.length } : {}),
          ...(body.timespan ? { timespan: body.timespan } : {}),
          ...details,
        },
      });
    try {
      const r = await runKql(
        { kind: 'delegated', session: c.session, mode: 'read' },
        this.deps.outbound,
        {
          source: body.source,
          query: body.query,
          subscriptions: body.subscriptions,
          managementGroups: body.managementGroups,
          workspace,
          timespan: body.timespan ?? (body.source === 'logAnalytics' ? 'P1D' : undefined),
          maxRows: QUERY_MAX_ROWS,
        },
        { correlationId: c.correlationId, signal },
      );
      const ms = Math.round(performance.now() - started);
      await audit('success', { rowCount: r.rows.length, totalRows: r.totalRows, truncated: r.truncated, ms });
      return {
        columns: r.columns,
        rows: r.rows,
        rowCount: r.rows.length,
        truncated: r.truncated,
        ms,
        provenance: r.provenance,
      };
    } catch (err) {
      const e = outboundAppError(err);
      await audit('failure', { error: e.code, ms: Math.round(performance.now() - started) }).catch(
        () => undefined,
      );
      throw e;
    }
  }
}
