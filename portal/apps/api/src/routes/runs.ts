import { RUN_STATUSES, type RunStatus } from '@adminforge/engine';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireSession } from '../auth/guards';
import type { AppContext } from '../context';
import { AppError, parseBody } from '../errors';
import type { RunsModule } from '../runs/module';
import type { Caller } from '../runs/service';
import { streamRunEvents } from '../runs/sse';
import { RUN_STATUS_ACTIVE } from '../runs/types';
import { assertCsrf } from '../security/csrf';

/**
 * Runs API (§9). Request/response shapes:
 * - POST /api/runs {playbook, version?, inputs, dryRun, previewRunId?, confirmation?} → 202 {runId, status}
 * - POST /api/runs/bulk {playbook, version?, items: object[], inputsTemplate?, dryRun?, concurrency?, stopOnError?, previewRunId?, confirmation?} → 202 {runId, status, items}
 *   Executing (dryRun: false) a playbook with a `confirm` block needs `previewRunId` — a succeeded dry run by the same
 *   person of the same definition version with identical inputs/items, ≤ 15 min old (409 preview_required /
 *   preview_stale) — and for `confirm.type: typed` the `confirmation` text (bulk: the number of items), compared
 *   trimmed and case-insensitive (422 confirmation_mismatch; the expected value is never returned).
 * - GET  /api/runs?scope=mine|all&status=active|<s>,<s>&playbook=&from=&to=&parent=&limit=&cursor= → {items: RunSummary[], cursor?}
 * - GET  /api/runs/:id → {run, steps, plan, tasks, children}
 * - GET  /api/runs/:id/events (SSE, Last-Event-ID) → data {id, type:'run'|'step'|'log'|'progress', ts, stepSeq, data}; `event: end` when finished
 * - POST /api/runs/:id/cancel → {runId, status}
 * - POST /api/runs/:id/resume → 202 {runId, status}
 * - POST /api/runs/:id/approvals/:stepId {decision:'approve'|'reject', comment?} → {status, approvals, required}
 * - POST /api/runs/:id/manual/:stepId {confirmed, notes?, values?} → {status}
 * - GET  /api/runs/:id/secret/:stepPath (+ X-AdminForge-CSRF) → {type:'secret', runId, stepId, stepPath, values, hints, producedAt}
 *   once, for the initiator's session, within 5 minutes; 404 secret_not_available otherwise
 * `:stepId` is the step path (URL-encoded), e.g. `approve`, `loop[2].approve`, `$approval` (implicit gate).
 */

const Key = z.string().trim().min(1).max(200);
const Version = z.string().trim().min(1).max(64);
const Inputs = z.record(z.string(), z.unknown());

/** "Preview then confirm": required for executions of playbooks with a confirm block (see RunService). */
const Confirmation = { previewRunId: z.uuid().optional(), confirmation: z.string().max(500).optional() };

export const CreateRunBody = z.object({ playbook: Key, version: Version.optional(), inputs: Inputs.default({}), dryRun: z.boolean().default(false), ...Confirmation });
export const BulkRunBody = z.object({
  playbook: Key,
  version: Version.optional(),
  items: z.array(Inputs).min(1).max(1000),
  inputsTemplate: Inputs.default({}),
  dryRun: z.boolean().default(false),
  concurrency: z.number().int().min(1).max(10).optional(),
  stopOnError: z.boolean().optional(),
  ...Confirmation,
});
export const ApprovalBody = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().trim().max(2000).optional() });
export const ManualBody = z.object({ confirmed: z.boolean(), notes: z.string().trim().max(4000).optional(), values: Inputs.optional() });

const DateParam = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Expected an ISO date')
  .transform((s) => new Date(s));
const ListQuery = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  status: z.string().max(400).optional(),
  playbook: Key.optional(),
  parent: z.uuid().optional(),
  from: DateParam.optional(),
  to: DateParam.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(400).optional(),
});

