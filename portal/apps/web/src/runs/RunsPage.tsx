import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowClockwiseIcon,
  Badge,
  Button,
  DataTable,
  IconButton,
  PageHeader,
  SegmentedControl,
  useNow,
  type DataColumn,
} from '@adminforge/ui';
import { ApiRequestError } from '../lib/api';
import { useDocumentTitle } from '../ops/ui';
import type { RunSummary } from './contracts';
import { fetchRunsPage, type RunsFilter } from './queries';
import { RunStatusPill, runStatusView } from './status';

export interface RunsSearch {
  scope?: 'mine' | 'all';
  status?: string;
  /** Definition key filter (sent to the API as `playbook=`). */
  definition?: string;
}

const TRIGGER: Record<string, string> = {
  interactive: 'Portal',
  bulk: 'Bulk',
  schedule: 'Schedule',
  child: 'Child run',
};

function durationMs(r: RunSummary, now: number): number | null {
  const from = r.startedAt ?? r.createdAt;
  if (!from) return null;
  const ms = (r.endedAt ? Date.parse(r.endedAt) : now) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Runs (§6.6 list): mine or everyone's, faceted by status, playbook, trigger and initiator; newest first. */
export function RunsPage({ search }: { search: RunsSearch }) {
  const navigate = useNavigate();
  const now = useNow(10_000);
  useDocumentTitle('Runs');
  const filter: RunsFilter = {
    scope: search.scope ?? 'mine',
    status: search.status,
    playbook: search.definition,
  };
  const q = useInfiniteQuery({
    queryKey: ['runs', 'list', filter] as const,
    queryFn: ({ pageParam, signal }) => fetchRunsPage(filter, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor ?? undefined,
    refetchInterval: 15_000,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);

  const columns = useMemo<DataColumn<RunSummary>[]>(
    () => [
      {
        id: 'run',
        header: 'Run',
        kind: 'identity',
        value: (r) => ({ primary: r.title, secondary: r.key }),
        cell: (r) => (
          <span className="flex min-w-0 flex-col leading-tight compact:flex-row compact:items-baseline compact:gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium text-fg">{r.title}</span>
              {r.dryRun && <Badge tone="accent">Dry run</Badge>}
            </span>
            <span className="truncate font-mono text-2xs text-fg-3">{r.key}</span>
          </span>
        ),
        width: 'minmax(260px, 2.4fr)',
      },
      {
        id: 'status',
        header: 'Status',
        kind: 'status',
        value: (r) => runStatusView(r.status, r.waitingReason),
        cell: (r) => <RunStatusPill status={r.status} waitingReason={r.waitingReason} size="sm" />,
        width: 'minmax(160px, 1fr)',
      },
      {
        id: 'playbook',
        header: 'Playbook',
        kind: 'text',
        value: (r) => r.key,
        filter: 'facet',
        hidden: true,
      },
      {
        id: 'initiator',
        header: 'Started by',
        kind: 'text',
        value: (r) => (r.identity === 'automation' ? 'Automation identity' : (r.initiator.upn ?? '—')),
        filter: 'facet',
        width: 'minmax(180px, 1.2fr)',
      },
      {
        id: 'trigger',
        header: 'Trigger',
        kind: 'text',
        value: (r) => TRIGGER[r.trigger] ?? r.trigger,
        filter: 'facet',
        width: 'minmax(100px, 0.6fr)',
      },
      {
        id: 'started',
        header: 'Started',
        kind: 'relativeTime',
        value: (r) => r.startedAt ?? r.createdAt,
        width: 'minmax(110px, 0.7fr)',
      },
      {
        id: 'duration',
        header: 'Duration',
        kind: 'number',
        value: (r) => durationMs(r, now),
        cell: (r) => {
          const live = !r.endedAt && r.status === 'running';
          return (
            <span
              className={`w-full truncate text-right font-mono text-xs tabular-nums ${live ? 'text-info' : 'text-fg-2'}`}
              title={live ? 'Still running' : undefined}
            >
              {formatMs(durationMs(r, now))}
            </span>
          );
        },
        width: 'minmax(96px, 0.6fr)',
      },
    ],
    [now],
  );

  const setSearch = (patch: Partial<RunsSearch>) =>
    void navigate({ to: '/runs', search: (prev: RunsSearch) => ({ ...prev, ...patch }), replace: true });

  const err = q.error;
  return (
    <>
      <PageHeader
        layout="list"
        eyebrow="Automation"
        title="Runs"
        description="Every playbook and runbook run — live, waiting on someone, or finished. Open one for its steps, logs and outputs."
        actions={
          <>
            <SegmentedControl
              aria-label="Whose runs"
              value={filter.scope}
              onValueChange={(v) => setSearch({ scope: v as 'mine' | 'all' })}
              options={[
                { value: 'mine', label: 'Mine' },
                { value: 'all', label: 'Everyone’s' },
              ]}
            />
            <IconButton
              label="Refresh"
              icon={<ArrowClockwiseIcon size={16} />}
              onClick={() => void q.refetch()}
            />
          </>
        }
      />
      {(filter.status || filter.playbook) && (
        <p className="-mt-3 mb-4 flex flex-wrap items-center gap-2 text-sm text-fg-2">
          Showing
          {filter.status && <Badge tone="outline">status: {filter.status}</Badge>}
          {filter.playbook && (
            <Badge tone="outline" mono>
              {filter.playbook}
            </Badge>
          )}
          <Button
            size="sm"
            intent="ghost"
            onClick={() => setSearch({ status: undefined, definition: undefined })}
          >
            Show all
          </Button>
        </p>
      )}
      <DataTable
        label="Runs"
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        loading={q.isPending}
        error={
          err
            ? {
                title: 'Runs didn’t load',
                message: err.message,
                hint: err instanceof ApiRequestError ? err.hint : undefined,
                code: err instanceof ApiRequestError ? err.code : undefined,
                correlationId: err instanceof ApiRequestError ? err.correlationId : undefined,
                onRetry: () => void q.refetch(),
              }
            : null
        }
        empty={{
          title: filter.scope === 'mine' ? 'You haven’t started any runs yet' : 'No runs yet',
          description:
            'Launch a playbook from a page, a row action, or the command palette — its run appears here.',
        }}
        searchPlaceholder="Search runs…"
        initialSort={[{ id: 'started', desc: true }]}
        onRowActivate={(r) => void navigate({ to: '/runs/$id', params: { id: r.id } })}
        rowLabel={(r) => r.title}
        maxHeight={640}
      />
      {q.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button pending={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Load older runs
          </Button>
        </div>
      )}
    </>
  );
}
