import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowClockwiseIcon,
  Badge,
  Button,
  CheckCircleIcon,
  DataTable,
  EmptyState,
  ErrorState,
  IconButton,
  IdChip,
  Kpi,
  KpiStrip,
  Meter,
  PageHeader,
  Panel,
  ProvenanceFooter,
  Skeleton,
  StatusPill,
  STATUS_SEVERITY,
  type DataColumn,
  type StatusTone,
} from '@adminforge/ui';
import { ApiRequestError } from '../../lib/api';
import { healthStatus, overviewQuery, skuName, type OverviewResponse } from '../../lib/overview';

type Sku = OverviewResponse['skus'][number];

const NO_SKUS: Sku[] = [];

const ratio = (s: Sku) => (s.total > 0 ? s.used / s.total : 0);

function skuStatus(s: Sku): { tone: StatusTone; label: string } | null {
  if (s.total > 0 && s.used >= s.total) return { tone: 'crit', label: 'No seats left' };
  if (ratio(s) > 0.9) return { tone: 'warn', label: 'Nearly full' };
  return null;
}

const LICENCE_COLUMNS: DataColumn<Sku>[] = [
  {
    id: 'licence',
    header: 'Licence',
    kind: 'identity',
    value: (s) => ({ primary: skuName(s.sku), secondary: s.sku }),
    width: 'minmax(240px, 2fr)',
  },
  { id: 'used', header: 'Assigned', kind: 'number', value: (s) => s.used, width: 'minmax(92px, 0.6fr)' },
  {
    id: 'available',
    header: 'Available',
    kind: 'number',
    value: (s) => Math.max(0, s.total - s.used),
    width: 'minmax(92px, 0.6fr)',
  },
  {
    id: 'utilisation',
    header: 'Utilisation',
    kind: 'number',
    value: ratio,
    cell: (s) => (
      <Meter value={s.used} max={s.total} label={`${skuName(s.sku)} utilisation`} className="w-full" />
    ),
    width: 'minmax(160px, 1.2fr)',
    align: 'start',
  },
  {
    id: 'status',
    header: 'Status',
    kind: 'status',
    value: (s) => skuStatus(s),
    cell: (s) => {
      const st = skuStatus(s);
      return st ? (
        <StatusPill status={st.tone} size="sm">
          {st.label}
        </StatusPill>
      ) : null;
    },
    width: 'minmax(128px, 0.9fr)',
    filter: 'none',
  },
];

function Provenance({ data, k }: { data: OverviewResponse | undefined; k: string }) {
  const p = data?.provenance[k];
  return p ? <ProvenanceFooter {...p} /> : null;
}

const ROW =
  'flex h-(--af-control-h) items-center justify-between gap-3 border-t border-line px-(--af-pad-panel) first:border-t-0';

type HealthRow = { service: string; status: string; st: { tone: StatusTone; label: string } };

/**
 * Services that need attention are listed; healthy ones fold into one summary line, because a real tenant
 * reports around thirty services and the useful signal is the few that aren't fine.
 */
