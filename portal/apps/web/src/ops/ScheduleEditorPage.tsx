import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Button,
  CodeBlock,
  Panel,
  PageHeader,
  Select,
  SegmentedControl,
  Switch,
  TextField,
} from '@adminforge/ui';
import { api } from '../lib/api';
import { errorText } from '../lib/errors';
import { arr, parser, pick, rec, str } from '../runs/json';
import { describeCron, formatInZone, nextRuns } from './cron';
import { Callout, useDocumentTitle } from './ui';

/**
 * Schedule editor (R6): a cron builder with a plain-language preview, time zone, job, retry and failure alerts. It
 * produces schedule YAML for review — content lives in git (D9), so the file is saved to portal/content/schedules,
 * validated and published like any other change (or handed to Claude Code with the adding-a-schedule-or-probe skill).
 */

type Cadence = 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';
type JobKind = 'report' | 'probe' | 'playbook' | 'contentHealth';

const DAYS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '0', label: 'Sunday' },
];
const ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Singapore',
  'Australia/Sydney',
];

export interface CronParts {
  cadence: Cadence;
  every: number;
  minute: number;
  time: string;
  day: string;
  dayOfMonth: number;
  custom: string;
}

/** The cron expression for the builder's choices. */
export function cronFor(p: CronParts): string {
  const [h = '0', m = '0'] = p.time.split(':');
  const hh = String(Number(h));
  const mm = String(Number(m));
  switch (p.cadence) {
    case 'minutes':
      return `*/${p.every} * * * *`;
    case 'hourly':
      return `${p.minute} * * * *`;
    case 'daily':
      return `${mm} ${hh} * * *`;
    case 'weekdays':
      return `${mm} ${hh} * * 1-5`;
    case 'weekly':
      return `${mm} ${hh} * * ${p.day}`;
    case 'monthly':
      return `${mm} ${hh} ${p.dayOfMonth} * *`;
    default:
      return p.custom.trim();
  }
}

interface DefinitionOption {
  value: string;
  label: string;
}

const definitionOptions = parser((input): DefinitionOption[] =>
  arr(rec(input).items).map((i) => {
    const o = rec(i);
    const key = str(o.key) ?? '';
    return { value: key, label: `${pick(o, 'title') ?? key} (${key})` };
  }),
);

const ScaffoldResult = parser((input) => {
  const o = rec(input);
  const yaml = str(o.yaml);
  const path = str(o.path);
  if (!yaml || !path) throw new TypeError('Expected { yaml, path }');
  return { yaml, path };
});

