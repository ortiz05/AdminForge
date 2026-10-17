import { useMemo, type ReactNode } from 'react';
import { errorDescription } from '../lib/errors';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Playbook, Runbook } from '@adminforge/schemas';
import {
  ArrowClockwiseIcon,
  Badge,
  Button,
  CodeBlock,
  ConfirmDialog,
  formatRelative,
  formatTimestamp,
  IdChip,
  LockKeyOpenIcon,
  PageHeader,
  Panel,
  RobotIcon,
  Skeleton,
  SkeletonText,
  StopCircleIcon,
  useNow,
  useToast,
} from '@adminforge/ui';
import { activeRunsQueryKey } from './keys';
import { RouterLink } from '../app/RouterLink';
import { useShell } from '../app/shell-context';
import { api, ApiRequestError, loginUrl } from '../lib/api';
import { browser } from '../lib/browser';
import { useMe } from '../lib/session';
import { Callout, elapsed, Facts, QueryError, useDocumentTitle } from '../ops/ui';
import { definitionQuery } from '../playbooks/contracts';
import { humanize, labelOf as inputLabel } from '../playbooks/form';
import { ApprovalCard, ManualStepCard } from './HumanTasks';
import { readApprovalItem } from './approvals';
import { isTerminal, labelOf, latestSteps, type RunDetail, type StepIndex } from './contracts';
import { LogView } from './LogView';
import { PlanView } from './PlanView';
import { buildTimeline, RunTimeline, stepIndex } from './RunTimeline';
import { RunStatusPill } from './status';
import { MaskedSecret, SecretNotices, SecretPanel } from './SecretPanel';
import { isSecretMask, maskSecrets, secretKey } from './secrets';
import { useRunLive } from './useRunLive';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRIGGER: Record<string, string> = {
  interactive: 'Started in the portal',
  bulk: 'Bulk action',
  schedule: 'Schedule',
  child: 'Child of another run',
};

function InputValue({ value, unit }: { value: unknown; unit?: string }) {
  if (value === undefined || value === null || value === '') return <span className="text-fg-3">—</span>;
  if (isSecretMask(value)) return <MaskedSecret value={value} />;
  if (value === '[redacted]' || value === '***')
    return <span className="font-mono text-xs text-fg-3">redacted</span>;
  if (typeof value === 'string' && GUID_RE.test(value))
    return <IdChip value={value} showLabel={false} label="Id" />;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number' && unit)
    return <span className="tabular-nums">{`${value.toLocaleString('en-US')} ${unit}`}</span>;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string'))
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((v) =>
          GUID_RE.test(v) ? (
            <IdChip key={v} value={v} showLabel={false} label="Id" />
          ) : (
            <Badge key={v}>{v}</Badge>
          ),
        )}
      </span>
    );
  if (typeof value === 'object')
    return <code className="font-mono text-xs break-all">{JSON.stringify(value)}</code>;
  return <span className="break-words">{String(value)}</span>;
}

/** What the run is waiting for, and the one thing that moves it on. */
function ParkedBanner({
  detail,
  index,
  onResume,
  resuming,
}: {
  detail: RunDetail;
  index: StepIndex;
  onResume: () => void;
  resuming: boolean;
}) {
  const me = useMe();
  const { arm, openArmDialog } = useShell();
  const run = detail.run;
  const steps = latestSteps(detail.steps);
  const waitingStep = run.waiting?.stepId ?? steps.find((s) => s.status === 'waiting')?.stepId;
  const status =
    run.waiting?.kind === 'arm'
      ? 'awaiting_arm'
      : run.waiting?.kind === 'reauth'
        ? 'awaiting_reauth'
        : run.status;

  switch (status) {
    case 'awaiting_arm':
      return (
        <Callout
          tone="warn"
          icon={<LockKeyOpenIcon size={18} />}
          title="Paused: the next step changes your tenant and needs write access"
          action={
            arm.armed ? (
              <Button intent="primary" pending={resuming} onClick={onResume}>
                Resume run
              </Button>
            ) : me.canArm ? (
              <Button onClick={openArmDialog}>
                <LockKeyOpenIcon size={14} aria-hidden />
                Arm write access
              </Button>
            ) : undefined
          }
        >
          {arm.armed
            ? 'Write access is on. Resume to continue from where the run stopped.'
            : `Write access ended before ${waitingStep ? `“${labelOf(index, waitingStep)}”` : 'the next step'} could start. Arm again, then resume — nothing that already ran is repeated.`}
        </Callout>
      );
    case 'awaiting_reauth':
      return (
        <Callout
          tone="warn"
          title="Paused: Microsoft asked you to sign in again"
          action={
            <>
              <Button onClick={() => browser.assign(loginUrl('/auth/login'))}>Sign in again</Button>
              <Button intent="ghost" pending={resuming} onClick={onResume}>
                Resume run
              </Button>
            </>
          }
        >
          Your session needs fresh credentials (sign-in frequency, Conditional Access, or revoked tokens).
          Sign in, then resume.
        </Callout>
      );
    case 'needs_review': {
      const stuck = steps.find((s) => s.status === 'needs_review');
      return (
        <Callout tone="crit" title="Needs review: a step may or may not have happened">
          {stuck ? `“${labelOf(index, stuck.stepId)}”` : 'A step'} can’t be retried safely and was in flight
          when the worker stopped. Check the target in the Microsoft admin center before running anything
          again.
        </Callout>
      );
    }
    default:
      return null;
  }
}

