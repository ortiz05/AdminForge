import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  CalendarBlankIcon,
  Checkbox,
  cn,
  EmptyState,
  field,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  TextField,
  useToast,
} from '@adminforge/ui';
import { ApiRequestError } from '../lib/api';
import {
  CadenceFields,
  cronFor,
  DEFAULT_CRON_PARTS,
  defaultZone,
  partsFromCron,
  zoneOptions,
} from '../ops/cadence';
import { describeCron, formatInZone, nextRuns } from '../ops/cron';
import { schedulesQuery, type ScheduleItem } from '../ops/schedules';
import { Callout, QueryError } from '../ops/ui';
import {
  defaultScheduleTitle,
  deliveryOptionsQuery,
  FORMAT_LABEL,
  formatsFor,
  formIssues,
  formValuesFromSchedule,
  paramDefault,
  paramDefaultText,
  REPORT_CADENCES,
  saveReportSchedule,
  scheduleRequest,
  type ReportFormat,
  type ReportItem,
  type ReportParam,
  type ScheduleFormState,
} from './catalog';

const NONE = 'none';

function initialState(report: ReportItem, existing: ScheduleItem | undefined): ScheduleFormState {
  const formats = formatsFor(report);
  if (existing) {
    return {
      title: existing.title,
      titleEdited: true,
      cron: partsFromCron(existing.cron, REPORT_CADENCES),
      timezone: existing.timezone,
      ...formValuesFromSchedule(report, existing),
    };
  }
  return {
    title: defaultScheduleTitle(report, DEFAULT_CRON_PARTS.cadence),
    titleEdited: false,
    cron: DEFAULT_CRON_PARTS,
    timezone: defaultZone(),
    params: Object.fromEntries(report.params.map((p) => [p.name, paramDefault(p)])),
    format: formats[0]!,
    retain: '26',
    emailKey: '',
    teamsKey: '',
    alertEmailKey: '',
    alertTeamsKey: '',
  };
}

/** "Runs every Monday at 06:00 UTC · next Mon 19 Oct, 06:00". */
function Preview({ cron, timezone }: { cron: string; timezone: string }) {
  const next = useMemo(() => nextRuns(cron, timezone, 1)[0], [cron, timezone]);
  const text = describeCron(cron, timezone);
  return (
    <p
      aria-live="polite"
      className={cn(
        'flex min-h-(--af-control-h) items-center gap-2 rounded-(--af-input-radius) border border-line bg-raised px-2.5 py-1.5 text-sm',
        next ? 'text-fg-2' : 'text-crit',
      )}
    >
      <CalendarBlankIcon size={14} aria-hidden className="shrink-0 text-fg-3" />
      {next ? (
        <span>
          {text.startsWith('Custom:')
            ? `Runs on a custom schedule (${cron})`
            : `Runs ${text[0]!.toLowerCase()}${text.slice(1)}`}
          <span className="text-fg-3"> · next {formatInZone(next, timezone)}</span>
        </span>
      ) : (
        <span>Not a valid cron expression yet.</span>
      )}
    </p>
  );
}

function Group({ legend, children, hint }: { legend: string; children: ReactNode; hint?: string }) {
  return (
    <div className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="af-eyebrow mb-3">{legend}</legend>
        {hint && <p className="-mt-1 text-xs text-fg-3">{hint}</p>}
        {children}
      </fieldset>
    </div>
  );
}

