import { z } from 'zod';

/**
 * Contracts of the content & platform API (definitions, datasources, search, capabilities, saved views, export, SSE,
 * audit, appearance, settings). The BFF validates requests with these; the web app parses responses with them.
 * Response objects are non-strict: fields may be added, never removed or renamed.
 */

/** Where data came from (widget provenance footer). `path` is a template ("/users/{id}"), never raw ids. */
export const ProvenanceInfo = z.object({
  service: z.string(),
  path: z.string(),
  ms: z.number(),
  requestId: z.string().optional(),
  /** Set when the result came from the per-user cache. */
  cachedAt: z.string().optional(),
});
export type ProvenanceInfo = z.infer<typeof ProvenanceInfo>;

/** A partial failure (one datasource, one $batch sub-request, one capability section). */
export const ErrorInfo = z.object({ code: z.string(), message: z.string(), hint: z.string().optional() });
export type ErrorInfo = z.infer<typeof ErrorInfo>;

// ── Definitions ──────────────────────────────────────────────────────────────

/** GET /api/definitions/:kind/:key[?version] → the client-safe definition plus `version` and `sha256`. */
export const DefinitionResponse = z.looseObject({
  kind: z.string(),
  id: z.string(),
  version: z.string(),
  sha256: z.string(),
  title: z.string(),
});
export type DefinitionResponse = z.infer<typeof DefinitionResponse>;

/** GET /api/definitions?kind= */
export const DefinitionSummary = z.object({
  kind: z.string(),
  key: z.string(),
  version: z.string(),
  sha256: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  owner: z.string(),
  status: z.string().optional(),
  template: z.string().optional(),
  nav: z
    .object({
      section: z.string(),
      label: z.string().optional(),
      icon: z.string().optional(),
      order: z.number().optional(),
      hidden: z.boolean().optional(),
    })
    .optional(),
  risk: z.string().optional(),
  mode: z.string().optional(),
  /** In-app route: /p/<key> (page, dashboard, report), /playbooks/<key>, /runbooks/<key>. */
  href: z.string().optional(),
  /** "Requires <licence>" when the tenant lacks a declared licence. */
  badge: z.string().optional(),
});
export const DefinitionListResponse = z.object({ items: z.array(DefinitionSummary) });
export type DefinitionSummary = z.infer<typeof DefinitionSummary>;
export type DefinitionListResponse = z.infer<typeof DefinitionListResponse>;

// ── Datasources ──────────────────────────────────────────────────────────────

const PageRef = z.string().min(1).max(200);
const DefVersion = z.string().min(1).max(100).optional();
const ParamValues = z.record(z.string(), z.unknown()).optional();

/** POST /api/datasources/execute */
export const DatasourceExecuteRequest = z.object({
  page: PageRef,
  version: DefVersion,
  datasource: z.string().min(1).max(100),
  params: ParamValues,
  /** `cursor` from the previous result (paging: cursor). Opaque. */
  cursor: z.string().max(8192).optional(),
});
export type DatasourceExecuteRequest = z.infer<typeof DatasourceExecuteRequest>;

export const DatasourceResult = z.object({
  data: z.unknown(),
  /** Next page (paging: cursor); absent on the last page. */
  cursor: z.string().optional(),
  /** null for static and skipped datasources. */
  provenance: ProvenanceInfo.nullable(),
  /** graphBatch: failed sub-requests (their values in `data` are null). */
  errors: z.record(z.string(), ErrorInfo).optional(),
  /** The datasource's `when` was false; data is null. */
  skipped: z.literal(true).optional(),
});
export type DatasourceResult = z.infer<typeof DatasourceResult>;

/** POST /api/datasources/execute-many — every datasource of the page when `datasources` is omitted. */
export const DatasourceExecuteManyRequest = z.object({
  page: PageRef,
  version: DefVersion,
  datasources: z.array(z.string().min(1).max(100)).max(50).optional(),
  params: ParamValues,
});
export type DatasourceExecuteManyRequest = z.infer<typeof DatasourceExecuteManyRequest>;

