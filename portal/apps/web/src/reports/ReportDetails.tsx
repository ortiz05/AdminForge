import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowSquareOutIcon,
  Badge,
  button,
  Button,
  CalendarBlankIcon,
  cn,
  DownloadSimpleIcon,
  Drawer,
  formatRelative,
  formatTimestamp,
  LockKeyIcon,
  PencilSimpleIcon,
  Skeleton,
  StatusPill,
} from '@adminforge/ui';
import { AppLink } from '../lib/links';
import { formatInZone, nextRuns } from '../ops/cron';
import { DeleteScheduleButton, RunNowButton, ScheduleToggle } from '../ops/ScheduleControls';
import { lastRunView, scheduleRunsPage, type ScheduleItem } from '../ops/schedules';
import { Facts, formatBytes, QueryError } from '../ops/ui';
import {
  SCHEDULE_FORM_DESCRIPTION,
  ScheduleFormFields,
  ScheduleFormFooter,
  scheduleFormTitle,
} from './ScheduleForm';
import {
  cadenceText,
  FORMAT_LABEL,
  paramDefaultText,
  reportDetailQuery,
  type ReportItem,
  type ScheduleSummary,
} from './catalog';

/** API names as engineers say them. */
const API_LABEL: Record<string, string> = {
  graph: 'Microsoft Graph',
  arm: 'Azure Resource Manager',
  logAnalytics: 'Log Analytics',
  exchange: 'Exchange Online',
  sharepoint: 'SharePoint',
  defender: 'Microsoft Defender',
};

/** "graph" → "Microsoft Graph"; "connections.billing-api" → "Connection billing-api"; anything else as given. */
const apiLabel = (api: string) =>
  API_LABEL[api] ?? (api.startsWith('connections.') ? `Connection ${api.slice('connections.'.length)}` : api);

