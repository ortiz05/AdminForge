import { createHash, randomBytes } from 'node:crypto';
import {
  PortalScheduleRequest,
  Schedule,
  validateCron,
  type DeliveryOptionsResponse,
  type PortalRole,
} from '@adminforge/schemas';
import { canonical } from '../audit/chain';
import type { AuditWriter } from '../audit/writer';
import { requireRole } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import { advancedParamOf } from '../datasources/advanced';
import type { DatasourceRunner, LoadedPage } from '../datasources/executor';
import type { DefinitionResolver } from '../definitions/types';
import { AppError, parseBody } from '../errors';
import { InvalidParams } from '../datasources/params';
import { isSchedulableParam, maskRedacted, REDACTED } from '../reports/catalog';
import { nextRun, runsTooOften } from './cron';
import {
  deliveryKeyLabel,
  deliveryOptions,
  isRecipientList,
  isWebhook,
  mailAvailable,
} from './delivery-keys';
import { AUTOMATION_USER } from './jobs';
import { copiedRequires, invalidCron, notifyTargets, reportJobDocument, scheduleDocument } from './scaffold';
import { actorOf, canManage, type Caller, type ScheduleItem, type ScheduleService } from './service';
import type { ScheduleStore } from './store';
import type { PortalInsertResult, ScheduleRow } from './types';

/**
 * Report schedules created in the portal (Reports → Schedule). They run at once — no git review — so the server keeps
 * them narrow: report jobs only (read-only, as the automation identity), at most hourly, delivered only to recipient
 * lists and webhooks named in the installation's configuration, capped per person and in total, and audited. The
 * definition is built with the schedule editor's builder (scaffold.ts) and validated with the Schedule schema; the row
 * is `source: 'portal'` under the reserved `portal.` key namespace. The creator (by oid) or a Portal.Admin may edit or
 * delete one; any Operator may turn it off (PATCH). Deleting retires the definition and keeps the run history.
 * Only params a schedule may set (isSchedulableParam) are accepted; names and summaries are plain single-line text
 * (they reach email and Teams). Before each run the scheduler confirms the creator still holds the roles
 * (creator-access.ts).
 */

/** 200 active in total, 25 active per person, 50 created per person in any 24 hours (deleted ones count). */
export const PORTAL_SCHEDULE_LIMITS = { total: 200, perCreator: 25, perDay: 50 } as const;
const DAY_MS = 86_400_000;
const RETRIES = 2;

type Env = Record<string, string | undefined>;
type ReportDef = LoadedPage['def'];

export interface PortalScheduleDeps {
  service: ScheduleService;
  store: ScheduleStore;
  definitions: Pick<DefinitionResolver, 'resolve'>;
  datasources: Pick<DatasourceRunner, 'prepareParams'>;
  audit: AuditWriter;
  /** Delivery configuration (recipient lists, webhooks, sender) — key names are checked against it. */
  deliveryEnv: () => Env;
  now: () => Date;
  /** Six hex characters for new keys (tests make it predictable). */
  suffix?: () => string;
}

const sha256 = (def: Schedule) => createHash('sha256').update(canonical(def)).digest('hex');

