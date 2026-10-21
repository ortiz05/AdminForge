import {
  identityKey,
  identityLabel,
  isWriteCapable,
  TRANSACTION_KINDS,
  type PortalRole,
  type Probe,
  type Schedule,
} from '@adminforge/schemas';

/** Who may see data a schedule collected with application permissions, unless its `requires.portalRoles` says otherwise. */
export const SCHEDULED_DATA_ROLES: readonly PortalRole[] = ['Portal.Operator'];

/**
 * Who opens the files of a schedule that runs with its creator's own access (ADR-014): the creator, or a Portal Admin
 * (`admin`, audited); anyone else is `denied`. `n/a` for other schedules (their roles decide).
 */
export function creatorFilesAccess(
  row: Pick<ScheduleRow, 'definition' | 'createdBy'>,
  session: SessionRecord,
): 'n/a' | 'creator' | 'admin' | 'denied' {
  const identity = row.definition.identity;
  if (!identity || identity === 'automation' || !('user' in identity)) return 'n/a';
  if (row.createdBy && row.createdBy === session.userOid) return 'creator';
  return hasRole(session, 'Portal.Admin') ? 'admin' : 'denied';
}
import type { AuditInput, AuditWriter } from '../audit/writer';
import { hasRole, requireRole } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import type { ArtifactStore, OpenedArtifact } from '../artifacts/store';
import type { DefinitionSource } from '../definitions/types';
import type { PlaybookRef } from '../runs/fingerprint';
import { AppError } from '../errors';
import type { ComponentHealth } from '../health/heartbeat';
import { AUTOMATION_PAUSED } from '../execution/emergency';
import { describeCron, nextRun } from './cron';
import { deliveryView, type DeliveryView, type NotifyView } from './delivery-keys';
import { maskRedacted, mayOpen } from '../reports/catalog';
import type { ScheduleEvents } from './events';
import type { ScheduleGrantRow, ScheduleGrantStore } from './grants';
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
  /** `automation`, `app:<name>` or `user` (identityKey). */
  identity: string;
  /** Who it runs as (ADR-014), for people. */
  runsAs: RunsAsView;
  job: {
    kind: Schedule['job']['kind'];
    ref?: string;
    refs?: string[];
    select?: { tags: string[] };
    /** Report jobs: the params the report runs with. */
    params?: Record<string, unknown>;
  };
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  writeCapable: boolean;
  approvedBy?: string[];
  source: 'content' | 'portal';
  /** The creator's UPN (portal schedules); null for content. */
  createdBy: string | null;
  /** Portal schedule, the caller holds Portal.Operator and created it (by oid) or holds Portal.Admin. */
  canManage: boolean;
  /** Report jobs: where the file goes (configuration key names, never values). */
  delivery?: DeliveryView[];
  /** `notify.onFailure` targets (key names). */
  notify?: NotifyView[];
  /** Set while an enable request waits for its second approver. */
  pendingApprovalId: string | null;
}

/** Who a schedule runs as, as the schedule list and page show it. */
export interface RunsAsView {
  kind: 'automation' | 'app' | 'user';
  /** The app identity's name, or the creator's UPN. */
  name: string | null;
  /** "automation identity", "app identity reports-team", "avery@example.com (their own access)". */
  label: string;
  /**
   * Creator schedules: whether the creator's grant works (`signed_in`), was refused by Microsoft (`needs_sign_in`), or
   * was never given (`not_signed_in`).
   */
  signIn?: 'signed_in' | 'needs_sign_in' | 'not_signed_in';
  /** Creator schedules: the caller is the creator and may sign in for it. */
  canSignIn?: boolean;
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
  /** Why a run didn't happen (skipped runs), or sent nothing (Run now while the schedule was disabled). */
  reason?: string;
}

