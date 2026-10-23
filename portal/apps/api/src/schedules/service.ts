import {
  identityKey,
  identityLabel,
  isWriteCapable,
  TRANSACTION_KINDS,
  type Probe,
  type Schedule,
  type RunAsDefaults,
  type ScheduleIdentity,
} from '@adminforge/schemas';

export { creatorFilesAccess, SCHEDULED_DATA_ROLES } from './run-access';

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
import { deliveryView } from './delivery-keys';
import { maskRedacted, mayOpen } from '../reports/catalog';
import type { ScheduleEvents } from './events';
import type { ScheduleGrantRow, ScheduleGrantStore } from './grants';
import type { ScheduleStore } from './store';
import {
  creatorFilesAccess,
  fileOnlyReason,
  restrictedRunError,
  runRestriction,
  scheduleDataRoles,
  schedulerWritten,
  type RunRestriction,
} from './run-access';
import { contentSchedules, contentSignature, syncSchedules } from './sync';
import type {
  ApprovalStatus,
  ScheduleApprovalPolicy,
  ScheduleApprovalRow,
  ScheduleRow,
  ScheduleRunRow,
} from './types';
import { runAsOf } from './run-as';

/**
 * Schedules as the API sees them (R6): list, enable/disable (two-person approval for write-capable schedules),
 * run now, history, report downloads, and the schedule side of the approvals inbox. Execution is the scheduler's job;
 * this service only writes rows, audits, and wakes the scheduler (`schedule.run_requested`).
 */

import {
  APPROVAL_TTL_MS,
  FILE_ONLY_MESSAGE,
  PORTAL_RUN_NOW_INTERVAL_MS,
  actorOf,
  canManage,
  decodeRunCursor,
  encodeRunCursor,
  isDeleted,
  runsAsView,
  type Caller,
  type ReportAccess,
  type ScheduleApprovalView,
  type ScheduleItem,
  type ScheduleRunItem,
} from './views';
import { setRunAs } from './run-as-api';

export * from './views';

const APPROVERS = ['Playbook.Approver'];
const INACTIVE = new Set(['draft', 'retired']);

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

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
      /** The installation's default accounts for read-only schedules (AF_SCHEDULE_DEFAULT_IDENTITY…). */
      defaults?: RunAsDefaults;
      /** The named app identities configured here (AF_SCHEDULE_IDENTITIES). */
      apps?: () => readonly string[];
      /**
       * The application permissions (`graph:User.Read.All`) an identity lacks of `scopes`, read live; null when it
       * can't be checked here (mock sign-in, no automation identity) — then the change is allowed.
       */
      permissionsMissing?: (
        identity: ScheduleIdentity,
        scopes: Readonly<Partial<Record<string, readonly string[] | undefined>>>,
      ) => Promise<string[] | null>;
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
      identity: identityKey(runAsOf(row, this.deps.defaults).identity),
      runsAs: runsAsView(row, session, grant, this.deps.defaults),
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
  /** PUT /api/schedules/:key/run-as (run-as-api.ts). */
  async setRunAs(c: Caller, key: string, wanted: string | null): Promise<{ disabled: boolean }> {
    return setRunAs(this, this.deps, c, key, wanted);
  }

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
        await this.deps.store.updateSchedule(row.id, {
          enabled: false,
          nextRunAt: null,
          approvedBy: null,
          approvedIdentity: null,
        });
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
      const runningAs = runAsOf(row, this.deps.defaults).identity;
      const existing = (await this.pendingApprovals()).find(
        (a) =>
          a.subjectId === key &&
          a.policy.sha256 === row.sha256 &&
          a.policy.targetFingerprint === targetFingerprint &&
          (a.policy.identity ?? 'automation') === identityKey(runningAs),
      );
      if (existing) return { statusCode: 202, body: { approvalId: existing.id } };
      const policy: ScheduleApprovalPolicy = {
        kind: 'approval',
        action: 'enable',
        approvers: APPROVERS,
        minApprovals: 1,
        title: `Enable schedule: ${def.title}`,
        message: `${c.session.upn} asks to enable "${def.title}", which runs a ${def.job.kind} job that changes data (${def.cron} ${def.timezone}) as ${runningAs === 'automation' ? 'the automation identity' : identityLabel(runningAs, def.owner)}. A second person must approve.`,
        definitionKey: key,
        definitionVersion: def.version,
        sha256: row.sha256,
        ...(targetFingerprint ? { targetFingerprint } : {}),
        identity: identityKey(runningAs),
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
          identity: identityKey(runningAs),
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
    session: SessionRecord,
  ): Promise<{ items: ScheduleRunItem[]; cursor?: string }> {
    const { row } = await this.row(key);
    const rows = await this.deps.store.listRuns(row.id, {
      limit: opts.limit + 1,
      ...(opts.cursor ? { before: decodeRunCursor(opts.cursor) } : {}),
    });
    const page = rows.slice(0, opts.limit);
    // A schedule that uses its creator's access: only they (or a Portal Admin) get links to its files.
    const files = creatorFilesAccess(row, session) !== 'denied';
    // Error details and run ids belong to what the run collected: for the roles that may see the schedule's data.
    const roles = await scheduleDataRoles(this.deps.definitions, row.definition);
    const restriction = runRestriction(session, files, roles);
    const report = row.definition.job.kind === 'report';
    const items = await Promise.all(page.map((r) => this.runItem(r, files, report, restriction)));
    return { items, ...(rows.length > opts.limit ? { cursor: encodeRunCursor(page.at(-1)!) } : {}) };
  }

  private async runItem(
    r: ScheduleRunRow,
    files = true,
    report = false,
    restriction: RunRestriction | null = null,
  ): Promise<ScheduleRunItem> {
    let artifact: ScheduleRunItem['artifact'];
    // No link a viewer can't open (the download asks for the same roles).
    if (r.artifactPath && files && !restriction) {
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
      ...(r.runId && !restriction ? { runId: r.runId } : {}),
      ...(artifact ? { artifact } : {}),
      ...(r.error
        ? {
            error:
              restriction && !schedulerWritten(r) ? restrictedRunError(r.error.code, restriction) : r.error,
          }
        : {}),
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
    for (const role of await scheduleDataRoles(this.deps.definitions, schedule))
      requireRole(session, role, action);
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
    // The account it runs as is part of what was approved: a run-as change since voids the request.
    if (
      input.decision === 'approve' &&
      row &&
      (a.policy.identity ?? identityKey(row.definition.identity)) !==
        identityKey(runAsOf(row, this.deps.defaults).identity)
    ) {
      await this.deps.store.updateApproval(a.id, { status: 'expired', decidedAt: now }, 'pending');
      throw new AppError(
        409,
        'definition_changed',
        'The account this schedule runs as changed after this was requested, so this approval no longer applies.',
        { hint: 'Ask the requester to enable it again, so you approve the account it runs as now.' },
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
          // The account it was approved for: the scheduler runs a write-capable schedule only as that one.
          approvedIdentity: a.policy.identity ?? identityKey(def.identity),
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
        identity: a.policy.identity ?? (row ? identityKey(row.definition.identity) : null),
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