/** One schedulable param: enum → select (checkboxes when several may be picked), boolean → switch, number, text. */
function ParamControl({
  p,
  value,
  onChange,
  error,
}: {
  p: ReportParam;
  value: unknown;
  onChange: (v: unknown) => void;
  error?: string;
}) {
  const f = field();
  const hint = p.description ?? undefined;
  if (p.type === 'enum' && p.values) {
    if (p.multiple) {
      const selected = Array.isArray(value) ? value : [];
      return (
        <fieldset className={f.root()} aria-describedby={error ? `${p.name}-error` : undefined}>
          <legend className={cn(f.label(), 'mb-1.5')}>{p.label}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {p.values.map((o) => (
              <Checkbox
                key={String(o.value)}
                label={o.label}
                checked={selected.includes(o.value)}
                onCheckedChange={(on) =>
                  onChange(
                    on
                      ? p
                          .values!.filter((x) => x.value === o.value || selected.includes(x.value))
                          .map((x) => x.value)
                      : selected.filter((x) => x !== o.value),
                  )
                }
              />
            ))}
          </div>
          {error && (
            <p id={`${p.name}-error`} className={f.error()}>
              {error}
            </p>
          )}
          {hint && <p className={f.hint()}>{hint}</p>}
        </fieldset>
      );
    }
    const options = p.values.map((o) => ({ value: String(o.value), label: o.label }));
    return (
      <Select
        label={p.label}
        hint={hint}
        error={error}
        value={value === null || value === undefined ? '' : String(value)}
        placeholder={p.required ? 'Choose…' : 'Report default'}
        onValueChange={(v) => onChange(p.values!.find((o) => String(o.value) === v)?.value ?? v)}
        options={options}
      />
    );
  }
  if (p.type === 'boolean')
    return (
      <div className="flex min-h-(--af-control-h) items-end pb-1.5">
        <Switch label={p.label} description={hint} checked={value === true} onCheckedChange={onChange} />
      </div>
    );
  if (p.type === 'number')
    return (
      <TextField
        label={p.label}
        type="number"
        inputMode="decimal"
        min={p.min ?? undefined}
        max={p.max ?? undefined}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
        hint={
          hint ??
          (p.min !== null && p.max !== null
            ? `${p.min} to ${p.max}`
            : p.min !== null
              ? `${p.min} or more`
              : p.max !== null
                ? `${p.max} or less`
                : undefined)
        }
        error={error}
        optional={!p.required}
      />
    );
  return (
    <TextField
      label={p.label}
      value={typeof value === 'string' ? value : value == null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
      hint={hint}
      error={error}
      optional={!p.required}
    />
  );
}

function FormBody({
  report,
  existing,
  formId,
  onDone,
}: {
  report: ReportItem;
  existing: ScheduleItem | undefined;
  formId: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => initialState(report, existing));
  const [submitted, setSubmitted] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const delivery = useQuery(deliveryOptionsQuery);
  const formats = formatsFor(report);
  const settable = report.params.filter((p) => p.schedulable);
  const fixed = report.params.filter((p) => !p.schedulable);
  const expr = cronFor(form.cron);
  const issues = formIssues(report, form);
  const shownIssues = submitted ? issues : {};

  const save = useMutation({
    mutationKey: SAVE_KEY,
    mutationFn: () => saveReportSchedule(scheduleRequest(report, form), existing?.key),
    onSuccess: () => {
      toast({
        tone: 'ok',
        title: existing ? 'Schedule saved' : 'Schedule created',
        description: existing
          ? `${form.title.trim()} runs with the new settings from its next due time.`
          : `${form.title.trim()} runs from its next due time, as the automation identity.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
    },
  });
  // The last attempt's refusal stays until the form changes.
  const set = (patch: Partial<ScheduleFormState>) => {
    if (save.isError) save.reset();
    setForm((f) => ({ ...f, ...patch }));
  };
  const setCron = (cron: ScheduleFormState['cron']) => {
    if (save.isError) save.reset();
    setForm((f) => ({
      ...f,
      cron,
      title: f.titleEdited ? f.title : defaultScheduleTitle(report, cron.cadence),
    }));
  };

  // The form opens with the name focused (the sheet switched from the details to the form).
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  useEffect(() => {
    if (save.isError) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [save.isError, save.error]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(issues).length || save.isPending) return;
    // Only while the form is still open: a save that finishes after Cancel doesn't navigate again.
    save.mutate(undefined, { onSuccess: () => onDone() });
  };

  const email = delivery.data?.email;
  const teams = delivery.data?.teams;
  const emailOptions = [
    { value: NONE, label: 'Don’t email' },
    ...(email?.lists ?? []).map((l) => ({ value: l.key, label: l.label })),
  ];
  const teamsOptions = [
    { value: NONE, label: 'Don’t post' },
    ...(teams?.lists ?? []).map((l) => ({ value: l.key, label: l.label })),
  ];
  // A key saved on the schedule stays selectable even if the installation no longer lists it.
  const withSaved = (options: typeof emailOptions, key: string) =>
    key && !options.some((o) => o.value === key) ? [...options, { value: key, label: key }] : options;
  const emailReady = Boolean(email?.available && email.lists.length);
  const err = save.error;
  // A refused cadence also shows on the cadence fields, where it gets fixed.
  const cronRefused =
    err instanceof ApiRequestError && (err.code === 'cron_too_frequent' || err.code === 'invalid_cron')
      ? err.message
      : undefined;

  return (
    <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-5 pb-4">
      <Group legend="When">
        <TextField
          ref={nameRef}
          label="Name"
          value={form.title}
          maxLength={120}
          onChange={(e) => set({ title: e.target.value, titleEdited: true })}
          error={shownIssues.title}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <CadenceFields
            value={form.cron}
            onChange={setCron}
            cadences={REPORT_CADENCES}
            customClassName="sm:col-span-2"
            error={shownIssues.cron ?? cronRefused}
          />
        </div>
        <div className="grid items-end gap-3 sm:grid-cols-3">
          <Select
            label="Time zone"
            value={form.timezone}
            onValueChange={(timezone) => set({ timezone })}
            options={zoneOptions(form.timezone)}
          />
          <div className="sm:col-span-2">
            <Preview cron={expr} timezone={form.timezone} />
          </div>
        </div>
      </Group>

      {report.params.length > 0 && (
        <Group legend="Parameters" hint="Anything you leave as it is follows the report’s default.">
          {settable.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {settable.map((p) => (
                <ParamControl
                  key={p.name}
                  p={p}
                  value={form.params[p.name]}
                  onChange={(v) => set({ params: { ...form.params, [p.name]: v } })}
                  error={shownIssues[`param.${p.name}`]}
                />
              ))}
            </div>
          )}
          {fixed.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm" aria-label="Parameters that use the report’s default">
              {fixed.map((p) => (
                <li key={p.name} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-fg">{p.label}</span>
                  <span className="text-xs text-fg-3">
                    uses the report’s default ({paramDefaultText(p).toLowerCase()})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Group>
      )}

      <Group legend="File">
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <div className={field().root()}>
            <span className={field().label()} aria-hidden>
              Format
            </span>
            <SegmentedControl
              aria-label="Format"
              value={form.format}
              onValueChange={(v) => set({ format: v as ReportFormat })}
              options={formats.map((f) => ({ value: f, label: FORMAT_LABEL[f] ?? f }))}
              className="self-start"
            />
          </div>
          <TextField
            label="Keep the newest"
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            value={form.retain}
            onChange={(e) => set({ retain: e.target.value })}
            hint="files; older ones are deleted"
            error={shownIssues.retain}
          />
        </div>
      </Group>

      <Group legend="Delivery">
        {delivery.isError ? (
          <QueryError compact title="Delivery options didn’t load" error={delivery.error} />
        ) : delivery.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
            <Skeleton className="h-(--af-control-h) w-full" />
            <Skeleton className="h-(--af-control-h) w-full" />
          </div>
        ) : (
          <div className="grid items-start gap-3 sm:grid-cols-2">
            {email?.available ? (
              <Select
                label="Email the file to"
                value={form.emailKey || NONE}
                onValueChange={(v) => set({ emailKey: v === NONE ? '' : v })}
                options={withSaved(emailOptions, form.emailKey)}
                hint={emailReady ? undefined : 'No recipient lists are configured yet.'}
              />
            ) : (
              <div className={field().root()}>
                <span className={field().label()}>Email</span>
                <p className="text-xs text-fg-3">
                  Email isn’t set up on this installation, so the file is kept here and can be posted to
                  Teams. A portal administrator can configure a mail sender.
                </p>
              </div>
            )}
            <Select
              label="Post to Teams"
              value={form.teamsKey || NONE}
              onValueChange={(v) => set({ teamsKey: v === NONE ? '' : v })}
              options={withSaved(teamsOptions, form.teamsKey)}
              hint={teams?.lists.length ? undefined : 'No Teams channels are configured yet.'}
            />
          </div>
        )}
      </Group>

      <Group legend="If a run fails">
        {delivery.isSuccess && (
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Select
              label="Alert by email"
              value={form.alertEmailKey || NONE}
              onValueChange={(v) => set({ alertEmailKey: v === NONE ? '' : v })}
              options={withSaved(
                emailOptions.map((o) => (o.value === NONE ? { ...o, label: 'No email alert' } : o)),
                form.alertEmailKey,
              )}
              disabled={!email?.available}
            />
            <Select
              label="Alert in Teams"
              value={form.alertTeamsKey || NONE}
              onValueChange={(v) => set({ alertTeamsKey: v === NONE ? '' : v })}
              options={withSaved(
                teamsOptions.map((o) => (o.value === NONE ? { ...o, label: 'No Teams alert' } : o)),
                form.alertTeamsKey,
              )}
            />
          </div>
        )}
        <p className="text-xs text-fg-3">
          Failed runs are retried twice and always show in the schedule’s history.
        </p>
      </Group>

      {err && (
        <div ref={errorRef}>
          <Callout tone="crit" role="alert" title={err.message}>
            {err instanceof ApiRequestError && err.hint}
            {err instanceof ApiRequestError && err.correlationId && (
              <span className="mt-1 block font-mono text-xs text-fg-2">Reference {err.correlationId}</span>
            )}
            {!(err instanceof ApiRequestError) && 'Try again; if it keeps happening, reload the page.'}
          </Callout>
        </div>
      )}
    </form>
  );
}

const SAVE_KEY = ['reports', 'schedule-save'] as const;

/** Whether `editKey` names a schedule of this report the caller may change (from GET /api/schedules). */
function useEditable(report: ReportItem, editKey: string | undefined) {
  const schedules = useQuery({ ...schedulesQuery, enabled: Boolean(editKey) });
  const existing = editKey ? schedules.data?.items.find((s) => s.key === editKey) : undefined;
  const editable = !editKey || Boolean(existing?.canManage && existing.job.ref === report.key);
  return { schedules, existing, editable };
}

/** The sheet title in form mode. */
export function scheduleFormTitle(report: ReportItem, editKey: string | undefined): string {
  if (!editKey) return `Schedule ${report.title}`;
  const title = report.schedules.find((s) => s.key === editKey)?.title;
  return title ? `Edit ${title}` : 'Edit schedule';
}

export const SCHEDULE_FORM_DESCRIPTION =
  'Runs as the automation identity, at most once an hour, from its next due time. Recipients come from this installation’s configuration.';

/**
 * The report schedule form (`?schedule=new` or `?edit=<key>`), shown in the report's side sheet in place of its
 * details (like the playbook form). Editing reads the schedule from GET /api/schedules (its params and delivery) and
 * is only offered when the API says `canManage`. The sheet's footer holds the buttons (ScheduleFormFooter).
 */
export function ScheduleFormFields({
  report,
  editKey,
  formId,
  onDone,
}: {
  report: ReportItem;
  editKey: string | undefined;
  formId: string;
  onDone: () => void;
}) {
  const { schedules, existing, editable } = useEditable(report, editKey);
  if (!editKey) return <FormBody report={report} existing={undefined} formId={formId} onDone={onDone} />;
  if (editable && existing)
    return (
      <FormBody key={existing.key} report={report} existing={existing} formId={formId} onDone={onDone} />
    );
  if (schedules.isError)
    return (
      <QueryError
        compact
        title="Schedules didn’t load"
        error={schedules.error}
        onRetry={() => void schedules.refetch()}
      />
    );
  if (schedules.isPending)
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  return (
    <EmptyState compact title="This schedule can’t be edited here">
      {existing
        ? existing.source === 'content'
          ? 'It is defined in content: change its YAML and publish it.'
          : 'Only the person who created it or a Portal Admin can change it.'
        : 'It may have been deleted, or the link points to another report.'}
    </EmptyState>
  );
}

export function ScheduleFormFooter({
  report,
  editKey,
  formId,
  onCancel,
}: {
  report: ReportItem;
  editKey: string | undefined;
  formId: string;
  onCancel: () => void;
}) {
  const { existing, editable } = useEditable(report, editKey);
  const saving = useIsMutating({ mutationKey: SAVE_KEY }) > 0;
  if (!editable || (editKey && !existing))
    return (
      <Button intent="ghost" onClick={onCancel}>
        Back to the report
      </Button>
    );
  return (
    <>
      <Button intent="ghost" onClick={onCancel} disabled={saving}>
        Cancel
      </Button>
      <Button intent="primary" type="submit" form={formId} pending={saving}>
        {editKey ? 'Save schedule' : 'Create schedule'}
      </Button>
    </>
  );
}
