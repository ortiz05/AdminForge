import { isWriteCapable, type Schedule } from '@adminforge/schemas';
import type { AuditInput, AuditWriter } from '../audit/writer';
import { hasRole, requireRole } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import type { ArtifactStore, OpenedArtifact } from '../artifacts/store';
import type { DefinitionSource } from '../definitions/types';
import { AppError } from '../errors';
import { describeCron, nextRun } from './cron';
import type { ScheduleEvents } from './events';
import type { ScheduleStore } from './store';
import { contentSchedules, contentSignature, syncSchedules } from './sync';
import type {
  ApprovalStatus,
  RunCursor,
  ScheduleApprovalPolicy,
  ScheduleApprovalRow,
  ScheduleRow,
  ScheduleRunRow,
} from './types';

/**
 * Schedules as the API sees them (R6): list, enable/disable (two-person approval for write-capable schedules),
 * run now, history, report downloads, and the schedule side of the approvals inbox. Execution is the scheduler's job;
 * this service only writes rows, audits, and wakes the scheduler (`schedule.run_requested`).
 */

export interface Caller {
  session: SessionRecord;
  correlationId: string;
  ip: string | null;
}

export interface ScheduleItem {
  key: string;
  title: string;
  summary: string | null;
  cron: string;
  cronText: string | null;
  timezone: string;
  enabled: boolean;
  identity: 'automation';
  job: { kind: Schedule['job']['kind']; ref?: string; refs?: string[]; select?: { tags: string[] } };
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  writeCapable: boolean;
  approvedBy?: string[];
  source: 'content' | 'portal';
  /** Set while an enable request waits for its second approver. */
  pendingApprovalId: string | null;
}

export interface ScheduleRunItem {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  runId?: string;
  artifact?: { name: string; href: string; size: number | null };
  error?: { code: string; message: string; hint?: string };
}

/** Schedule approvals in the inbox shape the web UI reads (same as run TaskViews, subjectType 'schedule'). */
export interface ScheduleApprovalView {
  id: string;
  subjectType: 'schedule';
  subjectId: string;
  stepId: null;
  kind: 'approval';
  title: string;
  status: ApprovalStatus;
  requestedBy: string;
  requestedByOid: string;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  scheduleKey: string;
  policy: Omit<ScheduleApprovalPolicy, 'initiatorOid'>;
  decisions: ScheduleApprovalRow['decisions'];
  canDecide: boolean;
}

export const APPROVAL_TTL_MS = 7 * 86_400_000;
const APPROVERS = ['Playbook.Approver'];
const INACTIVE = new Set(['draft', 'retired']);

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function encodeRunCursor(r: Pick<ScheduleRunRow, 'startedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ s: r.startedAt.toISOString(), i: r.id }), 'utf8').toString('base64url');
}

export function decodeRunCursor(cursor: string): RunCursor {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: string; i?: string };
    const startedAt = new Date(v.s ?? '');
    if (Number.isNaN(startedAt.getTime()) || !v.i || !/^[0-9a-f-]{36}$/i.test(v.i)) throw new Error('bad');
    return { startedAt, id: v.i };
  } catch {
    throw new AppError(400, 'invalid_request', 'The cursor is not valid.');
  }
}

export class ScheduleService {
  private signature = '';

  constructor(
    private readonly deps: {
      store: ScheduleStore;
      definitions: Pick<DefinitionSource, 'list'>;
      audit: AuditWriter;
      events: ScheduleEvents;
      artifacts: ArtifactStore;
      now: () => Date;
    },
  ) {}

  private actor(c: Caller): Omit<AuditInput, 'action' | 'result'> {
    return {
      actorOid: c.session.userOid,
      actorUpn: c.session.upn,
      sessionHash: c.session.idHash,
      mode: 'read',
      correlationId: c.correlationId,
      ip: c.ip,
    };
  }

