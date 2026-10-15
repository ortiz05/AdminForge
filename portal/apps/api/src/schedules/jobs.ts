import { pipeline } from 'node:stream/promises';
import {
  MAX_ATTACHMENT_BYTES,
  postTeams,
  sendEmail,
  type DeliveryDeps,
  type DeliveryStatus,
} from '../delivery/notifier';
import { isTerminal } from '@adminforge/engine';
import type { Delivery, Probe, ProbeJob, Schedule } from '@adminforge/schemas';
import type { ArtifactStore, WrittenArtifact } from '../artifacts/store';
import { missingLicences } from '../capabilities/licences';
import type { DatasourceRunner, LoadedPage, UserScope } from '../datasources/executor';
import type { DefinitionRegistry } from '../definitions/types';
import { AppError } from '../errors';
import type { ExecutionIdentity, OutboundExecutor } from '../execution/types';
import { runProbe, type ProbeDeps, type ProbeOutcome } from '../probes/checks';
import { cellValue, exportPages, exportStream, planExport, type ExportFormat } from '../reports/export';
import type { RunRepository } from '../runs/types';
import type { RunService } from '../runs/service';
import { contentHealth } from './content-health';
import type { ScheduleStore } from './store';
import type { ScheduleRow, ScheduleRunRow } from './types';

/**
 * What each `job.kind` does when a schedule fires (R6, ADR-011). Everything runs as the automation identity in read
 * mode, except playbook jobs, which hand over to the runs worker (`RunService.createScheduledRun`, identity
 * `automation`, two-person approval for write playbooks).
 */

export const AUTOMATION: ExecutionIdentity = { kind: 'automation', mode: 'read' };
/** `user` in expression scope for scheduled reports. */
export const AUTOMATION_USER: UserScope = {
  oid: 'automation',
  upn: 'automation identity',
  name: 'Automation identity',
  roles: ['Portal.Reader'],
};

export interface JobContext {
  schedule: ScheduleRow;
  def: Schedule;
  run: ScheduleRunRow;
  signal: AbortSignal;
  correlationId: string;
  /** "scheduled by" for audit and scheduled playbook runs. */
  scheduledBy: string | null;
  /** Run now: the requester's oid (they can't approve gates in the run they asked for). */
  requestedByOid?: string | null;
}

export interface JobResult {
  /** Default: succeeded. */
  status?: 'succeeded' | 'failed';
  result?: Record<string, unknown>;
  runId?: string;
  artifactPath?: string;
  error?: { code: string; message: string; hint?: string };
}

export interface JobRunner {
  run(ctx: JobContext): Promise<JobResult>;
}

