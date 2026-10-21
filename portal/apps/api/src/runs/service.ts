import { createHash, randomUUID } from 'node:crypto';
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
  type RunError,
  type RunStatus,
  type RunStore,
} from '@adminforge/engine';
import { renderTemplate } from '@adminforge/expressions';
import { PORTAL_ROLES, type Connection, type Kind, type PortalRole } from '@adminforge/schemas';
import type { AuditInput, AuditWriter } from '../audit/writer';
import { hasRole, requireRole } from '../auth/guards';
import { isArmed, type SessionRecord } from '../auth/session-store';
import { definitionRetired, RELOAD_HINT, versionSuperseded } from '../definitions/current';
import type { DefinitionResolver } from '../definitions/types';
import { AppError } from '../errors';
import { SCHEDULED_DATA_ROLES } from '../schedules/service';
import type { RunQueue } from './queue';
import { failTree, outdatedRun, pinnedDefinition, rootOf, runOutdated, wroteAnything } from './run-worker';
import { decisionOf, executedAs } from './store';
import { automationFingerprint, writesInTree, type PlaybookRef } from './fingerprint';
import {
  RUN_STATUS_ACTIVE as NON_TERMINAL,
  type NewRun,
  type RunDetail,
  type RunRepository,
  type RunRow,
  type RunSummary,
  type TaskRow,
  type TaskView,
} from './types';
import { runPlan, runSummary, runView, stepView, taskView } from './views';

/** Who is calling (from the request's session). */
export interface Caller {
  session: SessionRecord;
  correlationId: string;
  ip: string | null;
}

/** Server-side "preview then confirm" for playbooks with a `confirm` block (risk ≥ high). */
export interface ConfirmationInput {
  /** The dry run (same person, definition version and inputs, ≤ 15 minutes old) this execution was confirmed from. */
  previewRunId?: string;
  /** typed confirms: what the person typed (compared trimmed, case-insensitive). */
  confirmation?: string;
}

export interface CreateRunInput extends ConfirmationInput {
  playbook: string;
  version?: string;
  inputs?: Record<string, unknown>;
  dryRun?: boolean;
}

