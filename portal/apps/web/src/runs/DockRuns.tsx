import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { formatRelative, useNow } from '@adminforge/ui';
import { api } from '../lib/api';
import { isTerminal, RunDetailResponse, RunListResponse, type RunSummary } from './contracts';
import { canStream, usePortalEvent } from './event-stream';
import { activeRunsQueryKey } from './keys';
import { RUN_STATUS_VIEW, StatusGlyph } from './status';

const MAX_CHIPS = 3;
const RECENT_MS = 10 * 60_000;

/** Shown until the first answer, and whenever nothing is running. */
export const IDLE_TEXT = 'No runs in this session. Playbooks you start appear here with live progress.';

function progressText(run: RunSummary): string {
  const parts: string[] = [];
  if (run.progress) parts.push(`step ${Math.min(run.progress.done + 1, run.progress.total)}/${run.progress.total}`);
  if (run.currentStep) parts.push(run.currentStep);
  return parts.join(' · ');
}

function DockChip({ run, now }: { run: RunSummary; now: number }) {
  const view = RUN_STATUS_VIEW[run.status];
  const done = isTerminal(run.status);
  const detail = done
    ? run.endedAt
      ? formatRelative(run.endedAt, now)
      : view.label.toLowerCase()
    : run.status === 'running'
      ? progressText(run) || 'running'
      : view.label.toLowerCase();
  return (
    <Link
      to="/runs/$id"
      params={{ id: run.id }}
      className="flex h-6 min-w-0 max-w-80 items-center gap-1.5 rounded-md px-2 text-fg-2 hover:bg-hover hover:text-fg"
      aria-label={`${run.title}: ${view.label}${detail && !done ? `, ${detail}` : ''}. Open run.`}
    >
      <StatusGlyph status={run.status} tone={view.tone} size={13} colored />
      <span className="truncate font-medium text-fg">{run.title}</span>
      {run.dryRun && <span className="shrink-0 text-fg-3">(dry run)</span>}
      {detail && <span className="truncate text-fg-3">— {detail}</span>}
    </Link>
  );
}

/**
 * The live part of the run dock (loaded after first paint): my active runs with progress — refreshed by SSE
 * `run.updated` from /api/events, polling as a fallback — plus the ones that finished while I watched.
 */
export default function DockRuns() {
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const active = useQuery({
    queryKey: activeRunsQueryKey,
    queryFn: ({ signal }) => api('/api/runs?scope=mine&status=active', { schema: RunListResponse, signal }),
    refetchInterval: (q) => (q.state.status === 'error' ? 60_000 : canStream() ? 30_000 : 10_000),
    retry: false,
    staleTime: 5_000,
  });

  usePortalEvent('run.updated', () => {
    void queryClient.invalidateQueries({ queryKey: activeRunsQueryKey });
  });

  // A run that leaves the active list finished: fetch its outcome once and keep it in view for a while.
  const [recent, setRecent] = useState<Record<string, RunSummary>>({});
  const previous = useRef(new Map<string, RunSummary>());
  const fetching = useRef(new Set<string>());
  const items = active.data?.items;
  useEffect(() => {
    if (!items) return;
    const ids = new Set(items.map((r) => r.id));
    for (const [id, run] of previous.current) {
      if (ids.has(id) || fetching.current.has(id)) continue;
      fetching.current.add(id);
      void api(`/api/runs/${encodeURIComponent(id)}`, { schema: RunDetailResponse })
        .then((d) =>
          setRecent((all) => ({ ...all, [id]: { ...run, ...d.run, endedAt: d.run.endedAt ?? new Date().toISOString() } })),
        )
        .catch(() => undefined);
    }
    previous.current = new Map(items.map((r) => [r.id, r]));
  }, [items]);

  const live = items ?? [];
  const finished = Object.values(recent)
    .filter((r) => !live.some((l) => l.id === r.id) && !(r.endedAt && now - Date.parse(r.endedAt) > RECENT_MS))
    .sort((a, b) => Date.parse(b.endedAt ?? '') - Date.parse(a.endedAt ?? ''));
  const all = [...live, ...finished];
  const shown = all.slice(0, MAX_CHIPS);
  const more = all.length - shown.length;
  const announce = finished[0] ? `${finished[0].title}: ${RUN_STATUS_VIEW[finished[0].status].label}` : '';

  return (
    <>
      {live.length > 0 && (
        <span
          className="-ml-1.5 shrink-0 rounded-pill bg-accent-subtle px-1.5 py-0.5 font-mono text-2xs text-accent tabular-nums"
          aria-label={`${live.length} active`}
        >
          {live.length}
        </span>
      )}
      {all.length === 0 ? (
        <span className="truncate text-fg-3">{IDLE_TEXT}</span>
      ) : (
        <ul className="flex min-w-0 items-center gap-1" aria-label="Active and recent runs">
          {shown.map((run) => (
            <li key={run.id} className="min-w-0">
              <DockChip run={run} now={now} />
            </li>
          ))}
          {more > 0 && (
            <li className="shrink-0">
              <Link to="/runs" search={{ scope: 'mine' }} className="rounded-md px-2 py-1 text-fg-3 hover:bg-hover hover:text-fg">
                +{more} more
              </Link>
            </li>
          )}
        </ul>
      )}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </>
  );
}