/** Validates the built document with the content schema (the same one `adminforge validate` uses). */
function parseSchedule(doc: Record<string, unknown>): Schedule {
  const r = Schedule.safeParse(doc);
  if (!r.success)
    throw new AppError(
      400,
      'invalid_request',
      `The schedule wouldn’t be valid: ${r.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'schedule'}: ${i.message}`)
        .join('; ')}`,
    );
  return r.data;
}

/** 1.2.3 → 1.2.4 (pre-release/build parts are dropped). */
export function bumpPatch(version: string): string {
  const [major = '1', minor = '0', patch = '0'] = version.split(/[-+]/)[0]!.split('.');
  return `${Number(major) || 0}.${Number(minor) || 0}.${(Number(patch) || 0) + 1}`;
}

/** `portal.<ref with . → ->-<6 hex>`, e.g. portal.identity-inactive-users-3f9a2c. Keys are never reused. */
export const portalScheduleKey = (ref: string, suffix: string) =>
  `portal.${ref.replace(/\./g, '-')}-${suffix}`;

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

/** Line breaks, control and format characters (incl. bidirectional overrides and zero-width ones). */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
/** Links and markup: schemes, www., Markdown links, angle brackets. */
const LINK_LIKE = /(https?:|www\.|\]\(|[<>])/i;

/**
 * A schedule's name and summary reach email subjects and Teams cards, so they are plain single-line text: no line
 * breaks, control or format characters (bidi overrides), and nothing that reads as a link or markup.
 */
export function assertPlainText(field: 'name' | 'summary', value: string | undefined): void {
  if (!value) return;
  if (CONTROL_OR_FORMAT.test(value))
    throw new AppError(
      400,
      'invalid_request',
      `The schedule’s ${field} can only be one line of plain text (no line breaks or special characters).`,
      { hint: 'Type it again as plain text, e.g. “Inactive users, weekly”.' },
    );
  if (LINK_LIKE.test(value))
    throw new AppError(400, 'invalid_request', `The schedule’s ${field} can’t contain links or markup.`, {
      hint: 'Leave out web addresses, “www.”, Markdown links and < or >: recipients see it in email and Teams.',
    });
}

/** POST/PUT body: other job kinds are content (a clear refusal rather than a schema error). */
function parseRequest(raw: unknown): PortalScheduleRequest {
  const kind = (raw as { job?: { kind?: unknown } } | null | undefined)?.job?.kind;
  if (kind !== undefined && kind !== 'report')
    throw new AppError(400, 'job_not_allowed', 'Only report schedules can be created in the portal.', {
      hint: 'Probes, playbooks and other jobs are content: make the YAML in Schedules → New schedule (or with the adding-a-schedule-or-probe skill) and publish it after review.',
    });
  return parseBody(PortalScheduleRequest, raw);
}

const notConfigured = (message: string, hint: string) =>
  new AppError(400, 'delivery_not_configured', message, { hint });

/**
 * Email/Teams targets must be configured lists/webhooks (by key name), never the approval keys; email also needs the
 * sender mailbox.
 */
export function assertDelivery(env: Env, body: Pick<PortalScheduleRequest, 'job' | 'notifyOnFailure'>): void {
  const emailKeys = [body.job.emailKey, body.notifyOnFailure?.emailKey].filter((k): k is string => !!k);
  const teamsKeys = [body.job.teamsKey, body.notifyOnFailure?.teamsKey].filter((k): k is string => !!k);
  const approvals = [...emailKeys, ...teamsKeys].find((k) => k.startsWith('AF_APPROVALS_'));
  if (approvals)
    throw notConfigured(
      `“${deliveryKeyLabel(approvals)}” is kept for approval requests, so reports can’t be sent there.`,
      'Pick one of the recipient lists or Teams channels offered.',
    );
  for (const key of emailKeys)
    if (!isRecipientList(env, key))
      throw notConfigured(
        `There is no recipient list called "${deliveryKeyLabel(key)}" in this installation.`,
        `Pick one of the recipient lists offered, or don't email. Administrators: set ${key} (a key ending in _RECIPIENTS, _EMAIL or _ALERTS, holding the addresses) in the configuration file.`,
      );
  if (emailKeys.length && !mailAvailable(env))
    throw notConfigured(
      'Email isn’t set up in this installation, so reports can’t be emailed yet.',
      'Choose “Don’t email” for now. Administrators: set AF_MAIL_SENDER (the mailbox the automation identity sends from) in the configuration file.',
    );
  for (const key of teamsKeys)
    if (!isWebhook(env, key))
      throw notConfigured(
        `There is no Teams webhook called "${deliveryKeyLabel(key)}" in this installation.`,
        `Pick one of the Teams channels offered, or don't post. Administrators: set ${key} (a key ending in _WEBHOOK, holding the Workflows URL) in the configuration file.`,
      );
}

export class PortalSchedules {
  constructor(private readonly deps: PortalScheduleDeps) {}

  /** GET /api/schedules/delivery-options (Portal.Operator). */
  deliveryOptions(session: SessionRecord): DeliveryOptionsResponse {
    requireRole(session, 'Portal.Operator', 'Scheduling reports');
    return deliveryOptions(this.deps.deliveryEnv());
  }

