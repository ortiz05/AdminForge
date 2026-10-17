import {
  Button,
  ChartLineIcon,
  cn,
  EmptyState,
  formatDuration,
  formatNumber,
  formatRelative,
  IconButton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TrashIcon,
  useNow,
  XIcon,
} from '@adminforge/ui';
import type { QuerySource } from './contracts';
import { galleryFor, type StarterQuery } from './gallery';
import { clearHistory, removeRun, useHistory, type HistoryEntry } from './history';
import { SOURCE_META } from './sources';

const firstLines = (q: string) =>
  q
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');

function StarterList({
  source,
  current,
  onPick,
}: {
  source: QuerySource;
  current: string;
  onPick: (q: StarterQuery) => void;
}) {
  const items = galleryFor(source);
  return (
    <ul className="flex flex-col gap-1.5" aria-label={`Starter queries for ${SOURCE_META[source].label}`}>
      {items.map((q) => {
        const active = q.query.trim() === current.trim();
        return (
          <li key={q.id}>
            <button
              type="button"
              onClick={() => onPick(q)}
              aria-current={active || undefined}
              className={cn(
                'group flex w-full flex-col gap-1 rounded-(--af-input-radius) border px-3 py-2.5 text-left transition-colors duration-(--af-motion-fast)',
                active
                  ? 'border-accent/50 bg-accent-subtle'
                  : 'border-transparent hover:border-line hover:bg-hover',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'text-sm font-medium',
                    active ? 'text-accent' : 'text-fg group-hover:text-fg',
                  )}
                >
                  {q.title}
                </span>
                {q.chart && (
                  <ChartLineIcon
                    size={14}
                    className="shrink-0 text-fg-3"
                    aria-label="Has a suggested chart"
                  />
                )}
              </span>
              {/* fg-3 is too faint on the accent tint of the selected card (contrast); fg-2 keeps AA there. */}
              <span className={cn('text-xs leading-snug', active ? 'text-fg-2' : 'text-fg-3')}>
                {q.description}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function HistoryList({
  sources,
  onPick,
}: {
  sources: readonly QuerySource[];
  onPick: (e: HistoryEntry) => void;
}) {
  // Runs on a source that has since been switched off stay in this browser but aren't offered.
  const history = useHistory().filter((e) => sources.includes(e.source));
  const now = useNow(30_000);
  if (!history.length)
    return (
      <EmptyState compact title="No queries yet" className="py-8">
        Queries you run are kept here, in this browser only.
      </EmptyState>
    );
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1.5" aria-label="Query history">
        {history.map((e) => (
          <li key={`${e.ranAt}-${e.source}`} className="group relative">
            <button
              type="button"
              onClick={() => onPick(e)}
              className="flex w-full flex-col gap-1.5 rounded-(--af-input-radius) border border-transparent py-2.5 pr-9 pl-3 text-left transition-colors duration-(--af-motion-fast) hover:border-line hover:bg-hover"
            >
              <span className="line-clamp-2 font-mono text-xs leading-snug wrap-break-word text-fg">
                {firstLines(e.query)}
              </span>
              <span className="truncate text-2xs text-fg-3">
                {SOURCE_META[e.source].short} ·{' '}
                {e.failed ? (
                  <span className="text-crit">failed</span>
                ) : (
                  `${formatNumber(e.rowCount ?? 0)} row${e.rowCount === 1 ? '' : 's'}`
                )}{' '}
                ·{' '}
                <time
                  dateTime={e.ranAt}
                  title={e.ms !== undefined ? `Took ${formatDuration(e.ms)}` : undefined}
                >
                  {formatRelative(e.ranAt, now)}
                </time>
              </span>
            </button>
            <IconButton
              size="sm"
              label="Remove from history"
              tooltip={false}
              icon={<XIcon size={13} />}
              className="absolute top-1.5 right-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => removeRun(e.ranAt)}
            />
          </li>
        ))}
      </ul>
      <Button size="sm" intent="ghost" className="self-start" onClick={clearHistory}>
        <TrashIcon size={14} aria-hidden />
        Clear history
      </Button>
    </div>
  );
}

export function Sidebar({
  source,
  sources,
  current,
  onPickStarter,
  onPickHistory,
  tab,
  onTabChange,
}: {
  source: QuerySource;
  /** The sources this installation offers (history on any other is hidden). */
  sources: readonly QuerySource[];
  current: string;
  onPickStarter: (q: StarterQuery) => void;
  onPickHistory: (e: HistoryEntry) => void;
  tab: string;
  onTabChange: (tab: string) => void;
}) {
  return (
    <aside
      aria-label="Starter queries and history"
      className="flex min-w-0 flex-col rounded-(--af-panel-radius) border border-line bg-panel"
    >
      <Tabs value={tab} onValueChange={onTabChange} className="flex min-h-0 flex-col">
        <TabsList aria-label="Query library" className="px-3">
          <TabsTrigger value="gallery">Starter queries</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="gallery" className="p-2">
          <StarterList source={source} current={current} onPick={onPickStarter} />
        </TabsContent>
        <TabsContent value="history" className="p-2">
          <HistoryList sources={sources} onPick={onPickHistory} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}
