import { useEffect, useId, useMemo, useRef } from 'react';
import type { WidgetBlock } from '@adminforge/schemas';
import {
  Button,
  CaretDownIcon,
  ErrorState,
  KpiStrip,
  Panel,
  ProvenanceFooter,
  StatusPill,
  cn,
  type Provenance,
} from '@adminforge/ui';
import {
  TONE_LABEL,
  getPath,
  getWidget,
  parseWidgetConfig,
  useTemplate,
  useWhen,
  type WidgetData,
  type WidgetRuntime,
} from '@adminforge/widgets';
import type { PageData } from './use-page-data';

/** Literal class names so Tailwind sees them. */
const SPAN: Record<number, string> = {
  1: 'lg:col-span-1',
  2: 'lg:col-span-2',
  3: 'lg:col-span-3',
  4: 'lg:col-span-4',
  5: 'lg:col-span-5',
  6: 'lg:col-span-6',
  7: 'lg:col-span-7',
  8: 'lg:col-span-8',
  9: 'lg:col-span-9',
  10: 'lg:col-span-10',
  11: 'lg:col-span-11',
  12: 'lg:col-span-12',
};
/** The same spans in the inspector, by the drawer's own width (container query on the inspector page). */
const INSPECTOR_SPAN: Record<number, string> = {
  1: '@4xl:col-span-1',
  2: '@4xl:col-span-2',
  3: '@4xl:col-span-3',
  4: '@4xl:col-span-4',
  5: '@4xl:col-span-5',
  6: '@4xl:col-span-6',
  7: '@4xl:col-span-7',
  8: '@4xl:col-span-8',
  9: '@4xl:col-span-9',
  10: '@4xl:col-span-10',
  11: '@4xl:col-span-11',
  12: '@4xl:col-span-12',
};
/** KPI strip columns by count (xl): up to six in one row; 7–8 as two rows of four; more as rows of six. */
const stripColumns = (n: number) => (n <= 6 ? n : n <= 8 ? 4 : 6);
const STRIP_COLS: Record<number, string> = {
  1: 'md:grid-cols-1 xl:grid-cols-1',
  2: 'md:grid-cols-2 xl:grid-cols-2',
  3: 'md:grid-cols-3 xl:grid-cols-3',
  4: 'md:grid-cols-4 xl:grid-cols-4',
  5: 'md:grid-cols-3 xl:grid-cols-5',
  6: 'md:grid-cols-3 xl:grid-cols-6',
};
/** The same strip in the inspector, by the drawer's width: two columns, the page's count once it is wide (@4xl). */
const INSPECTOR_STRIP_COLS: Record<number, string> = {
  1: '@4xl:grid-cols-1',
  2: '@4xl:grid-cols-2',
  3: '@4xl:grid-cols-3',
  4: '@4xl:grid-cols-4',
  5: '@4xl:grid-cols-5',
  6: '@4xl:grid-cols-6',
};
const fillersFor = (count: number, columns: number) => (columns - (count % columns)) % columns;

export type Block = WidgetBlock & { description?: string };

/** Stable per-page id of a block: its `id`, or `<widget><index>`. Table ids key URL state. */
export const blockId = (block: Block, index: number, prefix = '') =>
  `${prefix}${block.id ?? `${block.widget}${index}`}`;

const EMPTY: WidgetData = { status: 'ready', value: undefined };