function ServiceHealthList({ services }: { services: HealthRow[] }) {
  const [showAll, setShowAll] = useState(false);
  if (services.length === 0) return <EmptyState compact title="No services reported" />;
  const healthy = services.filter((h) => h.st.tone === 'ok' && h.st.label === 'Healthy');
  const rows = showAll || healthy.length < 2 ? services : services.filter((h) => !healthy.includes(h));
  const folded = rows.length < services.length;
  return (
    <ul className="flex flex-col pb-1.5" aria-label="Services">
      {rows.map((h) => (
        <li key={h.service} className={ROW}>
          <span className="truncate text-fg">{h.service}</span>
          <StatusPill status={h.st.tone} size="sm">
            {h.st.label}
          </StatusPill>
        </li>
      ))}
      {(folded || showAll) && healthy.length >= 2 && (
        <li className={ROW}>
          <span className="flex min-w-0 items-center gap-2 text-fg-2">
            <CheckCircleIcon size={15} weight="fill" className="shrink-0 text-ok" aria-hidden />
            {folded ? (
              <span className="min-w-0 truncate">
                {healthy.length} more healthy{' '}
                <span className="text-fg-3">· {healthy.map((h) => h.service).join(', ')}</span>
              </span>
            ) : (
              <span>{healthy.length} services healthy</span>
            )}
          </span>
          <Button
            size="sm"
            intent="ghost"
            className="-mr-2 shrink-0"
            aria-expanded={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Show fewer' : 'Show all'}
          </Button>
        </li>
      )}
    </ul>
  );
}

/** Tenant overview (Task 1.18): directory size, licence use, service health, verified domains. */
export function OverviewPage() {
  const q = useQuery(overviewQuery);
  const data = q.data;
  const loading = q.isPending;

  const health = data && 'items' in data.health ? data.health.items : null;
  const healthError = data && 'error' in data.health ? data.health.error : null;
  const issues = useMemo(
    () => (health ?? []).map((h) => ({ ...h, st: healthStatus(h.status) })).filter((h) => h.st.tone !== 'ok'),
    [health],
  );
  const sortedHealth = useMemo(
    () =>
      (health ?? [])
        .map((h) => ({ ...h, st: healthStatus(h.status) }))
        .sort(
          (a, b) =>
            STATUS_SEVERITY[b.st.tone] - STATUS_SEVERITY[a.st.tone] || a.service.localeCompare(b.service),
        ),
    [health],
  );
  const seats = useMemo(
    () =>
      (data?.skus ?? []).reduce((acc, s) => ({ used: acc.used + s.used, total: acc.total + s.total }), {
        used: 0,
        total: 0,
      }),
    [data],
  );
  const domains = useMemo(
    () =>
      [...(data?.org.domains ?? [])].sort(
        (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name),
      ),
    [data],
  );

  if (q.isError) {
    const err = q.error;
    return (
      <>
        <PageHeader eyebrow="Tenant" title="Overview" />
        <Panel>
          <ErrorState
            title="The tenant overview didn’t load"
            message={err.message}
            hint={err instanceof ApiRequestError ? err.hint : undefined}
            code={err instanceof ApiRequestError ? err.code : undefined}
            correlationId={err instanceof ApiRequestError ? err.correlationId : undefined}
            action={<Button onClick={() => void q.refetch()}>Try again</Button>}
          />
        </Panel>
      </>
    );
  }

  const worst = [...issues].sort((a, b) => STATUS_SEVERITY[b.st.tone] - STATUS_SEVERITY[a.st.tone])[0];
  const healthKpi = healthError
    ? { value: '—', status: { tone: 'neutral' as const, label: 'Unavailable' } }
    : {
        value: issues.length,
        status: worst
          ? {
              tone: (worst.st.tone === 'info' ? 'warn' : worst.st.tone) as StatusTone,
              label: issues.length === 1 ? `${worst.service}` : `${worst.service} +${issues.length - 1}`,
            }
          : { tone: 'ok' as const, label: 'All healthy' },
      };

  return (
    <>
      <PageHeader
        eyebrow="Tenant"
        title={loading ? <Skeleton className="h-7 w-56" /> : data!.org.name}
        meta={data && <IdChip value={data.org.id} label="Tenant ID" />}
        description="Directory size, licence use, and Microsoft 365 service health at a glance."
        actions={
          <IconButton
            label="Refresh"
            intent="secondary"
            icon={<ArrowClockwiseIcon size={16} className={q.isFetching ? 'animate-spin' : undefined} />}
            onClick={() => void q.refetch()}
          />
        }
      />

      <KpiStrip label="Key figures" className="mb-(--af-gap-grid)">
        <Kpi
          variant="cell"
          label="Users"
          value={data?.counts.users}
          loading={loading}
          hint="Members and guests"
        />
        <Kpi
          variant="cell"
          label="Groups"
          value={data?.counts.groups}
          loading={loading}
          hint="Security and Microsoft 365"
        />
        <Kpi
          variant="cell"
          label="App registrations"
          value={data?.counts.apps}
          loading={loading}
          hint="Owned by this tenant"
        />
        <Kpi
          variant="cell"
          label="Devices"
          value={data?.counts.devices}
          loading={loading}
          hint="Entra registered and joined"
        />
        <Kpi
          variant="cell"
          label="Licensed seats"
          value={data ? seats.used : undefined}
          loading={loading}
          hint={
            data
              ? `of ${seats.total.toLocaleString('en-US')} in ${data.skus.length} subscriptions`
              : undefined
          }
        />
        <Kpi
          variant="cell"
          label="Services with issues"
          value={healthKpi.value}
          status={loading ? undefined : healthKpi.status}
          loading={loading}
        />
      </KpiStrip>

      <div className="grid gap-(--af-gap-grid) xl:grid-cols-12">
        <Panel
          className="xl:col-span-7"
          eyebrow="Microsoft 365"
          title="Service health"
          actions={
            health && (
              <StatusPill
                status={issues.length ? (issues.some((i) => i.st.tone === 'crit') ? 'crit' : 'warn') : 'ok'}
                size="sm"
              >
                {issues.length ? `${issues.length} need attention` : 'All healthy'}
              </StatusPill>
            )
          }
          flush
          footer={<Provenance data={data} k="health" />}
        >
          {loading ? (
            <div className="flex flex-col gap-3 px-(--af-pad-panel) pb-(--af-pad-panel)">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} />
              ))}
            </div>
          ) : healthError ? (
            <ErrorState
              compact
              title="Service health isn’t available"
              message={healthError.message}
              hint={healthError.hint}
              code={healthError.code}
            />
          ) : (
            <ServiceHealthList services={sortedHealth} />
          )}
        </Panel>

        <Panel
          className="xl:col-span-5"
          eyebrow="Directory"
          title="Verified domains"
          flush
          footer={<Provenance data={data} k="org" />}
        >
          {loading ? (
            <div className="flex flex-col gap-3 px-(--af-pad-panel) pb-(--af-pad-panel)">
              <Skeleton />
              <Skeleton className="w-2/3" />
            </div>
          ) : domains.length === 0 ? (
            <EmptyState compact title="No verified domains" />
          ) : (
            <ul className="flex flex-col pb-1.5" aria-label="Domains">
              {domains.map((d) => (
                <li key={d.name} className={ROW}>
                  <span className="truncate font-mono text-sm text-fg">{d.name}</span>
                  <span className="flex shrink-0 gap-1">
                    {d.isDefault && <Badge tone="accent">Default</Badge>}
                    {d.isInitial && <Badge tone="outline">Initial</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          className="xl:col-span-12"
          eyebrow="Licensing"
          title="Subscriptions"
          flush
          footer={<Provenance data={data} k="skus" />}
        >
          <DataTable
            label="Licence subscriptions"
            data={data?.skus ?? NO_SKUS}
            columns={LICENCE_COLUMNS}
            getRowId={(s) => s.sku}
            loading={loading}
            searchPlaceholder="Find a licence…"
            initialSort={[{ id: 'utilisation', desc: true }]}
            empty={{ title: 'No licence subscriptions', description: 'This tenant has no subscribed SKUs.' }}
            maxHeight={480}
          />
        </Panel>
      </div>
    </>
  );
}
