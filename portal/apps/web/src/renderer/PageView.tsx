import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Button, PageHeader, Panel, Tabs, TabsContent, TabsList, TabsTrigger, cn } from '@adminforge/ui';
import {
  LicenceGatePanel,
  contentHref,
  evaluateTemplate,
  getPath,
  splitDataRef,
  type InspectTarget,
  type PlaybookLaunch,
  type ProbesState,
  type TableViewState,
  type WidgetRuntime,
  useTemplate,
} from '@adminforge/widgets';
import { loginUrl } from '../lib/api';
import { browser } from '../lib/browser';
import { AppLink, useNavigateHref } from '../lib/links';
import { setKpiCollapsed, usePrefs } from '../lib/prefs';
import { useMe, useNav } from '../lib/session';
import { playbookSearch } from '../playbooks/url';
import {
  capabilitiesQuery,
  probesQuery,
  toProbeSummary,
  toWidgetError,
  viewsQuery,
  type PageDefinition,
} from './api';
import { ActionGroup, usePlaybookWrite } from './ActionGroup';
import { WidgetGrid, type Block, type KpiCollapse } from './blocks';
import { ExportMenu } from './ExportMenu';
import { FilterRegion, filterParamsOf } from './FilterRegion';
import {
  activeBlocks,
  exportTableId,
  licenceState,
  neededDatasources,
  sectionLabel,
  tableColumns,
  withIds,
  type TableColumns,
} from './page-model';
import {
  DefinitionBadges,
  EntityHeader,
  hasDefinitionBadges,
  RefreshControl,
  SignInBanner,
} from './PageParts';
import { ParamsForm } from './ParamsForm';
import { advancedParamOf, decodeFilter, paramIssues } from './QueryBuilder';
import { paramsToSearch, resolveParams } from './params';
import { usePageData } from './use-page-data';
import {
  pageSearch,
  readInspect,
  readTableView,
  tableSearch,
  tableViewToSearch,
  withInspect,
} from './url-state';
import { presetId, readDefaultView, sameState, ViewsMenu, viewStateOf, type ViewState } from './ViewsMenu';

export type SearchPatch = Record<string, unknown>;
export type SearchUpdate = (
  patch: SearchPatch | ((prev: SearchPatch) => SearchPatch),
  opts?: { replace?: boolean },
) => Promise<void>;

export interface PageViewProps {
  def: PageDefinition;
  /** Page params, `tab` and table state as this page sees them (the inspector maps its `i.*` keys to these). */
  search: SearchPatch;
  /** Writes page-level keys back (undefined removes a key). */
  update: SearchUpdate;
  /** Rendered inside the inspector drawer: compact header, one column, table state not kept in the URL. */
  inspector?: boolean;
  /** Saved view id from `?view=` (main page only). */
  viewId?: string;
  onTitle?: (title: string | undefined) => void;
  /** Inspector only: the address of this page on its own (the drawer header shows "Open full page"). */
  onFullPageHref?: (href: string | undefined) => void;
}

const NO_PROBES: ProbesState = { status: 'loading', probes: [] };

/** Probe results for probeStatus widgets (shared with the monitoring page's query). */
function useProbesHook(): WidgetRuntime['useProbes'] {
  return useCallback(function useProbes(keys: string[] | undefined): ProbesState {
    const q = useQuery({ ...probesQuery, select: (d) => d.items });
    if (q.isPending) return NO_PROBES;
    if (q.isError)
      return { status: 'error', probes: [], error: toWidgetError(q.error), retry: () => void q.refetch() };
    const all = (q.data ?? []).map(toProbeSummary);
    return {
      status: 'ready',
      probes: keys ? all.filter((p) => keys.includes(p.key)) : all,
      retry: () => void q.refetch(),
    };
  }, []);
}