  /** Content → store (only when the content schedules changed since the last sync in this process). Returns the content keys. */
  async ensureSynced(): Promise<Set<string>> {
    const content = await contentSchedules(this.deps.definitions);
    const sig = contentSignature(content);
    if (sig !== this.signature) {
      await syncSchedules(this.deps.store, content, this.deps.now());
      this.signature = sig;
    }
    return new Set(content.map((c) => c.key));
  }

  private async row(key: string): Promise<{ row: ScheduleRow; inContent: boolean }> {
    const keys = await this.ensureSynced();
    const row = await this.deps.store.getSchedule(key);
    if (!row || (row.source === 'content' && !keys.has(key)))
      throw new AppError(404, 'schedule_not_found', `No schedule "${key}".`);
    return { row, inContent: keys.has(key) };
  }

  private nextFor(row: ScheduleRow, now: Date): Date | null {
    if (!row.enabled) return null;
    if (row.nextRunAt && row.nextRunAt.getTime() > now.getTime()) return row.nextRunAt;
    try {
      return nextRun(row.definition.cron, row.definition.timezone, now);
    } catch {
      return null;
    }
  }

  /** Expires pending approvals past their deadline; returns the still-pending ones. */
  private async pendingApprovals(): Promise<ScheduleApprovalRow[]> {
    const now = this.deps.now();
    const out: ScheduleApprovalRow[] = [];
    for (const a of await this.deps.store.listApprovals({ status: 'pending' })) {
      if (a.expiresAt && a.expiresAt.getTime() <= now.getTime())
        await this.deps.store.updateApproval(a.id, { status: 'expired', decidedAt: now }, 'pending');
      else out.push(a);
    }
    return out;
  }

  item(row: ScheduleRow, pendingApprovalId: string | null, now: Date): ScheduleItem {
    const def = row.definition;
    const job = def.job;
    return {
      key: row.key,
      title: def.title,
      summary: def.summary ?? null,
      cron: def.cron,
      cronText: describeCron(def.cron),
      timezone: def.timezone,
      enabled: row.enabled,
      identity: 'automation',
      job: {
        kind: job.kind,
        ...('ref' in job && job.ref ? { ref: job.ref } : {}),
        ...(job.kind === 'probe' && job.refs ? { refs: job.refs } : {}),
        ...(job.kind === 'probe' && job.select ? { select: { tags: job.select.tags } } : {}),
      },
      nextRunAt: iso(this.nextFor(row, now)),
      lastRunAt: iso(row.lastRunAt),
      lastStatus: row.lastStatus,
      writeCapable: isWriteCapable(def),
      ...(row.approvedBy ? { approvedBy: [row.approvedBy] } : {}),
      source: row.source,
      pendingApprovalId,
    };
  }

  async list(): Promise<{ items: ScheduleItem[] }> {
    const keys = await this.ensureSynced();
    const now = this.deps.now();
    const pending = new Map((await this.pendingApprovals()).map((a) => [a.subjectId, a.id]));
    const rows = (await this.deps.store.listSchedules()).filter(
      (r) => r.source === 'portal' || keys.has(r.key),
    );
    return { items: rows.map((r) => this.item(r, pending.get(r.key) ?? null, now)) };
  }

  async get(key: string): Promise<ScheduleItem> {
    const { row } = await this.row(key);
    const pending = (await this.pendingApprovals()).find((a) => a.subjectId === key);
    return this.item(row, pending?.id ?? null, this.deps.now());
  }

