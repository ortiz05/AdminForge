import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowClockwiseIcon,
  Badge,
  Button,
  CircleNotchIcon,
  CodeBlock,
  DataTable,
  DownloadSimpleIcon,
  Drawer,
  EmptyState,
  formatTimestamp,
  IdChip,
  PageHeader,
  Panel,
  SealCheckIcon,
  StatusPill,
  TextField,
  type DataColumn,
} from '@adminforge/ui';
import { useMe } from '../lib/session';
import {
  auditCsv,
  auditPage,
  auditVerifyQuery,
  resultTone,
  type AuditEvent,
  type AuditFilter,
} from './audit';
import { Callout, Facts, isForbidden, QueryError, useDocumentTitle } from './ui';

export interface AuditSearch extends AuditFilter {
  event?: number;
}

function ChainStatus() {
  const q = useQuery(auditVerifyQuery);
  if (q.isPending)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-fg-3" role="status">
        <CircleNotchIcon size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />
        Verifying the hash chain…
      </span>
    );
  if (q.isError)
    return (
      <StatusPill status="neutral" size="md">
        Chain not verified
      </StatusPill>
    );
  const v = q.data;
  return v.ok ? (
    <span
      title={`Every event's hash was recomputed from the one before it (${v.checked.toLocaleString('en-US')} events).`}
    >
      <StatusPill status="ok">Chain verified ✓ · {v.checked.toLocaleString('en-US')} events</StatusPill>
    </span>
  ) : v.keyMissing ? (
    // Short, so it doesn't truncate on a phone; what to do is in KeyMissingCallout.
    <StatusPill status="crit">Can’t verify from #{v.brokenAt ?? '?'}</StatusPill>
  ) : (
    <StatusPill status="crit">Chain broken at #{v.brokenAt ?? '?'}</StatusPill>
  );
}

/**
 * S-10: from an event on the log is keyed with an audit chain key the portal doesn't have, so it can't be checked —
 * what an administrator does about it (Portal Admin only, so it may name configuration keys; never the key or its id).
 */
function KeyMissingCallout() {
  const v = useQuery(auditVerifyQuery).data;
  if (!v || v.ok || !v.keyMissing) return null;
  return (
    <Callout
      tone="crit"
      title={`The audit log can’t be verified from event #${v.brokenAt ?? '?'}`}
      className="mb-4"
    >
      From there on it is keyed with an audit chain key that isn’t configured. After a key rotation, put the
      earlier key in AUDIT_CHAIN_PREVIOUS_KEYS and restart. If no such key was ever configured, the event was
      forged: investigate who can write to the database.
    </Callout>
  );
}

function EventDrawer({ event, onClose }: { event: AuditEvent; onClose: () => void }) {
  const tone = resultTone(event.result);
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      modal={false}
      docked
      className="w-160"
      eyebrow={`Audit event #${event.seq}`}
      title={event.action}
      description={formatTimestamp(event.ts)}
    >
      <div className="flex flex-col gap-6">
        <Facts
          items={[
            [
              'Result',
              <StatusPill key="r" status={tone} size="sm">
                {event.result}
              </StatusPill>,
            ],
            ['Who', event.actorUpn ?? 'System'],
            [
              'Mode',
              event.mode === 'armed' || event.mode === 'write'
                ? 'Write access (armed)'
                : event.mode === 'automation'
                  ? 'Automation identity'
                  : (event.mode ?? '—'),
            ],
            ['Target', event.targetType ? `${event.targetType}` : null],
            [
              'Target ID',
              event.targetId ? (
                event.targetType === 'run' ? (
                  <Link
                    key="t"
                    to="/runs/$id"
                    params={{ id: event.targetId }}
                    className="font-mono text-xs text-accent hover:underline"
                  >
                    {event.targetId}
                  </Link>
                ) : (
                  <IdChip key="t" value={event.targetId} label="Target ID" showLabel={false} />
                )
              ) : null,
            ],
            [
              'Correlation ID',
              event.correlationId ? (
                <IdChip key="c" value={event.correlationId} label="Correlation ID" showLabel={false} />
              ) : null,
            ],
            [
              'Sequence',
              <span key="s" className="font-mono text-xs">
                {event.seq}
              </span>,
            ],
          ]}
        />
        {event.details !== null && event.details !== undefined && (
          <CodeBlock
            title="details (redacted)"
            language="json"
            code={JSON.stringify(event.details, null, 2)}
            maxHeight={420}
          />
        )}
        <p className="text-xs text-fg-3">
          The correlation ID is also sent to Microsoft as client-request-id, so you can find this change in
          Entra and Azure logs and quote it in support tickets.
        </p>
      </div>
    </Drawer>
  );
}

