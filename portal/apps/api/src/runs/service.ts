import { randomUUID } from 'node:crypto';
import {
  checkDefinition,
  findStep,
  hasWriteSteps,
  isTerminal,
  redactInputs,
  stepIdOf,
  validateInputs,
  type AutomationDefinition,
  type InputIssue,
  type RunStatus,
  type RunStore,
} from '@adminforge/engine';
import { PORTAL_ROLES, type Kind, type PortalRole } from '@adminforge/schemas';
import type { AuditInput, AuditWriter } from '../audit/writer';
import { hasRole, requireRole } from '../auth/guards';
import { isArmed, type SessionRecord } from '../auth/session-store';
import type { DefinitionResolver } from '../definitions/types';
import { AppError } from '../errors';
import type { RunQueue } from './queue';
import { pinnedDefinition, rootOf } from './run-worker';
import { decisionOf } from './store';
import { RUN_STATUS_ACTIVE as NON_TERMINAL, type NewRun, type RunDetail, type RunRepository, type RunRow, type RunSummary, type TaskRow, type TaskView } from './types';
import { runPlan, runSummary, runView, stepView, taskView } from './views';

/** Who is calling (from the request's session). */
export interface Caller {
  session: SessionRecord;
  correlationId: string;
  ip: string | null;
}

export interface CreateRunInput {
  playbook: string;
  version?: string;
  inputs?: Record<string, unknown>;
  dryRun?: boolean;
}

export interface BulkRunInput {
  playbook: string;
  version?: string;
  /** Per-item inputs (merged over inputsTemplate). */
  items: Array<Record<string, unknown>>;
  /** Inputs shared by every item (plain data; never evaluated). */
  inputsTemplate?: Record<string, unknown>;
  dryRun?: boolean;
  concurrency?: number;
  stopOnError?: boolean;
}

export interface ScheduledRunInput {
  /** The schedule that fires the run (id from `schedules`, key, who created/approved it). */
  schedule: { id?: string | null; key: string; createdBy?: string | null; approvedBy?: string[] | null };
  /** Playbook key, or { ref, version }. */
  playbook: string | { ref: string; version?: string };
  inputs?: Record<string, unknown>;
  dryRun?: boolean;
  correlationId?: string;
}

export interface ListRunsInput {
  scope: 'mine' | 'all';
  statuses?: RunStatus[];
  definitionKey?: string;
  parentRunId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: string;
}

const SEES_ALL: PortalRole[] = ['Portal.Operator', 'Playbook.Approver', 'Portal.Admin'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hasAny = (s: SessionRecord, roles: readonly string[]) => roles.some((r) => s.roles.includes(r));
const describeIssues = (issues: InputIssue[], prefix = 'inputs') =>
  issues
    .slice(0, 10)
    .map((i) => `${prefix}${i.field ? `.${i.field}` : ''}: ${i.message}`)
    .join('; ') + (issues.length > 10 ? `; and ${issues.length - 10} more` : '');

export function encodeCursor(row: Pick<RunRow, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: string; i?: string };
    const createdAt = new Date(v.c ?? '');
    if (Number.isNaN(createdAt.getTime()) || !v.i || !UUID.test(v.i)) throw new Error('bad');
    return { createdAt, id: v.i };
  } catch {
    throw new AppError(400, 'invalid_request', 'The cursor is not valid.');
  }
}

/**
 * Runs as the API sees them (§4.3, §9): create (interactive, bulk, scheduled), read, cancel, human decisions, resume.
 * Execution happens in the worker; this service only writes rows, audits, and enqueues.
 */
export class RunService {
  constructor(
    private readonly deps: {
      repo: RunRepository;
      queue: RunQueue;
      store: RunStore;
      definitions: () => DefinitionResolver;
      audit: AuditWriter;
      env: () => Record<string, unknown>;
      now: () => Date;
    },
  ) {}

  // ── helpers ──

