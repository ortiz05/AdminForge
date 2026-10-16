import {
  DefinitionId,
  formatContentError,
  parseDefinition,
  PORTAL_SCHEDULE_PREFIX,
  TimeZone,
  validateCron,
} from '@adminforge/schemas';
import { stringify } from 'yaml';
import { z } from 'zod';
import { AppError } from '../errors';
import { assertNoTenantValues, type TenantValue } from '../query/scaffold';
import { describeCron, nextRuns } from './cron';

/**
 * The schedule editor (R6): turns the form into schedule YAML the engineer commits through the normal review workflow
 * (git → `adminforge validate` → publish), exactly as `adminforge new schedule` would. Nothing is written server-side;
 * the YAML is validated with the content schema before it is returned.
 *
 * `scheduleDocument` / `reportJobDocument` / `notifyTargets` build the schedule document itself; in-app report
 * schedules (schedules/portal.ts) use the same builder, so both paths produce the same shape.
 */

const EnvKey = z.string().regex(/^AF_[A-Z0-9_]+$/, 'Expected an env key like AF_TEAMS_ALERTS_WEBHOOK');
/** Recipient lists: only keys named like one are ever read for email (delivery/notifier.ts RECIPIENT_KEY). */
const RecipientKey = z
  .string()
  .regex(
    /^AF_[A-Z0-9_]*(RECIPIENTS|EMAIL|ALERTS)$/,
    'Expected an env key ending in _RECIPIENTS, _EMAIL or _ALERTS, like AF_REPORT_RECIPIENTS',
  );
const Section = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const ScheduleScaffoldRequest = z.object({
  title: z.string().trim().min(1).max(120),
  /** `<section>.<name>`; default `<section>.<slug of title>`. */
  key: DefinitionId.optional(),
  section: Section.optional(),
  summary: z.string().trim().max(500).optional(),
  owner: z.string().trim().min(1).max(100).optional(),
  cron: z.string().trim().min(1).max(100),
  timezone: TimeZone,
  enabled: z.boolean().default(true),
  job: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('report'),
      ref: DefinitionId,
      format: z.enum(['csv', 'xlsx', 'json']).default('xlsx'),
      /** Keep the newest N files. */
      retain: z.number().int().min(1).max(1000).optional(),
      /** Env key holding recipient addresses (comma-separated); addresses are configuration, never content. */
      emailEnv: RecipientKey.optional(),
      /** Env key holding a Teams workflow webhook URL. */
      teamsWebhookEnv: EnvKey.optional(),
    }),
    z.object({ kind: z.literal('probe'), tags: z.array(z.string().trim().min(1)).min(1).max(5) }),
    z.object({
      kind: z.literal('playbook'),
      ref: DefinitionId,
      mode: z.enum(['read', 'write']).default('read'),
      inputs: z.record(z.string(), z.unknown()).optional(),
      /** Content review note for write jobs (the in-app two-person approval is what enables it). */
      reviewedBy: z.array(z.string().trim().min(1)).max(5).optional(),
      dryRun: z.boolean().optional(),
    }),
    z.object({ kind: z.literal('contentHealth'), scopes: z.boolean().optional() }),
  ]),
  retries: z.number().int().min(0).max(10).default(2),
  timeoutSeconds: z.number().int().min(60).max(14_400).optional(),
  notifyOnFailure: z
    .object({ emailEnv: RecipientKey.optional(), teamsWebhookEnv: EnvKey.optional() })
    .optional(),
});
export type ScheduleScaffoldRequest = z.infer<typeof ScheduleScaffoldRequest>;

export interface CronPreview {
  valid: boolean;
  /** Plain-language description ("Every Monday at 06:15"), when the expression is a common shape. */
  text: string | null;
  /** The next runs in the schedule's time zone (ISO, UTC). */
  next: string[];
  problem?: string;
}

/** What a cron expression means and when it will next fire — for the editor's live preview. */
export function previewCron(cron: string, timezone: string, now: Date): CronPreview {
  const problem = validateCron(cron);
  if (problem) return { valid: false, text: null, next: [], problem };
  return {
    valid: true,
    text: describeCron(cron),
    next: nextRuns(cron, timezone, now, 5).map((d) => d.toISOString()),
  };
}

const slug = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || 'schedule';

const env = (key: string) => `\${ env.${key} }`;

export interface ScheduleScaffoldResult {
  yaml: string;
  path: string;
  key: string;
  preview: CronPreview;
}