/** Pending approval gates and manual steps of this run, decided right here. */
function HumanTaskPanels({
  detail,
  def,
  index,
}: {
  detail: RunDetail;
  def: Playbook | Runbook | null;
  index: StepIndex;
}) {
  const run = detail.run;
  const pending = detail.tasks.filter((t) => t.status === 'pending');
  const approvals = pending
    .filter((t) => t.kind === 'approval')
    .map((t) =>
      readApprovalItem({
        id: t.id,
        subjectType: 'run',
        subjectId: run.id,
        stepId: t.stepId,
        title: `${run.title} · ${labelOf(index, t.stepId.replace(/^.*[.\]]/, ''))}`,
        requestedBy: t.requestedBy ?? run.initiator.upn ?? '',
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        message: t.message,
        policy: { approvers: t.approvers, minApprovals: t.minApprovals },
        requiresArm: t.writesAfter ?? (def ? def.mode === 'write' : undefined),
        canDecide: t.canDecide ?? undefined,
      }),
    )
    .filter((x): x is NonNullable<typeof x> => !!x);
  const manual = pending.filter((t) => t.kind === 'manual');
  if (!approvals.length && !manual.length) return null;
  const outline = def
    ? def.kind === 'playbook'
      ? def.steps
      : def.sections.flatMap((s) => s.steps ?? [])
    : [];
  return (
    <div className="flex flex-col gap-3">
      {approvals.map((it) => (
        <ApprovalCard key={it.id} item={it} headingLevel={2} />
      ))}
      {manual.map((t) => {
        const leaf = t.stepId.replace(/^.*[.\]]/, '');
        const spec = outline.find((o) => o.id === leaf);
        return (
          <ManualStepCard
            key={t.id}
            runId={run.id}
            stepId={t.stepId}
            title={t.title && t.title !== run.title ? t.title : labelOf(index, leaf)}
            instructions={t.instructions ?? (spec && spec.type === 'manual' ? spec.instructions : '')}
            checklist={
              t.checklist.length ? t.checklist : spec && spec.type === 'manual' ? (spec.checklist ?? []) : []
            }
          />
        );
      })}
    </div>
  );
}