  /** POST /api/schedules → the new schedule (201). */
  async create(c: Caller, raw: unknown): Promise<ScheduleItem> {
    requireRole(c.session, 'Portal.Operator', 'Scheduling reports');
    const body = parseRequest(raw);
    const now = this.deps.now();
    const checked = await this.check(c, body, now);

    const definition = this.build(body, checked, {
      key: '',
      version: '1.0.0',
      owner: c.session.upn,
      enabled: body.enabled,
    });
    let row: ScheduleRow | null = null;
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      const key = portalScheduleKey(body.job.ref, this.deps.suffix?.() ?? randomBytes(3).toString('hex'));
      const def = parseSchedule({ ...definition, id: key });
      // The caps are counted and the row inserted in one step (no two requests pass a cap together).
      const r = await this.deps.store.insertPortalSchedule(
        {
          key,
          source: 'portal',
          definition: def,
          sha256: sha256(def),
          enabled: body.enabled,
          nextRunAt: body.enabled ? nextRun(def.cron, def.timezone, now) : null,
          createdBy: c.session.userOid,
        },
        {
          total: PORTAL_SCHEDULE_LIMITS.total,
          perCreator: PORTAL_SCHEDULE_LIMITS.perCreator,
          recent: PORTAL_SCHEDULE_LIMITS.perDay,
          since: new Date(now.getTime() - DAY_MS),
        },
      );
      if (r.ok) row = r.row;
      else if (r.reason !== 'exists') throw limitReached(r.reason);
    }
    if (!row)
      throw new AppError(409, 'schedule_conflict', 'A new schedule key could not be allocated.', {
        hint: 'Try again.',
      });
    await this.deps.audit.append({
      ...actorOf(c),
      action: 'schedule.created',
      targetType: 'schedule',
      targetId: row.key,
      result: 'success',
      details: this.auditDetails(row, body, checked),
    });
    this.deps.service.changed(row.key);
    return this.deps.service.item(row, null, now, c.session, new Map([[body.job.ref, checked.report]]));
  }

  /** PUT /api/schedules/:key → the saved schedule (same report; keeps `enabled`; bumps the patch version). */
  async update(c: Caller, key: string, raw: unknown): Promise<ScheduleItem> {
    requireRole(c.session, 'Portal.Operator', 'Changing schedules');
    const row = await this.manageable(c, key);
    const body = parseRequest(raw);
    const ref = row.definition.job.kind === 'report' ? row.definition.job.ref : null;
    if (body.job.ref !== ref)
      throw new AppError(400, 'report_cannot_change', 'A schedule always runs the same report.', {
        hint: 'Schedule the other report from Reports, and delete this schedule if nobody needs it any more.',
      });
    const now = this.deps.now();
    // A `redact: true` param comes back masked from GET; the masked value means "keep what is stored".
    const stored = row.definition.job.kind === 'report' ? (row.definition.job.params ?? {}) : {};
    if (body.job.params)
      for (const [name, value] of Object.entries(body.job.params))
        if (value === REDACTED && Object.hasOwn(stored, name)) body.job.params[name] = stored[name];
    const checked = await this.check(c, body, now);
    const def = parseSchedule(
      this.build(body, checked, {
        key: row.key,
        version: bumpPatch(row.definition.version),
        owner: row.definition.owner,
        enabled: row.enabled,
      }),
    );
    const updated = await this.deps.store.updateSchedule(
      row.id,
      {
        definition: def,
        sha256: sha256(def),
        nextRunAt: row.enabled ? nextRun(def.cron, def.timezone, now) : null,
      },
      { sha256: row.sha256 },
    );
    if (!updated) throw changedMeanwhile();
    // Turned on or off while this was being saved (the toggle doesn't change the sha256): keep the next run consistent.
    const saved =
      updated.enabled === row.enabled
        ? updated
        : ((await this.deps.store.updateSchedule(row.id, {
            nextRunAt: updated.enabled ? nextRun(def.cron, def.timezone, now) : null,
          })) ?? updated);
    await this.deps.audit.append({
      ...actorOf(c),
      action: 'schedule.updated',
      targetType: 'schedule',
      targetId: row.key,
      result: 'success',
      details: { ...this.auditDetails(saved, body, checked), previousVersion: row.definition.version },
    });
    this.deps.service.changed(row.key);
    // Report schedules never wait for a second approver (they are read-only), so there is no pending approval.
    return this.deps.service.item(saved, null, now, c.session, new Map([[body.job.ref, checked.report]]));
  }

  /**
   * DELETE /api/schedules/:key: retires the definition, turns the schedule off and cancels runs still queued. The row,
   * its run history and files stay (until retention); downloads keep needing the schedule's and the report's roles.
   */
  async remove(c: Caller, key: string): Promise<void> {
    requireRole(c.session, 'Portal.Operator', 'Deleting schedules');
    const row = await this.manageable(c, key);
    const now = this.deps.now();
    const def = parseSchedule({ ...row.definition, status: 'retired' });
    const updated = await this.deps.store.updateSchedule(
      row.id,
      { definition: def, sha256: sha256(def), enabled: false, nextRunAt: null },
      { sha256: row.sha256 },
    );
    if (!updated) throw changedMeanwhile();
    let cancelled = 0;
    for (const q of await this.deps.store.runsInStatus(['queued']))
      if (
        q.scheduleId === row.id &&
        (await this.deps.store.updateRun(
          q.id,
          {
            status: 'skipped',
            endedAt: now,
            result: { ...q.result, reason: 'The schedule was deleted before this run started.' },
          },
          'queued',
        ))
      )
        cancelled++;
    await this.deps.audit.append({
      ...actorOf(c),
      action: 'schedule.deleted',
      targetType: 'schedule',
      targetId: row.key,
      result: 'success',
      details: {
        report: def.job.kind === 'report' ? def.job.ref : null,
        version: def.version,
        sha256: updated.sha256,
        createdBy: def.owner,
        wasEnabled: row.enabled,
        cancelledRuns: cancelled,
      },
    });
    this.deps.service.changed(row.key);
  }

  /** A portal schedule the caller may edit or delete. */
  private async manageable(c: Caller, key: string): Promise<ScheduleRow> {
    const { row } = await this.deps.service.row(key);
    if (row.source !== 'portal')
      throw new AppError(
        409,
        'schedule_is_content',
        'This schedule is defined in content; change its YAML and publish it.',
        {
          hint: 'Content schedules change through review (git → adminforge validate → publish). You can still turn it off here.',
        },
      );
    if (!canManage(row, c.session))
      throw new AppError(
        403,
        'forbidden',
        'Only the person who created this schedule or a portal administrator can change or delete it.',
        {
          hint: `Ask ${row.definition.owner} or a portal administrator (Portal.Admin). You can still turn it off.`,
        },
      );
    return row;
  }

  /** Everything a create or an update must satisfy (report, roles, export, format, params, cron, delivery). */
  private async check(
    c: Caller,
    body: PortalScheduleRequest,
    now: Date,
  ): Promise<{ report: ReportDef; reportVersion: string; params: Record<string, unknown> }> {
    assertPlainText('name', body.title);
    assertPlainText('summary', body.summary);
    const problem = validateCron(body.cron);
    if (problem) throw invalidCron(problem);
    if (runsTooOften(body.cron, body.timezone, now))
      throw new AppError(400, 'cron_too_frequent', 'Reports can run at most once an hour.', {
        hint: 'Pick an hourly, daily, weekly or monthly cadence, or a custom pattern with at least an hour between runs.',
      });

    const ref = body.job.ref;
    const resolved = await this.deps.definitions.resolve('report', ref);
    const report = resolved.def;
    if (report.status === 'draft' || report.status === 'retired')
      throw new AppError(
        404,
        'definition_not_found',
        `The report "${ref}" is ${report.status}, so it can’t be scheduled.`,
        {
          hint: 'Pick an active report from Reports.',
        },
      );
    // (The refusal doesn't name the report: the caller may not be allowed to see it.)
    for (const role of (report.requires?.portalRoles ?? []) as PortalRole[])
      requireRole(c.session, role, 'Scheduling this report');
    const spec = report.export;
    if (!spec)
      throw new AppError(
        400,
        'export_not_supported',
        `“${report.title}” has no export, so it can’t be scheduled.`,
        {
          hint: 'Open the report instead, or ask its owner to add an export (formats and columns) to it.',
        },
      );
    if (body.job.format !== 'json' && !spec.formats.includes(body.job.format))
      throw new AppError(
        400,
        'format_not_supported',
        `“${report.title}” can be delivered as ${[...spec.formats, 'json'].join(', ')}, not ${body.job.format}.`,
        { hint: 'Pick one of the formats offered.' },
      );

    // Validate the params now, as the automation identity, exactly as the run will — a bad value fails here, not at
    // 06:00. Only what the caller set is kept; defaults are evaluated at each run (relative dates stay relative).
    const raw = body.job.params ?? {};
    // Only params the schedule form offers: pickers, dates, ids, hidden params and the query builder's filter keep the
    // report's default, so a schedule can't aim application-permission reads at objects of its creator's choosing.
    const refused = Object.keys(raw).filter((name) => {
      const p = Object.hasOwn(report.params ?? {}, name) ? report.params![name] : undefined;
      return p ? !isSchedulableParam(p) : name === advancedParamOf(report.filters);
    });
    if (refused.length)
      throw new InvalidParams(
        refused.map((name) => ({
          param: name,
          message: 'can’t be set for a schedule (it uses the report’s default)',
        })),
        'Leave it out: a scheduled run uses the report’s default for it.',
      );
    const page: LoadedPage = {
      def: report,
      version: resolved.version,
      sha256: resolved.sha256,
      kind: 'report',
      key: ref,
    };
    const prepared = await this.deps.datasources.prepareParams(page, raw, AUTOMATION_USER);
    const params: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(raw))
      if (!isEmpty(value)) params[name] = Object.hasOwn(prepared, name) ? prepared[name] : value;

    assertDelivery(this.deps.deliveryEnv(), body);
    return { report, reportVersion: resolved.version, params };
  }

  /** The schedule document (the schedule editor's builder), before Schedule.parse. */
  private build(
    body: PortalScheduleRequest,
    checked: { report: ReportDef; params: Record<string, unknown> },
    o: { key: string; version: string; owner: string; enabled: boolean },
  ): Record<string, unknown> {
    const report = checked.report;
    return scheduleDocument({
      key: o.key,
      version: o.version,
      title: body.title,
      ...(body.summary ? { summary: body.summary } : {}),
      owner: o.owner,
      tags: [...new Set([...(report.tags ?? []), 'portal'])],
      cron: body.cron,
      timezone: body.timezone,
      enabled: o.enabled,
      job: reportJobDocument({
        ref: body.job.ref,
        format: body.job.format,
        retain: body.job.retain,
        params: checked.params,
        ...(body.job.emailKey ? { emailKey: body.job.emailKey } : {}),
        ...(body.job.teamsKey ? { teamsKey: body.job.teamsKey } : {}),
      }),
      retries: RETRIES,
      notifyOnFailure: notifyTargets(body.notifyOnFailure),
      // Files stay restricted to Operators plus the report's roles, even after the report is retired.
      requires: {
        ...copiedRequires(report.requires),
        portalRoles: [...new Set(['Portal.Operator', ...(report.requires?.portalRoles ?? [])])],
      },
    });
  }

  /** Audited: what runs, when, where it goes (key names) and the params (`redact: true` ones masked). */
  private auditDetails(
    row: ScheduleRow,
    body: PortalScheduleRequest,
    checked: { report: ReportDef; reportVersion: string; params: Record<string, unknown> },
  ): Record<string, unknown> {
    const declared = checked.report.params ?? {};
    return {
      report: body.job.ref,
      reportVersion: checked.reportVersion,
      version: row.definition.version,
      sha256: row.sha256,
      title: body.title,
      cron: body.cron,
      timezone: body.timezone,
      enabled: row.enabled,
      format: body.job.format,
      retain: body.job.retain,
      params: maskRedacted(checked.params, declared),
      emailKey: body.job.emailKey ?? null,
      teamsKey: body.job.teamsKey ?? null,
      notifyOnFailure: {
        emailKey: body.notifyOnFailure?.emailKey ?? null,
        teamsKey: body.notifyOnFailure?.teamsKey ?? null,
      },
    };
  }
}

function limitReached(reason: Exclude<PortalInsertResult, { ok: true }>['reason']): AppError {
  const L = PORTAL_SCHEDULE_LIMITS;
  if (reason === 'total')
    return new AppError(
      409,
      'schedule_limit',
      `This installation already has ${L.total} report schedules created in the portal, the most it allows.`,
      {
        hint: 'Delete schedules nobody needs any more, or ask an administrator to move long-lived ones into content.',
      },
    );
  if (reason === 'perCreator')
    return new AppError(
      409,
      'schedule_limit',
      `You already have ${L.perCreator} report schedules, the most one person can create.`,
      { hint: 'Delete one you no longer need, or ask a colleague or an administrator to schedule it.' },
    );
  return new AppError(
    409,
    'schedule_limit',
    `You created ${L.perDay} report schedules in the last 24 hours, the most one person can (deleted ones count).`,
    { hint: 'Try again tomorrow, or edit one of your schedules instead of creating a new one.' },
  );
}

const changedMeanwhile = () =>
  new AppError(409, 'schedule_changed', 'Someone changed this schedule at the same time.', {
    hint: 'Reload the page and try again.',
  });