function ConfigProblem({
  block,
  problems,
}: {
  block: Block;
  problems: Array<{ path: string; message: string }>;
}) {
  const authorId = useId();
  // For the reader: what can't be shown and that the rest works. The widget type, the problems and the CLI command
  // are for whoever maintains the page, labelled so (rule 10: no tooling advice addressed to the reader).
  return (
    <Panel aria-label={`${block.title ?? block.widget} configuration`}>
      <ErrorState
        compact
        title={block.title ? `“${block.title}” can’t be shown` : 'This part of the page can’t be shown'}
        message="Its definition has a mistake, so it is left out. The rest of the page works."
        hint={
          <div
            role="group"
            aria-labelledby={`${authorId}-label`}
            className="flex flex-col gap-1.5 rounded-md border border-line px-3 py-2.5 text-left"
          >
            <p id={`${authorId}-label`} className="af-eyebrow">
              For the content author
            </p>
            <p>
              The <code className="font-mono text-xs">{block.widget}</code> widget’s configuration:
            </p>
            <ul className="list-disc pl-5">
              {problems.slice(0, 5).map((p) => (
                <li key={p.path + p.message}>
                  <code className="font-mono text-xs">{p.path}</code>: {p.message}
                </li>
              ))}
            </ul>
            <p>
              Fix the page definition, then run{' '}
              <code className="font-mono text-xs">pnpm adminforge validate</code>.
            </p>
          </div>
        }
        code="invalid_widget_config"
      />
    </Panel>
  );
}

interface BlockProps {
  block: Block;
  index: number;
  runtime: WidgetRuntime;
  data: PageData;
  variant?: 'tile' | 'cell' | 'inspector';
  idPrefix?: string;
  className?: string;
}

/** One widget: validated against its schema, hidden while `when` is false, given its resolved data. */
export function WidgetBlockView({ block, index, runtime, data, variant, idPrefix, className }: BlockProps) {
  const parsed = useMemo(() => parseWidgetConfig(block as Block & Record<string, unknown>), [block]);
  const visible = useWhen(block.when, runtime.scope, { sticky: true });
  if (!parsed.ok)
    return (
      <div className={className}>
        <ConfigProblem block={block} problems={parsed.problems} />
      </div>
    );
  if (!visible) return null;
  // A licence gate renders nothing when the feature is licensed; don't leave an empty grid cell behind.
  if (block.widget === 'licenceGate') {
    const f = runtime.feature(String((block as { feature?: unknown }).feature));
    if (!f || f.available !== false) return null;
  }
  const def = getWidget(block.widget)!;
  const widgetData = block.data ? data.resolve(block.data) : EMPTY;
  const Component = def.component;
  const content = (
    <Component
      config={parsed.config}
      data={widgetData}
      runtime={runtime}
      instanceId={blockId(block, index, idPrefix)}
      variant={variant}
    />
  );
  // Part of the result only: say so under the widget rather than let a cut list or count read as complete. KPI cells
  // are covered once by their strip (KpiGroup).
  if (widgetData.truncated && widgetData.status === 'ready' && variant !== 'cell')
    return (
      <div className={cn('flex min-w-0 flex-col gap-1', className)}>
        {content}
        <PartialNote>
          Partial data: Microsoft has more than this view reads. Narrow the filters, or open a report for the
          full list.
        </PartialNote>
      </div>
    );
  return className ? <div className={className}>{content}</div> : content;
}

function PartialNote({ children }: { children: string }) {
  return (
    <p className="px-1 text-2xs text-fg-2" role="note">
      {children}
    </p>
  );
}

/** List pages: the KPI strip folds away to one line (remembered per page by the caller). */
export interface KpiCollapse {
  collapsed: boolean;
  onToggle: (collapsed: boolean) => void;
}

/**
 * A folded KPI that needs attention says so in the one-line bar (its label and status: "Sign-in blocked: Needs
 * review"), so folding the strip never hides a warning. The status is the KPI's own `status` / `statusLabel`.
 */