  /** PATCH { enabled }: 200 when done; 202 { approvalId } when a write-capable schedule needs a second person. */
  async setEnabled(
    c: Caller,
    key: string,
    enabled: boolean,
  ): Promise<{ statusCode: 200 | 202; body: Record<string, unknown> }> {
    requireRole(c.session, 'Portal.Operator', 'Enabling or disabling schedules');
    const { row } = await this.row(key);
    const def = row.definition;
    const now = this.deps.now();
    if (!enabled) {
      if (row.enabled || row.approvedBy)
        await this.deps.store.updateSchedule(row.id, { enabled: false, nextRunAt: null, approvedBy: null });
      for (const a of (await this.deps.store.listApprovals({ status: 'pending', subjectId: key })).filter(
        (x) => x.subjectId === key,
      ))
        await this.deps.store.updateApproval(a.id, { status: 'cancelled', decidedAt: now }, 'pending');
      await this.deps.audit.append({
        ...this.actor(c),
        action: 'schedule.disabled',
        targetType: 'schedule',
        targetId: key,
        result: 'success',
        details: { version: def.version, sha256: row.sha256, wasEnabled: row.enabled },
      });
      this.changed(key);
      return { statusCode: 200, body: { key, enabled: false } };
    }
    if (INACTIVE.has(def.status ?? 'active'))
      throw new AppError(
        409,
        'schedule_inactive',
        `Schedule ${key} is ${def.status}; it cannot be enabled.`,
        { hint: 'Set its status to active in content and publish it first.' },
      );
    if (row.enabled) return { statusCode: 200, body: { key, enabled: true } };
    if (isWriteCapable(def)) {
      const existing = (await this.pendingApprovals()).find(
        (a) => a.subjectId === key && a.policy.sha256 === row.sha256,
      );
      if (existing) return { statusCode: 202, body: { approvalId: existing.id } };
      const policy: ScheduleApprovalPolicy = {
        kind: 'approval',
        action: 'enable',
        approvers: APPROVERS,
        minApprovals: 1,
        title: `Enable schedule: ${def.title}`,
        message: `${c.session.upn} asks to enable "${def.title}", which runs a ${def.job.kind} job that changes data (${def.cron} ${def.timezone}) as the automation identity. A second person must approve.`,
        definitionKey: key,
        definitionVersion: def.version,
        sha256: row.sha256,
        requestedByUpn: c.session.upn,
        initiatorOid: c.session.userOid,
        writesAfter: false,
      };
      const a = await this.deps.store.insertApproval({
        subjectId: key,
        policy,
        requestedBy: c.session.userOid,
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
      });
      await this.deps.audit.append({
        ...this.actor(c),
        action: 'schedule.enable_requested',
        targetType: 'schedule',
        targetId: key,
        result: 'success',
        details: { approvalId: a.id, version: def.version, sha256: row.sha256, job: def.job.kind },
      });
      return { statusCode: 202, body: { approvalId: a.id } };
    }
    await this.deps.store.updateSchedule(row.id, {
      enabled: true,
      nextRunAt: nextRun(def.cron, def.timezone, now),
    });
    await this.deps.audit.append({
      ...this.actor(c),
      action: 'schedule.enabled',
      targetType: 'schedule',
      targetId: key,
      result: 'success',
      details: { version: def.version, sha256: row.sha256 },
    });
    this.changed(key);
    return { statusCode: 200, body: { key, enabled: true } };
  }

  private changed(key: string) {
    this.deps.events.publish({ type: 'schedules.changed', data: { key } });
    this.deps.events.publish({ type: 'schedule.updated', data: { key } });
  }

  /** POST /run: queues a manual run for the scheduler. */
  async runNow(c: Caller, key: string): Promise<{ scheduleRunId: string }> {
    requireRole(c.session, 'Portal.Operator', 'Running schedules');
    const { row } = await this.row(key);
    const def = row.definition;
    if (isWriteCapable(def) && !(row.enabled && row.approvedBy))
      throw new AppError(
        403,
        'approval_required',
        'This schedule changes data; it can run only after enabling it was approved by a second person.',
        { hint: 'Enable it first; a Playbook.Approver who is not you approves the request.' },
      );
    const run = await this.deps.store.insertRun({
      scheduleId: row.id,
      scheduleKey: key,
      trigger: 'manual',
      status: 'queued',
      startedAt: this.deps.now(),
      result: { requestedBy: c.session.upn, requestedByOid: c.session.userOid },
    });
    await this.deps.audit.append({
      ...this.actor(c),
      action: 'schedule.run_requested',
      targetType: 'schedule',
      targetId: key,
      result: 'success',
      details: { scheduleRunId: run.id, job: def.job.kind, version: def.version },
    });
    this.deps.events.publish({ type: 'schedule.run_requested', data: { key, scheduleRunId: run.id } });
    return { scheduleRunId: run.id };
  }