  private actor(caller: Caller): Omit<AuditInput, 'action' | 'result'> {
    return {
      actorOid: caller.session.userOid,
      actorUpn: caller.session.upn,
      sessionHash: caller.session.idHash,
      mode: isArmed(caller.session, this.deps.now()) ? 'write' : 'read',
      correlationId: caller.correlationId,
      ip: caller.ip,
    };
  }

  /** Latest (or exact) published playbook, falling back to a runbook with the same key. */
  async resolve(key: string, version?: string, kinds: ReadonlyArray<'playbook' | 'runbook'> = ['playbook', 'runbook']) {
    let last: unknown;
    for (const kind of kinds) {
      try {
        const r = await this.deps.definitions().resolve(kind as Kind, key, version);
        return { def: r.def as AutomationDefinition, version: r.version, sha256: r.sha256 };
      } catch (err) {
        if (!(err instanceof AppError) || err.status !== 404) throw err;
        last = err;
      }
    }
    throw last ?? new AppError(404, 'definition_not_found', `No published playbook "${key}".`);
  }

  private checkRunnable(def: AutomationDefinition) {
    if (def.status === 'retired') throw new AppError(409, 'definition_retired', `${def.title} is retired and can no longer run.`);
    const tooBig = checkDefinition(def);
    if (tooBig) throw new AppError(422, 'limit_exceeded', tooBig);
  }

  /** §5.3: any portal role may dry-run; executing a write playbook needs Portal.Operator plus the definition's roles. */
  authorize(session: SessionRecord, def: AutomationDefinition, dryRun: boolean) {
    if (!hasAny(session, PORTAL_ROLES)) throw new AppError(403, 'forbidden', 'Running playbooks needs a portal role.', { hint: 'Ask a portal administrator to add you to the Readers group.' });
    if (dryRun) return;
    if (def.mode === 'write' || hasWriteSteps(def)) requireRole(session, 'Portal.Operator', `Running ${def.title}`);
    for (const role of def.requires?.portalRoles ?? []) requireRole(session, role, `Running ${def.title}`);
  }

  private async validate(def: AutomationDefinition, inputs: unknown, prefix = 'inputs') {
    const v = await validateInputs(def.inputs, inputs ?? {}, { now: this.deps.now(), env: this.deps.env() });
    if (!v.ok) throw new AppError(400, 'invalid_inputs', `The inputs are not valid. ${describeIssues(v.errors, prefix)}`);
    return v.values;
  }

  canView(session: SessionRecord, row: RunRow): boolean {
    return row.initiatorOid === session.userOid || hasAny(session, SEES_ALL);
  }

  private async load(caller: Caller, id: string): Promise<RunRow> {
    const row = UUID.test(id) ? await this.deps.repo.getRun(id) : null;
    if (!row || !this.canView(caller.session, row)) throw new AppError(404, 'run_not_found', 'No such run.');
    return row;
  }

  private async enqueueRoot(row: RunRow) {
    const root = await rootOf(this.deps.repo, row);
    await this.deps.queue.enqueue(root.id);
  }

  private newRun(def: AutomationDefinition, pinned: { version: string; sha256: string }, fields: Pick<NewRun, 'dryRun' | 'trigger' | 'identity' | 'initiatorOid' | 'initiatorUpn' | 'sessionHash' | 'scheduleId' | 'inputs' | 'correlationId'>): NewRun {
    return { id: randomUUID(), kind: def.kind, definitionKey: def.id, definitionVersion: pinned.version, definitionSha256: pinned.sha256, parentRunId: null, ...fields };
  }

  // ── create ──

