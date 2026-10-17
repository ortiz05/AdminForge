import type { ComponentType } from 'react';
import type { z } from 'zod';
import type { Scope } from '@adminforge/expressions';
import type { DataTableView, LinkComponent, Provenance, TableDensity } from '@adminforge/ui';

/** A failed load, in the BFF's error vocabulary (§6.9: what happened, what to do, how to trace it). */
export interface WidgetError {
  code?: string;
  message: string;
  hint?: string;
  correlationId?: string;
  /** `reauth`: where the browser signs in again — the error offers "Sign in again" instead of "Try again". */
  login?: string;
}

/** What the renderer resolved for a widget's `data` reference. */
export interface WidgetData {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** The value at the `data` path (arrays are concatenated across loaded pages). */
  value: unknown;
  error?: WidgetError;
  /** Where the data came from (null for static data). */
  provenance?: Provenance | null;
  /** More pages exist (`paging: cursor`). */
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMore?: () => void;
  retry?: () => void;
  /** Sample data shown because the tenant lacks a licence (mock mode only). */
  preview?: boolean;
  /** Only part of the result: Microsoft had more than the datasource reads (`paging: all` cap, a `$batch` first page). */
  truncated?: boolean;
}

/**
 * `?playbook=<key>&inputs=…` (single) or `&items=…` (bulk, one inputs object per selected row; each may carry a
 * display-only `$label`, e.g. the row's name, which the drawer shows and strips before running).
 */
export interface PlaybookLaunch {
  playbook: string;
  inputs?: Record<string, unknown>;
  items?: Array<Record<string, unknown>>;
}

/** An entity page shown in the inspector drawer. */
export interface InspectTarget {
  page: string;
  params: Record<string, unknown>;
}

/** Table state the renderer keeps in the URL and saved views. */
export interface TableViewState extends DataTableView {
  density?: TableDensity;
}

/** One licensable feature from GET /api/me/capabilities. `available: null` = unknown (licences unreadable). */
export interface FeatureState {
  available: boolean | null;
  label: string;
  /** Why it's unavailable, in plain words. */
  reason?: string;
  /** What to license (SKU / service plan). */
  sku?: string;
}

export type ProbeHealth = 'ok' | 'warn' | 'crit' | 'error' | 'unknown';

/** Latest result + recent history of one synthetic probe. */
export interface ProbeSummary {
  key: string;
  title: string;
  /** The service it watches (the probe's `group`), when it names one. */
  group?: string | null;
  /** What to do when it warns or fails (the probe's `remedy`). */
  remedy?: string | null;
  /** Where its full result is (what it found, history): built by the app, e.g. `/monitoring?probe=…`. */
  href?: string;
  status: ProbeHealth;
  metric?: number | null;
  unit?: string;
  message?: string | null;
  lastRunAt?: string | null;
  durationMs?: number | null;
  history?: Array<{ ts: string; status: ProbeHealth; metric?: number | null }>;
}

export interface ProbesState {
  status: 'loading' | 'ready' | 'error';
  probes: ProbeSummary[];
  error?: WidgetError;
  provenance?: Provenance | null;
  retry?: () => void;
}

/**
 * Services a widget may use, supplied by the page renderer (or a test). Widgets never fetch on their own,
 * never touch the router directly, and never build URLs by hand.
 */
export interface WidgetRuntime {
  pageKey: string;
  /** Expression scope for page-level templates: `params`, `user`, `now`, and each datasource's data by name. */
  scope: Scope;
  /** Resolves another datasource path (KPI `delta`, `trend`), e.g. `counts.membersDelta`. */
  resolve: (path: string) => unknown;
  /** In-app or external link (the router's Link in the app). */
  Link: LinkComponent;
  navigate: (href: string) => void;
  /** URL of a content page with params, e.g. `/p/identity.user?id=…`. */
  hrefFor: (page: string, params?: Record<string, unknown>) => string;
  /** Opens the playbook drawer (URL params) — the drawer itself asks for anything missing and handles write access. */
  openPlaybook: (launch: PlaybookLaunch) => void;
  /** Opens an entity page in the inspector. */
  inspect?: (target: InspectTarget) => void;
  /** What the inspector shows now (to highlight the row). */
  inspecting?: InspectTarget | null;
  /** URL-backed table state per table instance; without `setTableView` tables keep their own state. */
  tableView: (instanceId: string) => TableViewState | undefined;
  setTableView?: (instanceId: string, view: TableViewState) => void;
  /** The page binds a server-side search param, so tables hide their own search box by default. */
  hasServerSearch?: boolean;
  /** Licence state of a feature (`intune`, `pim`, …). */
  feature: (key: string) => FeatureState | undefined;
  /** `fixtures` = mock mode (licence gates still preview sample data). */
  dataMode: 'live' | 'fixtures';
  /** Synthetic probe results (a hook: call it unconditionally). */
  useProbes: (keys: string[] | undefined) => ProbesState;
  /** Starts a sign-in at `login` (a `reauth` error's URL), keeping the person's place. */
  signIn?: (login: string) => void;
  /**
   * The page shows one "Sign in again" banner for its `reauth` errors, so widgets with that error stay quiet instead
   * of repeating it.
   */
  signInBanner?: boolean;
}

export interface WidgetProps<C> {
  config: C;
  data: WidgetData;
  runtime: WidgetRuntime;
  /** Stable per-page id of this block (`id`, or `<widget><index>`); keys URL state. */
  instanceId: string;
  /** `cell` = inside a KPI strip; `inspector` = inside the narrow drawer. */
  variant?: 'tile' | 'cell' | 'inspector';
}

export interface WidgetDefinition<C = unknown> {
  type: string;
  schema: z.ZodType<C>;
  component: ComponentType<WidgetProps<C>>;
  /** Default columns on the 12-column grid. */
  span: number;
  /** Whether the block needs a `data` reference. */
  needsData: boolean;
}