/** Server-side filters; remounted (keyed) whenever the URL's filters change, so the draft always starts from them. */
function FilterForm({
  filter,
  onApply,
  onClear,
}: {
  filter: AuditFilter;
  onApply: (f: AuditFilter) => void;
  onClear?: () => void;
}) {
  const [draft, setDraft] = useState(filter);
  const dirty = JSON.stringify(draft) !== JSON.stringify(filter);
  return (
    <form
      className="mb-4 flex flex-wrap items-end gap-3 rounded-(--af-panel-radius) border border-line bg-panel p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onApply({
          actor: draft.actor?.trim() || undefined,
          action: draft.action?.trim() || undefined,
          from: draft.from || undefined,
          to: draft.to || undefined,
        });
      }}
      aria-label="Filter the audit log"
    >
      <TextField
        label="Who"
        placeholder="name@example.com"
        value={draft.actor ?? ''}
        onChange={(e) => setDraft((d) => ({ ...d, actor: e.target.value }))}
        className="w-64"
      />
      <TextField
        label="Action"
        placeholder="e.g. run.*"
        value={draft.action ?? ''}
        onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value }))}
        className="w-56"
        inputClassName="font-mono"
      />
      <TextField
        label="From"
        type="date"
        value={draft.from ?? ''}
        onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
        className="w-44"
      />
      <TextField
        label="To"
        type="date"
        value={draft.to ?? ''}
        onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
        className="w-44"
      />
      <Button type="submit" intent={dirty ? 'primary' : 'secondary'}>
        Apply
      </Button>
      {onClear && (
        <Button intent="ghost" onClick={onClear}>
          Clear
        </Button>
      )}
      <p className="ml-auto self-center text-xs text-fg-3">
        Filters run on the server; facets below narrow what’s loaded.
      </p>
    </form>
  );
}