/** One run (§6.6 `run` template): status header, live step timeline, logs, outputs, plan, approvals and manual steps. */
export function RunPage({ id }: { id: string }) {
  const me = useMe();
  const now = useNow(5_000);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { query: q, detail, logs, live, secrets, notices, dismissSecret } = useRunLive(id);
  const run = detail?.run;
  const defQ = useQuery({
    ...definitionQuery<Playbook | Runbook>(
      run?.kind ?? 'playbook',
      run?.key ?? '',
      run?.version ?? undefined,
    ),
    enabled: Boolean(run && run.key !== 'unknown'),
    retry: false,
  });
  // Bulk runs are synthesised from the target playbook; the outline is the single forEach, so skip it.
  const def = run?.trigger === 'bulk' ? null : (defQ.data?.def ?? null);
  const entries = useMemo(() => (detail ? buildTimeline(detail, def) : []), [detail, def]);
  const index = useMemo(() => stepIndex(def), [def]);
  useDocumentTitle(run ? `${run.title} · run` : 'Run');

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['runs', 'detail', id] });
  const cancel = useMutation({
    mutationFn: () => api(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast({
        tone: 'info',
        title: 'Run cancelled',
        description: 'Steps that already ran stay done; nothing new starts.',
      });
      refresh();
      void queryClient.invalidateQueries({ queryKey: activeRunsQueryKey });
    },
    onError: (e) =>
      toast({ tone: 'crit', title: 'The run wasn’t cancelled', description: errorDescription(e) }),
  });
  const resume = useMutation({
    mutationFn: () => api(`/api/runs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
    onSuccess: () => {
      toast({ tone: 'info', title: 'Run resumed' });
      refresh();
    },
    onError: (e) => toast({ tone: 'crit', title: 'The run didn’t resume', description: errorDescription(e) }),
  });

  const crumbs = [{ label: 'Runs', href: '/runs' }, { label: run?.title ?? 'Run' }];

  if (q.isError) {
    const notFound = q.error instanceof ApiRequestError && q.error.status === 404;
    return (
      <>
        <PageHeader
          breadcrumbs={crumbs}
          linkAs={RouterLink}
          eyebrow="Run"
          title={notFound ? 'Run not found' : 'Run'}
        />
        <Panel>
          <QueryError
            title={notFound ? 'There’s no run with this id, or you can’t see it' : 'This run didn’t load'}
            error={q.error}
            onRetry={notFound ? undefined : () => void q.refetch()}
          />
        </Panel>
      </>
    );
  }

  if (!detail || !run) {
    return (
      <div aria-busy="true" className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-96" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid gap-6 xl:grid-cols-3">
          <Panel className="xl:col-span-2">
            <SkeletonText lines={6} />
          </Panel>
          <Panel>
            <SkeletonText lines={5} />
          </Panel>
        </div>
      </div>
    );
  }

  const terminal = isTerminal(run.status);
  const took = elapsed(run.startedAt ?? run.createdAt, run.endedAt, now);
  const done = entries.filter((e) =>
    ['succeeded', 'skipped', 'planned', 'failed', 'compensated'].includes(e.status),
  ).length;
  const failedAt = entries.findIndex((e) => e.status === 'failed' || e.status === 'needs_review');
  const description = [
    run.identity === 'automation'
      ? run.identityName
        ? `Ran as app identity ${run.identityName}`
        : 'Ran as the automation identity'
      : `Started by ${run.initiator.upn === me.user.upn ? 'you' : (run.initiator.upn ?? 'someone')}`,
    run.createdAt ? formatRelative(run.createdAt, now) : null,
    took ? (terminal ? `took ${took}` : `running for ${took}`) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        linkAs={RouterLink}
        eyebrow={run.dryRun ? 'Dry run' : run.kind === 'runbook' ? 'Runbook run' : 'Run'}
        title={run.title}
        meta={
          <>
            <RunStatusPill status={run.status} />
            {run.dryRun && <Badge tone="accent">Dry run · nothing changed</Badge>}
            {live && (
              <span className="inline-flex items-center gap-1.5 text-xs text-fg-3">
                <span
                  className="size-1.5 animate-pulse rounded-pill bg-ok motion-reduce:animate-none"
                  aria-hidden
                />
                Live
              </span>
            )}
          </>
        }
        description={description}
        actions={
          <>
            <Button intent="ghost" size="md" onClick={refresh} aria-label="Refresh run">
              <ArrowClockwiseIcon size={15} aria-hidden />
              Refresh
            </Button>
            {!terminal && (
              <ConfirmDialog
                trigger={
                  <Button>
                    <StopCircleIcon size={15} aria-hidden />
                    Cancel run
                  </Button>
                }
                title="Cancel this run?"
                description="Steps that already ran stay done. A step in flight finishes; nothing new starts."
                confirmLabel="Cancel run"
                cancelLabel="Keep running"
                intent="danger"
                onConfirm={() => cancel.mutateAsync().then(() => undefined)}
              />
            )}
          </>
        }
      />

      <div className="flex flex-col gap-6">
        {secrets.map((s) => {
          const child = s.runId !== run.id ? detail.children.find((c) => c.id === s.runId) : undefined;
          return (
            <SecretPanel
              key={secretKey(s)}
              secret={s}
              childRun={s.runId !== run.id}
              stepLabel={
                child
                  ? `${child.title} · ${humanize(s.stepId)}`
                  : s.runId === run.id
                    ? labelOf(index, s.stepId)
                    : humanize(s.stepId)
              }
              onDismiss={() => dismissSecret(secretKey(s))}
            />
          );
        })}
        <SecretNotices
          notices={notices.filter((n) => !secrets.some((s) => secretKey(s) === secretKey(n)))}
          labelFor={(stepId) => labelOf(index, stepId)}
        />
        <ParkedBanner
          detail={detail}
          index={index}
          onResume={() => resume.mutate()}
          resuming={resume.isPending}
        />
        {run.error && run.status !== 'needs_review' && (
          <Callout
            tone={run.status === 'compensated' ? 'warn' : 'crit'}
            role="alert"
            title={
              run.status === 'compensated'
                ? 'The run failed and its changes were rolled back'
                : 'The run failed'
            }
          >
            <p>{run.error.message}</p>
            {run.error.hint && <p className="mt-1">{run.error.hint}</p>}
            <p className="mt-2 flex flex-wrap items-center gap-2">
              {run.error.code && (
                <Badge mono tone="outline">
                  {run.error.code}
                </Badge>
              )}
              {run.error.status && (
                <Badge mono tone="outline">
                  HTTP {run.error.status}
                </Badge>
              )}
              {run.error.requestId && <IdChip value={run.error.requestId} label="Microsoft request-id" />}
              {run.correlationId && <IdChip value={run.correlationId} label="Correlation ID" />}
            </p>
          </Callout>
        )}
        <HumanTaskPanels detail={detail} def={def} index={index} />

        <div className="grid items-start gap-6 xl:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-6 xl:col-span-2">
            <Panel
              eyebrow="Steps"
              title={
                entries.length
                  ? failedAt >= 0
                    ? `Stopped at step ${failedAt + 1} of ${entries.length}`
                    : `${done} of ${entries.length} done`
                  : 'Steps'
              }
              actions={
                run.progress ? (
                  <span className="font-mono text-xs text-fg-3 tabular-nums">
                    {run.progress.done}/{run.progress.total}
                    {run.progress.failed ? ` · ${run.progress.failed} failed` : ''}
                  </span>
                ) : undefined
              }
            >
              {entries.length ? (
                <RunTimeline
                  entries={entries}
                  initiatorUpn={run.initiator.upn}
                  label={`Steps of ${run.title}`}
                />
              ) : (
                <p className="text-sm text-fg-3">
                  {terminal ? 'This run recorded no steps.' : 'Waiting for the first step…'}
                </p>
              )}
            </Panel>
            {detail.children.length > 0 && (
              <Panel
                eyebrow={run.trigger === 'bulk' ? 'Items' : 'Child runs'}
                title={`${detail.children.filter((c) => isTerminal(c.status)).length} of ${detail.children.length} finished`}
                flush
              >
                <ul className="flex flex-col">
                  {detail.children.map((c, i) => (
                    <li
                      key={c.id}
                      className="flex items-center justify-between gap-3 border-t border-line px-(--af-pad-panel) py-2.5 first:border-t-0"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="font-mono text-2xs text-fg-3 tabular-nums">
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <Link
                          to="/runs/$id"
                          params={{ id: c.id }}
                          className="truncate text-sm font-medium text-fg hover:underline"
                        >
                          {c.title}
                        </Link>
                      </span>
                      <RunStatusPill status={c.status} size="sm" />
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
            {detail.plan.length > 0 && (
              <Panel eyebrow="Plan" title={run.dryRun ? 'What a real run would change' : 'Planned changes'}>
                <PlanView plan={detail.plan} title="Changes" />
              </Panel>
            )}
            <Panel eyebrow="Logs" title="Step output" flush>
              <div className="px-(--af-pad-panel) pb-(--af-pad-panel)">
                <LogView logs={logs} steps={detail.steps} live={live} />
              </div>
            </Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-6">
            <Panel eyebrow="Details" title="About this run">
              <Facts
                items={[
                  [
                    run.kind === 'runbook' ? 'Runbook' : 'Playbook',
                    run.kind === 'runbook' ? (
                      <Link
                        to="/runbooks/$key"
                        params={{ key: run.key }}
                        search={{ run: run.id }}
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        {run.key}
                      </Link>
                    ) : (
                      <Link
                        to="/playbooks/$key"
                        params={{ key: run.key }}
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        {run.key}
                      </Link>
                    ),
                  ],
                  ['Version', run.version ? <span className="font-mono text-xs">{run.version}</span> : null],
                  ['Run ID', <IdChip key="id" value={run.id} label="Run ID" showLabel={false} />],
                  [
                    'Correlation ID',
                    run.correlationId ? (
                      <IdChip key="c" value={run.correlationId} label="Correlation ID" showLabel={false} />
                    ) : null,
                  ],
                  [
                    'Runs as',
                    run.identity === 'automation' ? (
                      <span className="inline-flex items-center gap-1.5">
                        <RobotIcon size={14} aria-hidden className="text-fg-3" />
                        Automation identity
                      </span>
                    ) : (
                      (run.initiator.upn ?? '—')
                    ),
                  ],
                  ['Trigger', TRIGGER[run.trigger] ?? run.trigger],
                  [
                    'Started',
                    run.startedAt || run.createdAt ? (
                      <time dateTime={(run.startedAt ?? run.createdAt)!}>
                        {formatTimestamp((run.startedAt ?? run.createdAt)!)}
                      </time>
                    ) : null,
                  ],
                  [
                    'Ended',
                    run.endedAt ? (
                      <time dateTime={run.endedAt}>{formatTimestamp(run.endedAt)}</time>
                    ) : terminal ? null : (
                      'Still running'
                    ),
                  ],
                  ...(run.parentRunId
                    ? ([
                        [
                          'Part of',
                          <Link
                            key="p"
                            to="/runs/$id"
                            params={{ id: run.parentRunId }}
                            className="text-accent hover:underline"
                          >
                            Parent run
                          </Link>,
                        ],
                      ] as Array<[string, ReactNode]>)
                    : []),
                ]}
              />
            </Panel>
            <Panel eyebrow="Inputs" title="What it ran with">
              {Object.keys(run.inputs).length ? (
                <Facts
                  items={Object.entries(run.inputs).map(([k, v]) => [
                    def?.inputs?.[k] ? inputLabel(k, def.inputs[k]!) : humanize(k),
                    <InputValue
                      key={k}
                      value={v}
                      unit={
                        def?.inputs?.[k]?.type === 'number'
                          ? (def.inputs[k] as { unit?: string }).unit
                          : undefined
                      }
                    />,
                  ])}
                />
              ) : (
                <p className="text-sm text-fg-3">No inputs.</p>
              )}
            </Panel>
            {run.outputs && Object.keys(run.outputs).length > 0 && (
              <Panel eyebrow="Outputs" title={terminal ? 'Result' : 'So far'}>
                <div className="flex flex-col gap-3">
                  {Object.entries(run.outputs).map(([k, v]) =>
                    isSecretMask(v) ? (
                      <div key={k} className="flex flex-col gap-0.5 text-sm">
                        <span className="text-xs text-fg-3">{humanize(k)}</span>
                        <MaskedSecret value={v} />
                      </div>
                    ) : v !== null && typeof v === 'object' ? (
                      <CodeBlock
                        key={k}
                        title={humanize(k)}
                        language="json"
                        code={JSON.stringify(maskSecrets(v), null, 2)}
                        maxHeight={240}
                      />
                    ) : (
                      <div key={k} className="flex flex-col gap-0.5 text-sm">
                        <span className="text-xs text-fg-3">{humanize(k)}</span>
                        <span className="break-words text-fg">{v === null ? '—' : String(v)}</span>
                      </div>
                    ),
                  )}
                </div>
              </Panel>
            )}
            {run.identity === 'automation' && (
              <Callout tone="neutral" icon={<RobotIcon size={18} />} title="Unattended run">
                {run.identityName
                  ? `Scheduled runs use the application permissions of app identity ${run.identityName}, not a person’s session.`
                  : 'Scheduled runs use the automation identity’s application permissions, not a person’s session.'}
              </Callout>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
