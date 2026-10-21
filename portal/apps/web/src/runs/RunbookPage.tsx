import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import type { Runbook, RunbookSection, Step } from '@adminforge/schemas';
import {
  ArrowSquareOutIcon,
  Badge,
  Button,
  Checkbox,
  cn,
  EmptyState,
  escapeMarkdown,
  PageHeader,
  Panel,
  PlayIcon,
  Skeleton,
  SkeletonText,
  useToast,
} from '@adminforge/ui';
import { activeRunsQueryKey } from './keys';
import { RouterLink } from '../app/RouterLink';
import { api, ApiRequestError } from '../lib/api';
import { useMe } from '../lib/session';
import { Callout, QueryError, useDocumentTitle } from '../ops/ui';
import { definitionQuery, inputsOf } from '../playbooks/contracts';
import { humanize, initialValues, prefillFromSearch, validateForm } from '../playbooks/form';
import { decodeParam } from '../playbooks/url';
import { InputsForm } from '../playbooks/InputsForm';
import { RiskBanner } from '../playbooks/Preflight';
import { playbookSearch } from '../playbooks/url';
import { latestSteps, StartRunResponse, type RunDetail, type RunStep, type StepStatus } from './contracts';
import { ManualStepCard } from './HumanTasks';
import { RunDataHidden } from './RunDataHidden';
import { Markdown } from './Markdown';
import { STEP_STATUS_VIEW, RunStatusPill, StatusGlyph } from './status';
import { TYPE_LABEL } from './RunTimeline';
import { SecretPanel } from './SecretPanel';
import { secretKey } from './secrets';
import { useRunLive } from './useRunLive';

export interface RunbookSearch {
  run?: string;
}

