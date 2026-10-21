import { Link } from '@tanstack/react-router';
import { flattenSteps, walkSteps, type Playbook, type Runbook, type Step } from '@adminforge/schemas';
import { Badge, CodeBlock, formatRelative, formatTimestamp, timeline, useNow } from '@adminforge/ui';
import { elapsed } from '../ops/ui';
import {
  labelOf,
  latestSteps,
  type RunDetail,
  type RunStep,
  type StepIndex,
  type StepStatus,
} from './contracts';
import { ErrorCode } from './RunDataHidden';
import { Disclosure } from './Disclosure';
import { maskSecrets } from './secrets';
import { STEP_STATUS_VIEW, StatusGlyph } from './status';
import { isNested, topLevelKey } from './useRunLive';

export const TYPE_LABEL: Record<string, string> = {
  graph: 'Graph',
  graphBatch: 'Graph batch',
  arm: 'Azure',
  resourceGraph: 'Resource Graph',
  logAnalytics: 'Log Analytics',
  function: 'Function',
  runner: 'PowerShell',
  http: 'HTTPS',
  transform: 'Transform',
  assert: 'Check',
  branch: 'Branch',
  forEach: 'For each',
  approval: 'Approval',
  manual: 'Manual',
  wait: 'Wait',
  notify: 'Notify',
  playbook: 'Playbook',
};

const WAITING_TEXT: Record<string, string> = {
  approval: 'Waiting for an approver.',
  manual: 'Waiting for someone to confirm this step.',
  wait: 'Waiting until it is time to continue.',
};

export interface TimelineEntry {
  key: string;
  label: string;
  describe: string | null;
  type: string;
  mode: 'read' | 'write';
  status: StepStatus;
  record: RunStep | null;
  children: RunStep[];
}

/** stepId → name/describe/type/mode for every step in a playbook or runbook (nested ones included). */
export function stepIndex(def: Playbook | Runbook | null | undefined): StepIndex {
  const index: StepIndex = new Map();
  if (!def) return index;
  const groups = def.kind === 'playbook' ? [def.steps] : def.sections.map((s) => s.steps ?? []);
  for (const steps of groups)
    walkSteps(steps, (s) =>
      index.set(s.id, {
        name: s.name ?? null,
        describe: s.describe ?? null,
        type: s.type,
        mode: s.mode ?? 'read',
      }),
    );
  return index;
}

/**
 * Timeline entries: the definition's top-level steps in order (so steps that haven't run yet show as "Not started"),
 * filled from the latest record per step; nested records (forEach items) group under their parent; anything the
 * outline doesn't know (compensations) follows in execution order.
 */
export function buildTimeline(detail: RunDetail, def?: Playbook | Runbook | null): TimelineEntry[] {
  const records = latestSteps(detail.steps);
  const top = records.filter((r) => !isNested(r.path));
  const nested = new Map<string, RunStep[]>();
  for (const r of records.filter((x) => isNested(x.path))) {
    const k = topLevelKey(r.path);
    nested.set(k, [...(nested.get(k) ?? []), r]);
  }
  const index = stepIndex(def);
  const nameOf = (r: RunStep) =>
    r.name ??
    index.get(r.stepId)?.name ??
    index.get(r.stepId)?.describe ??
    r.describe ??
    labelOf(index, r.stepId);
  const fromRecord = (r: RunStep): TimelineEntry => ({
    key: r.path,
    label: r.path.includes('#compensate') ? `Roll back: ${nameOf(r)}` : nameOf(r),
    describe: r.describe ?? index.get(r.stepId)?.describe ?? null,
    type: r.type,
    mode: r.mode,
    status: r.status,
    record: r,
    children: nested.get(topLevelKey(r.path)) ?? [],
  });
  if (!def) return top.map(fromRecord);
  const outline: Step[] = flattenSteps(def);
  const used = new Set<string>();
  const entries = outline.map((s): TimelineEntry => {
    const r = top.find((x) => x.stepId === s.id && !x.path.includes('#'));
    if (r) {
      used.add(r.path);
      return {
        ...fromRecord(r),
        label: s.name ?? s.describe ?? s.id,
        describe: s.describe ?? r.describe ?? null,
      };
    }
    return {
      key: s.id,
      label: s.name ?? s.describe ?? s.id,
      describe: s.describe ?? null,
      type: s.type,
      mode: s.mode ?? 'read',
      status: 'pending',
      record: null,
      children: nested.get(s.id) ?? [],
    };
  });
  const extra = top.filter((r) => !used.has(r.path)).map(fromRecord);
  return [...entries, ...extra];
}

const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(maskSecrets(v), null, 2));
const hasOutput = (v: unknown) =>
  v !== undefined && v !== null && !(typeof v === 'object' && Object.keys(v as object).length === 0);

/** What a failed step says: its message, or (metadata view, S-25) just its code — the message isn't sent. */
const ErrorText = ({ error, restricted }: { error: NonNullable<RunStep['error']>; restricted: boolean }) =>
  restricted ? <ErrorCode code={error.code} /> : <>{error.message}</>;