export function ScheduleEditorPage() {
  useDocumentTitle('New schedule');
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [cron, setCron] = useState<CronParts>({
    cadence: 'weekly',
    every: 15,
    minute: 0,
    time: '06:00',
    day: '1',
    dayOfMonth: 1,
    custom: '0 6 * * 1',
  });
  const [timezone, setTimezone] = useState(ZONES.includes(browserZone) ? browserZone : 'UTC');
  const [jobKind, setJobKind] = useState<JobKind>('report');
  const [ref, setRef] = useState('');
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [retain, setRetain] = useState('26');
  const [emailEnv, setEmailEnv] = useState('');
  const [tags, setTags] = useState('sweep-1h');
  const [mode, setMode] = useState<'read' | 'write'>('read');
  const [reviewedBy, setReviewedBy] = useState('');
  const [retries, setRetries] = useState('2');
  const [alertEnv, setAlertEnv] = useState('');
  const [enabled, setEnabled] = useState(true);

  const expr = cronFor(cron);
  const preview = useMemo(() => {
    try {
      const runs = nextRuns(expr, timezone, 5);
      return { text: describeCron(expr, timezone), runs, error: null as string | null };
    } catch (e) {
      return { text: null, runs: [] as Date[], error: (e as Error).message };
    }
  }, [expr, timezone]);

  const listKind = jobKind === 'report' || jobKind === 'playbook' ? jobKind : null;
  const defs = useQuery({
    queryKey: ['definition', 'list', listKind] as const,
    queryFn: ({ signal }) => api(`/api/definitions?kind=${listKind}`, { schema: definitionOptions, signal }),
    enabled: listKind !== null,
    staleTime: 60_000,
  });

  const scaffold = useMutation({
    mutationFn: () =>
      api('/api/schedules/scaffold', {
        method: 'POST',
        schema: ScaffoldResult,
        body: {
          title,
          ...(summary.trim() ? { summary: summary.trim() } : {}),
          cron: expr,
          timezone,
          enabled,
          retries: Number(retries) || 0,
          job:
            jobKind === 'report'
              ? {
                  kind: 'report',
                  ref,
                  format,
                  ...(Number(retain) > 0 ? { retain: Number(retain) } : {}),
                  ...(emailEnv.trim() ? { emailEnv: emailEnv.trim() } : {}),
                }
              : jobKind === 'probe'
                ? {
                    kind: 'probe',
                    tags: tags
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  }
                : jobKind === 'playbook'
                  ? {
                      kind: 'playbook',
                      ref,
                      mode,
                      ...(mode === 'write'
                        ? {
                            reviewedBy: reviewedBy
                              .split(',')
                              .map((t) => t.trim())
                              .filter(Boolean),
                          }
                        : {}),
                    }
                  : { kind: 'contentHealth' },
          ...(alertEnv.trim() ? { notifyOnFailure: { emailEnv: alertEnv.trim() } } : {}),
        },
      }),
  });

  const download = (yaml: string, path: string) => {
    const url = URL.createObjectURL(new Blob([yaml], { type: 'text/yaml' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: path.split('/').at(-1) });
    a.click();
    URL.revokeObjectURL(url);
  };

  const needsRef = (jobKind === 'report' || jobKind === 'playbook') && !ref;
  return (
    <>
      <PageHeader
        eyebrow="Automation"
        title="New schedule"
        description="Build a schedule and get its YAML. Schedules live in git: save the file, validate it, and publish — or ask Claude Code to add it with the adding-a-schedule-or-probe skill."
        actions={
          <Link to="/schedules" className="text-sm font-semibold text-accent hover:underline">
            Back to schedules
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Panel eyebrow="What" title="Name and job">
            <div className="flex flex-col gap-4">
              <TextField
                label="Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Weekly inactive guests report"
              />
              <TextField
                label="Summary"
                optional
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
              <Select
                label="Job"
                value={jobKind}
                onValueChange={(v) => {
                  setJobKind(v as JobKind);
                  setRef('');
                }}
                options={[
                  { value: 'report', label: 'Report (file, email, Teams)' },
                  { value: 'probe', label: 'Synthetic tests (probes by tag)' },
                  { value: 'playbook', label: 'Playbook' },
                  { value: 'contentHealth', label: 'Content health check' },
                ]}
              />
              {(jobKind === 'report' || jobKind === 'playbook') && (
                <Select
                  label={jobKind === 'report' ? 'Report' : 'Playbook'}
                  value={ref}
                  onValueChange={setRef}
                  placeholder={defs.isPending ? 'Loading…' : 'Choose…'}
                  options={defs.data ?? []}
                  error={defs.isError ? errorText(defs.error) : undefined}
                />
              )}
              {jobKind === 'report' && (
                <>
                  <SegmentedControl
                    aria-label="File format"
                    value={format}
                    onValueChange={(v) => setFormat(v as 'xlsx' | 'csv')}
                    options={[
                      { value: 'xlsx', label: 'Excel' },
                      { value: 'csv', label: 'CSV' },
                    ]}
                  />
                  <TextField
                    label="Keep the newest"
                    value={retain}
                    onChange={(e) => setRetain(e.target.value)}
                    inputMode="numeric"
                    hint="files (older ones are deleted)"
                  />
                  <TextField
                    label="Email to (env key)"
                    optional
                    value={emailEnv}
                    onChange={(e) => setEmailEnv(e.target.value.toUpperCase())}
                    placeholder="AF_REPORT_RECIPIENTS"
                    hint="Recipient addresses are configuration, not content: name an env key ending in _RECIPIENTS, _EMAIL or _ALERTS that holds them (comma-separated)."
                  />
                </>
              )}
              {jobKind === 'probe' && (
                <TextField
                  label="Probe tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  hint="Runs every probe carrying all of these tags (comma-separated)."
                />
              )}
              {jobKind === 'playbook' && (
                <>
                  <SegmentedControl
                    aria-label="Mode"
                    value={mode}
                    onValueChange={(v) => setMode(v as 'read' | 'write')}
                    options={[
                      { value: 'read', label: 'Reads only' },
                      { value: 'write', label: 'Changes data' },
                    ]}
                  />
                  {mode === 'write' && (
                    <TextField
                      label="Reviewed by"
                      value={reviewedBy}
                      onChange={(e) => setReviewedBy(e.target.value)}
                      hint="Who reviewed this change. Enabling it in the portal still needs a second person’s approval."
                    />
                  )}
                </>
              )}
            </div>
          </Panel>
          <Panel eyebrow="When" title="Cadence and time zone">
            <div className="flex flex-col gap-4">
              <Select
                label="Repeats"
                value={cron.cadence}
                onValueChange={(v) => setCron((c) => ({ ...c, cadence: v as Cadence }))}
                options={[
                  { value: 'minutes', label: 'Every few minutes' },
                  { value: 'hourly', label: 'Every hour' },
                  { value: 'daily', label: 'Every day' },
                  { value: 'weekdays', label: 'Weekdays' },
                  { value: 'weekly', label: 'Every week' },
                  { value: 'monthly', label: 'Every month' },
                  { value: 'custom', label: 'Custom (cron)' },
                ]}
              />
              {cron.cadence === 'minutes' && (
                <Select
                  label="Every"
                  value={String(cron.every)}
                  onValueChange={(v) => setCron((c) => ({ ...c, every: Number(v) }))}
                  options={[5, 10, 15, 30].map((n) => ({ value: String(n), label: `${n} minutes` }))}
                />
              )}
              {cron.cadence === 'hourly' && (
                <TextField
                  label="At minute"
                  value={String(cron.minute)}
                  inputMode="numeric"
                  onChange={(e) =>
                    setCron((c) => ({ ...c, minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) }))
                  }
                />
              )}
              {['daily', 'weekdays', 'weekly', 'monthly'].includes(cron.cadence) && (
                <TextField
                  label="At"
                  type="time"
                  value={cron.time}
                  onChange={(e) => setCron((c) => ({ ...c, time: e.target.value || '00:00' }))}
                />
              )}
              {cron.cadence === 'weekly' && (
                <Select
                  label="On"
                  value={cron.day}
                  onValueChange={(v) => setCron((c) => ({ ...c, day: v }))}
                  options={DAYS}
                />
              )}
              {cron.cadence === 'monthly' && (
                <TextField
                  label="On day"
                  value={String(cron.dayOfMonth)}
                  inputMode="numeric"
                  onChange={(e) =>
                    setCron((c) => ({
                      ...c,
                      dayOfMonth: Math.min(28, Math.max(1, Number(e.target.value) || 1)),
                    }))
                  }
                  hint="1–28, so it runs every month."
                />
              )}
              {cron.cadence === 'custom' && (
                <TextField
                  label="Cron expression"
                  value={cron.custom}
                  onChange={(e) => setCron((c) => ({ ...c, custom: e.target.value }))}
                  hint="minute hour day-of-month month day-of-week"
                />
              )}
              <Select
                label="Time zone"
                value={timezone}
                onValueChange={setTimezone}
                options={[...new Set([browserZone, ...ZONES])].map((z) => ({ value: z, label: z }))}
              />
            </div>
          </Panel>
          <Panel eyebrow="If it fails" title="Retries and alerts">
            <div className="flex flex-col gap-4">
              <Select
                label="Retries"
                value={retries}
                onValueChange={setRetries}
                options={['0', '1', '2', '3', '5'].map((n) => ({
                  value: n,
                  label: n === '0' ? 'Don’t retry' : `${n} with backoff`,
                }))}
              />
              <TextField
                label="Email failures to (env key)"
                optional
                value={alertEnv}
                onChange={(e) => setAlertEnv(e.target.value.toUpperCase())}
                placeholder="AF_SCHEDULE_ALERTS"
                hint="An env key ending in _RECIPIENTS, _EMAIL or _ALERTS that holds the addresses."
              />
              <Switch label="Enabled after publishing" checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </Panel>
        </div>
        <div className="flex flex-col gap-6">
          <Panel eyebrow="Preview" title={preview.text ?? 'Not a valid schedule yet'}>
            {preview.error ? (
              <p className="text-sm text-crit">{preview.error}</p>
            ) : (
              <ul className="flex flex-col gap-1 font-mono text-sm text-fg-2">
                <li className="text-xs text-fg-3">
                  {expr} · next runs ({timezone})
                </li>
                {preview.runs.map((d) => (
                  <li key={d.toISOString()}>{formatInZone(d, timezone)}</li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel eyebrow="Result" title="Schedule YAML">
            <div className="flex flex-col gap-4">
              <Button
                intent="primary"
                pending={scaffold.isPending}
                locked={
                  !title.trim()
                    ? 'Give the schedule a title first.'
                    : needsRef
                      ? 'Choose what it runs first.'
                      : preview.error
                        ? 'Fix the schedule first.'
                        : undefined
                }
                onClick={() => scaffold.mutate()}
              >
                Create YAML
              </Button>
              {scaffold.isError && (
                <Callout tone="crit" title="The YAML wasn’t created">
                  {errorText(scaffold.error)}
                </Callout>
              )}
              {scaffold.data && (
                <>
                  <CodeBlock
                    code={scaffold.data.yaml}
                    title={scaffold.data.path}
                    language="yaml"
                    maxHeight={420}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => void navigator.clipboard?.writeText(scaffold.data!.yaml)}>
                      Copy
                    </Button>
                    <Button onClick={() => download(scaffold.data!.yaml, scaffold.data!.path)}>
                      Download
                    </Button>
                  </div>
                  <Callout tone="neutral" title="Next steps">
                    Save it as <code className="font-mono">{scaffold.data.path}</code>, run{' '}
                    <code className="font-mono">pnpm adminforge validate</code>, open a pull request, and
                    after review <code className="font-mono">pnpm adminforge publish</code>. Schedules that
                    change data turn on only after a second person approves them here.
                  </Callout>
                </>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