  async create(caller: Caller, input: CreateRunInput): Promise<RunRow> {
    const dryRun = input.dryRun === true;
    const pinned = await this.resolve(input.playbook, input.version);
    const def = pinned.def;
    this.checkRunnable(def);
    this.authorize(caller.session, def, dryRun);
    const inputs = await this.validate(def, input.inputs);
    const s = caller.session;
    const row = await this.deps.repo.insertRun(
      this.newRun(def, pinned, {
        dryRun,
        trigger: 'interactive',
        identity: 'delegated',
        initiatorOid: s.userOid,
        initiatorUpn: s.upn,
        sessionHash: s.idHash,
        scheduleId: null,
        inputs,
        correlationId: caller.correlationId,
      }),
    );
    await this.deps.audit.append({
      ...this.actor(caller),
      action: 'run.created',
      targetType: 'run',
      targetId: row.id,
      details: { definition: def.id, version: pinned.version, sha256: pinned.sha256, kind: def.kind, dryRun, trigger: 'interactive', risk: def.risk, inputs: redactInputs(def.inputs, inputs) },
      result: 'success',
    });
    await this.deps.queue.enqueue(row.id);
    return row;
  }

  /**
   * Bulk action: one parent run (trigger `bulk`) whose synthesised definition is a forEach over the items; each item
   * runs the target playbook as a child run. Every item is validated up front against the target's inputs.
   */
  async createBulk(caller: Caller, input: BulkRunInput): Promise<RunRow> {
    const dryRun = input.dryRun === true;
    const pinned = await this.resolve(input.playbook, input.version, ['playbook']);
    const def = pinned.def;
    this.checkRunnable(def);
    this.authorize(caller.session, def, dryRun);
    if (!input.items.length) throw new AppError(400, 'invalid_request', 'A bulk action needs at least one item.');
    if (input.items.length > 1000) throw new AppError(400, 'invalid_request', 'A bulk action takes at most 1000 items.');
    const items: Array<Record<string, unknown>> = [];
    const problems: string[] = [];
    for (const [i, item] of input.items.entries()) {
      const v = await validateInputs(def.inputs, { ...(input.inputsTemplate ?? {}), ...item }, { now: this.deps.now(), env: this.deps.env() });
      if (v.ok) items.push(v.values);
      else problems.push(describeIssues(v.errors, `items[${i}]`));
      if (problems.length >= 10) break;
    }
    if (problems.length) throw new AppError(400, 'invalid_inputs', `Some items are not valid. ${problems.join('; ')}`);
    const s = caller.session;
    const row = await this.deps.repo.insertRun(
      this.newRun(def, pinned, {
        dryRun,
        trigger: 'bulk',
        identity: 'delegated',
        initiatorOid: s.userOid,
        initiatorUpn: s.upn,
        sessionHash: s.idHash,
        scheduleId: null,
        inputs: { items, ...(input.concurrency ? { concurrency: input.concurrency } : {}), ...(input.stopOnError ? { stopOnError: true } : {}) },
        correlationId: caller.correlationId,
      }),
    );
    await this.deps.audit.append({
      ...this.actor(caller),
      action: 'run.created',
      targetType: 'run',
      targetId: row.id,
      details: { definition: def.id, version: pinned.version, sha256: pinned.sha256, kind: def.kind, dryRun, trigger: 'bulk', risk: def.risk, items: items.length },
      result: 'success',
    });
    await this.deps.queue.enqueue(row.id);
    return row;
  }