/** The history line of a file-only run (F-10), in the present while it is waiting or running. */
function fileOnlyReason(r: Pick<ScheduleRunRow, 'status'>, report: boolean): string {
  const now = r.status === 'queued' || r.status === 'running';
  if (report)
    return now
      ? 'The schedule is disabled, so this run only writes the file: it sends no email, Teams message or notification.'
      : 'The schedule was disabled, so this run only wrote the file: it sent no email, Teams message or notification.';
  return now
    ? 'The schedule is disabled, so this run sends no email, Teams message or notification.'
    : 'The schedule was disabled, so this run sent no email, Teams message or notification.';
}

/** Run now on a disabled schedule (F-10): what the answer says. */
export const FILE_ONLY_MESSAGE =
  'The schedule is disabled, so this run only writes the file: it sends no email, Teams message or notification.';

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
/** Run now on a portal schedule: not again within this long of the last manual run. */
export const PORTAL_RUN_NOW_INTERVAL_MS = 15 * 60_000;

/** What `item` needs of a report: who may open it and which params it redacts. */
export interface ReportAccess {
  requires?: { portalRoles?: PortalRole[] };
  params?: Record<string, { redact?: boolean }>;
}
const APPROVERS = ['Playbook.Approver'];
const INACTIVE = new Set(['draft', 'retired']);

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** A portal schedule that was deleted (soft delete: kept for its history, hidden everywhere else). */
export const isDeleted = (row: Pick<ScheduleRow, 'source' | 'definition'>) =>
  row.source === 'portal' && row.definition.status === 'retired';

/**
 * Who may edit or delete a schedule created in the portal: a Portal.Operator who created it (by oid) or who is also a
 * Portal.Admin. Content schedules change through git only. (Any Operator may still turn one off.)
 */
export function canManage(row: Pick<ScheduleRow, 'source' | 'createdBy'>, session?: SessionRecord): boolean {
  if (!session || row.source !== 'portal' || !hasRole(session, 'Portal.Operator')) return false;
  return (!!row.createdBy && row.createdBy === session.userOid) || hasRole(session, 'Portal.Admin');
}

/** Who a schedule runs as, for its list row and page (the grant decides a creator schedule's sign-in state). */
export function runsAsView(
  row: Pick<ScheduleRow, 'definition' | 'createdBy' | 'source'>,
  session?: SessionRecord,
  grant?: ScheduleGrantRow | null,
): RunsAsView {
  const identity = row.definition.identity;
  if (!identity || identity === 'automation')
    return { kind: 'automation', name: null, label: identityLabel(identity) };
  if ('app' in identity) return { kind: 'app', name: identity.app, label: identityLabel(identity) };
  const owner = row.source === 'portal' ? row.definition.owner : null;
  return {
    kind: 'user',
    name: owner,
    label: identityLabel(identity, owner),
    signIn: !grant ? 'not_signed_in' : grant.status === 'active' ? 'signed_in' : 'needs_sign_in',
    canSignIn: !!session && !!row.createdBy && row.createdBy === session.userOid,
  };
}