/** Requirements of the job's target, copied so `adminforge validate --scopes` checks the automation identity. */
export type RequiresOf = (
  kind: 'report' | 'playbook',
  key: string,
) => Promise<Record<string, unknown> | null>;

/** What a schedule copies from the report or playbook it runs: its permissions (scopes) and licences. */
export function copiedRequires(
  requires: { scopes?: unknown; licences?: unknown } | undefined,
): Record<string, unknown> | null {
  return requires?.scopes || requires?.licences
    ? {
        ...(requires.scopes ? { scopes: requires.scopes } : {}),
        ...(requires.licences ? { licences: requires.licences } : {}),
      }
    : null;
}

/** A report job: a file (kept `retain` times), then email/Teams to configuration keys (`${ env.KEY }`, never values). */
export function reportJobDocument(j: {
  ref: string;
  format: 'csv' | 'xlsx' | 'json';
  retain?: number;
  params?: Record<string, unknown>;
  /** Configuration key holding recipient addresses. */
  emailKey?: string;
  /** Configuration key holding a Teams workflow webhook URL. */
  teamsKey?: string;
}): Record<string, unknown> {
  const delivery: Record<string, unknown>[] = [
    { type: 'file', format: j.format, ...(j.retain ? { retain: j.retain } : {}) },
  ];
  if (j.emailKey) delivery.push({ type: 'email', to: [env(j.emailKey)], format: j.format });
  if (j.teamsKey) delivery.push({ type: 'teams', webhook: env(j.teamsKey) });
  return {
    kind: 'report',
    ref: j.ref,
    ...(j.params && Object.keys(j.params).length ? { params: j.params } : {}),
    delivery,
  };
}

/** `notify.onFailure` targets for configuration keys. */
export function notifyTargets(n?: { emailKey?: string; teamsKey?: string }): Record<string, unknown>[] {
  const notify: Record<string, unknown>[] = [];
  if (n?.emailKey) notify.push({ type: 'email', to: [env(n.emailKey)] });
  if (n?.teamsKey) notify.push({ type: 'teams', webhook: env(n.teamsKey) });
  return notify;
}

export interface ScheduleDocumentInput {
  key: string;
  /** Default 1.0.0 (a new schedule). */
  version?: string;
  title: string;
  summary?: string;
  owner: string;
  tags?: string[];
  cron: string;
  timezone: string;
  enabled: boolean;
  job: Record<string, unknown>;
  /** Retries with exponential backoff from 5 minutes (0/absent = none). */
  retries?: number;
  timeoutSeconds?: number;
  notifyOnFailure?: Record<string, unknown>[];
  requires?: Record<string, unknown> | null;
  /** Editor autocomplete path (YAML files only). */
  $schema?: string;
}

/** The schedule document (validate it with the Schedule schema / parseDefinition before use). */
export function scheduleDocument(i: ScheduleDocumentInput): Record<string, unknown> {
  return {
    ...(i.$schema ? { $schema: i.$schema } : {}),
    kind: 'schedule',
    id: i.key,
    version: i.version ?? '1.0.0',
    title: i.title,
    ...(i.summary ? { summary: i.summary } : {}),
    owner: i.owner,
    ...(i.tags?.length ? { tags: i.tags } : {}),
    cron: i.cron,
    timezone: i.timezone,
    enabled: i.enabled,
    identity: 'automation',
    job: i.job,
    ...(i.retries ? { retry: { max: i.retries, backoff: 'exponential', delay: '5m' } } : {}),
    ...(i.timeoutSeconds ? { timeoutSeconds: i.timeoutSeconds } : {}),
    overlap: 'skip',
    ...(i.notifyOnFailure?.length ? { notify: { onFailure: i.notifyOnFailure } } : {}),
    ...(i.requires ? { requires: i.requires } : {}),
  };
}

/** Thrown for an invalid cron expression (the editor and in-app schedules). */
export function invalidCron(problem: string | undefined): AppError {
  return new AppError(400, 'invalid_cron', `The cron expression isn’t valid: ${problem}`, {
    hint: 'Use five fields: minute hour day-of-month month day-of-week, e.g. "15 6 * * 1" for Mondays at 06:15.',
  });
}

