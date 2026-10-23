import { useMemo, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { DataTable, formatRelative, formatTimestamp, StatusPill, type DataColumn } from '@adminforge/ui';
import { FUNCTION_LABEL, scheduleFunction, scheduleHealth, scheduleServices } from './monitoring-model';
import { nextRuns } from './cron';
import { ScheduleTitle } from './ScheduleTitle';
import { runsAsShort, type ProbeItem, type ScheduleItem } from './schedules';

function nextRunOf(s: ScheduleItem, now: number): string | null {
  if (!s.enabled) return null;
  if (s.nextRunAt && Date.parse(s.nextRunAt) > now) return s.nextRunAt;
  return nextRuns(s.cron, s.timezone, 1, new Date(now))[0]?.toISOString() ?? null;
}

/**
 * Monitoring's schedules: every report, automation, sweep and maintenance job the filters let through, worst first —
 * its status (how its last run went; off or awaiting approval), when it runs next and who it runs as. A row opens the
 * schedule. A sweep's services come from its checks: unknown (—) while they didn't load.
 */
export function MonitoringSchedules({
  items,
  probes,
  serviceLabel,
  now,
  loading,
  empty,
}: {
  items: ScheduleItem[];
  probes: readonly ProbeItem[] | null;
  serviceLabel: (key: string) => string;
  now: number;
  loading: boolean;
  empty: { title: string; description?: ReactNode; action?: ReactNode };
}) {
  const navigate = useNavigate();
  const columns = useMemo<DataColumn<ScheduleItem>[]>(() => {
    const servicesText = (s: ScheduleItem) => {
      if (!s.group && !probes) return '—';
      return (
        scheduleServices(s, probes ?? [])
          .map(serviceLabel)
          .join(', ') || 'All services'
      );
    };
    return [
      {
        id: 'schedule',
        header: 'Schedule',
        kind: 'identity',
        value: (s) => ({ primary: s.title, secondary: s.key }),
        cell: (s) => <ScheduleTitle s={s} />,
        width: 'minmax(200px, 2.4fr)',
      },
      {
        id: 'function',
        header: 'Function',
        kind: 'text',
        value: (s) => FUNCTION_LABEL[scheduleFunction(s)],
        width: 'minmax(96px, 0.9fr)',
      },
      {
        id: 'service',
        header: 'Service',
        kind: 'text',
        value: servicesText,
        cell: (s) => (
          <span className="truncate text-fg-2" title={servicesText(s)}>
            {servicesText(s)}
          </span>
        ),
        width: 'minmax(96px, 1fr)',
      },
      {
        id: 'status',
        header: 'Status',
        kind: 'status',
        value: (s) => scheduleHealth(s),
        cell: (s) => {
          const v = scheduleHealth(s);
          return (
            <span className="flex min-w-0 items-center gap-2">
              <StatusPill status={v.tone} size="sm">
                {v.label}
              </StatusPill>
              {s.enabled && s.lastRunAt && (
                <time
                  dateTime={s.lastRunAt}
                  title={`Last run ${formatTimestamp(s.lastRunAt)}`}
                  className="truncate text-xs text-fg-3"
                >
                  {formatRelative(s.lastRunAt, now)}
                </time>
              )}
            </span>
          );
        },
        width: 'minmax(132px, 1.1fr)',
      },
      {
        id: 'next',
        header: 'Next run',
        kind: 'relativeTime',
        value: (s) => nextRunOf(s, now),
        width: 'minmax(80px, 0.7fr)',
      },
      {
        id: 'runsAs',
        header: 'Runs as',
        kind: 'text',
        value: (s) => runsAsShort(s.runsAs),
        width: 'minmax(96px, 0.9fr)',
      },
    ];
  }, [now, probes, serviceLabel]);
  return (
    <DataTable
      label="Schedules and reports"
      data={items}
      columns={columns}
      getRowId={(s) => s.key}
      loading={loading}
      toolbar={false}
      empty={empty}
      initialSort={[{ id: 'status', desc: true }]}
      onRowActivate={(s) => void navigate({ to: '/schedules/$key', params: { key: s.key } })}
      rowLabel={(s) => s.title}
    />
  );
}
