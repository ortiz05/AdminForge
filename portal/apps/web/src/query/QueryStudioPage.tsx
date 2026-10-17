import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Button,
  CaretDownIcon,
  FloppyDiskIcon,
  Kbd,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  modKey,
  PageHeader,
  Panel,
  PlayIcon,
  SegmentedControl,
  Select,
  Skeleton,
  Textarea,
  TextField,
} from '@adminforge/ui';
import { useMe } from '../lib/session';
import { Callout, useDocumentTitle } from '../ops/ui';
import {
  defenderFeatureQuery,
  enabledSources,
  runQuery,
  SAVE_KINDS,
  SOURCES,
  subscriptionsQuery,
  workspacesQuery,
  type QueryRequest,
  type QuerySource,
  type SaveKind,
} from './contracts';
import { findStarter, type ChartHint, type StarterQuery } from './gallery';
import { recordRun, type HistoryEntry } from './history';
import { ResultsPanel, type RunState } from './ResultsPanel';
import { SaveDialog } from './SaveDialog';
import { Sidebar } from './Sidebar';
import { DEFAULT_TIMESPAN, isTimespan, SOURCE_META, TIMESPANS, type Timespan } from './sources';

const KqlEditor = lazy(() => import('./KqlEditor'));

export interface QuerySearch {
  source?: QuerySource;
  q?: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_WS = 'default';
const CUSTOM_WS = 'custom';
/** Longest query that is put in the URL after a run (longer ones stay in history only). */
const URL_QUERY_MAX = 2000;
const SAVE_MENU: Record<SaveKind, string> = {
  report: 'Report',
  probe: 'Probe (configuration check)',
  schedule: 'Schedule',
};

/** If Monaco fails to load (blocked chunk, old browser), the studio still works with a plain text area. */
class EditorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function PlainEditor({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <Textarea
      label={label}
      hideLabel
      value={value}
      spellCheck={false}
      rows={9}
      onChange={(e) => onChange(e.target.value)}
      className="p-3"
      textareaClassName="font-mono text-sm"
    />
  );
}

function SubscriptionPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const subs = useQuery(subscriptionsQuery);
  const options = subs.data ?? [];
  const label =
    value.length === 0
      ? 'All subscriptions'
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? '1 subscription')
        : `${value.length} subscriptions`;
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter((v) => v !== id));
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-fg" id="query-scope-label">
        Scope
      </span>
      <Menu>
        <MenuTrigger asChild>
          <Button
            className="w-56 justify-between font-normal"
            aria-labelledby="query-scope-label query-scope-value"
          >
            <span id="query-scope-value" className="truncate">
              {label}
            </span>
            <CaretDownIcon size={14} weight="bold" aria-hidden className="shrink-0 text-fg-3" />
          </Button>
        </MenuTrigger>
        <MenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
          <MenuCheckboxItem
            checked={value.length === 0}
            onCheckedChange={() => onChange([])}
            onSelect={(e) => e.preventDefault()}
          >
            All subscriptions you can read
          </MenuCheckboxItem>
          <MenuSeparator />
          <MenuLabel>
            {subs.isPending
              ? 'Loading subscriptions…'
              : subs.isError
                ? 'Subscriptions could not be listed'
                : 'Only these subscriptions'}
          </MenuLabel>
          {options.map((o) => (
            <MenuCheckboxItem
              key={o.value}
              checked={value.includes(o.value)}
              onCheckedChange={(on) => toggle(o.value, on)}
              onSelect={(e) => e.preventDefault()}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{o.label}</span>
                <span className="truncate font-mono text-2xs text-fg-3">{o.value}</span>
              </span>
            </MenuCheckboxItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  );
}

function WorkspacePicker({
  value,
  custom,
  onChange,
  onCustomChange,
}: {
  value: string;
  custom: string;
  onChange: (v: string) => void;
  onCustomChange: (v: string) => void;
}) {
  const ws = useQuery(workspacesQuery);
  const options = [
    { value: DEFAULT_WS, label: 'Default workspace', description: 'Configured for this AdminForge' },
    ...(ws.data ?? []).map((o) => ({ value: o.value, label: o.label, description: o.description })),
    { value: CUSTOM_WS, label: 'Another workspace…', description: 'Enter a workspace id' },
  ];
  const invalid = value === CUSTOM_WS && custom.trim() !== '' && !GUID.test(custom.trim());
  return (
    <div className="flex flex-wrap items-start gap-3">
      <Select label="Workspace" className="w-60" value={value} onValueChange={onChange} options={options} />
      {value === CUSTOM_WS && (
        <TextField
          label="Workspace id"
          className="w-80"
          inputClassName="font-mono"
          placeholder="00000000-0000-0000-0000-000000000000"
          value={custom}
          error={invalid ? 'A workspace id is a GUID (the workspace’s customer id).' : undefined}
          onChange={(e) => onCustomChange(e.target.value)}
        />
      )}
    </div>
  );
}

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

function DefenderNote() {
  const f = useQuery(defenderFeatureQuery);
  if (f.isPending || f.isError || !f.data) return null;
  if (!f.data.available)
    return (
      <Callout
        tone="warn"
        title="Advanced hunting needs Microsoft Defender XDR"
        className="mx-(--af-pad-panel) mb-3"
      >
        {sentence(f.data.reason ?? 'This tenant has no Defender licence that includes advanced hunting')}
        {f.data.sku && !f.data.reason?.includes(f.data.sku)
          ? ` Look for ${f.data.sku} in the tenant’s licences.`
          : ''}{' '}
        Queries return an error until the tenant has it; the starter queries still show what you can ask.
      </Callout>
    );
  if (f.data.reason)
    return (
      <Callout tone="info" title="Defender licence state unknown" className="mx-(--af-pad-panel) mb-3">
        {sentence(f.data.reason)} Microsoft Defender decides when the query runs.
      </Callout>
    );
  return null;
}

/** "A, B and C" */
const listOf = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '');

