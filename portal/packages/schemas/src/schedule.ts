import { z } from 'zod';
import { DefinitionId, Expr, Mode, RetryPolicy, Template, envelopeShape } from './common';
import { RunnerSpec } from './datasource';
import { isValidTimeZone, parseSchedule, validateCron } from './cadence';
import { NewsJob } from './news';

/**
 * Schedules (R6, ADR-011, ADR-014): cron jobs run on this host by the scheduler service as the identity they name —
 * the **automation identity** (default), a **named app identity** (`{ app: <name> }`, its own app registration with
 * application permissions) or, for read-only schedules created in the portal, **their creator** (`{ user: creator }`,
 * the creator's own delegated read access). `requires.scopes` lists the application permissions an app-only job needs;
 * `adminforge validate --scopes` checks them against the identity the schedule names. Write-capable jobs need
 * two-person approval (`approvedBy`).
 */

/**
 * Key prefix of schedules created in the portal (Reports → Schedule, stored only in the database). Content schedules
 * may not use it (`validateReferences`); the Schedule schema itself accepts it because portal definitions are
 * validated with it too.
 */
export const PORTAL_SCHEDULE_PREFIX = 'portal.';

// Cron and time-zone validation live with the English describer and grammar (./cadence).
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

/**
 * Email recipients are configuration, never addresses in content: each entry is `${ env.X }` naming a key of the
 * installation's configuration whose name ends in RECIPIENTS, EMAIL or ALERTS (e.g. `${ env.AF_REPORT_RECIPIENTS }`,
 * holding comma- or semicolon-separated addresses). The scheduler reads only keys named like that.
 */
export const RECIPIENT_REF = /^\s*\$\{\s*env\.AF_[A-Z0-9_]*(RECIPIENTS|EMAIL|ALERTS)\s*\}\s*$/;
export const RecipientRef = z
  .string()
  .regex(
    RECIPIENT_REF,
    'Use ${ env.AF_…_RECIPIENTS } (or a key ending in _EMAIL or _ALERTS): addresses live in the configuration, not in content',
  )
  .meta({ description: 'An ${ env.AF_…_RECIPIENTS } reference; the addresses live in local configuration' });

export const EmailTarget = z.strictObject({
  type: z.literal('email'),
  to: z.array(RecipientRef).min(1),
  cc: z.array(RecipientRef).optional(),
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
  NewsJob,
]);
export type ScheduleJob = z.infer<typeof ScheduleJob>;

/**
 * When a schedule runs, in English instead of cron: "weekdays at 07:00", "first Monday of the month at 08:30", "every 4
 * hours", "last day of the month at 23:00" (the grammar in ./cadence). Validation compiles it to `cron`.
 */
/**
 * A named app identity (AF_SCHEDULE_IDENTITIES): lower-case letters and digits, single dashes between them (2–31
 * characters), so "--" never occurs in a name and the app's alternate key `adminforge-identity-<name>--<label>` is
 * unambiguous. Its settings live in the env file as AF_IDENTITY_<NAME>_CLIENT_ID, … (`identityEnvPrefix`).
 */