/** A value inserted into runbook Markdown: plain text, escaped so data never becomes a link or markup. */
const asMarkdownText = (v: unknown) =>
  escapeMarkdown(v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** Renders `${ … }` in runbook text against the run's inputs (JSONata loads on demand); raw text until then. */
function useTemplated(text: string | undefined, scope: Record<string, unknown>): string {
  const key = JSON.stringify(scope);
  const [rendered, setRendered] = useState<{ for: string; value: string } | null>(null);
  useEffect(() => {
    let live = true;
    if (!text || !text.includes('${')) return;
    void import('@adminforge/expressions')
      .then(async ({ evaluate, splitTemplate }) => {
        let out = '';
        for (const seg of splitTemplate(text))
          out += seg.type === 'text' ? seg.value : asMarkdownText(await evaluate(seg.source, scope));
        return out;
      })
      .then((value) => live && setRendered({ for: `${text}\u0000${key}`, value }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, key]);
  return rendered && rendered.for === `${text}\u0000${key}` ? rendered.value : (text ?? '');
}

function TemplatedMarkdown({ source, scope }: { source: string; scope: Record<string, unknown> }) {
  return <Markdown source={useTemplated(source, scope)} />;
}

type SectionState = 'done' | 'active' | 'blocked' | 'pending';

function sectionState(section: RunbookSection, byId: Map<string, RunStep>): SectionState {
  const steps = section.steps ?? [];
  if (steps.length === 0) return 'done';
  const st = steps.map((s) => byId.get(s.id)?.status ?? 'pending');
  if (st.some((x) => x === 'failed' || x === 'needs_review')) return 'blocked';
  if (st.every((x) => ['succeeded', 'skipped', 'planned', 'compensated'].includes(x))) return 'done';
  if (st.some((x) => x !== 'pending')) return 'active';
  return 'pending';
}

function StepRow({
  step,
  record,
  runId,
  scope,
  full = true,
}: {
  step: Step;
  record?: RunStep;
  runId?: string;
  scope: Record<string, unknown>;
  /** Whether the viewer sees the run whole (S-25); a manual step waits for its own person only. */
  full?: boolean;
}) {
  const status: StepStatus = record?.status ?? 'pending';
  const view = STEP_STATUS_VIEW[status];
  const label = step.name ?? step.describe ?? step.id;

  if (step.type === 'manual') {
    if (runId && status === 'waiting' && full)
      return (
        <ManualStepCard
          runId={runId}
          stepId={step.id}
          title={label}
          instructions={step.instructions}
          checklist={step.checklist ?? []}
        />
      );
    const done = status === 'succeeded';
    return (
      <div
        className={cn(
          'flex flex-col gap-2 rounded-md border border-line p-4',
          done ? 'bg-panel' : 'bg-raised',
        )}
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-fg">
          <StatusGlyph status={status} tone={view.tone} size={16} colored />
          {label}
          <span className="sr-only">: {view.label}</span>
          <Badge className="ml-auto">Manual</Badge>
        </p>
        <TemplatedMarkdown source={step.instructions} scope={scope} />
        {(step.checklist ?? []).length > 0 && (
          <div className="flex flex-col gap-1.5" role="group" aria-label={`${label} checklist`}>
            {(step.checklist ?? []).map((c, i) => (
              <Checkbox key={i} label={c} checked={done} disabled />
            ))}
          </div>
        )}
        {!runId && <p className="text-xs text-fg-3">Start the runbook to work through this checklist.</p>}
        {record?.error && (
          <p className="text-sm text-crit">
            {full ? record.error.message : <span className="font-mono text-xs">{record.error.code}</span>}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-md border border-line bg-panel px-4 py-3">
      <StatusGlyph status={status} tone={view.tone} size={16} colored className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-medium text-fg">
          {label}
          <span className="sr-only">: {view.label}</span>
        </p>
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
          <Badge mono>
            {step.type === 'playbook' ? `Playbook ${step.ref}` : (TYPE_LABEL[step.type] ?? step.type)}
          </Badge>
          {(step.mode ?? 'read') === 'write' && <Badge tone="outline">Changes tenant</Badge>}
          <span>{view.label}</span>
        </p>
        {record?.error && (
          <p className="text-sm text-crit">
            {full ? record.error.message : <span className="font-mono text-xs">{record.error.code}</span>}
            {record.error.hint && <span className="block text-fg-2">{record.error.hint}</span>}
          </p>
        )}
        {step.type === 'playbook' && (
          <span className="flex flex-wrap gap-3 text-xs">
            {record?.childRunId && (
              <Link
                to="/runs/$id"
                params={{ id: record.childRunId }}
                className="font-medium text-accent hover:underline"
              >
                Open child run
              </Link>
            )}
            {!runId && (
              <Link
                to="."
                search={(prev: Record<string, unknown>) => ({
                  ...prev,
                  ...playbookSearch({ playbook: step.ref, inputs: undefined }),
                })}
                className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
              >
                Open this playbook on its own
                <ArrowSquareOutIcon size={12} aria-hidden />
              </Link>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function ProgressRail({
  sections,
  byId,
  total,
  done,
}: {
  sections: RunbookSection[];
  byId: Map<string, RunStep>;
  total: number;
  done: number;
}) {
  return (
    <nav aria-label="Runbook progress" className="sticky top-(--af-layout-rail-h) flex flex-col gap-3 pt-2">
      <p className="af-eyebrow">Progress</p>
      <p className="text-sm text-fg-2">
        <span className="af-display text-xl font-semibold text-fg tabular-nums">{done}</span> of {total} steps
      </p>
      <div className="h-1 overflow-hidden rounded-pill bg-hover" aria-hidden>
        <div
          className="h-full rounded-pill bg-accent"
          style={{ width: `${total ? (done / total) * 100 : 0}%` }}
        />
      </div>
      <ol className="flex flex-col gap-0.5">
        {sections.map((s, i) => {
          const state = sectionState(s, byId);
          const tone =
            state === 'done' ? 'ok' : state === 'blocked' ? 'crit' : state === 'active' ? 'info' : 'neutral';
          return (
            <li key={s.id}>
              <a
                href={`#section-${s.id}`}
                aria-current={state === 'active' ? 'step' : undefined}
                className={cn(
                  'flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-hover hover:text-fg',
                  state === 'active' ? 'bg-accent-subtle font-medium text-fg' : 'text-fg-2',
                )}
              >
                <StatusGlyph
                  status={state === 'active' ? 'waiting' : state}
                  tone={tone}
                  size={15}
                  colored
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="font-mono text-2xs text-fg-3">{i + 1}. </span>
                  {s.title}
                  <span className="sr-only">
                    {' '}
                    —{' '}
                    {state === 'done'
                      ? 'done'
                      : state === 'active'
                        ? 'in progress'
                        : state === 'blocked'
                          ? 'needs attention'
                          : 'not started'}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function RunbookBody({ def, version, runId }: { def: Runbook; version: string; runId?: string }) {
  const me = useMe();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const params = inputsOf(def);
  const rawSearch = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  // Links prefill the start form (`?inputs=<base64url JSON>` or `?userId=…`), checked against the inputs schema.
  const [prefill] = useState(() => prefillFromSearch(params, rawSearch, decodeParam));
  const [values, setValues] = useState(() => initialValues(params, prefill.values).values);
  const [showErrors, setShowErrors] = useState(false);
  const validation = validateForm(params, values);
  const live = useRunLive(runId ?? '', { enabled: Boolean(runId) });
  const detail: RunDetail | undefined = runId ? live.detail : undefined;
  const byId = useMemo(() => new Map(latestSteps(detail?.steps ?? []).map((s) => [s.stepId, s])), [detail]);
  const allSteps = def.sections.flatMap((s) => s.steps ?? []);
  const doneCount = allSteps.filter((s) =>
    ['succeeded', 'skipped', 'planned'].includes(byId.get(s.id)?.status ?? ''),
  ).length;
  const scope = { inputs: detail?.run.inputs ?? values, user: { upn: me.user.upn, name: me.user.name } };

  const start = useMutation({
    mutationFn: (inputs: Record<string, unknown>) =>
      api('/api/runs', {
        method: 'POST',
        body: { playbook: def.id, version, inputs, dryRun: false },
        schema: StartRunResponse,
      }),
    onSuccess: ({ runId: id }) => {
      toast({
        tone: 'info',
        title: `${def.title} started`,
        description: 'Work through the sections in order; progress is saved as you go.',
      });
      void queryClient.invalidateQueries({ queryKey: activeRunsQueryKey });
      void navigate({ to: '/runbooks/$key', params: { key: def.id }, search: { run: id } });
    },
  });

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Runbooks' }, { label: def.title }]}
        linkAs={RouterLink}
        eyebrow="Runbook"
        title={def.title}
        description={def.summary}
        meta={
          <>
            {detail && <RunStatusPill status={detail.run.status} />}
            <Badge tone={def.mode === 'write' ? 'outline' : 'neutral'}>
              {def.mode === 'write' ? 'Changes tenant' : 'Read-only'}
            </Badge>
            <Badge mono>v{version}</Badge>
          </>
        }
        actions={
          detail ? (
            <Link
              to="/runs/$id"
              params={{ id: detail.run.id }}
              className="inline-flex h-(--af-control-h) items-center gap-1.5 rounded-md border border-line bg-raised px-3 font-semibold text-fg hover:bg-hover"
            >
              Open run timeline
            </Link>
          ) : undefined
        }
      />
      <div className="flex items-start gap-10">
        <article className="flex min-w-0 max-w-3xl flex-1 flex-col gap-8" aria-label={def.title}>
          {!runId && (
            <Panel eyebrow="Before you start" title="Start this runbook">
              <div className="flex flex-col gap-5">
                {prefill.problems.length > 0 && (
                  <Callout tone="warn" title="Check the prefilled values">
                    <ul className="flex list-disc flex-col gap-0.5 pl-4">
                      {prefill.problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </Callout>
                )}
                <RiskBanner def={def} />
                {Object.keys(params).length > 0 && (
                  <InputsForm
                    params={params}
                    values={values}
                    errors={showErrors ? validation.errors : {}}
                    onChange={(k, v) => setValues((x) => ({ ...x, [k]: v }))}
                  />
                )}
                {def.mode === 'write' && (
                  <p className="text-sm text-fg-3">
                    Steps that change the tenant pause until you arm write access; checklists and read steps
                    don’t need it.
                  </p>
                )}
                {start.isError && (
                  <Callout tone="crit" role="alert" title="The runbook didn’t start">
                    {(start.error as Error).message}
                    {start.error instanceof ApiRequestError && start.error.hint && (
                      <span className="mt-1 block">{start.error.hint}</span>
                    )}
                  </Callout>
                )}
                <div className="flex justify-end">
                  <Button
                    intent="primary"
                    pending={start.isPending}
                    onClick={() => {
                      setShowErrors(true);
                      if (validation.ok) start.mutate(validation.values);
                    }}
                  >
                    <PlayIcon size={14} weight="fill" aria-hidden />
                    Start runbook
                  </Button>
                </div>
              </div>
            </Panel>
          )}
          {detail && detail.run.access !== 'full' && <RunDataHidden initiator={detail.run.initiator.upn} />}
          {runId && live.query.isError && (
            <QueryError
              title="The run didn’t load"
              error={live.query.error}
              onRetry={() => void live.query.refetch()}
            />
          )}
          {live.secrets.map((s) => (
            <SecretPanel
              key={secretKey(s)}
              secret={s}
              childRun={s.runId !== runId}
              stepLabel={humanize(s.stepId)}
              onDismiss={() => live.dismissSecret(secretKey(s))}
            />
          ))}
          {def.sections.map((section, i) => (
            <section
              key={section.id}
              id={`section-${section.id}`}
              aria-labelledby={`section-${section.id}-title`}
              className="flex scroll-mt-20 flex-col gap-4"
            >
              <h2
                id={`section-${section.id}-title`}
                className="af-display flex items-baseline gap-3 text-xl font-semibold text-fg"
              >
                <span className="font-mono text-sm text-fg-3 tabular-nums">
                  {String(i + 1).padStart(2, '0')}
                </span>
                {section.title}
              </h2>
              {section.body && <TemplatedMarkdown source={section.body} scope={scope} />}
              {(section.steps ?? []).map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  record={byId.get(step.id)}
                  runId={runId}
                  scope={scope}
                  full={detail?.run.access !== 'metadata'}
                />
              ))}
            </section>
          ))}
          {detail?.run.status === 'succeeded' && (
            <Callout tone="ok" title="Runbook complete">
              Every section is done. The run keeps the record of who did what and when.
            </Callout>
          )}
        </article>
        <aside className="hidden w-64 shrink-0 self-stretch lg:block">
          <ProgressRail sections={def.sections} byId={byId} total={allSteps.length} done={doneCount} />
        </aside>
      </div>
    </>
  );
}

/** Runbook (§6.6 `runbook` template): the guided document, its checklists and embedded steps, and a progress rail. */
export function RunbookPage({ runbookKey, search }: { runbookKey: string; search: RunbookSearch }) {
  const q = useQuery(definitionQuery<Runbook>('runbook', runbookKey));
  useDocumentTitle(q.data?.def.title ?? 'Runbook');
  if (q.isError) {
    const notFound = q.error instanceof ApiRequestError && q.error.status === 404;
    return (
      <>
        <PageHeader eyebrow="Runbook" title={notFound ? 'Runbook not found' : 'Runbook'} />
        <Panel>
          {notFound ? (
            <EmptyState title={`Nothing is published as “${runbookKey}”`}>
              Check the link, or ask the content owner whether it was renamed or retired.
            </EmptyState>
          ) : (
            <QueryError title="The runbook didn’t load" error={q.error} onRetry={() => void q.refetch()} />
          )}
        </Panel>
      </>
    );
  }
  if (!q.data)
    return (
      <div className="flex max-w-3xl flex-col gap-6" aria-busy="true">
        <Skeleton className="h-8 w-80" />
        <SkeletonText lines={4} />
        <Skeleton shape="block" className="h-32 w-full" />
      </div>
    );
  return (
    <RunbookBody key={search.run ?? 'new'} def={q.data.def} version={q.data.version} runId={search.run} />
  );
}