  /**
   * Called by the scheduler (R6, ADR-011): the run executes as the automation identity. Write-capable playbooks need
   * the schedule's two-person approval (`approvedBy`). Audited as "scheduled by X, executed as automation identity".
   */
  async createScheduledRun(input: ScheduledRunInput): Promise<RunRow> {
    const ref = typeof input.playbook === 'string' ? { ref: input.playbook } : input.playbook;
    const pinned = await this.resolve(ref.ref, ref.version);
    const def = pinned.def;
    this.checkRunnable(def);
    const dryRun = input.dryRun === true;
    const writes = def.mode === 'write' || hasWriteSteps(def);
    if (writes && !dryRun && !input.schedule.approvedBy?.length)
      throw new AppError(403, 'two_person_required', `Schedule ${input.schedule.key} runs a write playbook and needs a second person's approval before it can run.`);
    const inputs = await this.validate(def, input.inputs);
    const correlationId = input.correlationId ?? randomUUID();
    const row = await this.deps.repo.insertRun(
      this.newRun(def, pinned, {
        dryRun,
        trigger: 'schedule',
        identity: 'automation',
        initiatorOid: input.schedule.createdBy ?? null,
        initiatorUpn: null,
        sessionHash: null,
        scheduleId: input.schedule.id && UUID.test(input.schedule.id) ? input.schedule.id : null,
        inputs,
        correlationId,
      }),
    );
    await this.deps.audit.append({
      actorOid: 'automation',
      actorUpn: 'automation identity',
      mode: writes && !dryRun ? 'write' : 'read',
      action: 'run.created',
      targetType: 'run',
      targetId: row.id,
      details: {
        definition: def.id,
        version: pinned.version,
        sha256: pinned.sha256,
        dryRun,
        trigger: 'schedule',
        schedule: input.schedule.key,
        scheduledBy: input.schedule.createdBy ?? null,
        approvedBy: input.schedule.approvedBy ?? [],
        executedAs: 'automation identity',
        inputs: redactInputs(def.inputs, inputs),
      },
      result: 'success',
      correlationId,
    });
    await this.deps.queue.enqueue(row.id);
    return row;
  }

  // ── read ──

