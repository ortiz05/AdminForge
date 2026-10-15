import { useState } from 'react';
import { Badge, CaretRightIcon, cn, CodeBlock, CheckCircleIcon } from '@adminforge/ui';
import type { PlanEntry } from './contracts';

const SERVICE_LABEL: Record<string, string> = {
  graph: 'Microsoft Graph',
  arm: 'Azure Resource Manager',
  resourceGraph: 'Azure Resource Graph',
  logAnalytics: 'Log Analytics',
  exchange: 'Exchange Online',
  teams: 'Teams',
  sharepointAdmin: 'SharePoint admin',
  runner: 'PowerShell runner',
  function: 'Function app',
  http: 'HTTPS',
  notify: 'Notification',
};

export const serviceLabel = (s: string) => SERVICE_LABEL[s] ?? s;

const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function PlanItem({ entry, index }: { entry: PlanEntry; index: number }) {
  const [open, setOpen] = useState(false);
  const target = entry.url ?? entry.path ?? '';
  const hasBody =
    entry.body !== undefined &&
    entry.body !== null &&
    !(typeof entry.body === 'object' && Object.keys(entry.body as object).length === 0);
  const bodyId = `plan-body-${entry.stepPath.replace(/[^\w-]/g, '_')}`;
  return (
    <li className="flex gap-3 border-t border-line px-4 py-3 first:border-t-0">
      <span
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-pill bg-accent-subtle font-mono text-2xs font-semibold text-accent tabular-nums"
        aria-hidden
      >
        {index + 1}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-medium text-fg">
          {entry.describe ?? entry.stepId}
          {entry.compensation && (
            <Badge tone="warn" className="ml-2 align-middle">
              Rollback
            </Badge>
          )}
        </p>
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-xs text-fg-3">
          <span className="font-semibold text-fg-2">{entry.method}</span>
          <span>{serviceLabel(entry.service)}</span>
          <span className="min-w-0 break-all text-fg-2" title={target}>
            {target}
          </span>
        </p>
        {hasBody && (
          <div className="mt-1">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => setOpen((o) => !o)}
              className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-accent hover:underline"
            >
              <CaretRightIcon
                size={11}
                weight="bold"
                aria-hidden
                className={cn('transition-transform duration-(--af-motion-fast)', open && 'rotate-90')}
              />
              {open ? 'Hide request body' : 'Show request body'}
            </button>
            {open && (
              <div id={bodyId} className="mt-2">
                <CodeBlock
                  code={pretty(entry.body)}
                  title="Request body (redacted)"
                  language="json"
                  maxHeight={240}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The dry-run plan (§7.8): every write the run would make, in order, in plain words first and the request second.
 * Nothing here has happened yet.
 */
export function PlanView({
  plan,
  title = 'What this run will change',
  emptyText = 'Nothing changes: this run only reads.',
}: {
  plan: PlanEntry[];
  title?: string;
  emptyText?: string;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="af-eyebrow">{title}</h3>
        {plan.length > 0 && (
          <span className="text-xs text-fg-3">
            {plan.length} change{plan.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {plan.length === 0 ? (
        <p className="flex items-center gap-2 rounded-(--af-panel-radius) border border-line bg-panel px-4 py-3 text-sm text-fg-2">
          <CheckCircleIcon size={16} weight="fill" aria-hidden className="shrink-0 text-ok" />
          {emptyText}
        </p>
      ) : (
        <ol className="overflow-hidden rounded-(--af-panel-radius) border border-line bg-panel">
          {plan.map((entry, i) => (
            <PlanItem key={`${entry.stepPath}-${i}`} entry={entry} index={i} />
          ))}
        </ol>
      )}
    </section>
  );
}