export const DatasourceFailure = z.object({ error: ErrorInfo });
export const DatasourceExecuteManyResponse = z.object({
  page: z.string(),
  version: z.string(),
  sha256: z.string(),
  results: z.record(z.string(), z.union([DatasourceFailure, DatasourceResult])),
});
export type DatasourceExecuteManyResponse = z.infer<typeof DatasourceExecuteManyResponse>;

// ── Search ───────────────────────────────────────────────────────────────────

export const SEARCH_RESULT_TYPES = [
  'page',
  'dashboard',
  'report',
  'playbook',
  'runbook',
  'user',
  'group',
  'device',
  'app',
  'resource',
] as const;
export const SearchResultType = z.enum(SEARCH_RESULT_TYPES);

/** GET /api/search?q=&type= */
export const SearchResponse = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      type: SearchResultType,
      id: z.string().optional(),
      title: z.string(),
      subtitle: z.string().optional(),
      /** In-app route, or an https deep link into the Entra/Azure portals when `external`. */
      href: z.string(),
      external: z.boolean().optional(),
      icon: z.string().optional(),
    }),
  ),
  /** ok | timeout | error | skipped per source. */
  sources: z.record(z.string(), z.enum(['ok', 'timeout', 'error', 'skipped'])),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

// ── Capabilities ─────────────────────────────────────────────────────────────

export const FEATURE_KEYS = [
  'conditionalAccess',
  'pim',
  'identityProtection',
  'intune',
  'exchange',
  'teams',
  'sharepoint',
  'defender',
  'signInLogs',
] as const;

export const FeatureState = z.object({
  available: z.boolean(),
  /** Why not (e.g. "Requires Microsoft Entra ID P2 (AAD_PREMIUM_P2)"), or that licences could not be read. */
  reason: z.string().optional(),
  /** The tenant SKU providing it when available; otherwise the SKU / service plan that would enable it. */
  sku: z.string().optional(),
  label: z.string().optional(),
  servicePlans: z.array(z.string()).optional(),
});
export const DirectoryRoleInfo = z.object({
  /** Role definition id. */
  id: z.string(),
  displayName: z.string(),
  directoryScopeId: z.string().optional(),
  memberType: z.string().optional(),
  assignmentType: z.string().optional(),
  startDateTime: z.string().nullable().optional(),
  endDateTime: z.string().nullable().optional(),
});

/** GET /api/me/capabilities */
export const CapabilitiesResponse = z.object({
  features: z.record(z.string(), FeatureState),
  roles: z.object({
    active: z.array(DirectoryRoleInfo),
    eligible: z.array(DirectoryRoleInfo),
    /** false without Entra ID P2 / permission: hide "Activate in PIM". */
    eligibleAvailable: z.boolean().optional(),
    activeSource: z.enum(['pim', 'assignments']).nullable().optional(),
  }),
  skus: z
    .array(
      z.object({
        skuPartNumber: z.string(),
        capabilityStatus: z.string(),
        enabled: z.number(),
        consumed: z.number(),
      }),
    )
    .optional(),
  errors: z.record(z.string(), ErrorInfo).optional(),
  provenance: ProvenanceInfo.optional(),
});
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponse>;

// ── Saved views ──────────────────────────────────────────────────────────────

export const MAX_VIEW_STATE_BYTES = 16 * 1024;
/** Opaque to the API (params, columns, sort, filters, density…), ≤ 16 KB as JSON. */
export const SavedViewState = z
  .record(z.string(), z.unknown())
  .refine(
    (s) => JSON.stringify(s).length <= MAX_VIEW_STATE_BYTES,
    `View state must be at most ${MAX_VIEW_STATE_BYTES / 1024} KB`,
  );
const ViewName = z.string().trim().min(1).max(80);