  async runs(
    key: string,
    opts: { cursor?: string; limit: number },
  ): Promise<{ items: ScheduleRunItem[]; cursor?: string }> {
    const { row } = await this.row(key);
    const rows = await this.deps.store.listRuns(row.id, {
      limit: opts.limit + 1,
      ...(opts.cursor ? { before: decodeRunCursor(opts.cursor) } : {}),
    });
    const page = rows.slice(0, opts.limit);
    const items = await Promise.all(page.map((r) => this.runItem(r)));
    return { items, ...(rows.length > opts.limit ? { cursor: encodeRunCursor(page.at(-1)!) } : {}) };
  }

  private async runItem(r: ScheduleRunRow): Promise<ScheduleRunItem> {
    let artifact: ScheduleRunItem['artifact'];
    if (r.artifactPath) {
      const listed = (
        r.result?.artifacts as Array<{ path?: string; name?: string; size?: number }> | undefined
      )?.find((a) => a.path === r.artifactPath);
      artifact = {
        name: listed?.name ?? r.artifactPath.replace('/', '-'),
        href: `/api/artifacts/${r.id}`,
        size: listed?.size ?? (await this.deps.artifacts.size(r.artifactPath)),
      };
    }
    return {
      id: r.id,
      trigger: r.trigger,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      endedAt: iso(r.endedAt),
      ...(r.runId ? { runId: r.runId } : {}),
      ...(artifact ? { artifact } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
  }

  /** The report file of a run (path-safe); 404 when there is none. */
  async artifact(scheduleRunId: string): Promise<OpenedArtifact & { scheduleKey: string }> {
    const run = /^[0-9a-f-]{36}$/i.test(scheduleRunId) ? await this.deps.store.getRun(scheduleRunId) : null;
    const opened = run?.artifactPath ? await this.deps.artifacts.open(run.artifactPath) : null;
    if (!run || !opened)
      throw new AppError(
        404,
        'artifact_not_found',
        'This run has no report file (or it was removed by retention).',
      );
    return { ...opened, scheduleKey: run.scheduleKey };
  }

  // ── Approvals (enable write-capable schedules: two-person rule) ──

  private canDecide(s: SessionRecord, a: ScheduleApprovalRow): boolean {
    return (
      a.status === 'pending' &&
      hasRole(s, 'Playbook.Approver') &&
      a.policy.approvers.some((r) => s.roles.includes(r)) &&
      a.requestedBy !== s.userOid &&
      !a.decisions.some((d) => d.oid === s.userOid)
    );
  }

  view(s: SessionRecord, a: ScheduleApprovalRow): ScheduleApprovalView {
    const { initiatorOid: _i, ...policy } = a.policy;
    return {
      id: a.id,
      subjectType: 'schedule',
      subjectId: a.subjectId,
      stepId: null,
      kind: 'approval',
      title: a.policy.title,
      status: a.status,
      requestedBy: a.policy.requestedByUpn,
      requestedByOid: a.requestedBy,
      createdAt: a.createdAt.toISOString(),
      expiresAt: iso(a.expiresAt),
      decidedAt: iso(a.decidedAt),
      scheduleKey: a.subjectId,
      policy,
      decisions: a.decisions,
      canDecide: this.canDecide(s, a),
    };
  }

  /** Approver inbox items for schedules (Playbook.Approver). */
  async listApprovals(s: SessionRecord, status?: ApprovalStatus): Promise<ScheduleApprovalView[]> {
    requireRole(s, 'Playbook.Approver', 'The approval inbox');
    await this.pendingApprovals();
    const rows = await this.deps.store.listApprovals(status ? { status } : {});
    return rows
      .filter((a) => a.policy.approvers.some((r) => s.roles.includes(r)))
      .map((a) => this.view(s, a));
  }

  async getApproval(id: string): Promise<ScheduleApprovalRow | null> {
    return /^[0-9a-f-]{36}$/i.test(id) ? this.deps.store.getApproval(id) : null;
  }

  /** POST /api/approvals/:id for a schedule approval: approve enables the schedule (still the same definition). */
  async decide(
    c: Caller,
    id: string,
    input: { decision: 'approve' | 'reject'; comment?: string },
  ): Promise<{ status: ApprovalStatus; approvals: number; required: number }> {
    const s = c.session;
    requireRole(s, 'Playbook.Approver', 'Approving schedules');
    const a = await this.getApproval(id);
    if (!a) throw new AppError(404, 'approval_not_found', 'No such approval request.');
    const now = this.deps.now();
    if (a.status === 'pending' && a.expiresAt && a.expiresAt.getTime() <= now.getTime()) {
      await this.deps.store.updateApproval(a.id, { status: 'expired', decidedAt: now }, 'pending');
      throw new AppError(409, 'approval_expired', 'This approval request has expired. Ask for it again.');
    }
    if (a.status !== 'pending')
      throw new AppError(409, 'already_decided', `This approval was already ${a.status}.`);
    if (a.requestedBy === s.userOid)
      throw new AppError(403, 'own_request', 'You cannot approve your own request.', {
        hint: 'Ask another approver.',
      });
    if (!a.policy.approvers.some((r) => s.roles.includes(r)))
      throw new AppError(403, 'forbidden', `This approval needs one of: ${a.policy.approvers.join(', ')}.`);
    if (a.decisions.some((d) => d.oid === s.userOid))
      throw new AppError(409, 'already_decided', 'You already decided on this approval.');

    const row = await this.deps.store.getSchedule(a.subjectId);
    const decisions = [
      ...a.decisions,
      {
        oid: s.userOid,
        upn: s.upn,
        decision: input.decision,
        comment: input.comment ?? null,
        at: now.toISOString(),
      },
    ];
    const approvals = decisions.filter((d) => d.decision === 'approve').length;
    const required = a.policy.minApprovals;
    if (input.decision === 'approve' && (!row || row.sha256 !== a.policy.sha256)) {
      await this.deps.store.updateApproval(a.id, { status: 'expired', decidedAt: now }, 'pending');
      throw new AppError(
        409,
        'definition_changed',
        'The schedule changed after this was requested, so this approval no longer applies.',
        { hint: 'Ask the requester to enable it again.' },
      );
    }
    const status: ApprovalStatus =
      input.decision === 'reject' ? 'rejected' : approvals >= required ? 'approved' : 'pending';
    const updated = await this.deps.store.updateApproval(
      a.id,
      { decisions, status, decidedAt: status === 'pending' ? null : now },
      'pending',
    );
    if (!updated)
      throw new AppError(409, 'already_decided', 'Someone else decided on this approval at the same time.');
    if (status === 'approved' && row) {
      const def = row.definition;
      await this.deps.store.updateSchedule(
        row.id,
        { enabled: true, approvedBy: s.upn, nextRunAt: nextRun(def.cron, def.timezone, now) },
        { sha256: a.policy.sha256 },
      );
      this.changed(row.key);
    }
    await this.deps.audit.append({
      ...this.actor(c),
      action: input.decision === 'approve' ? 'schedule.approved' : 'schedule.rejected',
      targetType: 'schedule',
      targetId: a.subjectId,
      result: 'success',
      details: {
        approvalId: a.id,
        requestedBy: a.policy.requestedByUpn,
        decidedBy: s.upn,
        comment: input.comment ?? null,
        version: a.policy.definitionVersion,
        sha256: a.policy.sha256,
        approvals,
        required,
        enabled: status === 'approved',
      },
    });
    return { status, approvals, required };
  }
}
