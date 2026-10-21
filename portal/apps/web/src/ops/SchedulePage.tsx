import { useEffect, useRef } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Badge,
  button,
  Button,
  cn,
  DownloadSimpleIcon,
  EmptyState,
  formatRelative,
  formatTimestamp,
  PageHeader,
  Panel,
  PencilSimpleIcon,
  RobotIcon,
  Skeleton,
  SkeletonText,
  STATUS_ICON,
  StatusPill,
  useNow,
  UserIcon,
  useToast,
  WarningCircleIcon,
} from '@adminforge/ui';
import { formatBytes } from '@adminforge/widgets';
import { RouterLink } from '../app/RouterLink';
import { ApiRequestError } from '../lib/api';
import { browser } from '../lib/browser';
import { formatInZone, nextRuns } from './cron';
import { cadenceOf } from './SchedulesPage';
import { DeleteScheduleButton, RunNowButton, ScheduleToggle } from './ScheduleControls';
import {
  JOB_LABEL,
  lastRunView,
  runsAsSentence,
  runStatusView,
  runView,
  scheduleRunsPage,
  scheduleSignInReturn,
  scheduleSignInUrl,
  schedulesQuery,
  type ScheduleItem,
  type ScheduleRun,
} from './schedules';
import { Callout, elapsed, Facts, QueryError, useDocumentTitle } from './ui';

const TRIGGER_LABEL: Record<string, string> = {
  cron: 'Scheduled',
  schedule: 'Scheduled',
  manual: 'Run now',
  retry: 'Retry',
};
const TONE_TEXT = {
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
  info: 'text-info',
  neutral: 'text-fg-3',
} as const;

function JobRef({ s }: { s: ScheduleItem }) {
  if (!s.job.ref) return <span>{JOB_LABEL[s.job.kind] ?? s.job.kind}</span>;
  const ref = <code className="font-mono text-xs">{s.job.ref}</code>;
  if (s.job.kind === 'playbook')
    return (
      <Link to="/playbooks/$key" params={{ key: s.job.ref }} className="text-accent hover:underline">
        {ref}
      </Link>
    );
  if (s.job.kind === 'report')
    return (
      <Link to="/reports" search={{ report: s.job.ref }} className="text-accent hover:underline">
        {ref}
      </Link>
    );
  return ref;
}