export interface BulkRunInput extends ConfirmationInput {
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
  schedule: {
    id?: string | null;
    key: string;
    /** Who scheduled it, for display and audit ("content (owner: …)", or the UPN of whoever pressed Run now). */
    createdBy?: string | null;
    /** Run now: the requester's oid (they may not approve gates in this run). */
    requestedByOid?: string | null;
    approvedBy?: string[] | null;
    /** Fingerprint of the playbook (and children) the second person approved (runs/fingerprint.ts). */
    approvedTarget?: string | null;
    /** The named app identity the schedule runs as (ADR-014); absent = the automation identity. */
    identity?: string | null;
  };
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
const hasEvery = (s: SessionRecord, roles: readonly string[]) => roles.every((r) => s.roles.includes(r));

/** Whether an approval gate's `excludes` (object ids the change grants access to) lists `oid`. */
const grantsAccessTo = (t: TaskRow, oid: string) =>
  t.policy.kind === 'approval' && (t.policy.excludes ?? []).includes(oid.toLowerCase());

/**
 * The id of the run a preview confirms: derived from the preview's id, so a preview starts at most one run (a second
 * insert with the same id finds the first one).
 */
export function confirmedRunId(previewRunId: string): string {
  const h = createHash('sha256').update(`adminforge.confirmed:${previewRunId}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Looks up a schedule's `requires.portalRoles` by schedule id (wired by the schedules module). */
export type ScheduleRolesLookup = (scheduleId: string) => Promise<readonly PortalRole[] | null | undefined>;

/** F-08: open runs (queued or running) one person may have at once; RUN_MAX_OPEN_PER_USER. */
export const DEFAULT_MAX_OPEN_RUNS = 5;

/** The 429 for a person at their open-run cap (F-08). */
export const tooManyRuns = (max: number) =>
  new AppError(
    429,
    'too_many_runs',
    `You already have ${max} runs queued or running, the most one person can have at once.`,
    {
      hint: 'Wait for one to finish, or cancel one you don’t need (Runs), then start this again. Runs waiting for an approval, input, write access or a sign-in don’t count.',
    },
  );

/** Per-request memo for view checks (definition and schedule roles). */
type ViewCache = Map<string, Promise<readonly string[]>>;
export const PREVIEW_MAX_AGE_MS = 15 * 60_000;

/** JSON with sorted keys, so equal inputs compare equal whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as object)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

const fold = (s: string) => s.trim().toLocaleLowerCase('en-US');

interface Confirmed {
  previewRunId: string;
  confirm: 'typed' | 'click';
  confirmationMatched: boolean;
}
const describeIssues = (issues: InputIssue[], prefix = 'inputs') =>
  issues
    .slice(0, 10)
    .map((i) => `${prefix}${i.field ? `.${i.field}` : ''}: ${i.message}`)
    .join('; ') + (issues.length > 10 ? `; and ${issues.length - 10} more` : '');

export function encodeCursor(row: Pick<RunRow, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id }), 'utf8').toString(
    'base64url',
  );
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
      /** F-08: open runs one person may have at once (default 5). */
      maxOpenRuns?: number;
    },
  ) {}

  private scheduleRoles: ScheduleRolesLookup | null = null;

  /** Wires the schedule lookup (the schedules module is created after the runs module). */
  useSchedules(lookup: ScheduleRolesLookup): void {
    this.scheduleRoles = lookup;
  }

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
  async resolve(
    key: string,
    version?: string,
    kinds: ReadonlyArray<'playbook' | 'runbook'> = ['playbook', 'runbook'],
  ) {
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

  /**
   * People run the current version only: an older version (superseded or retired) may lack approvals or confirmations
   * added since. A client still holding an older version gets a 409 telling it to reload.
   */
  async resolveCurrent(
    key: string,
    version?: string,
    kinds: ReadonlyArray<'playbook' | 'runbook'> = ['playbook', 'runbook'],
  ) {
    let current: Awaited<ReturnType<RunService['resolve']>>;
    try {
      current = await this.resolve(key, undefined, kinds);
    } catch (err) {
      // No current version: retired (an exact older version may still resolve) or never published.
      if (version && err instanceof AppError && err.status === 404) {
        const old = await this.resolve(key, version, kinds);
        throw definitionRetired(old.def.title, 'can no longer run');
      }
      throw err;
    }
    if (version && version !== current.version)
      throw versionSuperseded(current.def.title, current.version, RELOAD_HINT.run);
    return current;
  }

  /** Retired definitions never run; drafts can be previewed (dry run) but not executed. */
  private checkRunnable(def: AutomationDefinition, dryRun: boolean) {
    if (def.status === 'retired') throw definitionRetired(def.title, 'can no longer run');
    if (def.status === 'draft' && !dryRun)
      throw new AppError(409, 'definition_draft', `${def.title} is a draft and can't run yet.`, {
        hint: 'Preview it to try it out. It can run once its owner publishes it with status: published.',
      });
    const tooBig = checkDefinition(def);
    if (tooBig) throw new AppError(422, 'limit_exceeded', tooBig);
  }

  /** The connection a function step calls, as it would resolve now (for schedule approval fingerprints). */
  private async connection(key: string) {
    const r = await this.deps.definitions().resolve('connection', key);
    return { version: r.version, sha256: r.sha256, def: r.def as Connection };
  }

  /** What a schedule's two-person approval covers: the playbook, its children and the connections they call. */
  fingerprint(ref: PlaybookRef): Promise<string> {
    return automationFingerprint(
      (r, v) => this.resolve(r, v),
      ref,
      (key) => this.connection(key),
    );
  }

  /**
   * §5.3: previews (dry runs) need the definition's own roles, since their read steps really run; executing a write
   * playbook also needs Portal.Operator.
   */
  authorize(session: SessionRecord, def: AutomationDefinition, dryRun: boolean) {
    if (!hasAny(session, PORTAL_ROLES))
      throw new AppError(403, 'forbidden', 'Running playbooks needs an AdminForge role.', {
        hint: 'Ask a portal administrator to add you to the AdminForge Reader group.',
      });
    for (const role of def.requires?.portalRoles ?? [])
      requireRole(session, role, `${dryRun ? 'Previewing' : 'Running'} ${def.title}`);
    if (dryRun) return;
    if (def.mode === 'write' || hasWriteSteps(def))
      requireRole(session, 'Portal.Operator', `Running ${def.title}`);
  }

  private async validate(
    def: AutomationDefinition,
    inputs: unknown,
    prefix = 'inputs',
    now = this.deps.now(),
  ) {
    const v = await validateInputs(def.inputs, inputs ?? {}, { now, env: this.deps.env() });
    if (!v.ok)
      throw new AppError(
        400,
        'invalid_inputs',
        `The inputs are not valid. ${describeIssues(v.errors, prefix)}`,
      );
    return v.values;
  }

  private memo(cache: ViewCache, key: string, load: () => Promise<readonly string[]>) {
    let p = cache.get(key);
    if (!p) cache.set(key, (p = load()));
    return p;
  }

  /** `requires.portalRoles` of the run's pinned definition ([] when it can no longer be resolved). */
  private async definitionRoles(row: RunRow): Promise<readonly string[]> {
    try {
      const r = await this.deps.definitions().resolve(row.kind, row.definitionKey, row.definitionVersion);
      return (r.def as AutomationDefinition).requires?.portalRoles ?? [];
    } catch {
      return [];
    }
  }

  /** Who may see what a scheduled run collected: the schedule's `requires.portalRoles`, else Operator. */
  private async scheduledRoles(row: RunRow): Promise<readonly string[]> {
    const roles =
      row.scheduleId && this.scheduleRoles
        ? await this.scheduleRoles(row.scheduleId).catch(() => null)
        : null;
    return roles ?? SCHEDULED_DATA_ROLES;
  }

  /**
   * Who may see a run (§9): its initiator, or a Portal.Operator, Playbook.Approver or Portal.Admin who also holds the
   * roles its definition requires. Scheduled runs (automation identity) collected data with application
   * permissions: they need the schedule's `requires.portalRoles` (default Portal.Operator) plus the definition's roles,
   * like the schedule's report files and probe rows.
   */
  async canView(session: SessionRecord, row: RunRow, cache: ViewCache = new Map()): Promise<boolean> {
    const defRoles = () =>
      this.memo(cache, `def:${row.kind}:${row.definitionKey}@${row.definitionVersion}`, () =>
        this.definitionRoles(row),
      );
    if (row.identity === 'automation') {
      const scheduled = await this.memo(cache, `schedule:${row.scheduleId ?? ''}`, () =>
        this.scheduledRoles(row),
      );
      return hasEvery(session, scheduled) && hasEvery(session, await defRoles());
    }
    if (row.initiatorOid === session.userOid) return true;
    return hasAny(session, SEES_ALL) && hasEvery(session, await defRoles());
  }

  /** The run, if the caller may see it (or `also` allows them to act on it without seeing its data). */
  private async load(caller: Caller, id: string, also?: (s: SessionRecord) => boolean): Promise<RunRow> {
    const row = UUID.test(id) ? await this.deps.repo.getRun(id) : null;
    if (!row || !(also?.(caller.session) || (await this.canView(caller.session, row))))
      throw new AppError(404, 'run_not_found', 'No such run.');
    return row;
  }

  private async enqueueRoot(row: RunRow) {
    const root = await rootOf(this.deps.repo, row);
    await this.deps.queue.enqueue(root.id);
  }

  private newRun(
    def: AutomationDefinition,
    pinned: { version: string; sha256: string },
    fields: Partial<Pick<NewRun, 'id' | 'identityName'>> &
      Pick<
        NewRun,
        | 'dryRun'
        | 'trigger'
        | 'identity'
        | 'initiatorOid'
        | 'initiatorUpn'
        | 'sessionHash'
        | 'scheduleId'
        | 'inputs'
        | 'correlationId'
      >,
  ): NewRun {
    return {
      id: fields.id ?? randomUUID(),
      kind: def.kind,
      definitionKey: def.id,
      definitionVersion: pinned.version,
      definitionSha256: pinned.sha256,
      parentRunId: null,
      identityName: null,
      ...fields,
    };
  }

  // ── preview then confirm ──

  /**
   * Loads the preview a confirmed execution refers to and checks it is still a valid basis: same initiator, same
   * definition (key, version, sha256), a top-level dry run of the same trigger that succeeded, at most 15 minutes old.
   * Errors never say which check failed beyond "stale", and never echo the expected confirmation.
   */
  private async loadPreview(
    caller: Caller,
    def: AutomationDefinition,
    pinned: { version: string; sha256: string },
    trigger: 'interactive' | 'bulk',
    previewRunId: string | undefined,
  ): Promise<RunRow> {
    if (!previewRunId)
      throw new AppError(
        409,
        'preview_required',
        'Preview this change first — the confirmation is based on what the preview found.',
        {
          hint: 'Select Preview, check what it will change, then run it.',
        },
      );
    const stale = (why: string) =>
      new AppError(
        409,
        'preview_stale',
        `The preview no longer matches this change (${why}). Preview it again.`,
      );
    const preview = UUID.test(previewRunId) ? await this.deps.repo.getRun(previewRunId) : null;
    if (!preview || preview.initiatorOid !== caller.session.userOid) throw stale('not your preview');
    if (
      preview.definitionKey !== def.id ||
      preview.definitionVersion !== pinned.version ||
      preview.definitionSha256 !== pinned.sha256
    )
      throw stale('the playbook changed');
    if (!preview.dryRun || preview.trigger !== trigger || preview.parentRunId !== null)
      throw stale('not a dry run of this kind');
    if (preview.status !== 'succeeded')
      throw stale(`the preview ${preview.status === 'failed' ? 'failed' : 'did not finish'}`);
    const age = this.deps.now().getTime() - preview.createdAt.getTime();
    if (age > PREVIEW_MAX_AGE_MS || age < -60_000) throw stale('older than 15 minutes');
    return preview;
  }

  /** `confirm.value` rendered against the preview: its inputs and its stored (secret-masked) step outputs. */
  private async previewScope(
    def: AutomationDefinition,
    preview: RunRow,
    session: SessionRecord,
  ): Promise<Record<string, unknown>> {
    const steps: Record<string, { output: unknown; status: string; error: unknown }> = {};
    for (const r of await this.deps.repo.listSteps(preview.id)) {
      if (/[[#>]/.test(r.path)) continue; // top-level steps only (latest record wins: listSteps is in seq order)
      steps[r.stepId] = {
        output: r.output === null ? undefined : r.output,
        status: r.status,
        error: r.error,
      };
    }
    return {
      inputs: preview.inputs,
      steps,
      run: { id: preview.id, dryRun: true, definition: { key: def.id, version: preview.definitionVersion } },
      user: { kind: 'delegated', oid: session.userOid, upn: session.upn, roles: session.roles },
      env: this.deps.env(),
      now: preview.createdAt.toISOString(),
    };
  }

  private async checkTyped(
    def: AutomationDefinition,
    preview: RunRow,
    caller: Caller,
    typed: string | undefined,
    expectedOverride?: string,
  ) {
    const confirm = def.confirm!;
    let expected = expectedOverride;
    let scope: Record<string, unknown> | undefined;
    if (expected === undefined) {
      scope = await this.previewScope(def, preview, caller.session);
      let v: unknown;
      try {
        v = await renderTemplate(confirm.value, scope);
      } catch {
        v = undefined;
      }
      // Only plain values can be typed; a masked secret (object) or a missing value can never be the confirmation.
      if (typeof v !== 'string' && typeof v !== 'number')
        throw new AppError(
          409,
          'preview_stale',
          'The preview did not produce the value to confirm. Preview it again.',
        );
      expected = String(v);
    }
    if (typed !== undefined && fold(typed) === fold(expected) && fold(expected) !== '') return;
    let message =
      expectedOverride !== undefined
        ? 'Type the number of items to confirm this change.'
        : "The confirmation doesn't match.";
    if (expectedOverride === undefined && confirm.message) {
      try {
        const m = await renderTemplate(
          confirm.message,
          scope ?? (await this.previewScope(def, preview, caller.session)),
        );
        // Never echo the expected value, even if the author's message contains it.
        if (typeof m === 'string' && m.trim() && !fold(m).includes(fold(expected))) message = m;
      } catch {
        // keep the generic message
      }
    }
    throw new AppError(422, 'confirmation_mismatch', message, {
      hint: 'Type the confirmation exactly as asked (case does not matter).',
    });
  }

  /** The audit/event record of a confirmed execution. */
  private confirmed(def: AutomationDefinition, preview: RunRow): Confirmed {
    const typed = def.confirm!.type === 'typed';
    return { previewRunId: preview.id, confirm: typed ? 'typed' : 'click', confirmationMatched: typed };
  }

  /** Executions of playbooks with a confirm block need a preview (and, for typed confirms, the matching text). */
  private needsConfirmation(def: AutomationDefinition, dryRun: boolean) {
    return !dryRun && !!def.confirm && def.confirm.type !== 'none';
  }

  /**
   * Inserts a run someone starts from the portal (a run, a preview or a bulk run), unless they already have
   * `maxOpenRuns` queued or running (F-08: 429 `too_many_runs`). A confirmed execution gets the id derived from its
   * preview, so a preview is used at most once (a replayed or concurrent confirmation finds the run the first one
   * started).
   */
  private async insert(run: NewRun, caller: Caller, confirmed: Confirmed | null): Promise<RunRow> {
    const max = this.deps.maxOpenRuns ?? DEFAULT_MAX_OPEN_RUNS;
    const res = await this.deps.repo.insertOpenRun(
      confirmed ? { ...run, id: confirmedRunId(confirmed.previewRunId) } : run,
      { max, ifAbsent: confirmed !== null },
    );
    if (!res.ok) throw tooManyRuns(max);
    const row = res.row;
    if (!confirmed) return row;
    if (row.correlationId !== caller.correlationId)
      throw new AppError(
        409,
        'preview_stale',
        'This preview was already used to start a run. Preview it again to run the change again.',
        { hint: 'Select Preview, check what it will change, then run it.' },
      );
    return row;
  }

  private async recordPreview(runId: string, c: Confirmed) {
    await this.deps.store.appendEvent(runId, {
      type: 'status',
      data: {
        scope: 'run',
        status: 'queued',
        previewRunId: c.previewRunId,
        confirm: c.confirm,
        confirmationMatched: c.confirmationMatched,
      },
    });
  }

  // ── create ──

  async create(caller: Caller, input: CreateRunInput): Promise<RunRow> {
    const dryRun = input.dryRun === true;
    const pinned = await this.resolveCurrent(input.playbook, input.version);
    const def = pinned.def;
    this.checkRunnable(def, dryRun);
    this.authorize(caller.session, def, dryRun);
    let inputs: Record<string, unknown>;
    let confirmed: Confirmed | null = null;
    if (this.needsConfirmation(def, dryRun)) {
      const preview = await this.loadPreview(caller, def, pinned, 'interactive', input.previewRunId);
      // Validate as of the preview, so relative defaults (dates, `now`) resolve exactly as previewed.
      inputs = await this.validate(def, input.inputs, 'inputs', preview.createdAt);
      if (canonicalJson(inputs) !== canonicalJson(preview.inputs))
        throw new AppError(
          409,
          'preview_stale',
          'The preview no longer matches this change (different inputs). Preview it again.',
        );
      if (def.confirm!.type === 'typed') await this.checkTyped(def, preview, caller, input.confirmation);
      inputs = preview.inputs;
      confirmed = this.confirmed(def, preview);
    } else inputs = await this.validate(def, input.inputs);
    const s = caller.session;
    const row = await this.insert(
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
      caller,
      confirmed,
    );
    await this.deps.audit.append({
      ...this.actor(caller),
      action: 'run.created',
      targetType: 'run',
      targetId: row.id,
      details: {
        definition: def.id,
        version: pinned.version,
        sha256: pinned.sha256,
        kind: def.kind,
        dryRun,
        trigger: 'interactive',
        risk: def.risk,
        inputs: redactInputs(def.inputs, inputs),
        ...(confirmed ?? {}),
      },
      result: 'success',
    });
    if (confirmed) await this.recordPreview(row.id, confirmed);
    await this.deps.queue.enqueue(row.id);
    return row;
  }

  /**
   * Bulk action: one parent run (trigger `bulk`) whose synthesised definition is a forEach over the items; each item
   * runs the target playbook as a child run. Every item is validated up front against the target's inputs.
   */
  async createBulk(caller: Caller, input: BulkRunInput): Promise<RunRow> {
    const dryRun = input.dryRun === true;
    const pinned = await this.resolveCurrent(input.playbook, input.version, ['playbook']);
    const def = pinned.def;
    this.checkRunnable(def, dryRun);
    this.authorize(caller.session, def, dryRun);
    if (!input.items.length)
      throw new AppError(400, 'invalid_request', 'A bulk action needs at least one item.');
    if (input.items.length > 1000)
      throw new AppError(400, 'invalid_request', 'A bulk action takes at most 1000 items.');
    const needsConfirmation = this.needsConfirmation(def, dryRun);
    const preview = needsConfirmation
      ? await this.loadPreview(caller, def, pinned, 'bulk', input.previewRunId)
      : null;
    const items: Array<Record<string, unknown>> = [];
    const problems: string[] = [];
    for (const [i, item] of input.items.entries()) {
      const v = await validateInputs(
        def.inputs,
        { ...(input.inputsTemplate ?? {}), ...item },
        { now: preview?.createdAt ?? this.deps.now(), env: this.deps.env() },
      );
      if (v.ok) items.push(v.values);
      else problems.push(describeIssues(v.errors, `items[${i}]`));
      if (problems.length >= 10) break;
    }
    if (problems.length)
      throw new AppError(400, 'invalid_inputs', `Some items are not valid. ${problems.join('; ')}`);
    const bulkInputs = {
      items,
      ...(input.concurrency ? { concurrency: input.concurrency } : {}),
      ...(input.stopOnError ? { stopOnError: true } : {}),
    };
    let confirmed: Confirmed | null = null;
    if (preview) {
      if (canonicalJson(bulkInputs) !== canonicalJson(preview.inputs))
        throw new AppError(
          409,
          'preview_stale',
          'The preview no longer matches this change (different items). Preview it again.',
        );
      // Bulk: type the number of objects changed ("Type 12 to confirm changing 12 objects").
      if (def.confirm!.type === 'typed')
        await this.checkTyped(def, preview, caller, input.confirmation, String(items.length));
      confirmed = this.confirmed(def, preview);
    }
    const s = caller.session;
    const row = await this.insert(
      this.newRun(def, pinned, {
        dryRun,
        trigger: 'bulk',
        identity: 'delegated',
        initiatorOid: s.userOid,
        initiatorUpn: s.upn,
        sessionHash: s.idHash,
        scheduleId: null,
        inputs: preview ? preview.inputs : bulkInputs,
        correlationId: caller.correlationId,
      }),
      caller,
      confirmed,
    );
    await this.deps.audit.append({
      ...this.actor(caller),
      action: 'run.created',
      targetType: 'run',
      targetId: row.id,
      details: {
        definition: def.id,
        version: pinned.version,
        sha256: pinned.sha256,
        kind: def.kind,
        dryRun,
        trigger: 'bulk',
        risk: def.risk,
        items: items.length,
        // The inputs every item shares (a reason, a message), redacted like a single run's: the per-item runs don't
        // record their inputs, so this is where the audit log keeps why.
        ...(input.inputsTemplate && Object.keys(input.inputsTemplate).length
          ? { inputs: redactInputs(def.inputs, input.inputsTemplate) }
          : {}),
        ...(confirmed ?? {}),
      },
      result: 'success',
    });
    if (confirmed) await this.recordPreview(row.id, confirmed);
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
    const dryRun = input.dryRun === true;
    this.checkRunnable(def, dryRun);
    // Write capability of the whole tree: a child playbook can change data even when the top level reads only.
    const writes = await writesInTree(
      (r, v) => this.resolve(r, v),
      ref,
      (d) => d.mode === 'write' || hasWriteSteps(d),
    );
    if (writes && !dryRun && !input.schedule.approvedBy?.length)
      throw new AppError(
        403,
        'two_person_required',
        `Schedule ${input.schedule.key} runs a write playbook and needs a second person's approval before it can run.`,
      );
    if (writes && !dryRun) {
      // The approval covered specific playbook versions: anything published since needs a new approval.
      const current = await this.fingerprint(ref);
      if (input.schedule.approvedTarget !== current) {
        await this.deps.audit.append({
          actorOid: 'automation',
          actorUpn: 'automation identity',
          mode: 'read',
          action: 'schedule.approval_outdated',
          correlationId: input.correlationId ?? randomUUID(),
          targetType: 'schedule',
          targetId: input.schedule.key,
          result: 'denied',
          details: { playbook: ref.ref, version: pinned.version, sha256: pinned.sha256 },
        });
        throw new AppError(
          409,
          'approval_outdated',
          `${def.title} changed after schedule ${input.schedule.key} was approved, so it didn't run.`,
          {
            hint: 'The schedule has been switched off. Enable it again; a second person must approve the current version.',
          },
        );
      }
    }
    const inputs = await this.validate(def, input.inputs);
    const correlationId = input.correlationId ?? randomUUID();
    const row = await this.deps.repo.insertRun(
      this.newRun(def, pinned, {
        dryRun,
        trigger: 'schedule',
        identity: 'automation',
        identityName: input.schedule.identity ?? null,
        // An oid, so self-approval checks work: Run now's requester (who then can't approve gates in it), else the
        // schedule's creator when that is an oid. Cron runs of content schedules have no initiating person.
        initiatorOid:
          [input.schedule.requestedByOid, input.schedule.createdBy].find(
            (v): v is string => typeof v === 'string' && UUID.test(v),
          ) ?? null,
        initiatorUpn: input.schedule.createdBy ?? null,
        sessionHash: null,
        scheduleId: input.schedule.id && UUID.test(input.schedule.id) ? input.schedule.id : null,
        inputs,
        correlationId,
      }),
    );
    await this.deps.audit.append({
      actorOid: 'automation',
      actorUpn: executedAs(row),
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
        executedAs: executedAs(row),
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
    if (q.scope === 'all' && !hasAny(caller.session, SEES_ALL))
      throw new AppError(
        403,
        'forbidden',
        'Seeing everyone’s runs needs the Portal.Operator, Playbook.Approver or Portal.Admin role.',
      );
    // Runs the caller may not open (scheduled data, definition roles) are left out; keep reading until the page is
    // full, the runs run out, or a few batches were scanned (the cursor then continues after the last one scanned).
    const cache: ViewCache = new Map();
    const visible: RunRow[] = [];
    let cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    let exhausted = false;
    let lastScanned: RunRow | undefined;
    for (let batch = 0; batch < 5 && visible.length <= q.limit; batch++) {
      const rows = await this.deps.repo.listRuns({
        ...(q.scope === 'mine' ? { initiatorOid: caller.session.userOid } : {}),
        ...(q.statuses?.length ? { statuses: q.statuses } : {}),
        ...(q.definitionKey ? { definitionKey: q.definitionKey } : {}),
        ...(q.parentRunId ? { parentRunId: q.parentRunId } : {}),
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
        limit: q.limit + 1,
        ...(cursor ? { cursor } : {}),
      });
      for (const r of rows) {
        lastScanned = r;
        if (await this.canView(caller.session, r, cache)) visible.push(r);
        if (visible.length > q.limit) break;
      }
      if (rows.length <= q.limit) {
        exhausted = true;
        break;
      }
      cursor = { createdAt: lastScanned!.createdAt, id: lastScanned!.id };
    }
    const page = visible.slice(0, q.limit);
    const titles = await this.titles(page);
    const next =
      visible.length > q.limit ? page[page.length - 1]! : !exhausted && lastScanned ? lastScanned : undefined;
    return {
      items: page.map((r) => runSummary(r, titles.get(r.id))),
      ...(next ? { cursor: encodeCursor(next) } : {}),
    };
  }

  async get(caller: Caller, id: string): Promise<RunDetail> {
    const row = await this.load(caller, id);
    const { repo } = this.deps;
    const [steps, tasks, children, firstEvents] = await Promise.all([
      repo.listSteps(id),
      repo.listTasks({ runId: id }),
      repo.listRuns({ parentRunId: id, limit: 1000 }),
      repo.listEvents(id, 0, 5),
    ]);
    const previewRunId =
      firstEvents.map((e) => e.data.previewRunId).find((v): v is string => typeof v === 'string') ?? null;
    let def: AutomationDefinition | null;
    let params: AutomationDefinition['inputs'];
    try {
      def = await pinnedDefinition(this.deps.definitions(), row);
      if (row.trigger === 'bulk')
        params = (await this.resolve(row.definitionKey, row.definitionVersion, ['playbook'])).def.inputs;
    } catch {
      def = null;
    }
    const titles = await this.titles(children);
    // Values typed into a manual step's `redact: true` fields are masked like secret inputs.
    const manualParams = (t: TaskRow) => {
      const step = def && t.stepId ? findStep(def, stepIdOf(t.stepId)) : undefined;
      return step?.type === 'manual' ? step.inputs : undefined;
    };
    return {
      run: { ...runView(row, def, steps, params), previewRunId },
      steps: steps.map(stepView),
      plan: runPlan(steps),
      tasks: tasks.map((t) => taskView(t, this.canDecide(caller.session, row, t), manualParams(t))),
      children: children.map((c) => runSummary(c, titles.get(c.id))),
    };
  }

  /** Events after `afterId` (SSE replay). Access is checked by the caller via `load`. */
  async assertViewable(caller: Caller, id: string): Promise<RunRow> {
    return this.load(caller, id);
  }

  // ── control ──

  async cancel(caller: Caller, id: string): Promise<RunRow> {
    // A Portal.Admin can stop any run, including a scheduled one whose data they may not see.
    const row = await this.load(caller, id, (s) => hasRole(s, 'Portal.Admin'));
    if (row.initiatorOid !== caller.session.userOid && !hasRole(caller.session, 'Portal.Admin'))
      throw new AppError(
        403,
        'forbidden',
        'Only the engineer who started this run (or a Portal.Admin) can cancel it.',
      );
    if (isTerminal(row.status))
      throw new AppError(409, 'run_finished', `The run already ended (${row.status}).`);
    const now = this.deps.now();
    const tree = await this.deps.repo.runTree(row.id);
    let cancelled = 0;
    for (const r of tree) {
      if (isTerminal(r.status)) continue;
      const updated = await this.deps.store.updateRun(
        r.id,
        { status: 'cancelled', endedAt: now },
        NON_TERMINAL,
      );
      if (!updated) continue;
      cancelled++;
      await this.deps.store.appendEvent(r.id, {
        type: 'status',
        data: { scope: 'run', status: 'cancelled', by: caller.session.upn },
      });
      for (const t of await this.deps.repo.listTasks({ runId: r.id, status: 'pending' }))
        await this.deps.repo.updateTask(t.id, { status: 'cancelled', decidedAt: now }, 'pending');
    }
    await this.deps.audit.append({
      ...this.actor(caller),
      action: 'run.cancelled',
      targetType: 'run',
      targetId: row.id,
      details: {
        definition: row.definitionKey,
        version: row.definitionVersion,
        previousStatus: row.status,
        runsCancelled: cancelled,
      },
      result: 'success',
    });
    // A cancelled child fails its parent's step; let the parent react.
    if (row.parentRunId) await this.enqueueRoot(row);
    return (await this.deps.repo.getRun(row.id))!;
  }

  /**
   * IAM-02: resuming re-checks what starting the run checked.
   * - Every unfinished run in the tree is still on the current published version; otherwise the run ends
   *   `run_outdated` (an older version may lack roles, approvals or fixes added since).
   * - The caller is still allowed to run it: the initiator passes the same check as starting it, anyone else the
   *   playbook's roles (the check an approver passed).
   * - A confirmed change parked on arming or signing in before it wrote anything still has a preview (or an approval)
   *   from the last 15 minutes; otherwise it ends `preview_stale` (nothing changed yet; preview it again).
   */
  private async checkContinuable(caller: Caller, root: RunRow, tree: RunRow[], tasks: TaskRow[]) {
    const s = caller.session;
    const now = this.deps.now();
    const { repo, store } = this.deps;
    const refuse = async (error: RunError, status: number) => {
      await failTree({ repo, store }, tree, error, now);
      await this.deps.audit.append({
        ...this.actor(caller),
        action: 'run.resumed',
        targetType: 'run',
        targetId: root.id,
        details: { definition: root.definitionKey, version: root.definitionVersion, refused: error.code },
        result: 'denied',
      });
      return new AppError(status, error.code, error.message, error.hint ? { hint: error.hint } : {});
    };
    const stale = await outdatedRun(this.deps.definitions(), repo, tree);
    if (stale)
      throw await refuse(
        runOutdated({
          definition: stale.row.definitionKey,
          version: stale.row.definitionVersion,
          current: stale.current,
        }),
        409,
      );
    const def = await pinnedDefinition(this.deps.definitions(), root);
    if (tree.some((r) => r.initiatorOid === s.userOid)) this.authorize(s, def, root.dryRun);
    else for (const role of def.requires?.portalRoles ?? []) requireRole(s, role, `Resuming ${def.title}`);

    if (root.dryRun || (root.status !== 'awaiting_arm' && root.status !== 'awaiting_reauth')) return;
    // Bulk runs execute a synthesised wrapper: the confirm block is the target playbook's.
    const target =
      root.trigger === 'bulk'
        ? (await this.resolve(root.definitionKey, root.definitionVersion, ['playbook'])).def
        : def;
    if (!target.confirm || target.confirm.type === 'none') return;
    const previewRunId = (await repo.listEvents(root.id, 0, 5))
      .map((e) => e.data.previewRunId)
      .find((v): v is string => typeof v === 'string');
    const preview = previewRunId && UUID.test(previewRunId) ? await repo.getRun(previewRunId) : null;
    const basis = Math.max(
      preview?.createdAt.getTime() ?? 0,
      ...tasks
        .filter((t) => t.policy.kind === 'approval' && t.status === 'approved' && t.decidedAt)
        .map((t) => t.decidedAt!.getTime()),
    );
    if (now.getTime() - basis <= PREVIEW_MAX_AGE_MS || (await wroteAnything(repo, tree))) return;
    throw await refuse(
      {
        code: 'preview_stale',
        message:
          'The preview this change was confirmed from is more than 15 minutes old, so the run stopped before changing anything.',
        hint: 'Preview it again, then run it.',
      },
      409,
    );
  }

  async resume(caller: Caller, id: string): Promise<RunRow> {
    const row = await this.load(caller, id);
    const root = await rootOf(this.deps.repo, row);
    if (isTerminal(root.status))
      throw new AppError(409, 'run_finished', `The run already ended (${root.status}).`);
    const oid = caller.session.userOid;
    const tree = await this.deps.repo.runTree(root.id);
    const tasks = await this.deps.repo.listTasks({ runIds: tree.map((r) => r.id) });
    const involved =
      tree.some((r) => r.initiatorOid === oid) || tasks.some((t) => t.decisions.some((d) => d.oid === oid));
    if (!involved && !hasRole(caller.session, 'Portal.Admin'))
      throw new AppError(
        403,
        'forbidden',
        'Only the engineers acting in this run (or a Portal.Admin) can resume it.',
      );
    await this.checkContinuable(caller, root, tree, tasks);
    // ADR-010: steps run with the actor's *current* session; rebind it everywhere this user acts in the run tree.
    let rebound = 0;
    for (const r of tree) {
      if (r.identity !== 'delegated' || r.initiatorOid !== oid || r.sessionHash === caller.session.idHash)
        continue;
      await this.deps.repo.updateRun(r.id, { sessionHash: caller.session.idHash });
      rebound++;
    }
    for (const t of tasks) {
      if (!t.decisions.some((d) => d.oid === oid && d.sessionHash !== caller.session.idHash)) continue;
      await this.deps.repo.updateTask(t.id, {
        decisions: t.decisions.map((d) => (d.oid === oid ? { ...d, sessionHash: caller.session.idHash } : d)),
      });
      rebound++;
    }
    await this.deps.audit.append({
      ...this.actor(caller),
      action: 'run.resumed',
      targetType: 'run',
      targetId: root.id,
      details: {
        definition: root.definitionKey,
        version: root.definitionVersion,
        status: root.status,
        sessionsRebound: rebound,
      },
      result: 'success',
    });
    await this.deps.queue.enqueue(root.id);
    return (await this.deps.repo.getRun(root.id))!;
  }

  // ── human tasks ──

  private canDecide(session: SessionRecord, run: RunRow, t: TaskRow): boolean {
    if (t.status !== 'pending' || isTerminal(run.status)) return false;
    if (t.decisions.some((d) => d.oid === session.userOid)) return false;
    // Manual steps: the person the step waits for confirms; the initiator or an Operator may also decline.
    if (t.policy.kind === 'manual')
      return (
        run.initiatorOid === session.userOid ||
        t.requestedBy === session.userOid ||
        hasRole(session, 'Portal.Operator')
      );
    return (
      hasRole(session, 'Playbook.Approver') &&
      hasAny(session, t.policy.approvers) &&
      run.initiatorOid !== session.userOid &&
      t.policy.initiatorOid !== session.userOid &&
      !grantsAccessTo(t, session.userOid)
    );
  }

  private async expire(t: TaskRow, run: RunRow): Promise<boolean> {
    if (t.status !== 'pending' || !t.expiresAt || t.expiresAt > this.deps.now()) return false;
    if (await this.deps.repo.updateTask(t.id, { status: 'expired', decidedAt: this.deps.now() }, 'pending'))
      await this.enqueueRoot(run);
    return true;
  }

  async decideApproval(
    caller: Caller,
    id: string,
    path: string,
    input: { decision: 'approve' | 'reject'; comment?: string },
  ): Promise<{ status: TaskRow['status']; approvals: number; required: number }> {
    const s = caller.session;
    requireRole(s, 'Playbook.Approver', 'Approving runs');
    // An approver named by the gate may decide on it without being allowed to see the run's data (scheduled runs need
    // the schedule's roles for that); the approvals inbox shows what is being approved.
    const row = UUID.test(id) ? await this.deps.repo.getRun(id) : null;
    const task = row ? await this.deps.repo.getTask(id, path) : null;
    const approver = task?.policy.kind === 'approval' && hasAny(s, task.policy.approvers);
    if (!row || (!approver && !(await this.canView(s, row))))
      throw new AppError(404, 'run_not_found', 'No such run.');
    if (!task || task.policy.kind !== 'approval')
      throw new AppError(404, 'approval_not_found', 'This run has no approval at that step.');
    if (isTerminal(row.status))
      throw new AppError(409, 'run_finished', `The run already ended (${row.status}).`);
    if (await this.expire(task, row))
      throw new AppError(409, 'approval_expired', 'This approval request has expired.');
    if (task.status !== 'pending')
      throw new AppError(409, 'already_decided', `This approval was already ${task.status}.`);
    const root = row.parentRunId ? await rootOf(this.deps.repo, row) : row;
    if ([row.initiatorOid, root.initiatorOid, task.policy.initiatorOid, task.requestedBy].includes(s.userOid))
      throw new AppError(403, 'own_run', 'You cannot approve a run you started.', {
        hint: 'Ask another approver.',
      });
    // ENG-02: whoever the change grants access to (the gate's `excludes`) can't approve or reject it either.
    if (grantsAccessTo(task, s.userOid))
      throw new AppError(403, 'own_access', "This change grants you access, so you can't approve it.", {
        hint: 'Ask another approver.',
      });
    if (!hasAny(s, task.policy.approvers))
      throw new AppError(
        403,
        'forbidden',
        `This approval needs one of: ${task.policy.approvers.join(', ')}.`,
      );
    if (task.decisions.some((d) => d.oid === s.userOid))
      throw new AppError(409, 'already_decided', 'You already decided on this approval.');
    if (input.decision === 'approve' && row.identity === 'delegated') {
      // The steps after the gate run as the approver: they need the roles the playbook requires, like its initiator.
      const def = await pinnedDefinition(this.deps.definitions(), row).catch(() => null);
      const missing = (def?.requires?.portalRoles ?? []).filter((r) => !hasRole(s, r));
      if (missing.length)
        throw new AppError(
          403,
          'forbidden',
          `The steps after this approval run as you, and ${def!.title} needs the ${missing.join(' and ')} role.`,
          { hint: 'Ask an approver who holds that role, or a portal administrator for the role.' },
        );
    }
    if (
      input.decision === 'approve' &&
      task.policy.writesAfter &&
      !row.dryRun &&
      !isArmed(s, this.deps.now())
    )
      throw new AppError(403, 'not_armed', 'The steps after this approval change data and will run as you.', {
        hint: 'Arm write access, then approve.',
      });
    const decisions = [
      ...task.decisions,
      {
        oid: s.userOid,
        upn: s.upn,
        decision: input.decision,
        comment: input.comment ?? null,
        sessionHash: s.idHash,
        at: this.deps.now().toISOString(),
      },
    ];
    const approvals = decisions.filter((d) => d.decision === 'approve').length;
    const required = task.policy.minApprovals ?? 1;
    const status: TaskRow['status'] =
      input.decision === 'reject' ? 'rejected' : approvals >= required ? 'approved' : 'pending';
    const updated = await this.deps.repo.updateTask(
      task.id,
      { decisions, status, decidedAt: status === 'pending' ? null : this.deps.now() },
      'pending',
    );
    if (!updated)
      throw new AppError(409, 'already_decided', 'Someone else decided on this approval at the same time.');
    await this.deps.audit.append({
      ...this.actor(caller),
      action: input.decision === 'approve' ? 'run.approved' : 'run.rejected',
      targetType: 'run',
      targetId: id,
      details: {
        definition: row.definitionKey,
        version: row.definitionVersion,
        step: path,
        comment: input.comment ?? null,
        approvals,
        required,
        final: status !== 'pending',
      },
      result: 'success',
    });
    await this.deps.store.appendEvent(id, {
      type: 'log',
      level: 'info',
      data: {
        message: `${input.decision === 'approve' ? 'Approved' : 'Rejected'} by ${s.upn}${input.comment ? `: ${input.comment}` : ''}`,
        path,
        decision: input.decision,
      },
    });
    if (status !== 'pending') await this.enqueueRoot(row);
    return { status, approvals, required };
  }

  async confirmManual(
    caller: Caller,
    id: string,
    path: string,
    input: { confirmed: boolean; notes?: string; values?: Record<string, unknown> },
  ): Promise<{ status: TaskRow['status'] }> {
    const s = caller.session;
    const row = await this.load(caller, id);
    const task = await this.deps.repo.getTask(id, path);
    if (!task || task.policy.kind !== 'manual')
      throw new AppError(404, 'task_not_found', 'This run has no manual step there.');
    if (isTerminal(row.status))
      throw new AppError(409, 'run_finished', `The run already ended (${row.status}).`);
    if (task.status !== 'pending')
      throw new AppError(
        409,
        'already_decided',
        `This step was already ${task.status === 'approved' ? 'confirmed' : task.status}.`,
      );
    // The person the step waits for: the run's initiator, or the approver after an approval (null: a scheduled run).
    const actor = task.requestedBy && task.requestedBy !== 'automation' ? task.requestedBy : null;
    if (row.initiatorOid !== s.userOid && actor !== s.userOid && !hasRole(s, 'Portal.Operator'))
      throw new AppError(
        403,
        'forbidden',
        'Only the engineer running this (or a Portal.Operator) can answer its steps.',
      );
    let values: Record<string, unknown> = {};
    const def = await pinnedDefinition(this.deps.definitions(), row).catch(() => null);
    const step = def ? findStep(def, stepIdOf(path)) : undefined;
    const params = step?.type === 'manual' ? step.inputs : undefined;
    if (input.confirmed) {
      // The steps that follow act as the person the step is waiting for, so only they confirm it (and fill in its
      // values); anyone else may only decline (IAM-10). A scheduled run waits for nobody: its initiator or an
      // Operator may confirm, without values.
      const takesValues = Object.keys(params ?? {}).length > 0 || Object.keys(input.values ?? {}).length > 0;
      if (actor ? actor !== s.userOid : takesValues)
        throw new AppError(
          403,
          'not_your_step',
          takesValues
            ? 'Only the engineer this step is waiting for can fill it in: the steps after it use these values and run as them.'
            : 'Only the engineer this step is waiting for can confirm it: the steps after it run as them.',
          {
            hint: `Ask ${task.policy.requestedByUpn ?? 'the engineer running it'} to complete it, or mark it as not done.`,
          },
        );
      if (params || input.values) {
        const v = await validateInputs(params, input.values ?? {}, {
          now: this.deps.now(),
          env: this.deps.env(),
        });
        if (!v.ok)
          throw new AppError(
            400,
            'invalid_inputs',
            `The values are not valid. ${describeIssues(v.errors, 'values')}`,
          );
        values = v.values;
      }
    }
    const decisions = [
      ...task.decisions,
      {
        oid: s.userOid,
        upn: s.upn,
        decision: input.confirmed ? ('confirm' as const) : ('decline' as const),
        comment: input.notes ?? null,
        values,
        sessionHash: s.idHash,
        at: this.deps.now().toISOString(),
      },
    ];
    const status = input.confirmed ? 'approved' : 'rejected';
    const updated = await this.deps.repo.updateTask(
      task.id,
      { decisions, status, decidedAt: this.deps.now() },
      'pending',
    );
    if (!updated)
      throw new AppError(409, 'already_decided', 'Someone else answered this step at the same time.');
    await this.deps.audit.append({
      ...this.actor(caller),
      action: input.confirmed ? 'run.manual.confirmed' : 'run.manual.declined',
      targetType: 'run',
      targetId: id,
      details: {
        definition: row.definitionKey,
        version: row.definitionVersion,
        step: path,
        notes: input.notes ?? null,
        // What was typed in, with `redact: true` fields masked.
        values: redactInputs(params, values),
      },
      result: 'success',
    });
    await this.deps.store.appendEvent(id, {
      type: 'log',
      level: 'info',
      data: {
        message: `${input.confirmed ? 'Confirmed' : 'Declined'} by ${s.upn}${input.notes ? `: ${input.notes}` : ''}`,
        path,
      },
    });
    await this.enqueueRoot(row);
    return { status };
  }

  /** Approver inbox: approval tasks the caller may act on (or has acted on). */
  async listApprovals(caller: Caller, q: { status?: TaskRow['status'] }): Promise<{ items: TaskView[] }> {
    const s = caller.session;
    requireRole(s, 'Playbook.Approver', 'The approval inbox');
    const tasks = await this.deps.repo.listTasks({
      kind: 'approval',
      ...(q.status ? { status: q.status } : {}),
    });
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
