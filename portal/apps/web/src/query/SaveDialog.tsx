import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Button,
  CodeBlock,
  Dialog,
  DialogClose,
  DownloadSimpleIcon,
  ErrorState,
  TextField,
} from '@adminforge/ui';
import { ApiRequestError } from '../lib/api';
import {
  scaffoldQuery,
  type QueryRequest,
  type ResultColumn,
  type SaveKind,
  type ScaffoldResult,
} from './contracts';
import { downloadText } from './results';
import { SOURCE_META } from './sources';

const KIND_TEXT: Record<SaveKind, { noun: string; what: string; skill: string }> = {
  report: {
    noun: 'report',
    what: 'A report page with this query as its datasource, a results table and CSV/XLSX export. It runs with each viewer’s own access.',
    skill: 'adding-a-page-or-report',
  },
  probe: {
    noun: 'probe',
    what: 'A configuration check (kind kql) that runs unattended as the automation identity. The row count is its metric; the offending rows are kept for drill-down.',
    skill: 'adding-a-schedule-or-probe',
  },
  schedule: {
    noun: 'schedule',
    what: 'A scheduled run of this query as the automation identity that delivers the results as a report. Enabling it needs review.',
    skill: 'adding-a-schedule-or-probe',
  },
};

export const SAVE_LABEL: Record<SaveKind, string> = {
  report: 'Save as report',
  probe: 'Save as probe',
  schedule: 'Save as schedule',
};

/** `portal/content/reports/azure/untagged.report.yaml` → `untagged`. */
export const slugOf = (path: string) =>
  (path.split('/').pop() ?? '')
    .replace(/\.ya?ml$/, '')
    .replace(/\.(report|probe|schedule|page|dashboard)$/, '') || 'query';

function Steps({ kind, file, title }: { kind: SaveKind; file: ScaffoldResult; title: string }) {
  const slug = file.key ?? slugOf(file.path);
  const commands = [
    'pnpm adminforge validate --scopes',
    `git switch -c content/${slug}`,
    `git add ${file.path}`,
    `git commit -m "content(${kind}): ${title.replace(/"/g, "'")}"`,
    'git push -u origin HEAD',
  ].join('\n');
  return (
    <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm text-fg-2 marker:text-fg-3">
      <li>
        Save the YAML above as <code className="font-mono text-xs break-all text-fg">{file.path}</code> in
        your clone of the AdminForge repository.
      </li>
      <li>
        <div className="flex flex-col gap-2">
          <span>
            Validate it against the schemas, expressions and permissions, then commit it on a branch and open
            a pull request:
          </span>
          <CodeBlock code={commands} title="Validate and commit" language="shell" wrap />
        </div>
      </li>
      <li>
        After the pull request is merged, publish it with{' '}
        <code className="font-mono text-xs text-fg">pnpm adminforge publish</code>. Nothing is live until
        then.
      </li>
    </ol>
  );
}

export interface SaveDialogProps {
  kind: SaveKind;
  request: QueryRequest;
  /** Columns of the last result, when it came from this exact query. */
  columns?: ResultColumn[];
  defaultTitle: string;
  onClose: () => void;
}

/** Turns the current query into a definition file for review — nothing is created in the portal or the tenant. */
export function SaveDialog({ kind, request, columns, defaultTitle, onClose }: SaveDialogProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [touched, setTouched] = useState(false);
  const scaffold = useMutation({
    mutationFn: () =>
      scaffoldQuery({
        as: kind,
        source: request.source,
        query: request.query,
        title: title.trim(),
        ...(request.timespan ? { timespan: request.timespan } : {}),
        ...(columns?.length
          ? { columns: columns.slice(0, 60).map((c) => ({ name: c.name, type: c.type })) }
          : {}),
      }),
  });
  const scoped =
    request.source === 'resourceGraph'
      ? Boolean(request.subscriptions?.length)
      : request.source === 'logAnalytics' && Boolean(request.workspace);
  const text = KIND_TEXT[kind];
  const titleError = touched && !title.trim() ? 'Give it a title.' : undefined;
  const file = scaffold.data;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!title.trim() || scaffold.isPending) return;
    scaffold.mutate();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={file ? `Your ${text.noun} file is ready` : SAVE_LABEL[kind]}
      description={file ? 'Review it, then commit it like any other content change.' : text.what}
      footer={
        file ? (
          <>
            <Button
              intent="ghost"
              onClick={() =>
                downloadText(
                  file.yaml,
                  file.path.split('/').pop() ?? `${slugOf(file.path)}.yaml`,
                  'application/yaml;charset=utf-8',
                )
              }
            >
              <DownloadSimpleIcon size={15} aria-hidden />
              Download file
            </Button>
            <DialogClose asChild>
              <Button intent="primary">Done</Button>
            </DialogClose>
          </>
        ) : (
          <>
            <DialogClose asChild>
              <Button intent="ghost">Cancel</Button>
            </DialogClose>
            <Button intent="primary" type="submit" form="query-save-form" pending={scaffold.isPending}>
              Create {text.noun} YAML
            </Button>
          </>
        )
      }
    >
      {file ? (
        <div className="flex flex-col gap-5">
          <CodeBlock code={file.yaml} title={file.path} language="yaml" maxHeight={240} />
          <Steps kind={kind} file={file} title={title.trim()} />
          <p className="rounded-(--af-input-radius) border border-line bg-raised px-3 py-2.5 text-sm text-fg-2">
            Working in Claude Code? Ask it to use the{' '}
            <code className="font-mono text-xs text-fg">{text.skill}</code> skill: it reviews the file against
            the content rules, adds fixtures and tests, and runs the checks for you.
          </p>
        </div>
      ) : (
        <form id="query-save-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <TextField
            label="Title"
            value={title}
            maxLength={120}
            required
            autoFocus
            error={titleError}
            hint={`Shown in navigation and alerts. The ${text.noun} queries ${SOURCE_META[request.source].label}.`}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => setTouched(true)}
          />
          <CodeBlock code={request.query} title="Query" language="kql" maxHeight={180} />
          {scoped && (
            <p className="text-sm text-fg-2">
              {request.source === 'resourceGraph'
                ? 'The file queries every subscription the identity running it can read: subscription ids are configuration, so they are not saved in content.'
                : 'The file queries the default workspace (AF_LOG_ANALYTICS_WORKSPACE_ID): workspace ids are configuration, so they are not saved in content.'}
            </p>
          )}
          {scaffold.isError && (
            <ErrorState
              compact
              title="The file wasn’t generated"
              message={(scaffold.error as Error).message}
              hint={scaffold.error instanceof ApiRequestError ? scaffold.error.hint : undefined}
              code={scaffold.error instanceof ApiRequestError ? scaffold.error.code : undefined}
              correlationId={
                scaffold.error instanceof ApiRequestError ? scaffold.error.correlationId : undefined
              }
            />
          )}
        </form>
      )}
    </Dialog>
  );
}