  private async titles(rows: RunRow[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const seen = new Map<string, Promise<string | undefined>>();
    for (const r of rows) {
      const k = `${r.kind}:${r.definitionKey}@${r.definitionVersion}`;
      if (!seen.has(k))
        seen.set(
          k,
          this.deps
            .definitions()
            .resolve(r.kind, r.definitionKey, r.definitionVersion)
            .then((d) => (d.def as { title?: string }).title)
            .catch(() => undefined),
        );
      const t = await seen.get(k)!;
      if (t) out.set(r.id, r.trigger === 'bulk' ? `${t} (bulk)` : t);
    }
    return out;
  }

  async list(caller: Caller, q: ListRunsInput): Promise<{ items: RunSummary[]; cursor?: string }> {
    if (q.scope === 'all' && !hasAny(caller.session, SEES_ALL)) throw new AppError(403, 'forbidden', 'Seeing everyone’s runs needs the Portal.Operator, Playbook.Approver or Portal.Admin role.');
    const rows = await this.deps.repo.listRuns({
      ...(q.scope === 'mine' ? { initiatorOid: caller.session.userOid } : {}),
      ...(q.statuses?.length ? { statuses: q.statuses } : {}),
      ...(q.definitionKey ? { definitionKey: q.definitionKey } : {}),
      ...(q.parentRunId ? { parentRunId: q.parentRunId } : {}),
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
      limit: q.limit + 1,
      ...(q.cursor ? { cursor: decodeCursor(q.cursor) } : {}),
    });
    const page = rows.slice(0, q.limit);
    const titles = await this.titles(page);
    return { items: page.map((r) => runSummary(r, titles.get(r.id))), ...(rows.length > q.limit ? { cursor: encodeCursor(page[page.length - 1]!) } : {}) };
  }

  async get(caller: Caller, id: string): Promise<RunDetail> {
    const row = await this.load(caller, id);
    const { repo } = this.deps;
    const [steps, tasks, children] = await Promise.all([repo.listSteps(id), repo.listTasks({ runId: id }), repo.listRuns({ parentRunId: id, limit: 1000 })]);
    let def: AutomationDefinition | null;
    let params: AutomationDefinition['inputs'];
    try {
      def = await pinnedDefinition(this.deps.definitions(), row);
      if (row.trigger === 'bulk') params = (await this.resolve(row.definitionKey, row.definitionVersion, ['playbook'])).def.inputs;
    } catch {
      def = null;
    }
    const titles = await this.titles(children);
    return {
      run: runView(row, def, steps, params),
      steps: steps.map(stepView),
      plan: runPlan(steps),
      tasks: tasks.map((t) => taskView(t, this.canDecide(caller.session, row, t))),
      children: children.map((c) => runSummary(c, titles.get(c.id))),
    };
  }

  /** Events after `afterId` (SSE replay). Access is checked by the caller via `load`. */
  async assertViewable(caller: Caller, id: string): Promise<RunRow> {
    return this.load(caller, id);
  }

  // ── control ──

  async cancel(caller: Caller, id: string): Promise<RunRow> {
    const row = await this.load(caller, id);
    if (row.initiatorOid !== caller.session.userOid && !hasRole(caller.session, 'Portal.Admin'))
      throw new AppError(403, 'forbidden', 'Only the engineer who started this run (or a Portal.Admin) can cancel it.');
    if (isTerminal(row.status)) throw new AppError(409, 'run_finished', `The run already ended (${row.status}).`);
    const now = this.deps.now();
    const tree = await this.deps.repo.runTree(row.id);
    let cancelled = 0;
    for (const r of tree) {
      if (isTerminal(r.status)) continue;
      const updated = await this.deps.store.updateRun(r.id, { status: 'cancelled', endedAt: now }, NON_TERMINAL);
      if (!updated) continue;
      cancelled++;
      await this.deps.store.appendEvent(r.id, { type: 'status', data: { scope: 'run', status: 'cancelled', by: caller.session.upn } });
      for (const t of await this.deps.repo.listTasks({ runId: r.id, status: 'pending' })) await this.deps.repo.updateTask(t.id, { status: 'cancelled', decidedAt: now }, 'pending');
    }
    await this.deps.audit.append({
      ...this.actor(caller),
      action: 'run.cancelled',
      targetType: 'run',
      targetId: row.id,
      details: { definition: row.definitionKey, version: row.definitionVersion, previousStatus: row.status, runsCancelled: cancelled },
      result: 'success',
    });
    // A cancelled child fails its parent's step; let the parent react.
    if (row.parentRunId) await this.enqueueRoot(row);
    return (await this.deps.repo.getRun(row.id))!;
  }

  async resume(caller: Caller, id: string): Promise<RunRow> {
    const row = await this.load(caller, id);
    const root = await rootOf(this.deps.repo, row);
    if (isTerminal(root.status)) throw new AppError(409, 'run_finished', `The run already ended (${root.status}).`);
    const oid = caller.session.userOid;
    const tree = await this.deps.repo.runTree(root.id);
    const tasks = await this.deps.repo.listTasks({ runIds: tree.map((r) => r.id) });
    const involved = tree.some((r) => r.initiatorOid === oid) || tasks.some((t) => t.decisions.some((d) => d.oid === oid));
    if (!involved && !hasRole(caller.session, 'Portal.Admin')) throw new AppError(403, 'forbidden', 'Only the engineers acting in this run (or a Portal.Admin) can resume it.');
    // ADR-010: steps run with the actor's *current* session; rebind it everywhere this user acts in the run tree.
    let rebound = 0;
    for (const r of tree) {
      if (r.identity !== 'delegated' || r.initiatorOid !== oid || r.sessionHash === caller.session.idHash) continue;
      await this.deps.repo.updateRun(r.id, { sessionHash: caller.session.idHash });
      rebound++;
    }
    for (const t of tasks) {
      if (!t.decisions.some((d) => d.oid === oid && d.sessionHash !== caller.session.idHash)) continue;
      await this.deps.repo.updateTask(t.id, { decisions: t.decisions.map((d) => (d.oid === oid ? { ...d, sessionHash: caller.session.idHash } : d)) });
      rebound++;
    }
    await this.deps.audit.append({
      ...this.actor(caller),
      action: 'run.resumed',
      targetType: 'run',
      targetId: root.id,
      details: { definition: root.definitionKey, version: root.definitionVersion, status: root.status, sessionsRebound: rebound },
      result: 'success',
    });
    await this.deps.queue.enqueue(root.id);
    return (await this.deps.repo.getRun(root.id))!;
  }

  // ── human tasks ──

  private canDecide(session: SessionRecord, run: RunRow, t: TaskRow): boolean {
    if (t.status !== 'pending' || isTerminal(run.status)) return false;
    if (t.decisions.some((d) => d.oid === session.userOid)) return false;
    if (t.policy.kind === 'manual') return run.initiatorOid === session.userOid || hasRole(session, 'Portal.Operator');
    return hasRole(session, 'Playbook.Approver') && hasAny(session, t.policy.approvers) && run.initiatorOid !== session.userOid && t.policy.initiatorOid !== session.userOid;
  }

  private async expire(t: TaskRow, run: RunRow): Promise<boolean> {
    if (t.status !== 'pending' || !t.expiresAt || t.expiresAt > this.deps.now()) return false;
    if (await this.deps.repo.updateTask(t.id, { status: 'expired', decidedAt: this.deps.now() }, 'pending')) await this.enqueueRoot(run);
    return true;
  }

  async decideApproval(caller: Caller, id: string, path: string, input: { decision: 'approve' | 'reject'; comment?: string }): Promise<{ status: TaskRow['status']; approvals: number; required: number }> {
    const s = caller.session;
    requireRole(s, 'Playbook.Approver', 'Approving runs');
    const row = await this.load(caller, id);
    const task = await this.deps.repo.getTask(id, path);
    if (!task || task.policy.kind !== 'approval') throw new AppError(404, 'approval_not_found', 'This run has no approval at that step.');
    if (isTerminal(row.status)) throw new AppError(409, 'run_finished', `The run already ended (${row.status}).`);
    if (await this.expire(task, row)) throw new AppError(409, 'approval_expired', 'This approval request has expired.');
    if (task.status !== 'pending') throw new AppError(409, 'already_decided', `This approval was already ${task.status}.`);
    const root = row.parentRunId ? await rootOf(this.deps.repo, row) : row;
    if ([row.initiatorOid, root.initiatorOid, task.policy.initiatorOid, task.requestedBy].includes(s.userOid))
      throw new AppError(403, 'own_run', 'You cannot approve a run you started.', { hint: 'Ask another approver.' });
    if (!hasAny(s, task.policy.approvers)) throw new AppError(403, 'forbidden', `This approval needs one of: ${task.policy.approvers.join(', ')}.`);
    if (task.decisions.some((d) => d.oid === s.userOid)) throw new AppError(409, 'already_decided', 'You already decided on this approval.');
    if (input.decision === 'approve' && task.policy.writesAfter && !row.dryRun && !isArmed(s, this.deps.now()))
      throw new AppError(403, 'not_armed', 'The steps after this approval change data and will run as you.', { hint: 'Arm write access, then approve.' });
    const decisions = [...task.decisions, { oid: s.userOid, upn: s.upn, decision: input.decision, comment: input.comment ?? null, sessionHash: s.idHash, at: this.deps.now().toISOString() }];
    const approvals = decisions.filter((d) => d.decision === 'approve').length;
    const required = task.policy.minApprovals ?? 1;
    const status: TaskRow['status'] = input.decision === 'reject' ? 'rejected' : approvals >= required ? 'approved' : 'pending';
    const updated = await this.deps.repo.updateTask(task.id, { decisions, status, decidedAt: status === 'pending' ? null : this.deps.now() }, 'pending');
    if (!updated) throw new AppError(409, 'already_decided', 'Someone else decided on this approval at the same time.');
    await this.deps.audit.append({
      ...this.actor(caller),
      action: input.decision === 'approve' ? 'run.approved' : 'run.rejected',
      targetType: 'run',
      targetId: id,
      details: { definition: row.definitionKey, version: row.definitionVersion, step: path, comment: input.comment ?? null, approvals, required, final: status !== 'pending' },
      result: 'success',
    });
    await this.deps.store.appendEvent(id, {
      type: 'log',
      level: 'info',
      data: { message: `${input.decision === 'approve' ? 'Approved' : 'Rejected'} by ${s.upn}${input.comment ? `: ${input.comment}` : ''}`, path, decision: input.decision },
    });
    if (status !== 'pending') await this.enqueueRoot(row);
    return { status, approvals, required };
  }

  async confirmManual(caller: Caller, id: string, path: string, input: { confirmed: boolean; notes?: string; values?: Record<string, unknown> }): Promise<{ status: TaskRow['status'] }> {
    const s = caller.session;
    const row = await this.load(caller, id);
    const task = await this.deps.repo.getTask(id, path);
    if (!task || task.policy.kind !== 'manual') throw new AppError(404, 'task_not_found', 'This run has no manual step there.');
    if (isTerminal(row.status)) throw new AppError(409, 'run_finished', `The run already ended (${row.status}).`);
    if (task.status !== 'pending') throw new AppError(409, 'already_decided', `This step was already ${task.status === 'approved' ? 'confirmed' : task.status}.`);
    if (row.initiatorOid !== s.userOid && !hasRole(s, 'Portal.Operator')) throw new AppError(403, 'forbidden', 'Only the engineer running this (or a Portal.Operator) can confirm its steps.');
    let values: Record<string, unknown> = {};
    if (input.confirmed) {
      const def = await pinnedDefinition(this.deps.definitions(), row).catch(() => null);
      const step = def ? findStep(def, stepIdOf(path)) : undefined;
      const params = step?.type === 'manual' ? step.inputs : undefined;
      if (params || input.values) {
        const v = await validateInputs(params, input.values ?? {}, { now: this.deps.now(), env: this.deps.env() });
        if (!v.ok) throw new AppError(400, 'invalid_inputs', `The values are not valid. ${describeIssues(v.errors, 'values')}`);
        values = v.values;
      }
    }
    const decisions = [
      ...task.decisions,
      { oid: s.userOid, upn: s.upn, decision: input.confirmed ? ('confirm' as const) : ('decline' as const), comment: input.notes ?? null, values, sessionHash: s.idHash, at: this.deps.now().toISOString() },
    ];
    const status = input.confirmed ? 'approved' : 'rejected';
    const updated = await this.deps.repo.updateTask(task.id, { decisions, status, decidedAt: this.deps.now() }, 'pending');
    if (!updated) throw new AppError(409, 'already_decided', 'Someone else answered this step at the same time.');
    await this.deps.audit.append({
      ...this.actor(caller),
      action: input.confirmed ? 'run.manual.confirmed' : 'run.manual.declined',
      targetType: 'run',
      targetId: id,
      details: { definition: row.definitionKey, version: row.definitionVersion, step: path, notes: input.notes ?? null },
      result: 'success',
    });
    await this.deps.store.appendEvent(id, { type: 'log', level: 'info', data: { message: `${input.confirmed ? 'Confirmed' : 'Declined'} by ${s.upn}${input.notes ? `: ${input.notes}` : ''}`, path } });
    await this.enqueueRoot(row);
    return { status };
  }

  /** Approver inbox: approval tasks the caller may act on (or has acted on). */
  async listApprovals(caller: Caller, q: { status?: TaskRow['status'] }): Promise<{ items: TaskView[] }> {
    const s = caller.session;
    requireRole(s, 'Playbook.Approver', 'The approval inbox');
    const tasks = await this.deps.repo.listTasks({ kind: 'approval', ...(q.status ? { status: q.status } : {}) });
    const items: TaskView[] = [];
    for (const t of tasks) {
      if (t.policy.kind !== 'approval' || !hasAny(s, t.policy.approvers)) continue;
      const run = await this.deps.repo.getRun(t.subjectId);
      if (!run) continue;
      if (await this.expire(t, run)) {
        if (q.status === 'pending') continue;
        t.status = 'expired';
      }
      if (q.status === 'pending' && isTerminal(run.status)) continue;
      items.push(taskView(t, this.canDecide(s, run, t)));
    }
    return { items };
  }

  /** The engine's view of a task decision (exposed for tests/tools). */
  decisionOf = decisionOf;
}

