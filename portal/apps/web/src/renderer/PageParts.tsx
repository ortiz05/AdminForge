import { useEffect } from 'react';
import type { PageDefinition } from './api';
import {
  ArrowClockwiseIcon,
  IconButton,
  IdChip,
  PageHeader,
  Skeleton,
  StatusPill,
  formatRelative,
  useNow,
} from '@adminforge/ui';
import { TONE_LABEL, useTemplate, type WidgetRuntime } from '@adminforge/widgets';
import { ActionGroup } from './ActionGroup';
import { AppLink } from '../lib/links';

/** "Updated 30 s ago" + Refresh; says when the page refreshes itself. */
export function RefreshControl({ updatedAt, fetching, onRefresh, every }: { updatedAt: number; fetching: boolean; onRefresh: () => void; every?: number }) {
  const now = useNow(15_000);
  return (
    <div className="flex items-center gap-1.5">
      <span className="hidden text-xs whitespace-nowrap text-fg-3 sm:inline" aria-live="polite">
        {fetching ? 'Refreshing…' : updatedAt ? `Updated ${formatRelative(updatedAt, now)}` : ''}
        {every ? ` · every ${every < 120 ? `${every} s` : `${Math.round(every / 60)} min`}` : ''}
      </span>
      <IconButton
        label="Refresh"
        intent="secondary"
        icon={<ArrowClockwiseIcon size={16} className={fetching ? 'animate-spin' : undefined} />}
        onClick={onRefresh}
      />
    </div>
  );
}

const asText = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const TONES = new Set(['ok', 'warn', 'crit', 'info', 'neutral']);

/**
 * The entity template's identity header (§6.6): name, sign-in/UPN line, status pill, copyable ids, and the page's
 * actions. Templates come from `header:` and are evaluated against the loaded datasources.
 */
export function EntityHeader({
  def,
  runtime,
  loading,
  section,
  inspector,
  onTitle,
}: {
  def: PageDefinition;
  runtime: WidgetRuntime;
  loading: boolean;
  section?: string;
  inspector?: boolean;
  onTitle?: (title: string | undefined) => void;
}) {
  const header = def.header;
  const title = useTemplate<unknown>(header?.title, runtime.scope, Boolean(header?.title));
  const subtitle = useTemplate<unknown>(header?.subtitle, runtime.scope, Boolean(header?.subtitle));
  const status = useTemplate<unknown>(header?.status, runtime.scope, Boolean(header?.status));
  const statusLabel = useTemplate<unknown>(header?.statusLabel, runtime.scope, Boolean(header?.statusLabel));
  const ids = useTemplate<Record<string, unknown>>(header?.ids, runtime.scope, Boolean(header?.ids));
  const titleText = asText(title.value);
  useEffect(() => onTitle?.(titleText || undefined), [titleText, onTitle]);

  const tone = TONES.has(asText(status.value)) ? (asText(status.value) as keyof typeof TONE_LABEL) : undefined;
  const idEntries = Object.entries(ids.value ?? {}).filter(([, v]) => asText(v));
  const meta = (
    <>
      {tone && (
        <StatusPill status={tone}>{asText(statusLabel.value) || TONE_LABEL[tone]}</StatusPill>
      )}
      {idEntries.map(([label, v]) => (
        <IdChip key={label} value={asText(v)} label={label} />
      ))}
    </>
  );
  const actions = def.actions?.length ? (
    <ActionGroup actions={def.actions} scope={runtime.scope} runtime={runtime} visibleCount={inspector ? 2 : 3} size={inspector ? 'sm' : 'md'} />
  ) : undefined;
  const shownTitle = loading && !titleText ? <Skeleton className="h-7 w-64" /> : titleText || def.title;

  if (inspector)
    return (
      <div className="flex flex-col gap-3 border-b border-line pb-4">
        {asText(subtitle.value) && <p className="truncate text-sm text-fg-2">{asText(subtitle.value)}</p>}
        {(tone || idEntries.length > 0) && <div className="flex flex-wrap items-center gap-2">{meta}</div>}
        {actions}
      </div>
    );
  return (
    <PageHeader
      linkAs={AppLink}
      eyebrow={section ? `${section} · ${def.title}` : def.title}
      title={shownTitle}
      description={asText(subtitle.value) || (loading ? undefined : def.summary)}
      meta={(tone || idEntries.length > 0) && meta}
      actions={actions}
    />
  );
}
