import { z } from 'zod';
import { DefinitionId, Expr, HttpMethod, Identifier, Requires, exprOr } from './common';

/**
 * Request specs shared by datasources (§7.5) and playbook steps (§7.7). Every string may contain `${ … }`;
 * path segments must go through `$encode()` and OData literals through `$odata()`.
 */

const QueryValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Query = z.record(z.string(), QueryValue);
const Headers = z.record(z.string(), z.string());
/** Path relative to the service root (no scheme/host), starting with `/`. */
const ServicePath = z
  .string()
  .regex(/^(\/|\$\{)/, 'Expected a path starting with / (relative to the service root)');

export const GraphRequestSpec = z.strictObject({
  method: HttpMethod.default('GET'),
  /** Relative to /v1.0 (or /beta), e.g. `/users/${ $encode(inputs.userId) }`. */
  path: ServicePath,
  query: Query.optional(),
  headers: Headers.optional(),
  body: z.unknown().optional(),
  /** Use /beta (flagged as preview in the UI and in validate output). */
  beta: z.boolean().optional(),
});
export type GraphRequestSpec = z.infer<typeof GraphRequestSpec>;

export const ArmRequestSpec = z.strictObject({
  method: HttpMethod.default('GET'),
  /** Relative to https://management.azure.com, e.g. `/subscriptions/${ $encode(params.subscriptionId) }/resourceGroups`. */
  path: ServicePath,
  /** Required on every ARM request. */
  apiVersion: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(-preview)?$/, 'Expected an ARM api-version like 2022-12-01'),
  query: Query.optional(),
  headers: Headers.optional(),
  body: z.unknown().optional(),
});
export type ArmRequestSpec = z.infer<typeof ArmRequestSpec>;

/** Subscriptions / management groups: literal ids or one expression returning a list. */
const IdList = exprOr(z.array(z.string().min(1)));

/** Resource Graph has no leading `union a, b` (it fails with "Failed to resolve table expression"). */
export const startsWithUnion = (kql: string) => /^\s*union\b/i.test(kql.replace(/^\s*\/\/.*$/gm, ''));
export const RESOURCE_GRAPH_UNION_MESSAGE =
  "Resource Graph can't start a query with union: pipe one table into the other, e.g. resources | union (resourcecontainers | where …).";

export const ResourceGraphSpec = {
  /** KQL over Resource Graph tables (resources, resourcecontainers, …). */
  query: z
    .string()
    .min(1)
    .refine((q) => !startsWithUnion(q), RESOURCE_GRAPH_UNION_MESSAGE),
  subscriptions: IdList.optional(),
  managementGroups: IdList.optional(),
};

export const LogAnalyticsSpec = {
  /** Workspace (customer) id GUID, usually `${ env.X }` or a param. */
  workspace: z.string().min(1),
  query: z.string().min(1),
  /** ISO 8601 duration or interval (`P1D`, `2026-01-01/2026-01-02`); defaults to the page time range. */
  timespan: z.string().optional(),
};

export const FunctionCallSpec = {
  /** Connection id (kind: connection). */
  connection: DefinitionId,
  /** Named operation from the connection's allowlist. */
  operation: Identifier,
  /** Values for `{name}` placeholders in the operation path. */
  pathParams: z.record(z.string(), z.unknown()).optional(),
  query: Query.optional(),
  headers: Headers.optional(),
  body: z.unknown().optional(),
};

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lower-case hex sha256');

export const RunnerService = z.enum(['graph', 'exchange', 'teams', 'sharepointAdmin', 'arm']);

export const RunnerSpec = {
  /** Path under content/scripts, e.g. `exchange/Get-MailboxForwarding.ps1`. */
  script: z.string().regex(/^[A-Za-z0-9_\-/]+\.ps1$/, 'Expected a script path like exchange/Get-Thing.ps1'),
  /** The runner refuses scripts whose sha256 differs (§5.10). */
  sha256: Sha256,
  /** Passed as JSON on stdin, never interpolated into script text. */
  parameters: z.record(z.string(), z.unknown()).optional(),
  /** Delegated tokens forwarded to the worker. */
  services: z.array(RunnerService).optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
};

/**
 * `none` = one request; `cursor` = the UI loads more pages on demand (follows nextLink / skip tokens);
 * `all` = the server follows every page up to `maxItems` (reports, exports, transforms).
 */
export const Paging = z.enum(['none', 'cursor', 'all']);
export type Paging = z.infer<typeof Paging>;

const dsBase = {
  label: z.string().optional(),
  /**
   * JSONata over the connector result, as `${ … }`. Scope: `value` (result), `params`, `user`, `env`, `now`.
   * Results: graph/arm → response body (`paging: all` → `{ value: [...] }`); graphBatch → `{ <name>: body }`;
   * resourceGraph → `{ value: rows, totalRecords }`; logAnalytics → `{ value: rows, tables }`; function → body;
   * runner → script output; static → `data`.
   */
  transform: Expr.optional(),
  cache: z.strictObject({ ttl: z.number().int().min(0).max(86_400) }).optional(),
  /** Skip this datasource (result `null`) unless true. */
  when: exprOr(z.boolean()).optional(),
  /** Extra requirements of this datasource only (shown per widget). */
  requires: Requires.optional(),
};

const paged = { paging: Paging.default('none'), maxItems: z.number().int().min(1).max(100_000).optional() };

export const GraphDatasource = z.strictObject({
  source: z.literal('graph'),
  ...dsBase,
  request: GraphRequestSpec,
  ...paged,
});
export const GraphBatchDatasource = z.strictObject({
  source: z.literal('graphBatch'),
  ...dsBase,
  /** Named sub-requests in one $batch round trip (auto-chunked by 20). */
  requests: z
    .record(Identifier, GraphRequestSpec)
    .refine((r) => Object.keys(r).length > 0, 'Add at least one request'),
});
export const ArmDatasource = z.strictObject({
  source: z.literal('arm'),
  ...dsBase,
  request: ArmRequestSpec,
  ...paged,
});
export const ResourceGraphDatasource = z.strictObject({
  source: z.literal('resourceGraph'),
  ...dsBase,
  ...ResourceGraphSpec,
  ...paged,
});
export const LogAnalyticsDatasource = z.strictObject({
  source: z.literal('logAnalytics'),
  ...dsBase,
  ...LogAnalyticsSpec,
});
export const FunctionDatasource = z.strictObject({
  source: z.literal('function'),
  ...dsBase,
  ...FunctionCallSpec,
});
export const RunnerDatasource = z.strictObject({ source: z.literal('runner'), ...dsBase, ...RunnerSpec });
export const StaticDatasource = z.strictObject({ source: z.literal('static'), ...dsBase, data: z.unknown() });

export const Datasource = z.discriminatedUnion('source', [
  GraphDatasource,
  GraphBatchDatasource,
  ArmDatasource,
  ResourceGraphDatasource,
  LogAnalyticsDatasource,
  FunctionDatasource,
  RunnerDatasource,
  StaticDatasource,
]);
export type Datasource = z.infer<typeof Datasource>;
export type DatasourceSource = Datasource['source'];

export const Datasources = z.record(Identifier, Datasource);
export type Datasources = z.infer<typeof Datasources>;