function HiddenKpiStatus({ block, runtime, data }: { block: Block; runtime: WidgetRuntime; data: PageData }) {
  // The KPI as the strip would show it: a valid configuration, and only while its `when` holds.
  const parsed = useMemo(() => parseWidgetConfig(block as Block & Record<string, unknown>), [block]);
  const shown = useWhen(block.when, runtime.scope, { sticky: true });
  const cfg = (parsed.ok ? parsed.config : {}) as {
    label?: string;
    field?: string;
    status?: unknown;
    statusLabel?: unknown;
  };
  const d = block.data ? data.resolve(block.data) : EMPTY;
  const ready = d.status === 'ready';
  const raw = ready ? d.value : undefined;
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? getPath(raw, cfg.field ?? 'value') : raw;
  const scope = useMemo(() => ({ ...runtime.scope, value }), [runtime.scope, value]);
  const status = useTemplate<unknown>(cfg.status, scope, ready && cfg.status !== undefined);
  const label = useTemplate<unknown>(cfg.statusLabel, scope, ready && cfg.statusLabel !== undefined);
  const tone = status.value === 'warn' || status.value === 'crit' ? status.value : undefined;
  if (!parsed.ok || !shown || !tone || value === undefined || value === null || value === '') return null;
  const words = typeof label.value === 'string' && label.value ? label.value : TONE_LABEL[tone];
  return <StatusPill status={tone}>{cfg.label ? `${cfg.label}: ${words}` : words}</StatusPill>;
}

