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
export const startsWithUnion = (kql: string) => /^\s*union\b/i.test(kql.replace(/^[ \t]*\/\/.*$/gm, ''));
export const RESOURCE_GRAPH_UNION_MESSAGE =
  "Resource Graph can't start a query with union: pipe one table into the other, e.g. resources | union (resourcecontainers | where …).";

/**
 * Resource Graph's join and union limits (learn.microsoft.com › Resource Graph › query language): at most three `join`
 * or `union` operations in a query, counted together; only one of them may bring in another table (a cross-table
 * join), unless every one is between `resources` and `resourcecontainers`; and a `union` stays within one table or
 * between those two. Azure refuses the query otherwise, so validate says so before anyone runs it. Returns the problem,
 * or null. Expressions (`${ … }`), strings and comments are left out; the first table after any `let` statements is the
 * query's own table.
 */
export function resourceGraphJoinProblem(kql: string): string | null {
  // Linear: an unclosed string runs to the end of its line (a closing quote can't be backtracked into).
  let text = kql.replace(/'(?:[^'\\\n]|\\.?)*(?:'|$)|"(?:[^"\\\n]|\\.?)*(?:"|$)/gm, "''");
  // ${ … } expressions, with nested braces.
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 0;
      for (i++; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) break;
      }
      out += "''";
    } else out += text[i];
  }
  text = out.replace(/\/\/.*$/gm, '').replace(/^\s*(let\b[^;]*;\s*)+/i, '');
  const own = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(text)?.[1]?.toLowerCase() ?? 'resources';
  const ops = [
    ...text.matchAll(
      /\|\s*(join|union)\b(?:\s+(?:kind|withsource|isfuzzy|hint\.[A-Za-z]+)\s*=\s*[A-Za-z0-9_]+)*\s*\(?\s*([A-Za-z_][A-Za-z0-9_]*)?/gi,
    ),
  ].map((m) => ({ op: m[1]!.toLowerCase(), table: (m[2] ?? own).toLowerCase() }));
  if (ops.length > 3)
    return `Resource Graph allows at most three join or union operations in one query (counted together); this one has ${ops.length}. Split it into datasources and combine them in a transform.`;
  const pair = new Set(['resources', 'resourcecontainers']);
  const inPair = (t: string) => pair.has(t) && pair.has(own);
  const cross = ops.filter((o) => o.table !== own);
  const badUnion = cross.find((o) => o.op === 'union' && !inPair(o.table));
  if (badUnion)
    return `Resource Graph only unions within one table or between resources and resourcecontainers, not ${own} and ${badUnion.table}. Use a separate datasource for ${badUnion.table}.`;
  if (cross.length > 1 && !cross.every((o) => inPair(o.table)))
    return `Resource Graph allows only one join to another table in a query (unless every one is between resources and resourcecontainers); this one joins ${own} to ${cross.map((o) => o.table).join(', ')}. Read the others in their own datasource (e.g. subscription names) and combine them in a transform.`;
  return null;
}

export const ResourceGraphSpec = {
  /** KQL over Resource Graph tables (resources, resourcecontainers, …). */
  query: z
    .string()
    .min(1)
    .refine((q) => !startsWithUnion(q), RESOURCE_GRAPH_UNION_MESSAGE)
    .superRefine((q, ctx) => {
      const problem = resourceGraphJoinProblem(q);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
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
  /**
   * Datasources that use this one (`ds.<name>`) still run when it fails: they see `null` instead of failing with
   * `dependency_failed`, and carry the failure in their result's `errors` (`ds.<name>`), so exports and scheduled
   * reports know they are incomplete (its own widgets still show the error). For enrichment some viewers can't read,
   * e.g. Teams Graph APIs that answer only people who hold a Teams licence. Never applies to a missing portal role,
   * the request policy (`policy_denied`), a missing tenant licence (`licence_required`) or a sign-in / arming problem
   * — here or anywhere further up the chain: those still fail the dependents.
   */
  optional: z.boolean().optional(),
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