export const IDENTITY_NAME = /^(?=.{2,31}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const IdentityName = z
  .string()
  .regex(IDENTITY_NAME, 'Expected a lower-case name like reports-team (letters, digits, single dashes)')
  .refine((n) => n !== 'automation', {
    message: '"automation" is the default identity; leave `identity` out',
  });

/** `AF_IDENTITY_<NAME>_` for an identity name (dashes become underscores). */
export const identityEnvPrefix = (name: string) => `AF_IDENTITY_${name.toUpperCase().replace(/-/g, '_')}_`;

/**
 * Who a schedule runs as (ADR-014): the automation identity (default), a named app identity, or the creator of a
 * schedule made in the portal (read-only jobs only: reports and probes).
 */
export const ScheduleIdentity = z.union(
  [
    z.literal('automation'),
    z.strictObject({ app: IdentityName }),
    z.strictObject({ user: z.literal('creator') }),
  ],
  { error: 'Expected automation, { app: <name> } or { user: creator }' },
);
export type ScheduleIdentity = z.infer<typeof ScheduleIdentity>;

/** `automation`, `app:<name>` or `user` — one string per kind of identity (keys, logs, the API). */
export function identityKey(identity: ScheduleIdentity | undefined): string {
  if (!identity || identity === 'automation') return 'automation';
  return 'app' in identity ? `app:${identity.app}` : 'user';
}

/** How an identity reads in the UI and the audit log ("automation identity", "app identity reports-team", "its creator"). */
export function identityLabel(identity: ScheduleIdentity | undefined, creator?: string | null): string {
  if (!identity || identity === 'automation') return 'automation identity';
  if ('app' in identity) return `app identity ${identity.app}`;
  return creator ? `${creator} (their own access)` : 'its creator (their own access)';
}

/** Job kinds that may run as the creator: they only read. */
const USER_JOBS = new Set(['report', 'probe']);

export const Every = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .meta({
    description:
      'When it runs, in plain English, instead of cron — e.g. "every weekday at 07:00", "every Monday at 08:30", "first Monday of the month at 8:30", "last day of the month at 23:00", "every 4 hours", "every 15 minutes". The time zone goes in `timezone`.',
    examples: ['every weekday at 07:00', 'first Monday of the month at 08:30', 'every 4 hours'],
  });

export const Schedule = z
  .strictObject({
    kind: z.literal('schedule'),
    ...envelopeShape,
    /** Five or six cron fields — or leave it out and say it in English with `every`. */
    cron: Cron.optional(),
    every: Every.optional(),
    timezone: TimeZone.default('UTC'),
    enabled: z.boolean().default(true),
    /** Who it runs as (ADR-014): the automation identity (default), `{ app: <name> }` or `{ user: creator }`. */
    identity: ScheduleIdentity.default('automation'),
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
    const identity = def.identity;
    if (identity !== 'automation' && 'user' in identity) {
      // A person's own access only ever reads, and only for a schedule a person made (content has no creator).
      if (!USER_JOBS.has(def.job.kind))
        ctx.addIssue({
          code: 'custom',
          path: ['identity'],
          message: `A ${def.job.kind} job can't run as its creator: only reports and probes can (they only read). Use the automation identity or an app identity.`,
        });
      if (!def.id.startsWith(PORTAL_SCHEDULE_PREFIX))
        ctx.addIssue({
          code: 'custom',
          path: ['identity'],
          message:
            'Only schedules created in the portal run as their creator; a schedule in content has no creator. Use the automation identity or `{ app: <name> }`.',
        });
    }
    // AdminForge's own housekeeping (news collection, content health) always runs as the automation identity.
    if (identity !== 'automation' && (def.job.kind === 'news' || def.job.kind === 'contentHealth'))
      ctx.addIssue({
        code: 'custom',
        path: ['identity'],
        message: `${def.job.kind} jobs always run as the automation identity; leave \`identity\` out.`,
      });
    if (def.job.kind === 'script' && def.job.mode === 'write' && !def.job.approvedBy?.length)
      ctx.addIssue({
        code: 'custom',
        path: ['job', 'approvedBy'],
        message: 'Write script schedules need approvedBy (two-person approval)',
      });
    if (def.every === undefined) {
      if (def.cron === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['cron'],
          message: 'Say when it runs: `cron` (e.g. "0 7 * * 1-5") or `every` (e.g. "every weekday at 07:00")',
        });
      return;
    }
    const parsed = parseSchedule(def.every);
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', path: ['every'], message: parsed.error });
      return;
    }
    if (parsed.timezone)
      ctx.addIssue({
        code: 'custom',
        path: ['every'],
        message: `Put the time zone in \`timezone: ${parsed.timezone}\`, not in \`every\``,
      });
    // A definition read back after validation carries both; they must agree.
    else if (def.cron !== undefined && def.cron.trim() !== parsed.cron)
      ctx.addIssue({
        code: 'custom',
        path: ['every'],
        message: `Use either \`cron\` or \`every\`, not both (\`every\` means "${parsed.cron}")`,
      });
  })
  // `every` is compiled to `cron`, so everything downstream reads `cron`.
  .transform((def) => ({
    ...def,
    cron: def.cron ?? (parseSchedule(def.every!) as { cron: string }).cron,
  }));
export type Schedule = z.infer<typeof Schedule>;