/** Audit (§5.9, Portal.Admin): the append-only, hash-chained log with filters, detail, export and chain verification. */
export function AuditPage({ search }: { search: AuditSearch }) {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useDocumentTitle('Audit');
  const filter: AuditFilter = {
    actor: search.actor,
    action: search.action,
    from: search.from,
    to: search.to,
  };

  const q = useInfiniteQuery({
    queryKey: ['audit', 'list', filter] as const,
    queryFn: ({ pageParam, signal }) => auditPage(filter, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const selected = search.event !== undefined ? rows.find((r) => r.seq === search.event) : undefined;

  const setSearch = (patch: Partial<AuditSearch>) =>
    void navigate({ to: '/audit', search: (prev: AuditSearch) => ({ ...prev, ...patch }), replace: true });
  const anyFilter = Boolean(filter.actor || filter.action || filter.from || filter.to);

  const columns = useMemo<DataColumn<AuditEvent>[]>(
    () => [
      {
        id: 'ts',
        header: 'Time',
        kind: 'relativeTime',
        value: (e) => e.ts,
        width: 'minmax(120px, 0.7fr)',
      },
      {
        id: 'actor',
        header: 'Who',
        kind: 'text',
        value: (e) => e.actorUpn ?? 'System',
        filter: 'facet',
        width: 'minmax(200px, 1.3fr)',
      },
      {
        id: 'mode',
        header: 'Mode',
        kind: 'text',
        value: (e) =>
          e.mode === 'armed' || e.mode === 'write'
            ? 'Write'
            : e.mode === 'automation'
              ? 'Automation'
              : e.mode
                ? 'Read'
                : '—',
        cell: (e) =>
          e.mode === 'armed' || e.mode === 'write' ? (
            <Badge tone="outline">Write</Badge>
          ) : (
            <span className="text-fg-3">
              {e.mode === 'automation' ? 'Automation' : e.mode ? 'Read' : '—'}
            </span>
          ),
        filter: 'facet',
        width: 'minmax(96px, 0.5fr)',
      },
      {
        id: 'action',
        header: 'Action',
        kind: 'text',
        value: (e) => e.action,
        cell: (e) => <code className="truncate font-mono text-xs text-fg">{e.action}</code>,
        filter: 'facet',
        width: 'minmax(180px, 1.2fr)',
      },
      {
        id: 'target',
        header: 'Target',
        kind: 'text',
        value: (e) => [e.targetType, e.targetId].filter(Boolean).join(' '),
        cell: (e) =>
          e.targetType ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-fg-2">{e.targetType}</span>
              {e.targetId && <span className="truncate font-mono text-2xs text-fg-3">{e.targetId}</span>}
            </span>
          ) : (
            <span className="text-fg-3">—</span>
          ),
        width: 'minmax(200px, 1.3fr)',
      },
      {
        id: 'result',
        header: 'Result',
        kind: 'status',
        value: (e) => ({ tone: resultTone(e.result), label: e.result }),
        width: 'minmax(110px, 0.6fr)',
      },
      {
        id: 'seq',
        header: 'Seq',
        kind: 'number',
        value: (e) => e.seq,
        cell: (e) => (
          <span className="w-full text-right font-mono text-xs text-fg-3 tabular-nums">{e.seq}</span>
        ),
        width: 'minmax(84px, 0.5fr)',
      },
    ],
    [],
  );

  if (q.isError && isForbidden(q.error))
    return (
      <>
        <PageHeader layout="list" eyebrow="Admin" title="Audit" />
        <Panel>
          <EmptyState title="The audit log is for Portal Admins" icon={<SealCheckIcon size={20} />}>
            Your account ({me.user.upn}) doesn’t have the Portal Admin role. Ask a Portal Admin for an export
            if you need one.
          </EmptyState>
        </Panel>
      </>
    );

  const err = q.error;
  return (
    <>
      <PageHeader
        layout="list"
        eyebrow="Admin"
        title="Audit"
        description="Every sign-in, arm and disarm, write request, run step, approval and setting change — append-only and hash-chained."
        meta={<ChainStatus />}
        actions={
          <>
            <Button
              intent="ghost"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['audit'] })}
            >
              <ArrowClockwiseIcon size={15} aria-hidden />
              Refresh and re-verify
            </Button>
            <Button
              aria-disabled={rows.length === 0 || undefined}
              onClick={() => {
                if (!rows.length) return;
                const url = URL.createObjectURL(
                  new Blob([auditCsv(rows)], { type: 'text/csv;charset=utf-8' }),
                );
                const a = document.createElement('a');
                a.href = url;
                a.download = `adminforge-audit-${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
                window.setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              <DownloadSimpleIcon size={15} aria-hidden />
              Export CSV
            </Button>
          </>
        }
      />
      <KeyMissingCallout />
      <FilterForm
        key={JSON.stringify(filter)}
        filter={filter}
        onApply={(f) => setSearch(f)}
        onClear={
          anyFilter
            ? () => setSearch({ actor: undefined, action: undefined, from: undefined, to: undefined })
            : undefined
        }
      />
      {err && !isForbidden(err) ? (
        <Panel>
          <QueryError title="The audit log didn’t load" error={err} onRetry={() => void q.refetch()} />
        </Panel>
      ) : (
        <DataTable
          label="Audit events"
          data={rows}
          columns={columns}
          getRowId={(e) => String(e.seq)}
          loading={q.isPending}
          error={null}
          empty={{
            title: anyFilter ? 'No events match these filters' : 'No audit events yet',
            description: anyFilter ? 'Widen the dates or clear the filters.' : undefined,
          }}
          searchPlaceholder="Search loaded events…"
          initialSort={[{ id: 'seq', desc: true }]}
          onRowActivate={(e) => setSearch({ event: e.seq })}
          activeRowId={selected ? String(selected.seq) : undefined}
          rowLabel={(e) => `${e.action} by ${e.actorUpn ?? 'system'}`}
          onEndReached={() => {
            if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
          }}
          loadingMore={q.isFetchingNextPage}
          rowCountLabel={(shown, loaded) =>
            `${shown === loaded ? loaded.toLocaleString('en-US') : `${shown.toLocaleString('en-US')} of ${loaded.toLocaleString('en-US')}`} loaded${q.hasNextPage ? ' · scroll for older' : ''}`
          }
          maxHeight={640}
        />
      )}
      {selected && (
        <EventDrawer key={selected.seq} event={selected} onClose={() => setSearch({ event: undefined })} />
      )}
    </>
  );
}
