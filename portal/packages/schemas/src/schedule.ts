import { z } from 'zod';
import { DefinitionId, Expr, Mode, RetryPolicy, Template, envelopeShape } from './common';
import { RunnerSpec } from './datasource';

/**
 * Schedules (R6, ADR-011): cron jobs run on this host by the scheduler service as the configured **automation identity**
 * (application permissions). `requires.scopes` lists the application permissions the job needs; `adminforge validate
 * --scopes` checks them against the automation identity. Write-capable jobs need two-person approval (`approvedBy`).
 */

const CRON_NICKNAMES = new Set([
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
]);
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface CronField {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset added to a name's index (months are 1-based). */
  nameBase?: number;
  dom?: boolean;
  dow?: boolean;
}
const SECOND: CronField = { name: 'second', min: 0, max: 59 };
const FIELDS: CronField[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31, dom: true },
  { name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAYS, nameBase: 0, dow: true },
];

function cronValue(token: string, f: CronField): number | undefined {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return n >= f.min && n <= f.max ? n : undefined;
  }
  const i = f.names?.indexOf(token.toUpperCase()) ?? -1;
  return i >= 0 ? i + (f.nameBase ?? 0) : undefined;
}

function checkCronField(text: string, f: CronField): string | undefined {
  for (const part of text.split(',')) {
    if (part === '') return `empty list item in ${f.name}`;
    if (part === '?' && (f.dom || f.dow)) continue;
    if (f.dom && /^(L|L-\d{1,2}|\d{1,2}W|LW)$/.test(part)) continue;
    if (f.dow && /^[0-7A-Za-z]{1,3}(L|#[1-5])$/.test(part)) {
      if (cronValue(part.replace(/(L|#[1-5])$/, ''), f) === undefined) return `invalid ${f.name} "${part}"`;
      continue;
    }
    const [range, step, extra] = part.split('/');
    if (extra !== undefined) return `invalid step in ${f.name} "${part}"`;
    if (step !== undefined && !(/^\d+$/.test(step) && Number(step) >= 1 && Number(step) <= f.max))
      return `invalid step in ${f.name} "${part}"`;
    if (range === '*') continue;
    const [a, b, more] = (range ?? '').split('-');
    if (more !== undefined) return `invalid range in ${f.name} "${part}"`;
    const lo = cronValue(a ?? '', f);
    if (lo === undefined) return `${f.name} "${a}" is out of range ${f.min}-${f.max}`;
    if (b !== undefined) {
      const hi = cronValue(b, f);
      if (hi === undefined) return `${f.name} "${b}" is out of range ${f.min}-${f.max}`;
      if (hi < lo) return `${f.name} range "${range}" is reversed`;
    }
  }
  return undefined;
}

/** Validates a 5-field (`m h dom mon dow`) or 6-field (seconds first) cron expression, or a nickname like `@daily`. Returns an error message or undefined. */
export function validateCron(expr: string): string | undefined {
  const text = expr.trim();
  if (CRON_NICKNAMES.has(text.toLowerCase())) return undefined;
  const parts = text.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return `Expected 5 or 6 cron fields, got ${parts.length}`;
  const fields = parts.length === 6 ? [SECOND, ...FIELDS] : FIELDS;
  for (let i = 0; i < parts.length; i++) {
    const err = checkCronField(parts[i]!, fields[i]!);
    if (err) return `Invalid cron: ${err}`;
  }
  return undefined;
}

/** True for IANA zone names the runtime knows (and `UTC`). */
export function isValidTimeZone(tz: string): boolean {
  if (!/^(UTC|GMT|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const Cron = z.string().superRefine((v, ctx) => {
  const err = validateCron(v);
  if (err) ctx.addIssue({ code: 'custom', message: err });
});
export const TimeZone = z
  .string()
  .refine(isValidTimeZone, { message: 'Expected an IANA time zone like Europe/London or UTC' });

/** Secret-bearing URLs (e.g. Teams workflow webhooks) are configuration, so only `${ env.X }` is accepted. */
const EnvRef = Expr.meta({ description: 'An ${ env.X } reference; the value lives in local configuration' });

export const TeamsTarget = z
  .strictObject({
    type: z.literal('teams'),
    /** `${ env.X }` holding a Teams workflow/webhook URL. */
    webhook: EnvRef.optional(),
    team: Template.optional(),
    channel: Template.optional(),
    message: Template.optional(),
  })
  .refine((t) => !!t.webhook !== !!(t.team && t.channel), {
    message: 'Use either webhook or team + channel',
    path: ['webhook'],
  });

export const EmailTarget = z.strictObject({
  type: z.literal('email'),
  to: z.array(Template).min(1),
  cc: z.array(Template).optional(),
  subject: Template.optional(),
  message: Template.optional(),
});

/** Who to tell when a scheduled run fails or succeeds. */
export const NotifyTargetSpec = z.discriminatedUnion('type', [EmailTarget, TeamsTarget]);
export type NotifyTargetSpec = z.infer<typeof NotifyTargetSpec>;

const ExportFormat = z.enum(['csv', 'xlsx', 'json']);

/** Where a scheduled report goes. */
export const Delivery = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('file'),
    format: ExportFormat.default('xlsx'),
    /** Relative to the scheduler's reports directory; `{date}`/`{datetime}` placeholders are filled in. */
    path: z
      .string()
      .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9_{}./-]+$/, 'Expected a relative path without ..')
      .optional(),
    /** Keep the newest N files. */
    retain: z.number().int().min(1).max(1000).optional(),
  }),
  EmailTarget.extend({ format: ExportFormat.default('xlsx'), attach: z.boolean().default(true) }),
  TeamsTarget.safeExtend({ format: ExportFormat.optional() }),
]);
export type Delivery = z.infer<typeof Delivery>;

export const ReportJob = z.strictObject({
  kind: z.literal('report'),
  ref: DefinitionId,
  params: z.record(z.string(), z.unknown()).optional(),
  delivery: z.array(Delivery).min(1),
});

export const PlaybookJob = z
  .strictObject({
    kind: z.literal('playbook'),
    ref: DefinitionId,
    inputs: z.record(z.string(), z.unknown()).optional(),
    /** Must match the playbook's mode; write jobs need `approvedBy`. */
    mode: Mode.default('read'),
    /** Approval record ids (or approver identities) that enabled this write schedule — two-person rule (R6). */
    approvedBy: z.array(z.string().min(1)).optional(),
    dryRun: z.boolean().optional(),
  })
  .refine((j) => j.mode !== 'write' || (j.approvedBy?.length ?? 0) > 0, {
    message: 'Write playbook schedules need approvedBy (two-person approval)',
    path: ['approvedBy'],
  });

/** Probes a `job: probe` sweep selects by tag: every probe carrying **all** of `tags` (drafts and retired probes are skipped). */
export const ProbeSelector = z.strictObject({ tags: z.array(z.string().min(1)).min(1) });
export type ProbeSelector = z.infer<typeof ProbeSelector>;

/** One probe (`ref`), a list (`refs`), or a tag sweep (`select: { tags: [...] }`) — exactly one of them. */
export const ProbeJob = z
  .strictObject({
    kind: z.literal('probe'),
    ref: DefinitionId.optional(),
    refs: z.array(DefinitionId).min(1).optional(),
    select: ProbeSelector.optional(),
    /** Probes run at the same time within one sweep (default 4). */
    concurrency: z.number().int().min(1).max(16).optional(),
  })
  .refine((j) => [j.ref, j.refs, j.select].filter((v) => v !== undefined).length === 1, {
    message: 'Use exactly one of ref, refs or select',
    path: ['ref'],
  });
export type ProbeJob = z.infer<typeof ProbeJob>;

export const ScriptJob = z.strictObject({
  kind: z.literal('script'),
  ...RunnerSpec,
  mode: Mode.default('read'),
  approvedBy: z.array(z.string().min(1)).optional(),
});

/** Re-validates published definitions against current schemas and (with `scopes`) the automation identity's permissions. */
export const ContentHealthJob = z.strictObject({
  kind: z.literal('contentHealth'),
  scopes: z.boolean().optional(),
});

export const ScheduleJob = z.discriminatedUnion('kind', [
  ReportJob,
  PlaybookJob,
  ProbeJob,
  ScriptJob,
  ContentHealthJob,
]);
export type ScheduleJob = z.infer<typeof ScheduleJob>;

export const Schedule = z
  .strictObject({
    kind: z.literal('schedule'),
    ...envelopeShape,
    cron: Cron,
    timezone: TimeZone.default('UTC'),
    enabled: z.boolean().default(true),
    /** Unattended runs always use the automation identity (ADR-011). */
    identity: z.literal('automation').default('automation'),
    job: ScheduleJob,
    retry: RetryPolicy.optional(),
    /** Run time limit (default 900; max 4h). */
    timeoutSeconds: z.number().int().min(1).max(14_400).optional(),
    /** What happens when a run is still going at the next tick. */
    overlap: z.enum(['skip', 'queue', 'allow']).default('skip'),
    notify: z
      .strictObject({
        onFailure: z.array(NotifyTargetSpec).optional(),
        onSuccess: z.array(NotifyTargetSpec).optional(),
      })
      .optional(),
  })
  .superRefine((def, ctx) => {
    if (def.job.kind === 'script' && def.job.mode === 'write' && !def.job.approvedBy?.length)
      ctx.addIssue({
        code: 'custom',
        path: ['job', 'approvedBy'],
        message: 'Write script schedules need approvedBy (two-person approval)',
      });
  });
export type Schedule = z.infer<typeof Schedule>;