/** Audit actor fields for a schedules API caller. */
export function actorOf(c: Caller): Omit<AuditInput, 'action' | 'result'> {
  return {
    actorOid: c.session.userOid,
    actorUpn: c.session.upn,
    sessionHash: c.session.idHash,
    mode: 'read',
    correlationId: c.correlationId,
    ip: c.ip,
  };
}

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
      /** Fingerprint of a playbook job's playbook and its children (runs/fingerprint.ts); absent → no playbook runs. */
      fingerprint?: (ref: PlaybookRef) => Promise<string>;
      /** Tells approvers a request is waiting (email/Teams); failures never block the request. */
      notifyApprovers?: (request: { title: string; requestedBy: string; key: string }) => Promise<void>;
      /** The emergency stop (execution/emergency.ts): while automation is paused, Run now is refused up front. */
      automationPaused?: () => Promise<boolean>;
      /** Creators' grants (ADR-014), for the "needs sign-in" state of schedules that run with their access. */
      grants?: Pick<ScheduleGrantStore, 'get'>;
      /** The scheduler's heartbeat (D-09) when it runs in this process with a database; the list reports it. */
      schedulerHealth?: () => Promise<ComponentHealth>;
    },
  ) {}

  /** The grants of creator schedules among `rows` (by schedule id). */
  async grantsFor(rows: readonly ScheduleRow[]): Promise<Map<string, ScheduleGrantRow | null>> {
    const out = new Map<string, ScheduleGrantRow | null>();
    const grants = this.deps.grants;
    if (!grants) return out;
    for (const r of rows)
      if (r.definition.identity !== 'automation' && 'user' in r.definition.identity)
        out.set(r.id, await grants.get(r.id));
    return out;
  }

  /** What an enable approval covers besides the schedule itself: the playbook a playbook job runs. */
  private async targetFingerprint(def: Schedule): Promise<string | undefined> {
    if (def.job.kind !== 'playbook' || !this.deps.fingerprint) return undefined;
    return this.deps.fingerprint({ ref: def.job.ref });
  }

  private actor(c: Caller): Omit<AuditInput, 'action' | 'result'> {
    return actorOf(c);
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

  /** A schedule the API may show: in content, or created in the portal and not deleted. 404 otherwise. */
  async row(key: string): Promise<{ row: ScheduleRow; inContent: boolean }> {
    const keys = await this.ensureSynced();
    const row = await this.deps.store.getSchedule(key);
    if (!row || (row.source === 'content' && !keys.has(key)) || isDeleted(row))
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

  /**
   * The API view of a row; `session` decides `canManage`. A report job's params, delivery and alerts are shown only to
   * someone who may open the report (`reports`: the published reports by key), with `redact: true` params masked.
   */
  item(
    row: ScheduleRow,
    pendingApprovalId: string | null,
    now: Date,
    session?: SessionRecord,
    reports?: ReadonlyMap<string, ReportAccess>,
    grant?: ScheduleGrantRow | null,
  ): ScheduleItem {
    const def = row.definition;
    const job = def.job;
    const report = job.kind === 'report' ? reports?.get(job.ref) : undefined;
    const details = job.kind !== 'report' || (!!session && !!report && mayOpen(session, report));
    return {
      key: row.key,
      title: def.title,
      summary: def.summary ?? null,
      cron: def.cron,
      cronText: describeCron(def.cron, def.timezone),
      timezone: def.timezone,
      enabled: row.enabled,
      identity: identityKey(def.identity),
      runsAs: runsAsView(row, session, grant),
      job: {
        kind: job.kind,
        ...('ref' in job && job.ref ? { ref: job.ref } : {}),
        ...(job.kind === 'probe' && job.refs ? { refs: job.refs } : {}),
        ...(job.kind === 'probe' && job.select ? { select: { tags: job.select.tags } } : {}),
        ...(job.kind === 'report' && details && job.params && Object.keys(job.params).length
          ? { params: maskRedacted(job.params, report?.params) }
          : {}),
      },
      nextRunAt: iso(this.nextFor(row, now)),
      lastRunAt: iso(row.lastRunAt),
      lastStatus: row.lastStatus,
      writeCapable: isWriteCapable(def),
      ...(row.approvedBy ? { approvedBy: [row.approvedBy] } : {}),
      source: row.source,
      // Portal schedules are owned by their creator (definition.owner is the creator's UPN; the row keeps the oid).
      createdBy: row.source === 'portal' ? def.owner : null,
      canManage: canManage(row, session),
      ...(details ? deliveryView(def) : {}),
      pendingApprovalId,
    };
  }

  /** Published reports by key (for `item`). */
  async reports(): Promise<Map<string, ReportAccess>> {
    return new Map(
      (await this.deps.definitions.list('report')).map((r) => [r.key, r.def as unknown as ReportAccess]),
    );
  }

  /**
   * GET /api/schedules. `scheduler` (when the scheduler runs here): `ok` while its ticks succeed, `stale` when it has
   * made no progress for two minutes — the API answers, but nothing fires — with when it last did.
   */
  async list(session?: SessionRecord): Promise<{ items: ScheduleItem[]; scheduler?: ComponentHealth }> {
    const keys = await this.ensureSynced();
    const now = this.deps.now();
    const pending = new Map((await this.pendingApprovals()).map((a) => [a.subjectId, a.id]));
    const rows = (await this.deps.store.listSchedules()).filter((r) =>
      r.source === 'portal' ? !isDeleted(r) : keys.has(r.key),
    );
    const reports = await this.reports();
    const grants = await this.grantsFor(rows);
    // Health is a hint for the page: if it can't be read, the list still answers.
    const scheduler = await this.deps.schedulerHealth?.().catch(() => undefined);
    return {
      items: rows.map((r) =>
        this.item(r, pending.get(r.key) ?? null, now, session, reports, grants.get(r.id)),
      ),
      ...(scheduler ? { scheduler } : {}),
    };
  }

  async get(key: string, session?: SessionRecord): Promise<ScheduleItem> {
    const { row } = await this.row(key);
    const pending = (await this.pendingApprovals()).find((a) => a.subjectId === key);
    const grants = await this.grantsFor([row]);
    return this.item(
      row,
      pending?.id ?? null,
      this.deps.now(),
      session,
      await this.reports(),
      grants.get(row.id),
    );
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
      const targetFingerprint = await this.targetFingerprint(def);
      const existing = (await this.pendingApprovals()).find(
        (a) =>
          a.subjectId === key &&
          a.policy.sha256 === row.sha256 &&
          a.policy.targetFingerprint === targetFingerprint,
      );
      if (existing) return { statusCode: 202, body: { approvalId: existing.id } };
      const policy: ScheduleApprovalPolicy = {
        kind: 'approval',
        action: 'enable',
        approvers: APPROVERS,
        minApprovals: 1,
        title: `Enable schedule: ${def.title}`,
        message: `${c.session.upn} asks to enable "${def.title}", which runs a ${def.job.kind} job that changes data (${def.cron} ${def.timezone}) as ${def.identity === 'automation' ? 'the automation identity' : identityLabel(def.identity, def.owner)}. A second person must approve.`,
        definitionKey: key,
        definitionVersion: def.version,
        sha256: row.sha256,
        ...(targetFingerprint ? { targetFingerprint } : {}),
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
      await this.deps
        .notifyApprovers?.({ title: policy.title, requestedBy: c.session.upn, key })
        .catch(() => undefined);
      await this.deps.audit.append({
        ...this.actor(c),
        action: 'schedule.enable_requested',
        targetType: 'schedule',
        targetId: key,
        result: 'success',
        details: {
          approvalId: a.id,
          version: def.version,
          sha256: row.sha256,
          job: def.job.kind,
          identity: identityKey(def.identity),
        },
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

  /** Wakes the scheduler (in any process) and tells browsers the schedule changed. */
  changed(key: string) {
    this.deps.events.publish({ type: 'schedules.changed', data: { key } });
    this.deps.events.publish({ type: 'schedule.updated', data: { key } });
  }

  /** Whether a probe job's probes (by ref, refs or tags, as jobs.ts selects them) include a synthetic transaction. */
  private async runsTransactions(def: Schedule): Promise<boolean> {
    const job = def.job;
    if (job.kind !== 'probe') return false;
    const probes = (await this.deps.definitions.list('probe')).filter((r) =>
      job.ref
        ? r.key === job.ref
        : job.refs
          ? job.refs.includes(r.key)
          : (job.select?.tags ?? []).every((t) => (r.def as Probe).tags?.includes(t)),
    );
    return probes.some((r) => (TRANSACTION_KINDS as readonly string[]).includes((r.def as Probe).check.kind));
  }

  /**
   * POST /run: queues a manual run for the scheduler. On a disabled schedule it is how an owner tries it before
   * enabling it, so the run only writes its file (F-10): no email, Teams post or notification until it is enabled.
   */
  async runNow(
    c: Caller,
    key: string,
  ): Promise<{ scheduleRunId: string; fileOnly?: true; message?: string }> {
    requireRole(c.session, 'Portal.Operator', 'Running schedules');
    const { row } = await this.row(key);
    if ((await this.deps.automationPaused?.()) === true)
      throw new AppError(
        409,
        AUTOMATION_PAUSED.code,
        'An administrator has paused automation, so schedules can’t run now.',
        { hint: AUTOMATION_PAUSED.hint },
      );
    const def = row.definition;
    if (isWriteCapable(def) && !(row.enabled && row.approvedBy))
      throw new AppError(
        403,
        'approval_required',
        'This schedule changes data; it can run only after enabling it was approved by a second person.',
        { hint: 'Enable it first; a Playbook.Approver who is not you approves the request.' },
      );
    // Synthetic transactions write to their test objects (ADR-015): a schedule turned off — e.g. because a test object
    // turned out to be in use — doesn't run them on demand either.
    if (!row.enabled && (await this.runsTransactions(def)))
      throw new AppError(
        409,
        'schedule_disabled',
        'This schedule runs synthetic transactions, which send, upload or create on test objects, and it is turned off, so it can’t run now.',
        {
          hint: 'Turn it on first, once its test objects are set up (docs/operations.md › Synthetic transactions).',
        },
      );
    if (row.source === 'portal') await this.assertRunNowAllowed(row);
    const fileOnly = !row.enabled;
    const run = await this.deps.store.insertRun({
      scheduleId: row.id,
      scheduleKey: key,
      trigger: 'manual',
      status: 'queued',
      startedAt: this.deps.now(),
      result: {
        requestedBy: c.session.upn,
        requestedByOid: c.session.userOid,
        ...(fileOnly ? { fileOnly: true } : {}),
      },
    });
    await this.deps.audit.append({
      ...this.actor(c),
      action: 'schedule.run_requested',
      targetType: 'schedule',
      targetId: key,
      result: 'success',
      details: {
        scheduleRunId: run.id,
        job: def.job.kind,
        version: def.version,
        ...(fileOnly ? { fileOnly: true } : {}),
      },
    });
    this.deps.events.publish({ type: 'schedule.run_requested', data: { key, scheduleRunId: run.id } });
    return {
      scheduleRunId: run.id,
      ...(fileOnly ? { fileOnly: true as const, message: FILE_ONLY_MESSAGE } : {}),
    };
  }

  /**
   * Run now on a schedule created in the portal: not while a run is queued or running, nor within 15 minutes of the
   * last manual run (every run reads the tenant with application permissions and may email or post the file).
   */
  private async assertRunNowAllowed(row: ScheduleRow) {
    const now = this.deps.now().getTime();
    if ((await this.deps.store.runsInStatus(['queued', 'running'])).some((r) => r.scheduleId === row.id))
      throw new AppError(429, 'run_too_soon', 'This schedule is already running or waiting to run.', {
        hint: 'Wait for that run to finish; its file appears in the schedule’s history.',
      });
    const last = (await this.deps.store.listRuns(row.id, { limit: 25 })).find(
      (r) => r.trigger === 'manual' && now - r.startedAt.getTime() < PORTAL_RUN_NOW_INTERVAL_MS,
    );
    if (last) {
      const minutes = Math.ceil((last.startedAt.getTime() + PORTAL_RUN_NOW_INTERVAL_MS - now) / 60_000);
      throw new AppError(429, 'run_too_soon', 'This schedule was run by hand less than 15 minutes ago.', {
        hint: `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or open the latest file in its history.`,
      });
    }
  }

  async runs(
    key: string,
    opts: { cursor?: string; limit: number },
    session?: SessionRecord,
  ): Promise<{ items: ScheduleRunItem[]; cursor?: string }> {
    const { row } = await this.row(key);
    const rows = await this.deps.store.listRuns(row.id, {
      limit: opts.limit + 1,
      ...(opts.cursor ? { before: decodeRunCursor(opts.cursor) } : {}),
    });
    const page = rows.slice(0, opts.limit);
    // A schedule that uses its creator's access: only they (or a Portal Admin) get links to its files.
    const files = !session || creatorFilesAccess(row, session) !== 'denied';
    const report = row.definition.job.kind === 'report';
    const items = await Promise.all(page.map((r) => this.runItem(r, files, report)));
    return { items, ...(rows.length > opts.limit ? { cursor: encodeRunCursor(page.at(-1)!) } : {}) };
  }

  private async runItem(r: ScheduleRunRow, files = true, report = false): Promise<ScheduleRunItem> {
    let artifact: ScheduleRunItem['artifact'];
    if (r.artifactPath && files) {
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
      // Why a run didn't happen (overlap, paused, deleted, needs sign-in): written by the scheduler, never tenant data.
      ...(r.status === 'skipped' && typeof r.result?.reason === 'string' ? { reason: r.result.reason } : {}),
      // Run now while the schedule was disabled: the history says why nobody heard about it.
      ...(r.status !== 'skipped' && r.result?.fileOnly === true ? { reason: fileOnlyReason(r, report) } : {}),
    };
  }

  /** The report file of a run (path-safe); 404 when there is none. */
  async artifact(
    scheduleRunId: string,
    session: SessionRecord,
  ): Promise<OpenedArtifact & { scheduleKey: string; adminOverride: boolean }> {
    const run = /^[0-9a-f-]{36}$/i.test(scheduleRunId) ? await this.deps.store.getRun(scheduleRunId) : null;
    const adminOverride = run ? await this.assertArtifactAccess(session, run.scheduleKey) : false;
    const opened = run?.artifactPath ? await this.deps.artifacts.open(run.artifactPath) : null;
    if (!run || !opened)
      throw new AppError(
        404,
        'artifact_not_found',
        'This run has no report file (or it was removed by retention).',
      );
    return { ...opened, scheduleKey: run.scheduleKey, adminOverride };
  }

  /**
   * Scheduled reports are collected with the automation identity's application permissions, which can see more than
   * a viewer's own Entra roles. Downloading one needs the schedule's `requires.portalRoles` (default: Operator) and the
   * report's own `requires.portalRoles`. A schedule that runs with its creator's own access collected what *they* can
   * see (their directory roles, data a ceiling withholds from the automation identity): only the creator opens its
   * files, or a Portal Admin — true is returned then, and the download is audited as an admin override.
   */
  private async assertArtifactAccess(session: SessionRecord, scheduleKey: string): Promise<boolean> {
    const action = 'Downloading this scheduled report';
    const row = await this.deps.store.getSchedule(scheduleKey);
    const schedule = row?.definition;
    const creator = row ? creatorFilesAccess(row, session) : 'n/a';
    if (creator === 'denied')
      throw new AppError(403, 'forbidden', 'Only the person who created this schedule can open its files.', {
        hint: 'It runs with their own access, so its files hold what they can see. Ask them for the file, or ask a portal administrator.',
      });
    for (const role of schedule?.requires?.portalRoles ?? SCHEDULED_DATA_ROLES)
      requireRole(session, role, action);
    if (schedule?.job.kind === 'report') {
      const ref = schedule.job.ref;
      const report = (await this.deps.definitions.list('report')).find((d) => d.key === ref)?.def as
        { requires?: { portalRoles?: PortalRole[] } } | undefined;
      for (const role of report?.requires?.portalRoles ?? []) requireRole(session, role, action);
    }
    return creator === 'admin';
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
    if (
      input.decision === 'approve' &&
      row &&
      (await this.targetFingerprint(row.definition)) !== a.policy.targetFingerprint
    ) {
      await this.deps.store.updateApproval(a.id, { status: 'expired', decidedAt: now }, 'pending');
      throw new AppError(
        409,
        'definition_changed',
        'The playbook this schedule runs changed after this was requested, so this approval no longer applies.',
        { hint: 'Ask the requester to enable it again, so you approve the current version.' },
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
        {
          enabled: true,
          approvedBy: s.upn,
          approvedTarget: a.policy.targetFingerprint ?? null,
          nextRunAt: nextRun(def.cron, def.timezone, now),
        },
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