/** URL-backed table state with an immediate local overlay (typing in a filter shouldn't wait for the router). */
function useTableViews(
  search: SearchPatch,
  update: SearchUpdate,
  columns: Record<string, TableColumns>,
  enabled: boolean,
) {
  const [pending, setPending] = useState<Record<string, TableViewState>>({});
  const timers = useRef<Record<string, number>>({});
  useEffect(() => {
    const t = timers.current;
    return () => Object.values(t).forEach((id) => window.clearTimeout(id));
  }, []);
  const get = useCallback(
    (ns: string) => pending[ns] ?? readTableView(search, ns, columns[ns]?.all),
    [pending, search, columns],
  );
  const set = useCallback(
    (ns: string, view: TableViewState) => {
      setPending((p) => ({ ...p, [ns]: view }));
      window.clearTimeout(timers.current[ns]);
      timers.current[ns] = window.setTimeout(() => {
        const cols = columns[ns] ?? { all: [], visible: [] };
        void update(tableViewToSearch(ns, view, cols), { replace: true }).finally(() =>
          setPending((p) => {
            if (p[ns] !== view) return p;
            const { [ns]: _done, ...rest } = p;
            return rest;
          }),
        );
      }, 250);
    },
    [columns, update],
  );
  const reset = useCallback(() => setPending({}), []);
  return enabled ? { get, set, reset } : { get: () => undefined, set: undefined, reset };
}

/**
 * Renders any published page, dashboard or report with its template (§6.6): dashboard · list-detail · entity ·
 * report · settings. Params live in the URL; data comes from the BFF; widgets come from @adminforge/widgets.
 */