export const SavedView = z.object({
  id: z.string(),
  page: z.string(),
  name: z.string(),
  state: z.record(z.string(), z.unknown()),
  shared: z.boolean(),
  /** Owner's object id. */
  owner: z.string(),
  /** The caller owns it (may edit/delete). */
  mine: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedView = z.infer<typeof SavedView>;
/** GET /api/views?page= */
export const SavedViewList = z.object({ items: z.array(SavedView) });
/** POST /api/views → 201 SavedView */
export const CreateViewRequest = z.object({
  page: PageRef,
  name: ViewName,
  state: SavedViewState,
  shared: z.boolean().optional(),
});
/** PATCH /api/views/:id → SavedView (owner only). DELETE /api/views/:id → 204. */
export const UpdateViewRequest = z
  .object({ name: ViewName.optional(), state: SavedViewState.optional(), shared: z.boolean().optional() })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export type CreateViewRequest = z.infer<typeof CreateViewRequest>;
export type UpdateViewRequest = z.infer<typeof UpdateViewRequest>;

// ── Report export ────────────────────────────────────────────────────────────

/** POST /api/reports/:key/export → the file (Content-Disposition attachment). `columns` = field names (visible-column exports). */
export const ExportRequest = z.object({
  params: ParamValues,
  format: z.enum(['csv', 'xlsx']),
  columns: z.array(z.string().min(1).max(200)).max(200).optional(),
  version: DefVersion,
});
export type ExportRequest = z.infer<typeof ExportRequest>;

// ── Events (GET /api/events, SSE) ────────────────────────────────────────────

export const SSE_EVENTS = [
  'ready',
  'definitions.changed',
  'session.mode',
  'session.ended',
  'run.updated',
  'appearance.changed',
] as const;
export const DefinitionsChangedEvent = z.object({
  keys: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});
export const SessionModeEvent = z.object({
  mode: z.enum(['read', 'armed']),
  armedUntil: z.string().nullable(),
});

// ── Audit, appearance, settings (Portal.Admin) ───────────────────────────────

export const AuditItem = z.object({
  seq: z.number(),
  ts: z.string(),
  actorUpn: z.string().nullable(),
  actorOid: z.string().nullable().optional(),
  mode: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  result: z.string(),
  correlationId: z.string(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
/** GET /api/audit?actor=&action=&from=&to=&cursor=&limit= (newest first; action may end in `.` or `*` for a prefix) */
export const AuditPage = z.object({ items: z.array(AuditItem), cursor: z.string().optional() });
/** GET /api/audit/verify */
export const AuditVerifyResponse = z.object({
  ok: z.boolean(),
  checked: z.number(),
  brokenAt: z.number().optional(),
});
export type AuditItem = z.infer<typeof AuditItem>;
export type AuditPage = z.infer<typeof AuditPage>;

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const AppearanceThemeOverrides = z.object({
  accent: HexColor.optional(),
  'accent-strong': HexColor.optional(),
  focus: HexColor.optional(),
  'radius-scale': z.number().optional(),
});
/** GET /api/admin/appearance; PUT takes the same body (+ the `version` it was based on → 409 when stale). */
export const AppearanceResponse = z.object({
  version: z.number(),
  overrides: z.record(z.string(), AppearanceThemeOverrides),
  /** Default theme for people without a preference (`system` = follow their OS). */
  theme: z.enum(['steel', 'daylight', 'contrast', 'system']).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  fontScale: z.number().optional(),
});
export type AppearanceResponse = z.infer<typeof AppearanceResponse>;

/** GET /api/admin/settings */
export const AdminSettingsResponse = z.object({
  authMode: z.enum(['entra', 'mock']),
  dataMode: z.enum(['live', 'fixtures']),
  contentSource: z.enum(['fs', 'db']),
  writeSessionMaxMinutes: z.number(),
  apps: z.object({ read: z.boolean(), write: z.boolean(), automation: z.boolean() }),
  tenant: z.object({ name: z.string(), domain: z.string() }),
});
export type AdminSettingsResponse = z.infer<typeof AdminSettingsResponse>;