function History({ s }: { s: ScheduleItem }) {
  const now = useNow(30_000);
  const q = useInfiniteQuery({
    queryKey: ['schedule-runs', s.key] as const,
    queryFn: ({ pageParam, signal }) => scheduleRunsPage(s.key, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor ?? undefined,
    refetchInterval: 30_000,
  });
  const runs: ScheduleRun[] = q.data?.pages.flatMap((p) => p.items) ?? [];
  const failures = runs.filter((r) => runStatusView(r.status).tone === 'crit').length;
  return (
    <Panel
      eyebrow="History"
      title="Recent runs"
      description={runs.length ? `${runs.length} shown${failures ? ` · ${failures} failed` : ''}` : undefined}
      flush
    >
      {q.isError ? (
        <div className="p-(--af-pad-panel)">
          <QueryError
            compact
            title="Run history didn’t load"
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        </div>
      ) : q.isPending ? (
        <div className="flex flex-col gap-2 p-(--af-pad-panel)" aria-busy="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : runs.length === 0 ? (
        <EmptyState compact title="This schedule hasn’t run yet">
          {s.enabled ? 'Its first run is listed under Cadence.' : 'Enable it, or use Run now.'}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Runs of {s.title}, newest first</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs text-fg-3">
                <th scope="col" className="px-(--af-pad-panel) py-2 font-medium">
                  Result
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Started
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Trigger
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Took
                </th>
                <th scope="col" className="px-(--af-pad-panel) py-2 font-medium">
                  Output
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const v = runView(r);
                const failed = v.tone === 'crit';
                const Glyph = STATUS_ICON[v.tone];
                return (
                  <tr
                    key={r.id}
                    className={cn(
                      'border-b border-line align-top last:border-b-0',
                      failed && 'bg-crit-subtle',
                    )}
                  >
                    <td className="px-(--af-pad-panel) py-2.5">
                      <span className={cn('inline-flex items-center gap-1.5 font-medium', TONE_TEXT[v.tone])}>
                        <Glyph size={14} weight="fill" aria-hidden />
                        {v.label}
                      </span>
                      {r.error && (
                        <p className="mt-1 max-w-md text-xs text-fg-2">
                          {r.error.message}
                          {r.error.code && <span className="ml-1 font-mono">({r.error.code})</span>}
                        </p>
                      )}
                      {!r.error && r.reason && <p className="mt-1 max-w-md text-xs text-fg-2">{r.reason}</p>}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {r.startedAt ? (
                        <time
                          dateTime={r.startedAt}
                          title={formatTimestamp(r.startedAt)}
                          className="text-fg-2"
                        >
                          {formatInZone(r.startedAt, s.timezone)}
                          <span className={cn('block text-xs', failed ? 'text-fg-2' : 'text-fg-3')}>
                            {formatRelative(r.startedAt, now)}
                          </span>
                        </time>
                      ) : (
                        <span className="text-fg-3">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-fg-2">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap text-fg-2 tabular-nums">
                      {elapsed(r.startedAt, r.endedAt, now) ?? '—'}
                    </td>
                    <td className="px-(--af-pad-panel) py-2.5">
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {r.artifact && (
                          <a
                            // No `download` attribute: the server's Content-Disposition saves the file, and a failure
                            // (expired file, missing role, signed out) opens the explained problem page instead of
                            // saving the error as the report.
                            href={r.artifact.href}
                            title={r.artifact.name}
                            aria-label={`Download ${r.artifact.name}${r.artifact.size !== null ? ` (${formatBytes(r.artifact.size)})` : ''}`}
                            className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-accent hover:underline"
                          >
                            <DownloadSimpleIcon size={14} aria-hidden />
                            {(r.artifact.name.split('.').pop() ?? 'file').toUpperCase()}
                            {r.artifact.size !== null && (
                              <span className="text-xs font-normal text-fg-3">
                                {formatBytes(r.artifact.size)}
                              </span>
                            )}
                          </a>
                        )}
                        {r.runId && (
                          <Link
                            to="/runs/$id"
                            params={{ id: r.runId }}
                            className="text-accent hover:underline"
                          >
                            Open run
                          </Link>
                        )}
                        {!r.artifact && !r.runId && <span className="text-fg-3">—</span>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && (
        <div className="flex justify-center border-t border-line p-3">
          <Button size="sm" pending={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Load older runs
          </Button>
        </div>
      )}
    </Panel>
  );
}

/** One schedule: identity, cadence with the next runs, the job, and its history with report downloads. */
export function SchedulePage({ scheduleKey, signedIn = false }: { scheduleKey: string; signedIn?: boolean }) {
  const navigate = useNavigate();
  const now = useNow(60_000);
  const q = useQuery(schedulesQuery);
  const s = q.data?.items.find((x) => x.key === scheduleKey);
  const { toast } = useToast();
  const announced = useRef(false);
  // Back from the Entra sign-in for this schedule: say it worked (once), then drop the marker from the address.
  useEffect(() => {
    if (!signedIn || !s || announced.current) return;
    announced.current = true;
    if (s.runsAs.kind === 'user' && s.runsAs.signIn === 'signed_in')
      toast({
        tone: 'ok',
        title: `Signed in for ${s.title}`,
        description: s.nextRunAt
          ? `It runs with your access from ${formatInZone(s.nextRunAt, s.timezone)}.`
          : 'It runs with your access once it is turned on.',
      });
    void navigate({ to: '/schedules/$key', params: { key: scheduleKey }, search: {}, replace: true });
  }, [signedIn, s, scheduleKey, navigate, toast]);
  useDocumentTitle(s?.title ?? 'Schedule');
  const crumbs = [{ label: 'Schedules', href: '/schedules' }, { label: s?.title ?? scheduleKey }];

  if (q.isError)
    return (
      <>
        <PageHeader breadcrumbs={crumbs} linkAs={RouterLink} eyebrow="Schedule" title={scheduleKey} />
        <Panel>
          <QueryError title="Schedules didn’t load" error={q.error} onRetry={() => void q.refetch()} />
        </Panel>
      </>
    );
  if (q.isPending)
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <Skeleton className="h-8 w-96" />
        <SkeletonText lines={3} />
      </div>
    );
  if (!s)
    return (
      <>
        <PageHeader breadcrumbs={crumbs} linkAs={RouterLink} eyebrow="Schedule" title="Schedule not found" />
        <Panel>
          <EmptyState title={`There’s no schedule called “${scheduleKey}”`}>
            It may have been removed from content, or the link is mistyped.
          </EmptyState>
        </Panel>
      </>
    );

  const upcoming = s.enabled ? nextRuns(s.cron, s.timezone, 5, new Date(now)) : [];
  const last = lastRunView(s);
  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        linkAs={RouterLink}
        eyebrow={`Schedule · ${JOB_LABEL[s.job.kind] ?? s.job.kind}`}
        title={s.title}
        description={s.summary ?? undefined}
        meta={
          <>
            <StatusPill status={s.enabled ? 'ok' : 'neutral'}>
              {s.enabled ? 'Enabled' : 'Disabled'}
            </StatusPill>
            {s.writeCapable && <Badge tone="outline">Changes tenant</Badge>}
            <Badge>
              {s.source === 'portal'
                ? `Created in the portal${s.createdBy ? ` by ${s.createdBy}` : ''}`
                : 'From content'}
            </Badge>
          </>
        }
        actions={
          <>
            <ScheduleToggle schedule={s} withLabel />
            <RunNowButton schedule={s} size="md" />
            {s.canManage && s.job.kind === 'report' && s.job.ref && (
              <>
                <Link
                  to="/reports"
                  search={{ report: s.job.ref, edit: s.key }}
                  className={button({ intent: 'secondary' })}
                >
                  <PencilSimpleIcon size={14} aria-hidden />
                  Edit
                </Link>
                <DeleteScheduleButton
                  schedule={s}
                  size="md"
                  onDeleted={() => void navigate({ to: '/schedules' })}
                />
              </>
            )}
          </>
        }
      />
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 xl:col-span-2">
          <SignInCallout s={s} />
          {last.tone === 'crit' && (
            <Callout tone="crit" role="alert" title="The last run failed">
              {s.runsAs.kind === 'user' ? (
                <>
                  Check the error in the history below. It runs with {s.runsAs.name ?? 'its creator'}’s own
                  access, so a missing permission means their roles or the Read app’s permissions changed.
                </>
              ) : (
                <>
                  Check the error in the history below. If it says a permission is missing, the{' '}
                  {s.runsAs.kind === 'app' ? `app identity ${s.runsAs.name}` : 'automation identity'} needs
                  that application permission — run{' '}
                  <code className="font-mono text-xs">pnpm adminforge validate --scopes</code>.
                </>
              )}
            </Callout>
          )}
          <History s={s} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Callout
            tone="neutral"
            icon={s.runsAs.kind === 'user' ? <UserIcon size={18} /> : <RobotIcon size={18} />}
            title={runsAsSentence(s.runsAs)}
          >
            {s.runsAs.kind === 'user'
              ? 'It reads only what its creator can see, with their read-only access, and never changes anything. Only they (and portal administrators) can open its files. It stops when they lose access to AdminForge.'
              : s.runsAs.kind === 'app'
                ? `Not as you, and not as whoever enabled it: the application permissions of app identity ${s.runsAs.name} decide what it can read and change.`
                : 'Not as you, and not as whoever enabled it: the automation identity’s application permissions decide what it can read and change.'}
            {s.approvedBy.length > 0 && (
              <span className="mt-1 block">Approved by {s.approvedBy.join(', ')}.</span>
            )}
          </Callout>
          <Panel eyebrow="Cadence" title="When it runs">
            <div className="flex flex-col gap-4">
              {/* The sentence wraps here (a panel title would cut it off). */}
              <p className="text-sm font-medium text-fg">{cadenceOf(s)}</p>
              <Facts
                items={[
                  [
                    'Cron',
                    <code key="c" className="font-mono text-xs">
                      {s.cron}
                    </code>,
                  ],
                  ['Time zone', s.timezone.replace(/_/g, ' ')],
                  [
                    'Last run',
                    s.lastRunAt
                      ? `${formatInZone(s.lastRunAt, s.timezone)} · ${last.label.toLowerCase()}`
                      : 'Never',
                  ],
                ]}
              />
              <div className="flex flex-col gap-2">
                <p className="af-eyebrow">Next runs</p>
                {upcoming.length === 0 ? (
                  <p className="text-sm text-fg-3">
                    {s.enabled ? 'The cron expression has no future runs.' : 'Disabled: no runs scheduled.'}
                  </p>
                ) : (
                  <ol className="flex flex-col gap-1">
                    {upcoming.map((d) => (
                      <li
                        key={d.toISOString()}
                        className="flex justify-between gap-3 font-mono text-xs text-fg-2 tabular-nums"
                      >
                        <time dateTime={d.toISOString()}>{formatInZone(d, s.timezone)}</time>
                        <span className="text-fg-3">{formatRelative(d, now)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          </Panel>
          <Panel eyebrow="Job" title={JOB_LABEL[s.job.kind] ?? s.job.kind}>
            <Facts
              items={[
                ['Runs', <JobRef key="j" s={s} />],
                [
                  'Key',
                  <code key="k" className="font-mono text-xs">
                    {s.key}
                  </code>,
                ],
              ]}
            />
          </Panel>
        </div>
      </div>
    </>
  );
}

/**
 * A schedule that runs with its creator's access needs their sign-in for it (ADR-014): before the first run, and again
 * when Microsoft asks (password reset, sign-in policy, a long break). Only the creator can sign in for it.
 */
function SignInCallout({ s }: { s: ScheduleItem }) {
  const signIn = useMutation({
    mutationFn: () => scheduleSignInUrl(s.key, scheduleSignInReturn(s.key)),
    onSuccess: (url) => browser.assign(url),
  });
  const r = s.runsAs;
  if (r.kind !== 'user' || r.signIn === 'signed_in') return null;
  const again = r.signIn === 'needs_sign_in';
  const err = signIn.error;
  const who = r.name ?? 'its creator';
  return (
    <Callout
      tone="warn"
      title={again ? 'Needs sign-in' : 'Not signed in yet'}
      action={
        r.canSignIn ? (
          <Button size="sm" pending={signIn.isPending} onClick={() => signIn.mutate()}>
            {again ? 'Sign in again' : 'Sign in'}
          </Button>
        ) : undefined
      }
    >
      {r.canSignIn
        ? again
          ? 'Microsoft asked for a new sign-in, so runs are skipped until you sign in for this schedule again. Your own session stays as it is.'
          : 'It runs with your own access once you sign in for it. Until then it doesn’t run. Your own session stays as it is.'
        : again
          ? `Microsoft asked ${who} to sign in again, so runs are skipped. Ask them to open this schedule and sign in. A portal administrator can turn it off or delete it.`
          : `It runs with ${who}’s own access once they sign in for it. Ask them to open this schedule and sign in. A portal administrator can turn it off or delete it.`}
      {err && (
        <span role="alert" className="mt-2 flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 font-medium text-crit">
            <WarningCircleIcon size={14} weight="fill" aria-hidden />
            {err.message}
          </span>
          {err instanceof ApiRequestError && err.hint && <span className="text-fg-2">{err.hint}</span>}
          {err instanceof ApiRequestError && err.correlationId && (
            <span className="font-mono text-xs text-fg-2">Reference {err.correlationId}</span>
          )}
        </span>
      )}
    </Callout>
  );
}