function parseQuery<T extends z.ZodType>(schema: T, query: unknown): z.infer<T> {
  const r = schema.safeParse(query ?? {});
  if (!r.success) throw new AppError(400, 'invalid_request', `The query is not valid. ${r.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; ')}`);
  return r.data;
}

function statuses(raw: string | undefined): RunStatus[] | undefined {
  if (!raw) return undefined;
  const out = new Set<RunStatus>();
  for (const s of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (s === 'active') RUN_STATUS_ACTIVE.forEach((x) => out.add(x));
    else if ((RUN_STATUSES as readonly string[]).includes(s)) out.add(s as RunStatus);
    else throw new AppError(400, 'invalid_request', `Unknown run status "${s}".`);
  }
  return [...out];
}

export const callerOf = (request: FastifyRequest): Caller => ({ session: requireSession(request), correlationId: request.id, ip: request.ip ?? null });

export function runRoutes(api: FastifyInstance, _ctx: AppContext, runs: RunsModule) {
  const { service } = runs;

  api.post('/runs', async (request, reply) => {
    const row = await service.create(callerOf(request), parseBody(CreateRunBody, request.body));
    return reply.status(202).send({ runId: row.id, status: row.status });
  });

  api.post('/runs/bulk', async (request, reply) => {
    const body = parseBody(BulkRunBody, request.body);
    const row = await service.createBulk(callerOf(request), body);
    return reply.status(202).send({ runId: row.id, status: row.status, items: body.items.length });
  });

  api.get('/runs', async (request) => {
    const q = parseQuery(ListQuery, request.query);
    return service.list(callerOf(request), {
      scope: q.scope,
      ...(q.status ? { statuses: statuses(q.status) } : {}),
      ...(q.playbook ? { definitionKey: q.playbook } : {}),
      ...(q.parent ? { parentRunId: q.parent } : {}),
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
  });

  api.get<{ Params: { id: string } }>('/runs/:id', async (request) => service.get(callerOf(request), request.params.id));

  api.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>('/runs/:id/events', async (request, reply) => {
    const row = await service.assertViewable(callerOf(request), request.params.id);
    const header = request.headers['last-event-id'];
    const raw = (Array.isArray(header) ? header[0] : header) ?? request.query.lastEventId ?? '0';
    const last = /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
    await streamRunEvents(request, reply, runs, row.id, last);
  });

  // Show-once secret that was not delivered live: the first fetch by the initiator's session takes it. Consuming, so
  // the CSRF header is required even on GET (a cross-site navigation must not burn it).
  api.get<{ Params: { id: string; stepPath: string } }>('/runs/:id/secret/:stepPath', async (request) => {
    assertCsrf(request);
    const caller = callerOf(request);
    const row = await service.assertViewable(caller, request.params.id);
    const secret = await runs.secrets.claim(row.id, request.params.stepPath, caller.session.idHash);
    if (!secret)
      throw new AppError(404, 'secret_not_available', 'This secret is not available: it was already shown, it expired (5 minutes), or it belongs to another session.', {
        hint: 'Secrets are shown once to the person who started the run. Run the playbook again to get a new one.',
      });
    return secret;
  });

  api.post<{ Params: { id: string } }>('/runs/:id/cancel', async (request) => {
    const row = await service.cancel(callerOf(request), request.params.id);
    return { runId: row.id, status: row.status };
  });

  api.post<{ Params: { id: string } }>('/runs/:id/resume', async (request, reply) => {
    const row = await service.resume(callerOf(request), request.params.id);
    return reply.status(202).send({ runId: row.id, status: row.status });
  });

  api.post<{ Params: { id: string; stepId: string } }>('/runs/:id/approvals/:stepId', async (request) =>
    service.decideApproval(callerOf(request), request.params.id, request.params.stepId, parseBody(ApprovalBody, request.body)),
  );

  api.post<{ Params: { id: string; stepId: string } }>('/runs/:id/manual/:stepId', async (request) =>
    service.confirmManual(callerOf(request), request.params.id, request.params.stepId, parseBody(ManualBody, request.body)),
  );
}