export async function scaffoldSchedule(
  r: ScheduleScaffoldRequest,
  deps: { known: readonly TenantValue[]; now: Date; requiresOf?: RequiresOf },
): Promise<ScheduleScaffoldResult> {
  assertNoTenantValues(
    {
      title: r.title,
      summary: r.summary,
      inputs: r.job.kind === 'playbook' && r.job.inputs ? JSON.stringify(r.job.inputs) : undefined,
    },
    deps.known,
  );
  const preview = previewCron(r.cron, r.timezone, deps.now);
  if (!preview.valid) throw invalidCron(preview.problem);

  const section =
    r.section ?? (r.job.kind === 'probe' ? 'probes' : r.job.kind === 'report' ? 'reports' : 'ops');
  const key = r.key ?? `${section}.${slug(r.title)}`;
  if (key.startsWith(PORTAL_SCHEDULE_PREFIX))
    throw new AppError(
      400,
      'invalid_request',
      `Schedule keys starting with "${PORTAL_SCHEDULE_PREFIX}" are reserved for schedules created in the portal.`,
      { hint: 'Pick another section, e.g. reports or ops.' },
    );
  const [folder, ...rest] = key.split('.');
  const path = `portal/content/schedules/${folder}/${rest.join('.')}.schedule.yaml`;

  let job: Record<string, unknown>;
  let requires: Record<string, unknown> | null = null;
  if (r.job.kind === 'report') {
    job = reportJobDocument({
      ref: r.job.ref,
      format: r.job.format,
      ...(r.job.retain ? { retain: r.job.retain } : {}),
      ...(r.job.emailEnv ? { emailKey: r.job.emailEnv } : {}),
      ...(r.job.teamsWebhookEnv ? { teamsKey: r.job.teamsWebhookEnv } : {}),
    });
    requires = (await deps.requiresOf?.('report', r.job.ref)) ?? null;
  } else if (r.job.kind === 'probe') {
    job = { kind: 'probe', select: { tags: r.job.tags } };
  } else if (r.job.kind === 'playbook') {
    if (r.job.mode === 'write' && !r.job.reviewedBy?.length)
      throw new AppError(
        400,
        'review_required',
        'A schedule that changes data needs the content reviewer’s name.',
        {
          hint: 'Fill in "Reviewed by". Enabling it in the portal still needs a second person’s approval.',
        },
      );
    job = {
      kind: 'playbook',
      ref: r.job.ref,
      mode: r.job.mode,
      ...(r.job.inputs && Object.keys(r.job.inputs).length ? { inputs: r.job.inputs } : {}),
      ...(r.job.mode === 'write' ? { approvedBy: r.job.reviewedBy } : {}),
      ...(r.job.dryRun ? { dryRun: true } : {}),
    };
    requires = (await deps.requiresOf?.('playbook', r.job.ref)) ?? null;
  } else {
    job = { kind: 'contentHealth', ...(r.job.scopes ? { scopes: true } : {}) };
  }

  const doc = scheduleDocument({
    $schema: '../../../packages/schemas/generated/schedule.schema.json',
    key,
    title: r.title,
    ...(r.summary ? { summary: r.summary } : {}),
    owner: r.owner ?? 'portal-admins',
    cron: r.cron,
    timezone: r.timezone,
    enabled: r.enabled,
    job,
    retries: r.retries,
    ...(r.timeoutSeconds ? { timeoutSeconds: r.timeoutSeconds } : {}),
    notifyOnFailure: notifyTargets({
      ...(r.notifyOnFailure?.emailEnv ? { emailKey: r.notifyOnFailure.emailEnv } : {}),
      ...(r.notifyOnFailure?.teamsWebhookEnv ? { teamsKey: r.notifyOnFailure.teamsWebhookEnv } : {}),
    }),
    requires,
  });
  const header = [
    `# Made with the schedule editor. Save as ${path}, then: pnpm adminforge validate && pnpm adminforge publish`,
    preview.text ? `# Runs: ${preview.text} (${r.timezone}).` : null,
    r.job.kind === 'playbook' && r.job.mode === 'write'
      ? '# Changes data: after publishing, enabling it needs a second person’s approval in the portal.'
      : null,
  ]
    .filter(Boolean)
    .join('\n');
  const yaml = `${header}\n${stringify(doc, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' })}`;
  const parsed = parseDefinition(yaml, path.replace(/^portal\/content\//, ''));
  if (!parsed.ok)
    throw new AppError(
      400,
      'invalid_scaffold',
      `The schedule wouldn’t be valid: ${parsed.errors.slice(0, 3).map(formatContentError).join('; ')}`,
    );
  return { yaml, path, key, preview };
}