function Children({ items, restricted }: { items: RunStep[]; restricted: boolean }) {
  const done = items.filter((c) =>
    ['succeeded', 'failed', 'skipped', 'cancelled', 'compensated'].includes(c.status),
  ).length;
  const failed = items.filter((c) => c.status === 'failed').length;
  const shown = items.slice(0, 50);
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <p className="text-xs text-fg-3">
        {done} of {items.length} item{items.length === 1 ? '' : 's'} done{failed ? ` · ${failed} failed` : ''}
      </p>
      <ul className="flex flex-col overflow-hidden rounded-md border border-line text-sm">
        {shown.map((c, i) => {
          const view = STEP_STATUS_VIEW[c.status];
          const index = /\[(\d+)\]/.exec(c.path)?.[1];
          return (
            <li
              key={c.path}
              className="flex items-center gap-2 border-t border-line bg-sunken px-2.5 py-1.5 first:border-t-0"
            >
              <StatusGlyph status={c.status} tone={view.tone} size={13} colored />
              <span className="min-w-0 flex-1 truncate text-fg-2">
                Item {index !== undefined ? Number(index) + 1 : i + 1}
                <span className="sr-only">: {view.label}</span>
                {c.error && (
                  <span className="ml-2 text-crit">
                    <ErrorText error={c.error} restricted={restricted} />
                  </span>
                )}
              </span>
              {c.childRunId && (
                <Link
                  to="/runs/$id"
                  params={{ id: c.childRunId }}
                  className="shrink-0 text-xs font-medium text-accent hover:underline"
                >
                  Open run
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > shown.length && (
        <p className="text-xs text-fg-3">+{items.length - shown.length} more</p>
      )}
    </div>
  );
}

/** The `run` template's step timeline: state glyph, what the step does, how long it took, errors with hints, outputs. */
export function RunTimeline({
  entries,
  initiatorUpn,
  label = 'Steps',
  restricted = false,
}: {
  entries: TimelineEntry[];
  initiatorUpn?: string | null;
  label?: string;
  /** Someone else's delegated run (S-25): errors arrive as codes and references only. */
  restricted?: boolean;
}) {
  const now = useNow(5_000);
  const s = timeline();
  return (
    <ol className={s.list()} aria-label={label}>
      {entries.map((e, i) => {
        const view = STEP_STATUS_VIEW[e.status];
        const c = timeline({ tone: view.tone });
        const r = e.record;
        const took = r && r.startedAt ? elapsed(r.startedAt, r.endedAt, now) : null;
        const muted = e.status === 'pending' || e.status === 'skipped';
        return (
          <li key={e.key} className={c.item()} data-status={e.status}>
            {i < entries.length - 1 && <span className={c.rail()} aria-hidden />}
            <span className={c.node()}>
              <StatusGlyph status={e.status} tone={view.tone} size={18} />
            </span>
            <div className={c.body()}>
              <div className={c.head()}>
                <span className={c.title({ className: muted ? 'text-fg-3' : undefined })}>
                  <span className="sr-only">{view.label}: </span>
                  {e.label}
                </span>
                <span className={c.time()}>
                  {e.status === 'running' && took ? (
                    `${took}…`
                  ) : took ? (
                    <span title={r?.endedAt ? formatTimestamp(r.endedAt) : undefined}>{took}</span>
                  ) : r?.endedAt ? (
                    formatRelative(r.endedAt, now)
                  ) : (
                    <span aria-hidden={e.status === 'pending' || undefined}>{view.label}</span>
                  )}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs">
                <Badge mono>{TYPE_LABEL[e.type] ?? e.type}</Badge>
                {e.mode === 'write' && <Badge tone="outline">Changes tenant</Badge>}
                {e.status !== 'pending' && e.status !== 'running' && (
                  <span className="text-fg-3">{view.label}</span>
                )}
                {r && r.attempt > 1 && <span className="text-fg-3">attempt {r.attempt}</span>}
                {r?.actorUpn && initiatorUpn && r.actorUpn !== initiatorUpn && (
                  <span className="text-fg-3">as {r.actorUpn}</span>
                )}
              </div>
              {e.describe && e.describe !== e.label && <p className={c.description()}>{e.describe}</p>}
              {e.status === 'waiting' && (
                <p className="text-sm font-medium text-warn">{WAITING_TEXT[e.type] ?? 'Waiting.'}</p>
              )}
              {r?.error && (
                <div
                  className="mt-1 flex flex-col gap-0.5 text-sm"
                  role={e.status === 'failed' ? 'alert' : undefined}
                >
                  <p className="font-medium text-crit">
                    <ErrorText error={r.error} restricted={restricted} />
                    {r.error.status ? (
                      <span className="ml-1.5 font-mono text-xs">({r.error.status})</span>
                    ) : null}
                  </p>
                  {r.error.hint && <p className="text-fg-2">{r.error.hint}</p>}
                  {r.error.requestId && (
                    <p className="font-mono text-2xs text-fg-3">Microsoft request-id {r.error.requestId}</p>
                  )}
                </div>
              )}
              {e.children.length > 0 && <Children items={e.children} restricted={restricted} />}
              {r?.childRunId && e.children.length === 0 && (
                <Link
                  to="/runs/$id"
                  params={{ id: r.childRunId }}
                  className="mt-1 text-sm font-medium text-accent hover:underline"
                >
                  Open child run
                </Link>
              )}
              {r && hasOutput(r.output) && e.children.length === 0 && (
                <Disclosure label="Show output" openLabel="Hide output" className="mt-1">
                  <CodeBlock
                    code={pretty(r.output)}
                    title={`${e.key} output`}
                    language="json"
                    maxHeight={260}
                  />
                </Disclosure>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