export interface JobDeps {
  definitions: DefinitionRegistry;
  store: ScheduleStore;
  outbound: OutboundExecutor;
  probes: Omit<ProbeDeps, 'outbound'>;
  datasources: DatasourceRunner;
  artifacts: ArtifactStore;
  /** Scheduled playbook runs; null when the runs module is not available in this process. */
  runs: { service: RunService; repo: RunRepository } | null;
  automationClientId: string | null;
  exportMaxRows: number;
  now: () => Date;
  /** Abortable sleep (tests inject a fake). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called after each probe result is stored (events). */
  onProbe?: (outcome: ProbeOutcome) => void;
  /** Email/Teams delivery of report files (absent: those targets are reported as not configured). */
  delivery?: DeliveryDeps;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const INACTIVE = new Set(['draft', 'retired']);

/** The probes a probe job covers: `ref`, `refs`, or every active probe carrying all `select.tags` (sorted by key). */
export async function selectProbes(
  job: ProbeJob,
  definitions: Pick<DefinitionRegistry, 'list' | 'resolve'>,
): Promise<Array<{ key: string; probe: Probe }>> {
  if (job.ref) return [{ key: job.ref, probe: (await definitions.resolve('probe', job.ref)).def }];
  if (job.refs)
    return Promise.all(
      job.refs.map(async (key) => ({ key, probe: (await definitions.resolve('probe', key)).def })),
    );
  const tags = job.select?.tags ?? [];
  return (await definitions.list('probe'))
    .map((r) => ({ key: r.key, probe: r.def as Probe }))
    .filter(
      ({ probe }) => !INACTIVE.has(probe.status ?? 'active') && tags.every((t) => probe.tags?.includes(t)),
    )
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Runs `fn` over items with at most `limit` at a time. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function createJobRunner(deps: JobDeps): JobRunner {
  const sleep = deps.sleep ?? defaultSleep;

  async function probeJob(ctx: JobContext, job: ProbeJob): Promise<JobResult> {
    const probes = await selectProbes(job, deps.definitions);
    if (!probes.length)
      return {
        status: 'failed',
        error: {
          code: 'no_probes',
          message: `No active probe matches this job (${job.select ? `tags ${job.select.tags.join(', ')}` : 'refs'}).`,
        },
      };
    const counts = { ok: 0, warn: 0, crit: 0, error: 0 };
    const results: Array<{ key: string; status: string; metric: number | null; code: string }> = [];
    await eachLimited(probes, job.concurrency ?? 4, async ({ key, probe }) => {
      if (ctx.signal.aborted) return;
      const outcome = await runProbe(
        key,
        probe,
        { ...deps.probes, outbound: deps.outbound },
        { signal: ctx.signal, correlationId: ctx.correlationId },
      );
      counts[outcome.status]++;
      results.push({ key, status: outcome.status, metric: outcome.metric, code: outcome.code });
      await deps.store.insertProbeResult({
        probeKey: key,
        ts: outcome.ts,
        status: outcome.status,
        metric: outcome.metric,
        durationMs: outcome.durationMs,
        message: outcome.message.slice(0, 2000),
        details: outcome.details,
        scheduleRunId: ctx.run.id,
      });
      deps.onProbe?.(outcome);
    });
    if (ctx.signal.aborted) throw ctx.signal.reason;
    results.sort((a, b) => a.key.localeCompare(b.key));
    const result = { probes: probes.length, ...counts, results };
    if (counts.error === probes.length)
      return {
        status: 'failed',
        result,
        error: {
          code: 'probes_errored',
          message: `None of the ${probes.length} probe(s) could be evaluated (see each probe's message).`,
        },
      };
    return { result };
  }

  async function reportJob(
    ctx: JobContext,
    job: Extract<Schedule['job'], { kind: 'report' }>,
  ): Promise<JobResult> {
    const resolved = await deps.definitions.resolve('report', job.ref);
    const page: LoadedPage = {
      def: resolved.def,
      version: resolved.version,
      sha256: resolved.sha256,
      kind: 'report',
      key: job.ref,
    };
    const params = await deps.datasources.prepareParams(page, job.params ?? {}, AUTOMATION_USER);
    const spec = page.def.export;
    if (!spec)
      throw new AppError(
        400,
        'export_not_supported',
        `Report ${job.ref} declares no export, so it cannot be scheduled.`,
      );
    const notes: DeliveryStatus[] = [];
    let files = job.delivery.filter((d): d is Extract<Delivery, { type: 'file' }> => d.type === 'file');
    if (!files.length) files = [{ type: 'file', format: job.delivery[0]?.format ?? 'xlsx' }];
    const formats = [...new Set(files.map((f) => f.format))];
    const written: Array<WrittenArtifact & { format: string; rows: number; truncated: boolean }> = [];
    const at = deps.now();
    for (const format of formats) {
      const planFormat: ExportFormat =
        format === 'json' ? (spec.formats.includes('csv') ? 'csv' : spec.formats[0]!) : format;
      const plan = await planExport(page, params, planFormat, { maxRows: deps.exportMaxRows });
      const pages = exportPages(
        deps.datasources,
        {
          identity: AUTOMATION,
          user: AUTOMATION_USER,
          page,
          params,
          correlationId: ctx.correlationId,
          signal: ctx.signal,
        },
        plan,
      );
      let stats = { rows: 0, truncated: false };
      const artifact = await deps.artifacts.write(ctx.schedule.key, at, format, async (out) => {
        if (format === 'json') {
          const rows: Record<string, unknown>[] = [];
          for await (const p of pages) {
            stats = { rows: stats.rows + p.rows.length, truncated: stats.truncated || p.truncated };
            for (const r of p.rows)
              rows.push(Object.fromEntries(plan.columns.map((c) => [c.field, cellValue(r, c, 'csv')])));
          }
          await pipeline(async function* () {
            yield JSON.stringify(
              {
                report: job.ref,
                version: page.version,
                generatedAt: at.toISOString(),
                params,
                columns: plan.columns.map((c) => ({ field: c.field, label: c.label })),
                rows,
                truncated: stats.truncated,
              },
              null,
              2,
            );
          }, out);
          return;
        }
        await pipeline(
          exportStream(format, plan.columns, pages, (_err, s) => {
            stats = s;
          }),
          out,
        );
      });
      written.push({ ...artifact, format, ...stats });
      const retain = files.find((f) => f.format === format && f.retain)?.retain;
      if (retain) await deps.artifacts.prune(ctx.schedule.key, format, retain);
    }
    // Email and Teams: the report goes out after the file is safely written (the file stays with the run either way).
    for (const d of job.delivery) {
      if (d.type === 'file') continue;
      if (!deps.delivery) {
        notes.push({
          type: d.type,
          status: 'not_configured',
          message: 'Delivery is not available in this process.',
        });
        continue;
      }
      const file = written.find((w) => w.format === (d.format ?? written[0]!.format)) ?? written[0]!;
      const def = ctx.schedule.definition;
      const msg = {
        title:
          (d.type === 'email' ? d.subject : undefined) ?? `${def.title} — ${at.toISOString().slice(0, 10)}`,
        text: `${d.message ?? `The scheduled report "${resolved.def.title}" ran: ${file.rows} row(s)${file.truncated ? ' (truncated)' : ''}.`}\nSchedule: ${def.title}. Reference: ${ctx.correlationId}.`,
        link: `${deps.delivery.publicBaseUrl}/schedules/${encodeURIComponent(ctx.schedule.key)}`,
      };
      if (d.type === 'email') {
        const opened = d.attach === false ? null : await deps.artifacts.open(file.path);
        const bytes = opened ? await streamBytes(opened.stream, MAX_ATTACHMENT_BYTES + 1) : null;
        notes.push(
          await sendEmail(
            deps.delivery,
            { to: d.to, ...(d.cc ? { cc: d.cc } : {}) },
            {
              ...msg,
              ...(bytes && opened
                ? { attachment: { name: file.name, contentType: opened.contentType, bytes } }
                : {}),
            },
            ctx.correlationId,
          ),
        );
      } else notes.push(await postTeams(deps.delivery, d.webhook, msg));
    }
    return {
      artifactPath: written[0]!.path,
      result: {
        report: job.ref,
        version: page.version,
        artifacts: written.map((w) => ({
          path: w.path,
          name: w.name,
          size: w.size,
          format: w.format,
          rows: w.rows,
          truncated: w.truncated,
        })),
        ...(notes.length ? { delivery: notes } : {}),
      },
    };
  }

  async function playbookJob(
    ctx: JobContext,
    job: Extract<Schedule['job'], { kind: 'playbook' }>,
  ): Promise<JobResult> {
    if (!deps.runs)
      throw new AppError(503, 'runs_unavailable', 'Playbook runs are not available in this process.');
    // Only the in-app two-person approval counts; `job.approvedBy` in content is a review note, not proof.
    let row;
    try {
      row = await deps.runs.service.createScheduledRun({
        schedule: {
          id: ctx.schedule.id,
          key: ctx.schedule.key,
          createdBy: ctx.scheduledBy,
          ...(ctx.requestedByOid ? { requestedByOid: ctx.requestedByOid } : {}),
          approvedBy: ctx.schedule.approvedBy ? [ctx.schedule.approvedBy] : [],
          approvedTarget: ctx.schedule.approvedTarget,
        },
        playbook: job.ref,
        inputs: job.inputs,
        dryRun: job.dryRun,
        correlationId: ctx.correlationId,
      });
    } catch (err) {
      // The playbook changed since approval: switch the schedule off so it needs a fresh two-person approval.
      if (err instanceof AppError && err.code === 'approval_outdated')
        await deps.store.updateSchedule(ctx.schedule.id, {
          enabled: false,
          approvedBy: null,
          approvedTarget: null,
          nextRunAt: null,
        });
      throw err;
    }
    // Follow the run until it ends or waits for a person; the schedule's timeout bounds the wait (the run continues).
    let status = row.status;
    for (;;) {
      const r = await deps.runs.repo.getRun(row.id);
      status = r?.status ?? status;
      if (isTerminal(status)) {
        if (status === 'succeeded')
          return {
            runId: row.id,
            result: { playbook: job.ref, runStatus: status, dryRun: job.dryRun === true },
          };
        return {
          status: 'failed',
          runId: row.id,
          result: { playbook: job.ref, runStatus: status },
          error: { code: 'run_failed', message: r?.error?.message ?? `The playbook run ended ${status}.` },
        };
      }
      if (status.startsWith('awaiting_'))
        return { runId: row.id, result: { playbook: job.ref, runStatus: status, handedOver: true } };
      await sleep(2_000, ctx.signal);
    }
  }

  return {
    async run(ctx) {
      const job = ctx.def.job;
      switch (job.kind) {
        case 'probe':
          return probeJob(ctx, job);
        case 'report':
          return reportJob(ctx, job);
        case 'playbook':
          return playbookJob(ctx, job);
        case 'script':
          throw new AppError(
            501,
            'script_not_supported',
            'Scheduled PowerShell scripts can’t run yet: the runner can’t sign in to Exchange, Teams or SharePoint as the automation identity. The script was not run.',
            {
              hint: 'Run the script from its page instead, or turn this schedule off. (Tracked in docs/backlog.md.)',
            },
          );
        case 'contentHealth': {
          const licences = deps.probes.licences;
          const licensed = licences
            ? async (required: string[]) => {
                const missing = missingLicences(
                  await licences.get(AUTOMATION, { correlationId: ctx.correlationId }),
                  required,
                );
                return missing === null ? null : missing.length === 0;
              }
            : undefined;
          const report = await contentHealth(deps.definitions, {
            scopes: job.scopes,
            outbound: deps.outbound,
            automationClientId: deps.automationClientId,
            ...(licensed ? { licensed } : {}),
            correlationId: ctx.correlationId,
            signal: ctx.signal,
          });
          const failing = report.problems > 0 || (report.scopes?.missing.length ?? 0) > 0;
          return failing
            ? {
                status: 'failed',
                result: { ...report },
                error: {
                  code: 'content_unhealthy',
                  message: [
                    report.problems ? `${report.problems} content problem(s)` : '',
                    report.scopes?.missing.length
                      ? `${report.scopes.missing.length} declared permission(s) the automation identity lacks`
                      : '',
                  ]
                    .filter(Boolean)
                    .join('; '),
                },
              }
            : { result: { ...report } };
        }
      }
    },
  };
}

/** Reads a stream into memory, stopping after `limit` bytes (the caller treats a full buffer as "too large"). */
async function streamBytes(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= limit) {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      break;
    }
  }
  return Buffer.concat(chunks);
}
