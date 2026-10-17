import { useState } from 'react';
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
  WarningCircleIcon,
} from '@adminforge/ui';
import { describeCron as describeSentence } from '@adminforge/schemas';
import { api } from '../lib/api';
import { errorText } from '../lib/errors';
import { arr, parser, pick, rec, str } from '../runs/json';
import {
  CadenceFields,
  cadenceProblem,
  previewHint,
  cronFor,
  DEFAULT_CRON_PARTS,
  defaultZone,
  useCronPreview,
  type CronParts,
} from './cadence';
import { describeCron, formatInZone } from './cron';
import { scheduleIdentitiesQuery } from './schedules';
import { TimeZoneField } from './TimeZoneField';
import { Callout, useDocumentTitle } from './ui';

/**
 * Schedule editor (R6): a cadence builder (choices, English or cron) with a plain-English preview and the next five
 * runs from the API, a searchable time zone, job, retry and failure alerts. It
 * produces schedule YAML for review — content lives in git (D9), so the file is saved to portal/content/schedules,
 * validated and published like any other change (or handed to Claude Code with the adding-a-schedule-or-probe skill).
 */

type JobKind = 'report' | 'probe' | 'playbook' | 'contentHealth';

// The cron builder is shared with the report schedule form (Reports); re-exported for existing imports.
export { cronFor, type CronParts } from './cadence';

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
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [cron, setCron] = useState<CronParts>(DEFAULT_CRON_PARTS);
  const [timezone, setTimezone] = useState(defaultZone);
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
  const [runAs, setRunAs] = useState('automation');
  const identities = useQuery(scheduleIdentitiesQuery);

  const expr = cronFor(cron);
  // A problem the cadence field already shows is said there, once; the preview only points at it.
  const fieldProblem = cadenceProblem(cron);
  const server = useCronPreview(fieldProblem ? '' : expr, timezone);
  const answer = expr && server.data?.cron === expr.trim() ? server.data : undefined;
  const serverProblem = !fieldProblem && answer && !answer.valid ? answer.problem : undefined;
  const preview = {
    text: expr && !fieldProblem && !serverProblem ? describeCron(expr, timezone) : null,
    runs: answer?.next ?? [],
    hint: fieldProblem ? previewHint(cron) : null,
    error: serverProblem ?? null,
  };
  // English goes to the API as English (the YAML then says `every:`), without a zone: that is the zone field.
  const sentence = cron.cadence === 'english' && expr ? describeSentence(expr) : '';
  const when = sentence && !sentence.startsWith('Custom:') ? { every: sentence } : { cron: expr };

  const listKind = jobKind === 'report' || jobKind === 'playbook' ? jobKind : null;
  const defs = useQuery({
    queryKey: ['definition', 'list', listKind] as const,
    queryFn: ({ signal }) => api(`/api/definitions?kind=${listKind}`, { schema: definitionOptions, signal }),
    enabled: listKind !== null,
    staleTime: 60_000,
  });

  // Content health always runs as the automation identity (ADR-014); the rest may name a configured app identity.
  const appIdentities = jobKind === 'contentHealth' ? [] : (identities.data?.apps ?? []);
  const runsAsChoice = runAs.startsWith('app:') && appIdentities.includes(runAs.slice('app:'.length));

  const scaffold = useMutation({
    mutationFn: () =>
      api('/api/schedules/scaffold', {
        method: 'POST',
        schema: ScaffoldResult,
        body: {
          title,
          ...(summary.trim() ? { summary: summary.trim() } : {}),
          ...when,
          timezone,
          enabled,
          retries: Number(retries) || 0,
          ...(runsAsChoice ? { identity: { app: runAs.slice('app:'.length) } } : {}),
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
      {jobKind === 'report' && (
        <Callout
          tone="info"
          className="mb-6"
          title="Reports can be scheduled straight from Reports"
          action={
            <Link
              to="/reports"
              className="text-sm font-semibold text-accent underline-offset-2 hover:underline"
            >
              Open Reports
            </Link>
          }
        >
          Open a report there and choose Schedule: it runs from the next due time, by file, email or Teams,
          with no YAML or review. Use this editor when the schedule should live in git.
        </Callout>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
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
              {appIdentities.length > 0 && (
                <Select
                  label="Run as"
                  value={runsAsChoice ? runAs : 'automation'}
                  onValueChange={setRunAs}
                  options={[
                    { value: 'automation', label: 'Automation identity' },
                    ...appIdentities.map((name) => ({ value: `app:${name}`, label: `App identity ${name}` })),
                  ]}
                  hint={
                    runsAsChoice ? (
                      <>
                        Its own app registration, with only the permissions its schedules declare:{' '}
                        <code className="font-mono">pnpm adminforge provision entra</code> grants them.
                      </>
                    ) : (
                      'AdminForge’s app for schedules, with the application permissions content declares.'
                    )
                  }
                />
              )}
            </div>
          </Panel>
          <Panel eyebrow="When" title="Cadence and time zone">
            <div className="flex flex-col gap-4">
              <CadenceFields value={cron} onChange={setCron} timezone={timezone} onTimezone={setTimezone} />
              <TimeZoneField value={timezone} onChange={setTimezone} />
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
        {/* Stays in view next to the form on wide screens, so the preview is beside the cadence being edited. */}
        <div className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-(--af-layout-rail-h) lg:self-start lg:pt-1">
          <Panel eyebrow="Preview" title="When it runs">
            <div className="flex flex-col gap-3">
              {preview.hint ? (
                <p className="text-sm text-fg-3">{preview.hint}</p>
              ) : preview.error ? (
                <p className="flex items-start gap-1.5 text-sm text-crit">
                  <WarningCircleIcon size={16} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
                  {preview.error}
                </p>
              ) : (
                preview.text && <p className="text-sm font-medium text-fg">{preview.text}</p>
              )}
              {!preview.hint && !preview.error && expr && (
                <ul
                  className="flex flex-col gap-1 font-mono text-sm text-fg-2"
                  aria-label="Next runs"
                  aria-busy={server.isFetching}
                >
                  <li className="text-xs break-all text-fg-3">
                    {expr} · next runs ({timezone.replace(/_/g, ' ')})
                  </li>
                  {preview.runs.map((iso) => (
                    <li key={iso}>
                      <time dateTime={iso}>{formatInZone(iso, timezone)}</time>
                    </li>
                  ))}
                  {server.isError && (
                    <li className="font-sans text-xs text-fg-3">
                      The next runs couldn’t be worked out right now; the schedule itself is fine.
                    </li>
                  )}
                </ul>
              )}
            </div>
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
                      : preview.hint || preview.error
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