/** Consecutive KPIs share one strip; its foot names each distinct source once. */
function KpiGroup({
  items,
  runtime,
  data,
  compact,
  collapse,
}: {
  items: Array<{ block: Block; index: number }>;
  runtime: WidgetRuntime;
  data: PageData;
  compact: boolean;
  collapse?: KpiCollapse;
}) {
  const stripId = useId();
  // Folding swaps the toggle for another button: keep keyboard focus on whichever one is shown.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    toggleRef.current?.focus();
  }, [collapse?.collapsed]);
  const flip = (collapsed: boolean) => {
    refocus.current = true;
    collapse?.onToggle(collapsed);
  };
  const provenances = useMemo(() => {
    const seen = new Map<string, Provenance>();
    for (const { block } of items) {
      if (!block.data) continue;
      const p = data.resolve(block.data).provenance;
      // One line per distinct source (several datasources can share a service and path, e.g. graph · /$batch).
      const key = p ? `${p.service} ${p.path}` : '';
      if (p && !seen.has(key)) seen.set(key, p);
    }
    return [...seen.values()];
  }, [items, data]);
  const partial = items.some(({ block }) => block.data && data.resolve(block.data).truncated);
  const wide = stripColumns(items.length);
  // Empty cells keep the panel surface when the last row isn't full (the strip's hairlines are its background). The
  // inspector has two layouts (two columns, `wide` from @4xl), each with its own fillers shown only in that layout.
  const fillers = compact ? fillersFor(items.length, 2) : fillersFor(items.length, wide);
  const wideFillers = compact ? fillersFor(items.length, wide) : 0;
  if (collapse?.collapsed)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={toggleRef}
          size="sm"
          intent="ghost"
          aria-expanded={false}
          className="-ml-2"
          onClick={() => flip(false)}
        >
          {/* Like every disclosure (the navigation's sections, Show output): right when closed, down when open. */}
          <CaretDownIcon size={12} weight="bold" aria-hidden className="-rotate-90 text-fg-3" />
          Show key figures
        </Button>
        <span className="text-xs text-fg-3">{items.length} hidden</span>
        {items.map(({ block, index }) => (
          <HiddenKpiStatus key={blockId(block, index)} block={block} runtime={runtime} data={data} />
        ))}
      </div>
    );
  const toggle = collapse && (
    <Button
      ref={toggleRef}
      size="sm"
      intent="ghost"
      aria-expanded
      aria-controls={stripId}
      className="-ml-2"
      onClick={() => flip(true)}
    >
      <CaretDownIcon size={12} weight="bold" aria-hidden className="text-fg-3" />
      Hide key figures
    </Button>
  );
  return (
    <div className="flex flex-col gap-1.5" id={stripId}>
      <KpiStrip
        label="Key figures"
        className={cn('grid-cols-2', compact ? INSPECTOR_STRIP_COLS[wide] : STRIP_COLS[wide])}
      >
        {items.map(({ block, index }) => (
          <WidgetBlockView
            key={blockId(block, index)}
            block={block}
            index={index}
            runtime={runtime}
            data={data}
            variant="cell"
          />
        ))}
        {Array.from({ length: fillers }, (_, i) => (
          <div
            key={`filler-${i}`}
            className={compact ? 'bg-panel @4xl:hidden' : 'hidden bg-panel xl:block'}
            aria-hidden
          />
        ))}
        {Array.from({ length: wideFillers }, (_, i) => (
          <div key={`filler-wide-${i}`} className="hidden bg-panel @4xl:block" aria-hidden />
        ))}
      </KpiStrip>
      {partial && (
        <PartialNote>
          Some figures count only the first items Microsoft returned, so the real numbers may be higher.
        </PartialNote>
      )}
      {(provenances.length > 0 || toggle) && (
        <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 px-1">
          {toggle && <div className="mr-auto flex">{toggle}</div>}
          {provenances.length <= 2 ? (
            provenances.map((p) => <ProvenanceFooter key={`${p.service}${p.path}`} {...p} />)
          ) : (
            // Many sources: one line (services, endpoint count, slowest call); every endpoint in the tooltip.
            <div title={provenances.map((p) => `${p.service} ${p.path}`).join('\n')}>
              <ProvenanceFooter
                service={[...new Set(provenances.map((p) => p.service))].join(', ')}
                path={`${provenances.length} endpoints`}
                ms={Math.max(...provenances.map((p) => p.ms ?? 0))}
                cachedAt={
                  provenances.every((p) => p.cachedAt)
                    ? provenances.map((p) => p.cachedAt!).sort()[0]
                    : undefined
                }
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type Group =
  | { kind: 'kpis'; items: Array<{ block: Block; index: number }> }
  | { kind: 'block'; block: Block; index: number };

function group(blocks: readonly Block[]): Group[] {
  const out: Group[] = [];
  blocks.forEach((block, index) => {
    const last = out[out.length - 1];
    if (block.widget === 'kpi') {
      if (last?.kind === 'kpis') last.items.push({ block, index });
      else out.push({ kind: 'kpis', items: [{ block, index }] });
    } else out.push({ kind: 'block', block, index });
  });
  return out;
}

/**
 * The 12-column widget grid (§6.6). In the inspector it follows the drawer's width instead of the window's: one column
 * while the drawer is narrow, the page's own spans once it is wide (≥ 56rem, container query).
 */
export function WidgetGrid({
  blocks,
  runtime,
  data,
  inspector,
  idPrefix,
  className,
  kpis,
}: {
  blocks: readonly Block[];
  runtime: WidgetRuntime;
  data: PageData;
  inspector?: boolean;
  idPrefix?: string;
  className?: string;
  /** List pages: KPI strips can be folded to one line. */
  kpis?: KpiCollapse;
}) {
  const groups = useMemo(() => group(blocks), [blocks]);
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-(--af-gap-grid)',
        inspector ? '@4xl:grid-cols-12' : 'lg:grid-cols-12',
        className,
      )}
    >
      {groups.map((g) =>
        g.kind === 'kpis' ? (
          <div
            key={`kpis-${g.items[0]!.index}`}
            className={inspector ? '@4xl:col-span-12' : 'lg:col-span-12'}
          >
            <KpiGroup
              items={g.items}
              runtime={runtime}
              data={data}
              compact={Boolean(inspector)}
              collapse={inspector ? undefined : kpis}
            />
          </div>
        ) : (
          <WidgetBlockView
            key={blockId(g.block, g.index, idPrefix)}
            block={g.block}
            index={g.index}
            runtime={runtime}
            data={data}
            idPrefix={idPrefix}
            variant={inspector ? 'inspector' : 'tile'}
            // A grid wrapper stretches the panel to the row's height, so neighbouring panels end level.
            className={cn(
              'grid min-w-0',
              (inspector ? INSPECTOR_SPAN : SPAN)[g.block.span ?? getWidget(g.block.widget)?.span ?? 12],
            )}
          />
        ),
      )}
    </div>
  );
}