export function PageView({ def, search, update, inspector, viewId, onTitle, onFullPageHref }: PageViewProps) {
  const me = useMe();
  const nav = useNav();
  const navigate = useNavigate();
  const navigateHref = useNavigateHref();
  const location = useRouterState({ select: (s) => s.location.search as SearchPatch });
  const template = (def.template as string | undefined) ?? (def.kind === 'report' ? 'report' : 'dashboard');

  const params = useMemo(() => resolveParams(def.params, search), [def.params, search]);
  // The full page opens on the tab the inspector shows.
  const inspectorTab = inspector && typeof search.tab === 'string' ? search.tab : undefined;
  const fullPageHref = inspector
    ? contentHref(def.id, inspectorTab ? { ...params.send, tab: inspectorTab } : params.send)
    : undefined;
  useEffect(() => onFullPageHref?.(fullPageHref), [fullPageHref, onFullPageHref]);
  useEffect(() => () => onFullPageHref?.(undefined), [onFullPageHref]);
  // Query builder (`filters.advanced`): the URL carries the structured filter as base64url JSON (`?adv=…`); requests
  // send it as the JSON object and the BFF validates and compiles it. (`client` dialect builders aren't offered.)
  const advSpec = def.filters?.advanced?.dialect === 'client' ? undefined : def.filters?.advanced;
  const advParam = advSpec ? advancedParamOf(advSpec) : undefined;
  const advFilter = useMemo(
    () => (advParam ? decodeFilter(search[advParam]) : undefined),
    [advParam, search],
  );
  const send = useMemo(
    () => (advParam && advFilter ? { ...params.send, [advParam]: advFilter } : params.send),
    [params.send, advParam, advFilter],
  );
  const { blocks, tab } = useMemo(
    () => activeBlocks(def, typeof search.tab === 'string' ? search.tab : undefined),
    [def, search.tab],
  );
  const headerBlocks = useMemo(
    () =>
      def.tabs?.length && def.layout?.length && template === 'entity' ? withIds(def.layout, 'head_') : [],
    [def, template],
  );
  const allBlocks = useMemo(() => [...headerBlocks, ...blocks], [headerBlocks, blocks]);

  // Licences: only asked for when the page could be gated.
  const gateRelevant =
    Boolean(def.requires?.licences?.length) || allBlocks.some((b) => b.widget === 'licenceGate');
  const caps = useQuery({ ...capabilitiesQuery, enabled: gateRelevant });
  const licence = licenceState(def, caps.data);
  const preview = licence.missing.length > 0 && me.dataMode === 'fixtures';
  const blocked = licence.missing.length > 0 && !preview;

  const needed = useMemo(
    () => (blocked ? [] : neededDatasources(def, [allBlocks, def.header, def.actions])),
    [blocked, def, allBlocks],
  );
  const data = usePageData(def, send, needed, !blocked && (!gateRelevant || !caps.isPending));
  // Microsoft wants a fresh sign-in for some of the page's data (`reauth`): one banner offers it, and the widgets
  // with that error stay quiet instead of repeating it (runtime.signInBanner).
  const signInError = useMemo(() => {
    for (const name of needed) {
      const e = data.resolve(name).error;
      if (e?.code === 'reauth') return e;
    }
    return undefined;
  }, [needed, data]);

  // A 400 invalid_params lists every problem; show each next to its control (advanced filter or facet).
  const serverIssues = useMemo(() => {
    const f = data.failure;
    if (!f || f.code !== 'invalid_params') return {};
    return paramIssues(f.message, [...Object.keys(def.params ?? {}), ...(advParam ? [advParam] : [])]);
  }, [data.failure, def.params, advParam]);
  const filterIssues = useMemo(() => {
    const out: Record<string, string> = { ...params.issues };
    for (const [name, msgs] of Object.entries(serverIssues))
      if (name !== advParam) out[name] = `${def.params?.[name]?.label ?? name} ${msgs.join('; ')}`;
    return out;
  }, [params.issues, serverIssues, advParam, def.params]);
  const advanced = useMemo(
    () =>
      advSpec
        ? { spec: advSpec, filter: advFilter, issues: advParam ? (serverIssues[advParam] ?? []) : [] }
        : undefined,
    [advSpec, advFilter, advParam, serverIssues],
  );

  const [mountedAt] = useState(() => Date.now());
  const scope = useMemo(
    () => ({
      user: { oid: me.user.oid, upn: me.user.upn, name: me.user.name, roles: me.roles },
      now: new Date(Math.max(mountedAt, data.updatedAt)).toISOString(),
      ...data.scopeData,
      params: params.values,
    }),
    [me, mountedAt, data.updatedAt, data.scopeData, params.values],
  );

  const columns = useMemo(() => tableColumns(allBlocks), [allBlocks]);
  const tableViews = useTableViews(search, update, columns, !inspector);
  const useProbes = useProbesHook();
  const inspecting = useMemo(() => readInspect(location), [location]);

  const runtime: WidgetRuntime = useMemo(
    () => ({
      pageKey: def.id,
      scope,
      resolve: (path: string) => {
        const { root, rest } = splitDataRef(path);
        return getPath(data.scopeData[root], rest);
      },
      Link: AppLink,
      navigate: navigateHref,
      hrefFor: contentHref,
      openPlaybook: (launch: PlaybookLaunch) =>
        void navigate({
          to: '.',
          search: ((prev: SearchPatch) => ({ ...prev, ...playbookSearch(launch) })) as never,
        }),
      inspect: (target: InspectTarget) =>
        void navigate({ to: '.', search: ((prev: SearchPatch) => withInspect(prev, target)) as never }),
      inspecting,
      tableView: tableViews.get,
      setTableView: tableViews.set,
      hasServerSearch: Boolean(def.filters?.search),
      feature: (key: string) => caps.data?.features[key],
      dataMode: me.dataMode,
      useProbes,
      usePlaybookWrite,
      signIn: (login: string) => browser.assign(loginUrl(login)),
      signInBanner: Boolean(signInError),
    }),
    [
      def.id,
      def.filters?.search,
      scope,
      data.scopeData,
      navigate,
      navigateHref,
      inspecting,
      tableViews.get,
      tableViews.set,
      caps.data,
      me.dataMode,
      useProbes,
      signInError,
    ],
  );

  const setParams = useCallback(
    (patch: SearchPatch) => void update({ ...paramsToSearch(def.params, patch), view: undefined }, {}),
    [update, def.params],
  );

  // ── Saved views ──────────────────────────────────────────────────────────────────────────────────
  const viewsEnabled =
    !inspector && (def.savedViews?.enabled ?? (template === 'list-detail' || template === 'report'));
  const firstTable = Object.keys(columns)[0];
  const presets = useMemo(
    () =>
      (def.savedViews?.presets ?? []).map((p) => ({
        name: p.name,
        state: {
          params: Object.fromEntries(
            Object.entries(paramsToSearch(def.params, p.params)).filter(([, v]) => v !== undefined),
          ),
          table: p.columns && firstTable ? { [`${firstTable}.cols`]: p.columns.join(',') } : {},
        } satisfies ViewState,
      })),
    [def.savedViews?.presets, def.params, firstTable],
  );
  const currentState: ViewState = useMemo(() => {
    const declared = new Set([...Object.keys(def.params ?? {}), ...(advParam ? [advParam] : [])]);
    return {
      params: Object.fromEntries(Object.entries(pageSearch(search)).filter(([k]) => declared.has(k))),
      table: tableSearch(search),
    };
  }, [search, def.params, advParam]);
  const applyView = useCallback(
    (id: string | undefined, state: ViewState, opts?: { replace?: boolean }) => {
      tableViews.reset();
      void update((prev) => {
        const next: SearchPatch = {};
        for (const [k, v] of Object.entries(prev)) {
          const isParam = !k.includes('.') && (Object.hasOwn(def.params ?? {}, k) || k === advParam);
          const isTable = k.includes('.') && !k.startsWith('i.');
          if (!isParam && !isTable && k !== 'view') next[k] = v;
        }
        return { ...next, ...state.params, ...state.table, view: id || undefined };
      }, opts);
    },
    [update, def.params, tableViews, advParam],
  );

  // Open the user's default view when the page is opened without any state in the URL.
  const views = useQuery({ ...viewsQuery(def.id), enabled: viewsEnabled });
  const triedDefault = useRef(false);
  useEffect(() => {
    if (!viewsEnabled || triedDefault.current) return;
    const id = readDefaultView(def.id);
    const pristine =
      !viewId && !Object.keys(currentState.params).length && !Object.keys(currentState.table).length;
    if (!id || !pristine) {
      triedDefault.current = true;
      return;
    }
    const preset = presets.find((p) => presetId(p.name) === id);
    if (preset) {
      triedDefault.current = true;
      applyView(id, preset.state, { replace: true });
      return;
    }
    if (views.isPending) return;
    triedDefault.current = true;
    const saved = views.data?.find((v) => v.id === id);
    if (saved) applyView(id, viewStateOf(saved), { replace: true });
  }, [viewsEnabled, def.id, viewId, currentState, presets, views.isPending, views.data, applyView]);

  // ── Export ───────────────────────────────────────────────────────────────────────────────────────
  // `export.data` may be a template over params (a page whose views switch tables): rendered as the server renders it.
  const exportScope = useMemo(() => ({ params }), [params]);
  const exportRef = useTemplate<unknown>(def.export?.data, exportScope, Boolean(def.export?.data));
  const exportTable = useMemo(
    () =>
      def.export ? exportTableId(allBlocks, def.datasources, def.export.data, exportRef.value) : undefined,
    [def.export, def.datasources, exportRef.value, allBlocks],
  );
  const exportColumns = useMemo(() => {
    if (!exportTable) return undefined;
    const view = tableViews.get(exportTable);
    const cols = columns[exportTable]!;
    const order = view?.columnOrder?.length
      ? [...view.columnOrder, ...cols.all.filter((c) => !view.columnOrder!.includes(c))]
      : cols.all;
    const vis = view?.columnVisibility;
    return order.filter((c) => cols.all.includes(c) && (vis?.[c] ?? cols.visible.includes(c)));
  }, [exportTable, tableViews, columns]);
  const [fileName, setFileName] = useState(def.id.split('.').pop() ?? 'export');
  useEffect(() => {
    let live = true;
    if (def.export?.fileName)
      void evaluateTemplate<unknown>(def.export.fileName, scope).then(
        (v) => live && typeof v === 'string' && v && setFileName(v),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [def.export?.fileName, scope]);

  // ── Layout ───────────────────────────────────────────────────────────────────────────────────────
  const section = sectionLabel(def, nav.data?.sections);
  const filterParams = useMemo(
    () => (template === 'report' ? [] : filterParamsOf(def, allBlocks)),
    [template, def, allBlocks],
  );
  const refresh = (
    <RefreshControl
      updatedAt={data.updatedAt}
      fetching={data.fetching}
      onRefresh={data.refresh}
      every={def.refresh}
    />
  );
  const exportMenu = def.export && !inspector && (
    <ExportMenu
      pageKey={def.id}
      version={def.version}
      spec={def.export}
      params={send}
      columns={exportColumns}
      fallbackName={fileName}
    />
  );
  const viewsMenu = viewsEnabled && (
    <ViewsMenu
      page={def.id}
      spec={def.savedViews}
      presets={presets}
      current={currentState}
      activeId={viewId ?? (presets.some((p) => sameState(p.state, currentState)) ? undefined : '')}
      onApply={(id, state) => applyView(id, state)}
    />
  );

  const signInBanner = signInError && <SignInBanner error={signInError} />;
  const gate = licence.missing.length > 0 && (
    <LicenceGatePanel missing={licence.missing} preview={preview} className={cn(!blocked && 'mb-0')} />
  );

  // The page-level gate already explains these features; drop licenceGate blocks that would repeat it.
  const gatedKeys = new Set(licence.missing.map((m) => m.key));
  const notGated = (b: readonly Block[]) =>
    b.filter(
      (x) => !(x.widget === 'licenceGate' && gatedKeys.has(String((x as { feature?: unknown }).feature))),
    );
  // List pages: the KPI strip folds to one line, remembered per page (D-11).
  const listPage = template === 'list-detail' && !inspector;
  const kpiCollapsedPages = usePrefs().kpiCollapsed;
  const kpis: KpiCollapse | undefined = useMemo(
    () =>
      listPage
        ? {
            collapsed: Boolean(kpiCollapsedPages?.includes(def.id)),
            onToggle: (collapsed: boolean) => setKpiCollapsed(def.id, collapsed),
          }
        : undefined,
    [listPage, kpiCollapsedPages, def.id],
  );
  const grid = (b: readonly Block[]) => (
    <WidgetGrid
      blocks={notGated(b)}
      runtime={runtime}
      data={data}
      inspector={inspector}
      kpis={kpis}
      // Its own stacking context: sticky table headers inside stay under the sticky filter bar.
      className={listPage ? 'isolate' : undefined}
    />
  );

  // Entity: identity header, page actions, optional blocks above tabs, then tabs.
  if (template === 'entity') {
    const tabs = def.tabs ?? [];
    const setTab = (t: string) => void update({ tab: t === tabs[0]?.id ? undefined : t }, { replace: true });
    return (
      // In the inspector the widget grid follows the drawer's width (container query, renderer/blocks.tsx).
      <div className={cn('flex flex-col gap-(--af-gap-grid)', inspector && '@container')}>
        <EntityHeader
          def={def}
          runtime={runtime}
          loading={!data.settled}
          section={section}
          inspector={inspector}
          onTitle={onTitle}
          data={data}
        />
        {gate}
        {signInBanner}
        {!blocked && headerBlocks.length > 0 && grid(headerBlocks)}
        {!blocked &&
          (tabs.length > 1 ? (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList aria-label={`${def.title} sections`} className="overflow-x-auto">
                {tabs.map((t) => (
                  <TabsTrigger key={t.id} value={t.id}>
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value={tab ?? tabs[0]!.id}>{grid(blocks)}</TabsContent>
            </Tabs>
          ) : (
            grid(blocks)
          ))}
      </div>
    );
  }

  const header = !inspector && (
    <PageHeader
      linkAs={AppLink}
      layout={template === 'list-detail' ? 'list' : 'default'}
      eyebrow={section}
      title={def.title}
      meta={hasDefinitionBadges(def) && <DefinitionBadges def={def} />}
      description={def.summary}
      actions={
        // A gated page has no data to refresh, save or export.
        !blocked && (
          <>
            {refresh}
            {viewsMenu}
            {template !== 'report' && exportMenu}
            {def.actions?.length ? (
              <ActionGroup actions={def.actions} scope={scope} runtime={runtime} />
            ) : null}
          </>
        )
      }
    />
  );

  if (template === 'report') {
    const summary = blocks.filter((b) => b.widget !== 'table');
    const tables = blocks.filter((b) => b.widget === 'table');
    return (
      <div className="flex flex-col gap-(--af-gap-grid)">
        {header}
        {gate}
        {signInBanner}
        {!blocked && (
          <>
            <ParamsForm
              declared={def.params ?? {}}
              values={params.values}
              issues={filterIssues}
              onChange={setParams}
            />
            {summary.length > 0 && grid(summary)}
            {tables.length > 0 && grid(tables)}
            {def.export && (
              <Panel aria-label="Export">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <p className="font-semibold text-fg">Export this report</p>
                    <p className="text-sm text-fg-2">
                      Every row for these parameters — not just the rows loaded above. The export is recorded
                      in the audit log.
                    </p>
                  </div>
                  <ExportMenu
                    pageKey={def.id}
                    version={def.version}
                    spec={def.export}
                    params={send}
                    columns={exportColumns}
                    fallbackName={fileName}
                    intent="primary"
                    label="Export report"
                  />
                </div>
              </Panel>
            )}
          </>
        )}
      </div>
    );
  }

  if (template === 'settings' && (def.tabs?.length ?? 0) > 1) {
    const tabs = def.tabs!;
    return (
      <div className="flex flex-col gap-(--af-gap-grid)">
        {header}
        {gate}
        {signInBanner}
        <div className="grid gap-(--af-gap-grid) lg:grid-cols-12">
          <nav aria-label={`${def.title} sections`} className="lg:col-span-3">
            <ul className="flex flex-col gap-0.5">
              {tabs.map((t) => (
                <li key={t.id}>
                  <Button
                    intent="ghost"
                    aria-current={t.id === tab ? 'page' : undefined}
                    className={cn(
                      'w-full justify-start',
                      t.id === tab && 'af-nav-active bg-selected text-fg',
                    )}
                    onClick={() =>
                      void update({ tab: t.id === tabs[0]!.id ? undefined : t.id }, { replace: true })
                    }
                  >
                    {t.label}
                  </Button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="min-w-0 lg:col-span-9">{!blocked && grid(blocks)}</div>
        </div>
      </div>
    );
  }

  // dashboard · list-detail · settings without sections
  return (
    <div className="flex flex-col gap-(--af-gap-grid)">
      {header}
      {gate}
      {signInBanner}
      {!blocked && filterParams.length + (def.filters?.search ? 1 : 0) + (advanced ? 1 : 0) > 0 && (
        <FilterRegion
          declared={def.params ?? {}}
          searchParam={def.filters?.search}
          filterParams={filterParams}
          values={params.values}
          issues={filterIssues}
          onChange={setParams}
          advanced={advanced}
          sticky={listPage}
        />
      )}
      {!blocked && grid(blocks)}
    </div>
  );
}