/**
 * Query Studio (/query): read-only KQL over Resource Graph, Log Analytics and Defender advanced hunting (R12) — the
 * sources this installation offers (GET /api/me `querySources`). A link naming a source that is switched off opens
 * the first offered source instead, without the link's query (it is written for the other source).
 */
export function QueryStudioPage({ search }: { search: QuerySearch }) {
  useDocumentTitle('Query Studio');
  const navigate = useNavigate();
  const me = useMe();
  const sources = useMemo(() => enabledSources(me.querySources), [me.querySources]);
  const linkedOff = search.source && !sources.includes(search.source) ? search.source : undefined;
  const initialSource: QuerySource = search.source && !linkedOff ? search.source : sources[0]!;
  const [source, setSource] = useState<QuerySource>(initialSource);
  const [drafts, setDrafts] = useState<Record<QuerySource, string>>(() => {
    const d = Object.fromEntries(SOURCES.map((s) => [s, SOURCE_META[s].starter])) as Record<
      QuerySource,
      string
    >;
    if (search.q && !linkedOff) d[initialSource] = search.q;
    return d;
  });
  const [subscriptions, setSubscriptions] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState(DEFAULT_WS);
  const [customWorkspace, setCustomWorkspace] = useState('');
  const [timespan, setTimespan] = useState<Timespan>(DEFAULT_TIMESPAN);
  const [run, setRun] = useState<RunState>({ status: 'idle' });
  const [chartHint, setChartHint] = useState<ChartHint | undefined>();
  const [saving, setSaving] = useState<SaveKind | null>(null);
  const [tab, setTab] = useState('gallery');
  const [formError, setFormError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const editorApi = useRef<{ focus: () => void } | null>(null);
  const meta = SOURCE_META[source];
  const query = drafts[source];

  useEffect(() => () => abort.current?.abort(), []);

  const setQuery = useCallback((q: string) => setDrafts((d) => ({ ...d, [source]: q })), [source]);

  const buildRequest = useCallback(
    (text: string, src: QuerySource = source): QueryRequest | string => {
      if (!text.trim()) return 'Write a query first, or pick a starter query.';
      const req: QueryRequest = { source: src, query: text };
      if (src === 'resourceGraph' && subscriptions.length) req.subscriptions = subscriptions;
      if (src === 'logAnalytics') {
        if (workspace === CUSTOM_WS) {
          if (!GUID.test(customWorkspace.trim()))
            return 'Enter the workspace id (a GUID) or choose a workspace.';
          req.workspace = customWorkspace.trim().toLowerCase();
        } else if (workspace !== DEFAULT_WS) req.workspace = workspace;
      }
      if (SOURCE_META[src].timespan && timespan !== 'query') req.timespan = timespan;
      return req;
    },
    [source, subscriptions, workspace, customWorkspace, timespan],
  );

  const execute = useCallback(() => {
    const built = buildRequest(query);
    if (typeof built === 'string') {
      setFormError(built);
      return;
    }
    setFormError(null);
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const request = built;
    setRun({ status: 'running', startedAt: Date.now(), request });
    const hint = findStarter(request.query, request.source)?.chart;
    setChartHint(hint);
    const entry: Omit<HistoryEntry, 'ranAt'> = {
      source: request.source,
      query: request.query,
      ...(request.workspace ? { workspace: request.workspace } : {}),
      ...(request.subscriptions ? { subscriptions: request.subscriptions } : {}),
      ...(request.timespan ? { timespan: request.timespan } : {}),
    };
    runQuery(request, ctrl.signal).then(
      (result) => {
        if (ctrl.signal.aborted) return;
        const finishedAt = new Date().toISOString();
        setRun({ status: 'done', result, request, finishedAt });
        recordRun({ ...entry, ranAt: finishedAt, rowCount: result.rows.length, ms: result.ms });
        void navigate({
          to: '/query',
          search: {
            source: request.source,
            ...(request.query.length <= URL_QUERY_MAX ? { q: request.query } : {}),
          },
          replace: true,
        });
      },
      (error: unknown) => {
        if ((error as Error)?.name === 'AbortError' || ctrl.signal.aborted) return;
        setRun({ status: 'error', error, request });
        recordRun({ ...entry, ranAt: new Date().toISOString(), failed: true });
      },
    );
  }, [buildRequest, query, navigate]);

  const cancel = useCallback(() => {
    abort.current?.abort();
    setRun((r) => (r.status === 'running' ? { status: 'cancelled', request: r.request } : r));
  }, []);

  const changeSource = (s: QuerySource) => {
    setSource(s);
    setFormError(null);
  };

  const pickStarter = (q: StarterQuery) => {
    setDrafts((d) => ({ ...d, [q.source]: q.query }));
    setSource(q.source);
    setFormError(null);
    editorApi.current?.focus();
  };

  const pickHistory = (e: HistoryEntry) => {
    setDrafts((d) => ({ ...d, [e.source]: e.query }));
    setSource(e.source);
    if (e.source === 'resourceGraph') setSubscriptions(e.subscriptions ?? []);
    if (e.source === 'logAnalytics') {
      setWorkspace(e.workspace ? CUSTOM_WS : DEFAULT_WS);
      setCustomWorkspace(e.workspace ?? '');
    }
    if (e.timespan && isTimespan(e.timespan)) setTimespan(e.timespan);
    else if (SOURCE_META[e.source].timespan) setTimespan('query');
    setFormError(null);
    editorApi.current?.focus();
  };

  /** Ctrl/⌘ + Enter anywhere in the studio (the editor handles its own). Portalled menus and dialogs are excluded. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    e.preventDefault();
    execute();
  };

  const saveRequest = useMemo(() => {
    const built = buildRequest(query);
    return typeof built === 'string' ? null : built;
  }, [buildRequest, query]);
  const starter = findStarter(query, source);
  const resultColumns = useMemo(
    () => (run.status === 'done' ? run.result.columns.map((c) => c.name) : undefined),
    [run],
  );
  const running = run.status === 'running';
  const mod = modKey();
  const editorLabel = `${meta.label} query. Press ${mod === '⌘' ? 'Command' : 'Control'} Enter to run.`;

  return (
    <div className="flex flex-col gap-(--af-gap-grid)" onKeyDown={onKeyDown}>
      <PageHeader
        eyebrow="Automation"
        title="Query Studio"
        description={`Read-only KQL across ${listOf(sources.map((s) => SOURCE_META[s].label))}, with your own access. Save a query as a report, probe or schedule for review.`}
        actions={
          saveRequest ? (
            <Menu>
              <MenuTrigger asChild>
                <Button>
                  <FloppyDiskIcon size={15} aria-hidden />
                  Save as…
                  <CaretDownIcon size={13} weight="bold" aria-hidden className="text-fg-3" />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>Create a definition file for review</MenuLabel>
                {SAVE_KINDS.map((k) => (
                  <MenuItem key={k} onSelect={() => setSaving(k)}>
                    {SAVE_MENU[k]}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          ) : (
            <Button locked="Write a query first.">
              <FloppyDiskIcon size={15} aria-hidden />
              Save as…
            </Button>
          )
        }
      />

      <div className="grid min-w-0 items-start gap-(--af-gap-grid) xl:grid-cols-4">
        <div className="flex min-w-0 flex-col gap-(--af-gap-grid) xl:col-span-3">
          <Panel flush aria-label="Query editor" className="overflow-hidden">
            {/* Context fields wrap on the left; Run stays at the bottom right, next to the editor. */}
            <div className="flex items-end gap-4 border-b border-line px-(--af-pad-panel) pt-1 pb-4">
              <div className="flex min-w-0 flex-1 flex-wrap items-end gap-x-4 gap-y-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-fg" id="query-source-label">
                    Source
                  </span>
                  <SegmentedControl
                    aria-label="Source"
                    value={source}
                    onValueChange={(v) => changeSource(v as QuerySource)}
                    options={sources.map((s) => ({ value: s, label: SOURCE_META[s].short }))}
                  />
                </div>
                {source === 'resourceGraph' && (
                  <SubscriptionPicker value={subscriptions} onChange={setSubscriptions} />
                )}
                {source === 'logAnalytics' && (
                  <WorkspacePicker
                    value={workspace}
                    custom={customWorkspace}
                    onChange={setWorkspace}
                    onCustomChange={setCustomWorkspace}
                  />
                )}
                {meta.timespan && (
                  <Select
                    label="Time range"
                    className="w-44"
                    value={timespan}
                    onValueChange={(v) => isTimespan(v) && setTimespan(v)}
                    options={TIMESPANS.map((t) => ({ value: t.value, label: t.label }))}
                  />
                )}
              </div>
              <Button
                intent="primary"
                className="shrink-0"
                onClick={execute}
                pending={running}
                aria-keyshortcuts="Control+Enter Meta+Enter"
              >
                {!running && <PlayIcon size={14} weight="fill" aria-hidden />}
                {running ? 'Running…' : 'Run'}
              </Button>
            </div>

            {linkedOff && (
              <div className="pt-3">
                <Callout
                  tone="info"
                  title={`${SOURCE_META[linkedOff].label} is switched off for this AdminForge`}
                  className="mx-(--af-pad-panel) mb-3"
                >
                  You followed a link to it; {SOURCE_META[initialSource].label} is shown instead. Whoever runs
                  this AdminForge can switch it back on.
                </Callout>
              </div>
            )}
            {source === 'advancedHunting' && (
              <div className="pt-3">
                <DefenderNote />
              </div>
            )}

            <div className="bg-sunken">
              <EditorBoundary
                fallback={<PlainEditor value={query} onChange={setQuery} label={editorLabel} />}
              >
                <Suspense fallback={<Skeleton shape="block" className="h-42 rounded-none" />}>
                  <KqlEditor
                    value={query}
                    onChange={setQuery}
                    onRun={execute}
                    tables={meta.tables}
                    columns={resultColumns}
                    ariaLabel={editorLabel}
                    placeholder={`Write a ${meta.short} query…`}
                    onReady={(api) => {
                      editorApi.current = api;
                    }}
                  />
                </Suspense>
              </EditorBoundary>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line px-(--af-pad-panel) py-2.5 text-xs text-fg-3">
              <span>
                {starter ? <span className="text-fg-2">{starter.title} · </span> : null}
                {meta.about}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd keys={[mod, 'Enter']} /> to run
              </span>
            </div>
            {formError && (
              <p
                role="alert"
                className="border-t border-line px-(--af-pad-panel) py-2.5 text-sm font-medium text-crit"
              >
                {formError}
              </p>
            )}
          </Panel>

          <ResultsPanel state={run} chartHint={chartHint} onRetry={execute} onCancel={cancel} />
        </div>

        <Sidebar
          source={source}
          sources={sources}
          current={query}
          onPickStarter={pickStarter}
          onPickHistory={pickHistory}
          tab={tab}
          onTabChange={setTab}
        />
      </div>

      {saving && saveRequest && (
        <SaveDialog
          kind={saving}
          request={saveRequest}
          columns={
            run.status === 'done' && run.request.source === source && run.request.query === query
              ? run.result.columns
              : undefined
          }
          defaultTitle={starter?.title ?? ''}
          onClose={() => setSaving(null)}
        />
      )}
    </div>
  );
}
