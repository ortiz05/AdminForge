import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  button,
  ArrowClockwiseIcon,
  Button,
  Badge,
  DataTable,
  formatRelative,
  formatTimestamp,
  IconButton,
  Kpi,
  KpiStrip,
  PageHeader,
  Panel,
  RobotIcon,
  StatusPill,
  useNow,
  type DataColumn,
} from '@adminforge/ui';
import { ApiRequestError } from '../lib/api';
import { describeCron, formatInZone, nextRuns } from './cron';
import { RunNowButton, ScheduleToggle } from './ScheduleControls';
import {
  JOB_LABEL,
  lastRunView,
  runsAsShort,
  runStatusView,
  schedulesQuery,
  signInView,
  type ScheduleItem,
} from './schedules';
import { Callout, useDocumentTitle } from './ui';

/** The cadence in English with the browser's clock, naming the zone (the API's `cronText` only for custom shapes). */
const cadenceWithoutZone = (s: ScheduleItem) => {
  const text = describeCron(s.cron, s.timezone, { zone: false });
  return text.startsWith('Custom:') && s.cronText ? s.cronText : text;
};

export const cadenceOf = (s: ScheduleItem) => {
  const text = describeCron(s.cron, s.timezone);
  return text.startsWith('Custom:') && s.cronText ? s.cronText : text;
};

/** Next run: the scheduler's own value, else computed from the cron (disabled schedules have none). */
export function nextRunOf(s: ScheduleItem, now: number): string | null {
  if (!s.enabled) return null;
  if (s.nextRunAt && Date.parse(s.nextRunAt) > now) return s.nextRunAt;
  return nextRuns(s.cron, s.timezone, 1, new Date(now))[0]?.toISOString() ?? null;
}