/** The schedule controls (toggle, run now) take a ScheduleItem; a report schedule is read-only and never writes. */
export function summaryAsItem(s: ScheduleSummary, ref: string): ScheduleItem {
  return {
    ...s,
    summary: null,
    identity:
      s.runsAs.kind === 'user' ? 'user' : s.runsAs.kind === 'app' ? `app:${s.runsAs.name}` : 'automation',
    job: { kind: 'report', ref, params: null },
    writeCapable: false,
    approvedBy: [],
    delivery: [],
    notify: [],
  };
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = `report-section-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={id} className="af-eyebrow">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The newest file a schedule wrote, from its run history. */
function LatestFile({ scheduleKey }: { scheduleKey: string }) {
  const q = useQuery({
    queryKey: ['schedule-runs', scheduleKey, 'latest'] as const,
    queryFn: ({ signal }) => scheduleRunsPage(scheduleKey, null, signal),
    staleTime: 30_000,
  });
  const artifact = q.data?.items.find((r) => r.artifact)?.artifact;
  if (!artifact) return null;
  const ext = (artifact.name.split('.').pop() ?? 'file').toUpperCase();
  return (
    // No `download` attribute: the server's Content-Disposition saves the file, and a failure (expired file, missing
    // role) opens the explained problem page instead of saving the error as the report.
    <a
      href={artifact.href}
      title={artifact.name}
      aria-label={`Download the latest file, ${artifact.name}${artifact.size !== null ? ` (${formatBytes(artifact.size)})` : ''}`}
      className={button({ intent: 'ghost', size: 'sm' })}
    >
      <DownloadSimpleIcon size={12} aria-hidden />
      Latest {ext}
      {artifact.size !== null && <span className="font-normal text-fg-3">{formatBytes(artifact.size)}</span>}
    </a>
  );
}

function ScheduleRow({
  s,
  reportKey,
  now,
  operator,
  onEdit,
}: {
  s: ScheduleSummary;
  reportKey: string;
  now: number;
  operator: boolean;
  onEdit: (key: string) => void;
}) {
  const item = summaryAsItem(s, reportKey);
  const next = s.enabled
    ? s.nextRunAt && Date.parse(s.nextRunAt) > now
      ? new Date(s.nextRunAt)
      : (nextRuns(s.cron, s.timezone, 1, new Date(now))[0] ?? null)
    : null;
  const last = lastRunView(s);
  return (
    <li className="flex flex-col gap-2.5 rounded-md border border-line bg-raised px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Link
            to="/schedules/$key"
            params={{ key: s.key }}
            className="truncate font-medium text-fg underline-offset-2 hover:underline"
            title={s.title}
          >
            {s.title}
          </Link>
          <p className="text-sm text-fg-2">{cadenceText(s)}</p>
          <p className="truncate font-mono text-2xs text-fg-3">
            {s.cron} · {s.timezone}
          </p>
        </div>
        <ScheduleToggle schedule={item} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-fg-3">
        <span>
          Next run{' '}
          {next ? (
            <time dateTime={next.toISOString()} title={formatTimestamp(next)} className="text-fg-2">
              {formatInZone(next, s.timezone)} · {formatRelative(next, now)}
            </time>
          ) : (
            <span className="text-fg-2">{s.enabled ? 'not scheduled' : 'paused'}</span>
          )}
        </span>
        <span className="inline-flex items-center gap-1.5">
          Last run
          <StatusPill status={last.tone} size="sm">
            {last.label}
          </StatusPill>
          {s.lastRunAt && (
            <time dateTime={s.lastRunAt} title={formatTimestamp(s.lastRunAt)}>
              {formatRelative(s.lastRunAt, now)}
            </time>
          )}
        </span>
        <Badge tone="outline" className="max-w-full font-medium">
          <span className="truncate">
            {s.source === 'portal' ? `Created by ${s.createdBy ?? 'someone in the portal'}` : 'Content'}
          </span>
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <RunNowButton schedule={item} />
        <LatestFile scheduleKey={s.key} />
        {operator && s.canManage && (
          <>
            <Button
              size="sm"
              intent="ghost"
              onClick={() => onEdit(s.key)}
              aria-label={`Edit ${s.title}`}
              data-return-focus={`edit:${s.key}`}
            >
              <PencilSimpleIcon size={12} aria-hidden />
              Edit
            </Button>
            <DeleteScheduleButton schedule={s} />
          </>
        )}
      </div>
    </li>
  );
}

const list = (items: string[]) => (items.length ? items.join(', ') : <span className="text-fg-3">None</span>);

function Body({
  report,
  operator,
  now,
  onSchedule,
  onEdit,
  onTag,
  activeTags,
}: {
  report: ReportItem;
  operator: boolean;
  now: number;
  onSchedule: () => void;
  onEdit: (key: string) => void;
  onTag: (tag: string) => void;
  activeTags: string[];
}) {
  const detail = useQuery(reportDetailQuery(report.key));
  const columns = detail.data?.columns;
  const scopes = Object.entries(report.requires.scopes);
  const shownParams = report.params;
  const scheduleLocked = !report.schedulable
    ? 'This report has no export, so it can’t be scheduled.'
    : undefined;
  return (
    <div className="flex flex-col gap-5">
      {report.summary ? (
        <p className="text-sm text-fg-2">{report.summary}</p>
      ) : (
        <p className="text-sm text-fg-3">This report has no summary. Open it to see what it covers.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <AppLink href={report.href} className={button({ intent: 'primary' })}>
          Open report
          <ArrowSquareOutIcon size={14} aria-hidden />
        </AppLink>
        {operator ? (
          <Button onClick={onSchedule} locked={scheduleLocked} data-return-focus="schedule">
            {!scheduleLocked && <CalendarBlankIcon size={14} aria-hidden />}
            Schedule
          </Button>
        ) : (
          <p className="text-xs text-fg-3">Scheduling a report needs the Portal Operator role.</p>
        )}
      </div>
      {report.tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
          {report.tags.map((t) => (
            <li key={t}>
              <button
                type="button"
                onClick={() => onTag(t)}
                aria-pressed={activeTags.includes(t)}
                aria-label={`Show reports tagged ${t}`}
                className={cn(
                  'inline-flex h-5 items-center rounded-sm border px-1.5 font-mono text-2xs text-fg-2',
                  'transition-colors duration-(--af-motion-fast) hover:border-line-strong hover:text-fg',
                  activeTags.includes(t) ? 'border-accent bg-accent-subtle text-accent' : 'border-line',
                )}
              >
                {t}
              </button>
            </li>
          ))}
        </ul>
      )}

      <Section
        title="Schedules"
        aside={
          report.schedules.length > 0 && (
            <span className="text-xs text-fg-3 tabular-nums">
              {report.schedules.filter((s) => s.enabled).length} of {report.schedules.length} enabled
            </span>
          )
        }
      >
        {report.schedules.length === 0 ? (
          <p className="text-sm text-fg-3">
            Not scheduled.{' '}
            {report.schedulable
              ? 'Schedule it to get the file on a cadence, by email or in Teams.'
              : 'It has no export, so it can only be opened.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label={`Schedules of ${report.title}`}>
            {report.schedules.map((s) => (
              <ScheduleRow
                key={s.key}
                s={s}
                reportKey={report.key}
                now={now}
                operator={operator}
                onEdit={onEdit}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Requirements">
        <Facts
          items={[
            [
              'Licences',
              report.requires.licences.length ? (
                <span key="l" className="font-mono text-xs">
                  {report.requires.licences.join(', ')}
                </span>
              ) : (
                list([])
              ),
            ],
            ['Entra roles', list(report.requires.entraRoles)],
            ['Portal roles', list(report.requires.portalRoles)],
            ...scopes.map(([api, perms]): [string, ReactNode] => [
              apiLabel(api),
              <span key={api} className="font-mono text-xs">
                {perms.join(', ')}
              </span>,
            ]),
          ]}
        />
      </Section>

      {shownParams.length > 0 && (
        <Section title="Parameters">
          <Facts
            items={shownParams.map((p): [ReactNode, ReactNode] => [
              p.label,
              <span key={p.name} className="text-fg-2">
                {paramDefaultText(p)}
              </span>,
            ])}
          />
        </Section>
      )}

      <Section title="Export">
        <Facts
          items={[
            [
              'Formats',
              report.exportFormats.length
                ? report.exportFormats.map((f) => FORMAT_LABEL[f] ?? f.toUpperCase()).join(', ')
                : 'No export',
            ],
            [
              'Columns',
              detail.isError ? (
                <QueryError
                  key="c"
                  compact
                  title="Columns didn’t load"
                  error={detail.error}
                  onRetry={() => void detail.refetch()}
                />
              ) : !columns ? (
                <Skeleton key="c" className="h-4 w-48" />
              ) : columns.length === 0 ? (
                <span key="c" className="text-fg-3">
                  Set when the report runs
                </span>
              ) : (
                <ul key="c" className="flex flex-wrap gap-1" aria-label="Export columns">
                  {columns.map((c) => (
                    <li key={c.field}>
                      <Badge title={c.field}>{c.label}</Badge>
                    </li>
                  ))}
                </ul>
              ),
            ],
          ]}
        />
      </Section>
    </div>
  );
}

/**
 * Details of one report (`?report=<key>`), docked beside the catalogue like the inspector: what it covers, open or
 * schedule it, its schedules with their controls and latest file, requirements, parameters and export columns.
 */
export function ReportDetails({
  reportKey,
  known,
  areaLabel,
  catalogPending,
  operator,
  now,
  form,
  onClose,
  onSchedule,
  onEdit,
  onFormDone,
  onFormCancel,
  onTag,
  activeTags,
}: {
  reportKey: string | undefined;
  /** The report from the catalogue; read from GET /api/reports/:key otherwise (a shared link to one you can't see). */
  known: ReportItem | undefined;
  areaLabel: (area: string) => string;
  catalogPending: boolean;
  operator: boolean;
  now: number;
  /** The schedule form replaces the details (a new schedule, or editing `editKey`). */
  form: { editKey?: string } | null;
  onClose: () => void;
  onSchedule: () => void;
  onEdit: (scheduleKey: string) => void;
  onFormDone: () => void;
  onFormCancel: () => void;
  onTag: (tag: string) => void;
  activeTags: string[];
}) {
  const detail = useQuery({
    ...reportDetailQuery(reportKey ?? ''),
    enabled: Boolean(reportKey && !known && !catalogPending),
  });
  const report = known ?? detail.data;
  const formId = useId();
  const inForm = Boolean(form && report && reportKey);

  // Back from the form: focus returns to the button that opened it (Schedule, or that schedule's Edit).
  const bodyRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<string | null>(null);
  const wasInForm = useRef(inForm);
  const formTarget = form?.editKey ? `edit:${form.editKey}` : 'schedule';
  useEffect(() => {
    if (inForm) returnTo.current = formTarget;
    else if (wasInForm.current && returnTo.current)
      bodyRef.current
        ?.querySelector<HTMLElement>(`[data-return-focus="${CSS.escape(returnTo.current)}"]`)
        ?.focus();
    wasInForm.current = inForm;
  }, [inForm, formTarget]);

  return (
    <Drawer
      open={Boolean(reportKey)}
      onOpenChange={(o) => !o && (inForm ? onFormCancel() : onClose())}
      modal={false}
      docked
      className="w-160"
      eyebrow={report ? `${areaLabel(report.area)} · ${inForm ? 'Schedule' : 'Report'}` : 'Report'}
      title={
        report && inForm
          ? scheduleFormTitle(report, form?.editKey)
          : (report?.title ?? (detail.isError ? 'Report not available' : 'Loading…'))
      }
      description={
        report && inForm ? (
          SCHEDULE_FORM_DESCRIPTION
        ) : report ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
            <code className="font-mono text-fg-2">{report.key}</code>
            {report.version && <span>v{report.version}</span>}
            {report.owner && <span>· {report.owner}</span>}
            {report.badge && (
              <span
                className="inline-flex h-5 items-center gap-1 rounded-sm border border-line px-1.5 text-2xs font-medium"
                title={report.badge}
              >
                <LockKeyIcon size={10} weight="bold" aria-hidden />
                {report.badge}
              </span>
            )}
          </span>
        ) : undefined
      }
      footer={
        report && inForm ? (
          <ScheduleFormFooter
            report={report}
            editKey={form?.editKey}
            formId={formId}
            onCancel={onFormCancel}
          />
        ) : undefined
      }
    >
      <div ref={bodyRef}>
        {report && inForm ? (
          <ScheduleFormFields
            key={form?.editKey ?? 'new'}
            report={report}
            editKey={form?.editKey}
            formId={formId}
            onDone={onFormDone}
          />
        ) : report && reportKey ? (
          <Body
            key={report.key}
            report={report}
            operator={operator}
            now={now}
            onSchedule={onSchedule}
            onEdit={onEdit}
            onTag={onTag}
            activeTags={activeTags}
          />
        ) : detail.isError ? (
          <QueryError compact title="This report isn’t available" error={detail.error} />
        ) : (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton shape="block" className="h-32 w-full" />
          </div>
        )}
      </div>
    </Drawer>
  );
}
