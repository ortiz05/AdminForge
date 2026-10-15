import {
  DefinitionId,
  formatContentError,
  parseDefinition,
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
 */

const EnvKey = z.string().regex(/^AF_[A-Z0-9_]+$/, 'Expected an env key like AF_REPORT_RECIPIENTS');
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
      emailEnv: EnvKey.optional(),
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
  notifyOnFailure: z.object({ emailEnv: EnvKey.optional(), teamsWebhookEnv: EnvKey.optional() }).optional(),
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
  if (!preview.valid)
    throw new AppError(400, 'invalid_cron', `The cron expression isn’t valid: ${preview.problem}`, {
      hint: 'Use five fields: minute hour day-of-month month day-of-week, e.g. "15 6 * * 1" for Mondays at 06:15.',
    });

  const section =
    r.section ?? (r.job.kind === 'probe' ? 'probes' : r.job.kind === 'report' ? 'reports' : 'ops');
  const key = r.key ?? `${section}.${slug(r.title)}`;
  const [folder, ...rest] = key.split('.');
  const path = `portal/content/schedules/${folder}/${rest.join('.')}.schedule.yaml`;

  let job: Record<string, unknown>;
  let requires: Record<string, unknown> | null = null;
  if (r.job.kind === 'report') {
    const delivery: Record<string, unknown>[] = [
      { type: 'file', format: r.job.format, ...(r.job.retain ? { retain: r.job.retain } : {}) },
    ];
    if (r.job.emailEnv) delivery.push({ type: 'email', to: [env(r.job.emailEnv)], format: r.job.format });
    if (r.job.teamsWebhookEnv) delivery.push({ type: 'teams', webhook: env(r.job.teamsWebhookEnv) });
    job = { kind: 'report', ref: r.job.ref, delivery };
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

  const notify: Record<string, unknown>[] = [];
  if (r.notifyOnFailure?.emailEnv) notify.push({ type: 'email', to: [env(r.notifyOnFailure.emailEnv)] });
  if (r.notifyOnFailure?.teamsWebhookEnv)
    notify.push({ type: 'teams', webhook: env(r.notifyOnFailure.teamsWebhookEnv) });

  const doc: Record<string, unknown> = {
    $schema: '../../../packages/schemas/generated/schedule.schema.json',
    kind: 'schedule',
    id: key,
    version: '1.0.0',
    title: r.title,
    ...(r.summary ? { summary: r.summary } : {}),
    owner: r.owner ?? 'portal-admins',
    cron: r.cron,
    timezone: r.timezone,
    enabled: r.enabled,
    identity: 'automation',
    job,
    ...(r.retries ? { retry: { max: r.retries, backoff: 'exponential', delay: '5m' } } : {}),
    ...(r.timeoutSeconds ? { timeoutSeconds: r.timeoutSeconds } : {}),
    overlap: 'skip',
    ...(notify.length ? { notify: { onFailure: notify } } : {}),
    ...(requires ? { requires } : {}),
  };
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