function Upcoming({ schedules, now }: { schedules: ScheduleItem[]; now: number }) {
  const upcoming = useMemo(
    () =>
      schedules
        .filter((s) => s.enabled)
        .flatMap((s) => nextRuns(s.cron, s.timezone, 3, new Date(now)).map((at) => ({ s, at })))
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .slice(0, 8),
    [schedules, now],
  );
  return (
    <Panel
      eyebrow="Next 8 runs"
      title="Upcoming"
      description="Computed from each schedule’s cron in its own time zone."
    >
      {upcoming.length === 0 ? (
        <p className="text-sm text-fg-3">
          Nothing is scheduled. Enable a schedule to see its next runs here.
        </p>
      ) : (
        <ol className="gap-x-10 md:columns-2" aria-label="Upcoming runs">
          {upcoming.map(({ s, at }) => (
            <li
              key={`${s.key}-${at.toISOString()}`}
              className="flex break-inside-avoid items-baseline justify-between gap-3 border-b border-line py-2"
            >
              <Link
                to="/schedules/$key"
                params={{ key: s.key }}
                className="min-w-0 truncate text-sm text-fg hover:underline"
              >
                {s.title}
              </Link>
              <time
                dateTime={at.toISOString()}
                title={formatTimestamp(at)}
                className="shrink-0 font-mono text-xs text-fg-2 tabular-nums"
              >
                {formatInZone(at, s.timezone)} <span className="text-fg-3">· {formatRelative(at, now)}</span>
              </time>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/** How many failed schedules the alert names before "Show n more". */
const FAILED_SHOWN = 5;

/** Schedules (R6): unattended jobs on this host, their cadence in words, next and last runs, enable / run now. */
export function SchedulesPage() {
  const navigate = useNavigate();
  const now = useNow(30_000);
  const q = useQuery(schedulesQuery);
  useDocumentTitle('Schedules');
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  // Most recent first: the alert names the latest FAILED_SHOWN and folds the rest behind "Show n more".
  const failing = items
    .filter((s) => runStatusView(s.lastStatus).tone === 'crit')
    .sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? ''));
  const [allFailed, setAllFailed] = useState(false);
  const failedShown = allFailed ? failing : failing.slice(0, FAILED_SHOWN);
  // Schedules that use the caller's own access and can't run until they sign in for them.
  const mine = items.filter((s) => s.runsAs.canSignIn && signInView(s.runsAs) !== null);
  const pending = items.filter((s) => s.pendingApprovalId && !s.enabled);
  const enabled = items.filter((s) => s.enabled);
  const soonest = enabled
    .map((s) => nextRunOf(s, now))
    .filter((x): x is string => !!x)
    .sort()[0];

  const columns = useMemo<DataColumn<ScheduleItem>[]>(
    () => [
      {
        id: 'schedule',
        header: 'Schedule',
        kind: 'identity',
        value: (s) => ({ primary: s.title, secondary: s.key }),
        cell: (s) => (
          <span className="flex min-w-0 flex-col leading-tight">
            <Link
              to="/schedules/$key"
              params={{ key: s.key }}
              className="truncate font-medium text-fg hover:underline"
              title={s.title}
            >
              {s.title}
            </Link>
            <span className="flex min-w-0 items-center gap-1.5 font-mono text-2xs text-fg-3">
              <span className="truncate">{s.key}</span>
              {s.writeCapable && (
                <Badge tone="outline" className="h-4 font-body">
                  Changes tenant
                </Badge>
              )}
              {s.source === 'portal' && (
                <Badge
                  tone="outline"
                  className="h-4 font-body"
                  title={s.createdBy ? `Created in the portal by ${s.createdBy}` : 'Created in the portal'}
                >
                  Created in portal
                  {s.createdBy && <span className="sr-only"> by {s.createdBy}</span>}
                </Badge>
              )}
            </span>
          </span>
        ),
        width: 'minmax(240px, 2.4fr)',
      },
      {
        id: 'cadence',
        header: 'Cadence',
        kind: 'text',
        value: (s) => cadenceOf(s),
        cell: (s) => (
          // The zone goes on the second line with the cron, so a long sentence never cuts it off.
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-fg-2" title={cadenceOf(s)}>
              {cadenceWithoutZone(s)}
            </span>
            <span className="truncate font-mono text-2xs text-fg-3">
              {s.cron} · {s.timezone.replace(/_/g, ' ')}
            </span>
          </span>
        ),
        width: 'minmax(198px, 2fr)',
      },
      {
        id: 'job',
        header: 'Job',
        kind: 'text',
        value: (s) => JOB_LABEL[s.job.kind] ?? s.job.kind,
        filter: 'facet',
        width: 'minmax(110px, 0.8fr)',
      },
      {
        id: 'runsAs',
        header: 'Runs as',
        kind: 'text',
        value: (s) => runsAsShort(s.runsAs),
        cell: (s) => {
          const signIn = signInView(s.runsAs);
          return (
            <span className="flex min-w-0 flex-col items-start gap-0.5 leading-tight">
              <span className="max-w-full truncate text-fg-2" title={s.runsAs.label}>
                {runsAsShort(s.runsAs)}
              </span>
              {/* Two lines like every other cell: the sign-in state when it needs one, else "Own access". */}
              {signIn ? (
                <StatusPill status={signIn.tone} size="sm">
                  {signIn.label}
                </StatusPill>
              ) : (
                s.runsAs.kind === 'user' && <span className="text-2xs text-fg-3">Own access</span>
              )}
            </span>
          );
        },
        filter: 'facet',
        width: 'minmax(132px, 1.2fr)',
      },
      {
        id: 'next',
        header: 'Next run',
        kind: 'relativeTime',
        value: (s) => nextRunOf(s, now),
        width: 'minmax(88px, 0.6fr)',
      },
      {
        id: 'last',
        header: 'Last run',
        kind: 'status',
        value: (s) => lastRunView(s, { short: true }),
        cell: (s) => {
          const v = lastRunView(s, { short: true });
          return (
            <span className="flex min-w-0 items-center gap-2">
              <StatusPill status={v.tone} size="sm">
                {v.label}
              </StatusPill>
              {s.lastRunAt && (
                <time
                  dateTime={s.lastRunAt}
                  title={formatTimestamp(s.lastRunAt)}
                  className="truncate text-xs text-fg-3"
                >
                  {formatRelative(s.lastRunAt, now)}
                </time>
              )}
            </span>
          );
        },
        width: 'minmax(150px, 1.1fr)',
      },
      {
        id: 'enabled',
        header: 'Enabled',
        kind: 'text',
        value: (s) => (s.enabled ? 'Enabled' : s.pendingApprovalId ? 'Awaiting approval' : 'Disabled'),
        cell: (s) => <ScheduleToggle schedule={s} />,
        filter: 'facet',
        width: 'minmax(112px, 0.5fr)',
      },
      {
        id: 'actions',
        header: 'Actions',
        headerHidden: true,
        kind: 'text',
        value: () => '',
        cell: (s) => <RunNowButton schedule={s} />,
        sortable: false,
        filter: 'none',
        hideable: false,
        pin: 'end',
        width: 'minmax(100px, 0.6fr)',
      },
    ],
    [now],
  );

  const err = q.error;
  return (
    <>
      <PageHeader
        layout="list"
        eyebrow="Automation"
        title="Schedules"
        description="Jobs that run on their own on this host: reports, synthetic tests, content health and approved playbooks."
        actions={
          <div className="flex items-center gap-2">
            <Link to="/schedules/new" className={button({ intent: 'secondary', size: 'sm' })}>
              New schedule
            </Link>
            <IconButton
              label="Refresh"
              icon={<ArrowClockwiseIcon size={16} />}
              onClick={() => void q.refetch()}
            />
          </div>
        }
      />
      <div className="flex flex-col gap-6">
        <Callout tone="neutral" icon={<RobotIcon size={18} />} title="Who schedules run as">
          Unattended runs use an app registration with application permissions: the automation identity, or an
          app identity a schedule names. A report schedule can instead use its creator’s own read access. Each
          run is audited as scheduled by the person who enabled it and executed as the identity it ran as.
          Schedules that can change the tenant need a second person to approve before they turn on.
        </Callout>
        {mine.length > 0 && (
          <Callout
            tone="warn"
            title={`${mine.length} schedule${mine.length === 1 ? '' : 's'} need${mine.length === 1 ? 's' : ''} you to sign in`}
          >
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {mine.map((s) => (
                <Link
                  key={s.key}
                  to="/schedules/$key"
                  params={{ key: s.key }}
                  className="font-medium text-fg underline-offset-2 hover:underline"
                >
                  {s.title}
                </Link>
              ))}
            </span>
          </Callout>
        )}
        {failing.length > 0 && (
          <Callout
            tone="crit"
            role="alert"
            title={`${failing.length} schedule${failing.length === 1 ? '' : 's'} failed on the last run`}
          >
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {failedShown.map((s) => (
                <Link
                  key={s.key}
                  to="/schedules/$key"
                  params={{ key: s.key }}
                  className="font-medium text-fg underline-offset-2 hover:underline"
                >
                  {s.title}
                </Link>
              ))}
              {failing.length > FAILED_SHOWN && (
                <Button
                  size="sm"
                  intent="ghost"
                  className="-my-1 -ml-1"
                  aria-expanded={allFailed}
                  onClick={() => setAllFailed((v) => !v)}
                >
                  {allFailed ? 'Show fewer' : `Show ${failing.length - FAILED_SHOWN} more`}
                </Button>
              )}
            </span>
          </Callout>
        )}
        <KpiStrip label="Schedule summary" className="xl:grid-cols-4">
          <Kpi
            variant="cell"
            label="Enabled"
            value={q.isPending ? null : enabled.length}
            hint={`of ${items.length}`}
            loading={q.isPending}
          />
          <Kpi
            variant="cell"
            label="Next run"
            value={soonest ? formatRelative(soonest, now).replace(/^in /, '') : '—'}
            hint={soonest ? `at ${formatTimestamp(soonest).slice(11, 16)} UTC` : 'nothing scheduled'}
            loading={q.isPending}
          />
          <Kpi
            variant="cell"
            label="Failed last run"
            value={q.isPending ? null : failing.length}
            status={
              failing.length ? { tone: 'crit', label: 'Needs a look' } : { tone: 'ok', label: 'All passing' }
            }
            loading={q.isPending}
          />
          <Kpi
            variant="cell"
            label="Awaiting approval"
            value={q.isPending ? null : pending.length}
            hint="to enable"
            loading={q.isPending}
          />
        </KpiStrip>
        <div className="flex flex-col gap-6">
          <div className="min-w-0">
            <DataTable
              label="Schedules"
              data={items}
              columns={columns}
              getRowId={(s) => s.key}
              loading={q.isPending}
              error={
                err
                  ? {
                      title: 'Schedules didn’t load',
                      message: err.message,
                      hint: err instanceof ApiRequestError ? err.hint : undefined,
                      code: err instanceof ApiRequestError ? err.code : undefined,
                      correlationId: err instanceof ApiRequestError ? err.correlationId : undefined,
                      onRetry: () => void q.refetch(),
                    }
                  : null
              }
              empty={{
                title: 'No schedules yet',
                description: (
                  <>
                    Add one under <code className="font-mono text-xs">portal/content/schedules</code> with{' '}
                    <code className="font-mono text-xs">pnpm adminforge new schedule</code>.
                  </>
                ),
              }}
              searchPlaceholder="Search schedules…"
              initialSort={[{ id: 'next', desc: false }]}
              onRowActivate={(s) => void navigate({ to: '/schedules/$key', params: { key: s.key } })}
              rowLabel={(s) => s.title}
            />
          </div>
          <Upcoming schedules={items} now={now} />
        </div>
      </div>
    </>
  );
}
